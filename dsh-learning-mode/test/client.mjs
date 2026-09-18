/**
 * 浏览器半边的渲染自检。
 *
 * 这是唯一能"离线"验证面板代码的途径：真机可见性只能人眼看，
 * 但"面板代码有没有引用错误 / 复习视图是否真的渲染出摘要"可以在这里断言。
 *
 * 做法：把 lib/client.js 当成它真实的样子执行（顶层就是 window.__ModuleLoader__.load），
 * 用一个元素记录型的迷你 React 替换 require('react')，再把 hook 返回值预置成想要的
 * 状态，直接把组件函数调一次，然后把返回的元素树拍平成文本检查内容。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const code = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let failures = 0
const check = (label, cond, extra) => {
  if (cond) console.log('  ok  ' + label)
  else { failures += 1; console.log('  FAIL ' + label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 300))) }
}

// ── 迷你 React：createElement 记录元素树；useState 从预置队列里取 ──────────
let hookQueue = []
const logs = []
const effects = []
const stateWrites = []
const react = {
  createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2)
    return { __el: true, type, props: props === null || props === undefined ? {} : props, children }
  },
  useState(initial) {
    const next = hookQueue.length > 0 ? hookQueue.shift() : initial
    return [next, (value) => { stateWrites.push(value) }]
  },
  // 离线渲染不自动跑副作用（状态由 hookQueue 预置）；effect 记录下来供"轮询"用例手动触发
  useEffect(fn) { effects.push(fn) },
}
const reactDom = { createPortal: (node) => node }

// ── 假环境：定时器 / fetch 都要能被断言（面板"轮询自己回到节奏"是这轮修的 bug） ──
const timers = []
let timerSeq = 0
const fakeSetTimeout = (fn, delay) => { timers.push({ id: ++timerSeq, fn, delay, kind: 'timeout' }); return timerSeq }
const fakeSetInterval = (fn, delay) => { timers.push({ id: ++timerSeq, fn, delay, kind: 'interval' }); return timerSeq }
const noopClear = () => {}
let fetchResponses = []
const fetchCalls = []
const fakeFetch = (url, options) => {
  let body = {}
  try { body = JSON.parse(options.body) } catch { /* ignore */ }
  fetchCalls.push({ url, op: body.op, body })
  const next = fetchResponses.length > 0 ? fetchResponses.shift() : { status: 200, json: { ok: true, enabled: false } }
  return Promise.resolve({
    status: next.status,
    text: () => Promise.resolve(JSON.stringify(next.json)),
  })
}

// ── 假 DOM：跳转功能靠 `data-chat-turn` / `data-conversation-scroll` 定位 ──
// chatRows 由各用例自己控制（默认空）：这样"聊天区还没渲染出来"也能被测到。
let chatRows = []
const fakeScroller = {
  _top: 100,
  clientHeight: 600,
  getBoundingClientRect: () => ({ top: 0, left: 0 }),
  get scrollTop() { return this._top },
  set scrollTop(value) { this._top = value },
}
function fakeRow(turn, top) {
  const classes = new Set()
  return {
    dataset: { chatTurn: String(turn) },
    clientHeight: 100,
    _top: top === undefined ? 500 : top,
    getBoundingClientRect() { return { top: this._top, left: 0 } },
    closest(sel) { return sel === '[data-conversation-scroll]' ? fakeScroller : null },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    scrollIntoView() { this._rawScrolled = true },
  }
}
const fakeDocument = {
  body: {},
  querySelectorAll(sel) {
    if (sel === '[data-chat-turn]') return chatRows
    return []
  },
  querySelector(sel) { return sel === '[data-conversation-scroll]' ? fakeScroller : null },
}

// ── 假客户端服务：apply 里用**可选访问**拿（拿不到只是没有跳转功能）────────
const openedSessions = []
const loadedThrough = []
const servicesState = { openThrows: false, openAddsRow: 0, binding: null }
const fakeSessions = {
  open(id) {
    if (servicesState.openThrows) throw new Error('unknown-session')
    openedSessions.push(id)
    if (servicesState.openAddsRow > 0) chatRows = [fakeRow(servicesState.openAddsRow)]
  },
  binding() { return servicesState.binding },
}
/** 客户端写进 rpc.log 的诊断行（跳转/环境上报都靠它取证）。 */
function diagLines() {
  return fetchCalls.filter((c) => c.op === 'diag').map((c) => String((c.body && c.body.line) || ''))
}
/** 让挂在微任务队列上的 rpc().then 链条跑完。 */
const flush = async (times = 8) => { for (let i = 0; i < times; i += 1) await Promise.resolve() }

/** 按 title 找元素 props（头部拖动条 / ⟲ 恢复默认这类没有 className 的按钮）。 */
function findByTitle(node, title) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findByTitle(child, title); if (hit !== null) return hit }
    return null
  }
  if (node.__el !== true) return null
  if (node.props.title === title) return node.props
  if (node.type === 'style') return null
  if (typeof node.type === 'function') return findByTitle(node.type(node.props), title)
  return findByTitle(node.children, title)
}

/** 取注入到页面里的那段 scoped CSS 文本。 */
function cssTextOf(node) {
  if (node === null || node === undefined || typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(cssTextOf).join('')
  if (node.__el !== true) return ''
  if (node.type === 'style') return Array.isArray(node.children) ? node.children.join('') : String(node.children || '')
  if (typeof node.type === 'function') return cssTextOf(node.type(node.props))
  return cssTextOf(node.children)
}

// 假 window.__ModuleLoader__：只捕获定义，不执行 factory
const captured = {}
// 事件监听记录（面板拖动把 move/up 挂在 window 上，要能断言"挂上了 / 松手卸掉了"）
let winListeners = {}
const fakeWindow = {
  __ModuleLoader__: { load: (def) => { captured[def.id] = def } },
  prompt: () => null,
  innerWidth: 1400,
  innerHeight: 900,
  addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn) },
  removeEventListener(type, fn) { winListeners[type] = (winListeners[type] || []).filter((f) => f !== fn) },
}
// 假 localStorage：面板窗口几何（位置/大小）存在这里
const fakeStore = new Map()
const fakeLocalStorage = {
  getItem: (key) => (fakeStore.has(key) ? fakeStore.get(key) : null),
  setItem: (key, value) => { fakeStore.set(String(key), String(value)) },
  removeItem: (key) => { fakeStore.delete(key) },
}
const requireShim = (name) => {
  if (name === 'react') return react
  if (name === 'react-dom') return reactDom
  throw new Error('unexpected require: ' + name)
}

new Function(
  'window', 'require', 'console',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'fetch', 'document', 'localStorage',
  code,
)(
  fakeWindow,
  requireShim,
  { info: (...a) => { logs.push(a.join(' ')) }, log: () => {}, error: () => {} },
  fakeSetTimeout, fakeSetInterval, noopClear, noopClear, fakeFetch, fakeDocument, fakeLocalStorage,
)

const def = captured['dsh-learning-mode']
check('客户端模块已把自身注册进 __ModuleLoader__', def !== undefined && typeof def.factory === 'function')
const plugin = def.factory(requireShim)
check('插件导出 name/inject/apply', typeof plugin.name === 'string' && typeof plugin.apply === 'function')
check('声明了 inject: ["slots"]（不声明会在 apply 第一行抛）', Array.isArray(plugin.inject) && plugin.inject.includes('slots'))

// ── 走一遍 apply()，确认注册座位 ────────────────────────────────────────
const registrations = []
const injected = []
const slots = {
  inject(key, cb) { injected.push(key); cb() },
  register(options, component) { registrations.push({ options, component }); return () => {} },
}
plugin.apply({ slots, get: (name) => (name === 'sessions' ? fakeSessions : undefined) })
check('apply() 不抛错且调用了 slots.inject', injected.includes('conversation.session.header.actions'), injected)
check('注册进 conversation.session.header.actions', registrations.length === 1 && registrations[0].options.name === 'conversation.session.header.actions')
check('注册 id 是 learning-mode', registrations[0].options.id === 'learning-mode')

// ── 拍平元素树成文本 ────────────────────────────────────────────────────
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (node.__el === true) {
    // <style> 里的 scoped CSS 不是用户可见文本，跳过（否则断言会被样式文本污染）
    if (node.type === 'style') return ''
    // 函数组件就地展开（TreeRow 这类不用 hook 的组件）
    if (typeof node.type === 'function') return textOf(node.type(node.props))
    return textOf(node.children)
  }
  return ''
}

/** 收集元素树里所有 title 属性（悬停才可见的解释文案在这里断言）。 */
function titlesOf(node, out) {
  const acc = out || []
  if (node === null || node === undefined || typeof node !== 'object') return acc
  if (Array.isArray(node)) { for (const child of node) titlesOf(child, acc); return acc }
  if (node.__el !== true) return acc
  if (typeof node.props.title === 'string') acc.push(node.props.title)
  if (typeof node.type === 'function') { titlesOf(node.type(node.props), acc); return acc }
  titlesOf(node.children, acc)
  return acc
}

/** 按 className 找第一个元素的 props（新入口按钮 / NEW 角标之类）。 */
function propsByClass(node, className) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) { const hit = propsByClass(child, className); if (hit !== null) return hit }
    return null
  }
  if (node.__el !== true) return null
  if (typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes(className)) return node.props
  if (typeof node.type === 'function') return propsByClass(node.type(node.props), className)
  return propsByClass(node.children, className)
}

const Chip = registrations[0].component
const TREE = {
  id: 'tutorial',
  title: 'Java 学习',
  nodes: [
    {
      id: 'n1', title: 'Java', status: 'todo', note: '', noteState: null, children: [
        { id: 'n2', title: '对象', status: 'done', note: '继承是 is-a；组合是 has-a', noteState: 'done', children: [] },
        { id: 'n3', title: '语法', status: 'done', note: '', noteState: 'running', children: [] },
      ],
    },
  ],
}
const STATE = {
  ok: true, enabled: true, usage: '使用说明文本', focus: 'Java/对象',
  trees: [{ id: 'tutorial', title: 'Java 学习', total: 3, done: 2, lastUsedAt: null }],
  tree: TREE,
}
const REVIEW = {
  ok: true,
  tree: { id: 'tutorial', title: 'Java 学习' },
  stats: { done: 2, total: 3, withNote: 1 },
  items: [
    { path: 'Java/对象', title: '对象', note: '继承是 is-a；组合是 has-a', noteAt: null, noteState: 'done', doneAt: '2026-09-18T10:00:00.000Z' },
    { path: 'Java/语法', title: '语法', note: '', noteAt: null, noteState: 'running', doneAt: '2026-09-17T10:00:00.000Z' },
  ],
}

// 未开启的会话 → render null（零侵入的关键断言）
hookQueue = [{ ok: true, enabled: false }]
check('普通会话：整个 Chip 渲染为 null', Chip({ sessionId: 's1' }) === null)

// 学习会话但面板收起 → 只渲染一个「学习树」按钮
hookQueue = [STATE, '', null]
const collapsed = textOf(Chip({ sessionId: 's1' }))
check('学习会话：收起时只显示「学习树」按钮', collapsed.includes('学习树') && !collapsed.includes('复习'), collapsed)

/** 数一数元素树里有几个 <style>（面板 CSS 的载体）。 */
/** 找到元素树里的 svg，取它的 viewBox（图标签名对不上时返回 null）。 */
function svgViewBox(node) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) { const hit = svgViewBox(child); if (hit !== null) return hit }
    return null
  }
  if (node.__el !== true) return null
  if (node.type === 'svg') return node.props.viewBox === undefined ? '' : String(node.props.viewBox)
  if (typeof node.type === 'function') return svgViewBox(node.type(node.props))
  return svgViewBox(node.children)
}

function countStyles(node) {
  if (node === null || node === undefined || typeof node !== 'object') return 0
  if (Array.isArray(node)) return node.reduce((sum, child) => sum + countStyles(child), 0)
  if (node.__el !== true) return 0
  if (node.type === 'style') return 1
  if (typeof node.type === 'function') return countStyles(node.type(node.props))
  return countStyles(node.children)
}

// ⚠️ 回归：CSS 曾经挂在面板里 → 面板收起时 <style> 不在 DOM → 入口按钮变成 UA 默认样式
//（实拍：直角框、字号变大、图标贴文字）。现在挂在"永远渲染"的 Chip 外层。
hookQueue = [STATE, '', null, 'tree', null]
const collapsedEl = Chip({ sessionId: 's1' })
check('收起状态也带面板 CSS（否则入口按钮退化成浏览器默认按钮）', countStyles(collapsedEl) >= 1)
// 实拍反馈"svg 图标偏上"的根因：viewBox 16×16 但 ink 只占上半 → 居中的是空盒子。
// 这里把 viewBox 钉在"紧贴图形边界"上，谁改回 0 0 16 16 就会红。
check('树图标 viewBox 紧贴图形边界（治"偏上"）', svgViewBox(collapsedEl) === '2 0.8 12 9.6', svgViewBox(collapsedEl))
hookQueue = [STATE, '', 'panel', 'tree', null]
check('展开状态同样带面板 CSS（不会重复丢）', countStyles(Chip({ sessionId: 's1' })) >= 1)

// 学习会话 + 树视图
hookQueue = [STATE, '', 'panel', 'tree', null]
const treeRendered2 = Chip({ sessionId: 's1' })
const treeView = textOf(treeRendered2)
check('树视图渲染节点标题', treeView.includes('Java') && treeView.includes('对象'), treeView.slice(0, 200))
check('树视图有 [学会] / [已完成] / [⟳] 按钮', treeView.includes('学会') && treeView.includes('已完成') && treeView.includes('⟳'))
check('树视图有 [树] [复习] 页签', treeView.includes('复习') && treeView.includes('树'))
check('使用说明默认不展开', !treeView.includes('使用说明文本'), treeView.slice(0, 300))
// ── 这一版重做的核心：树保持一行，摘要默认不铺开（实拍反馈"总结的占空显示不合理"）──
check('摘要默认**不**展开（树不被摘要顶散）', !treeView.includes('继承是 is-a'), treeView.slice(0, 300))
check('有摘要的节点给「摘要」小按钮（点开才展开）', treeView.includes('摘要'), treeView.slice(0, 300))
check('生成中的节点给状态角标', treeView.includes('生成中'), treeView.slice(0, 300))
check('聚焦节点带 ▶ 标记（一眼看到"我在哪"）', treeView.includes('▶'), treeView.slice(0, 300))
check('父节点带进度角标 done/total', treeView.includes('2/3'), treeView.slice(0, 300))
// 点开摘要 → 该节点摘要出现（展开是本地视图状态，用 hookQueue 预置）
hookQueue = [STATE, '', 'panel', 'tree', null, { n2: true }]
check('点开摘要按钮后该节点摘要可见', textOf(Chip({ sessionId: 's1' })).includes('继承是 is-a；组合是 has-a'))

// 使用说明展开
hookQueue = [STATE, '', 'usage', 'tree', null]
check('点开后使用说明可见', textOf(Chip({ sessionId: 's1' })).includes('使用说明文本'))

// 学习会话 + 复习视图
hookQueue = [STATE, '', 'panel', 'review', REVIEW]
const reviewView = textOf(Chip({ sessionId: 's1' }))
check('复习视图列出已完成路径', reviewView.includes('Java/对象') && reviewView.includes('Java/语法'), reviewView.slice(0, 300))
check('复习视图显示摘要正文', reviewView.includes('继承是 is-a；组合是 has-a'), reviewView.slice(0, 300))
check('复习视图标出"摘要待补"', reviewView.includes('摘要待补'), reviewView.slice(0, 300))
check('复习视图显示统计', reviewView.includes('2 个已完成'), reviewView.slice(0, 300))

// ══ 变更提示（item 4）：新增节点 → 按钮红点 → 点开清红点 → 树里标 NEW ══
// 水位线 seenAt 是"上次看过"；节点 createdAt 比它新 = 新增
const STATE_WITH_NEW = {
  ...STATE,
  seenAt: '2026-09-17T00:00:00.000Z',
  tree: { id: 'tutorial', title: 'Java 学习', nodes: [
    { id: 'n1', title: 'Java', status: 'todo', note: '', noteState: null, createdAt: '2026-09-10T00:00:00.000Z', children: [
      { id: 'n2', title: '对象', status: 'done', note: '继承是 is-a；组合是 has-a', noteState: 'done', createdAt: '2026-09-10T00:00:00.000Z', children: [] },
      { id: 'n4', title: '新知识点', status: 'todo', note: '', noteState: null, createdAt: '2026-09-18T00:00:00.000Z', children: [] },
    ] },
  ] },
}
// 收起状态 → 入口按钮上有 +1 红点（⚠️ 一次渲染只消费一次 hookQueue，元素要复用）
hookQueue = [STATE_WITH_NEW, '', null, 'tree', null]
const chipEl = Chip({ sessionId: 's1' })
const chipNewText = textOf(chipEl)
const chipProps = propsByClass(chipEl, 'lm-chip')
check('入口按钮用与邻居（快照）同款的药丸类名', chipProps !== null && chipProps.className === 'lm-chip', chipProps && chipProps.className)
// 实拍反馈：内联 SVG 默认按基线坐 → 图标偏上。修法是邻居 .u_icon 那两句。
check('图标包在 lm-chip-icon 里（vertical-align:-2px + line-height:0 治"偏上"）',
  textOf(chipEl).includes('学习树') && JSON.stringify(chipEl).includes('lm-chip-icon'), Object.keys(chipProps || {}))
check('有新增时按钮显示红点 +N', chipNewText.includes('+1'), chipNewText)
check('按钮 title 说明新增数量', chipProps !== null && String(chipProps.title).includes('新增 1 个知识点'), chipProps && chipProps.title)

// 点开 → 乐观清红点 + 发 seen RPC + 打开面板
stateWrites.length = 0
fetchCalls.length = 0
hookQueue = [STATE_WITH_NEW, '', null, 'tree', null]
const chipEl2 = Chip({ sessionId: 's1' })
propsByClass(chipEl2, 'lm-chip').onClick()
const optimisticSeen = stateWrites.filter((w) => typeof w === 'function').map((w) => w(STATE_WITH_NEW))
check('点按钮：乐观把 seenAt 推到 now（红点立刻消失）',
  optimisticSeen.some((next) => next !== null && typeof next.seenAt === 'string' && next.seenAt !== '2026-09-17T00:00:00.000Z'), stateWrites.length)
check('点按钮：把面板打开（setOpen panel）', stateWrites.includes('panel'), stateWrites)
check('点按钮：发出 op=seen（把水位线落盘）', fetchCalls.some((c) => c.op === 'seen'), fetchCalls)

// 面板开着 + 冻结水位线 → 树里标 NEW、"新增 N 个"提示、折叠的父分支被强制展开
hookQueue = [STATE_WITH_NEW, '', 'panel', 'tree', null, {}, { n1: true }, '2026-09-17T00:00:00.000Z']
const marked = textOf(Chip({ sessionId: 's1' }))
check('面板里标出 NEW 角标', marked.includes('NEW'), marked.slice(0, 400))
check('面板顶部提示"新增 N 个知识点"', marked.includes('新增 1 个知识点'), marked.slice(0, 400))
check('新增节点的折叠父分支被强制展开（否则看不见新增）', marked.includes('新知识点'), marked.slice(0, 400))

// 关掉再开：水位线已推进 → 不再标 NEW（标记是算出来的，不是存出来的）
hookQueue = [STATE_WITH_NEW, '', 'panel', 'tree', null, {}, {}, '2026-09-18T00:00:00.000Z']
check('水位线推进后：树里没有 NEW 了', !textOf(Chip({ sessionId: 's1' })).includes('NEW'))

// 复习视图读取中（review 还没回来）
hookQueue = [STATE, '', 'panel', 'review', null]
check('复习视图数据未到时显示读取中', textOf(Chip({ sessionId: 's1' })).includes('读取中'))

// 没有树时给出引导文案
hookQueue = [{ ...STATE, tree: null }, '', 'panel', 'tree', null]
check('没有树时给出引导文案', textOf(Chip({ sessionId: 's1' })).includes('还没有学习树'))
hookQueue = [{ ...STATE, tree: { id: 'x', title: 'X', nodes: [] } }, '', 'panel', 'tree', null]
check('空树不报错（渲染为空面板）', textOf(Chip({ sessionId: 's1' })).includes('学习树'))

// 各种 noteState 的提示文案
hookQueue = [{ ...STATE, tree: { id: 'x', title: 'X', nodes: [
  { id: 'a', title: 'A', status: 'done', note: '', noteState: 'failed', children: [] },
  { id: 'b', title: 'B', status: 'done', note: '', noteState: 'skipped', children: [] },
  { id: 'c', title: 'C', status: 'done', note: '', noteState: null, children: [] },
] } }, '', 'panel', 'tree', null]
const hintsEl = Chip({ sessionId: 's1' })
const hints = textOf(hintsEl)
const hintTitles = titlesOf(hintsEl).join(' ｜ ')
check('failed 有专门角标', hints.includes('摘要失败'), hints.slice(0, 400))
check('failed 的完整解释在悬停提示里', hintTitles.includes('摘要没生成出来'), hintTitles.slice(0, 300))
check('skipped 有角标，完整解释在悬停提示里', hints.includes('无摘要') && hintTitles.includes('内容还太少'), hints.slice(0, 400))
check('无状态时提示可以点 ⟳ 总结', hintTitles.includes('还没有摘要'), hintTitles.slice(0, 300))

check('关键步骤打了 [learning-mode] 日志（离线诊断判据）', logs.some((line) => line.includes('[learning-mode]')), logs.slice(0, 3))

// ── 乐观更新：点 ✓ 立刻改本地状态，不等下一次轮询 ───────────────────────
function findInTree(nodes, id) {
  for (const n of nodes || []) {
    if (n.id === id) return n
    const deeper = findInTree(n.children, id)
    if (deeper !== null) return deeper
  }
  return null
}
/** 从元素树里挖出树行的统一操作入口 onAct（需要就地展开函数组件） */
function findAct(node) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findAct(child); if (hit !== null) return hit }
    return null
  }
  if (node.__el !== true) return null
  if (node.props !== undefined && typeof node.props.onAct === 'function') return node.props.onAct
  if (typeof node.type === 'function') return findAct(node.type(node.props))
  return findAct(node.children)
}

hookQueue = [STATE, '', 'panel', 'tree', null]
stateWrites.length = 0
fetchCalls.length = 0
const treeRendered = Chip({ sessionId: 's1' })
const rowAct = findAct(treeRendered)
check('树行拿到统一操作入口 act', typeof rowAct === 'function')
rowAct('done', { id: 'n3', path: 'Java/语法', done: true })
check('乐观更新：立刻写入本地状态（旧版要等最多 3 秒轮询）', stateWrites.length === 1, stateWrites.length)
check('乐观更新走的是函数式 setState（基于最新状态打补丁）', typeof stateWrites[0] === 'function')
const optimistic = stateWrites[0](STATE)
check('乐观更新把该节点标成 done', findInTree(optimistic.tree.nodes, 'n3').status === 'done', findInTree(optimistic.tree.nodes, 'n3'))
check('乐观更新没有动别的节点', findInTree(optimistic.tree.nodes, 'n2').status === 'done' && findInTree(optimistic.tree.nodes, 'n1').status === 'todo')
rowAct('done', { id: 'n3', path: 'Java/语法', done: false })
const reverted = stateWrites[1](optimistic)
check('再点一次可撤销（乐观回滚成 todo）', findInTree(reverted.tree.nodes, 'n3').status === 'todo', findInTree(reverted.tree.nodes, 'n3'))
check('乐观更新之后仍然发出 RPC', fetchCalls.some((c) => c.op === 'done'), fetchCalls)

// ── 轮询回归：面板必须"自己回到节奏"，不能等用户切会话 ─────────────────────
// 实拍反馈的 bug：插件在 agent/created 之后才把会话标成 enabled，
// 面板先到时拿到 enabled:false 就停轮询 → 学习树按钮永远不出现，必须切聊天框。
async function pollProbe(responses) {
  timers.length = 0
  fetchCalls.length = 0
  effects.length = 0
  stateWrites.length = 0
  fetchResponses = responses.slice()
  hookQueue = [null, '', null, 'tree', null] // 首帧：还没有 state 数据
  Chip({ sessionId: 's1' })
  check('面板挂载时注册了轮询副作用', effects.length >= 1, effects.length)
  effects[0]() // 启动轮询
  await flush()
  return {
    ops: fetchCalls.map((c) => c.op),
    lines: diagLines(),
    timeouts: timers.filter((t) => t.kind === 'timeout').map((t) => t.delay),
    intervals: timers.filter((t) => t.kind === 'interval').map((t) => t.delay),
    writes: stateWrites.slice(),
  }
}

let probe = await pollProbe([{ status: 200, json: { ok: true, enabled: false } }])
check('挂载即立刻请求 state（不用切会话）', probe.ops[0] === 'state', probe.ops)
check('未启用时**继续排下一次轮询**（这是 bug 的回归守卫）', probe.timeouts.length === 1, probe.timeouts)
check('未启用时的轮询间隔是秒级快节奏', probe.timeouts[0] === 800, probe.timeouts)

probe = await pollProbe([{ status: 404, json: { ok: false, error: 'session-not-found' } }])
check('404（会话还没注册）也继续重试', probe.timeouts.length === 1, probe.timeouts)
check('404 不把错误态写给 UI', probe.writes.every((w) => w === null || typeof w !== 'string' || !String(w).includes('session-not-found')), probe.writes)

probe = await pollProbe([{ status: 200, json: { ok: true, enabled: true, tree: null, trees: [], usage: '' } }])
check('启用后进入 3 秒常态轮询', probe.timeouts[0] === 3000, probe.timeouts)
check('启用后把 state 交给面板', probe.writes.length >= 1, probe.writes.length)

// 长时间非学习会话：快节奏退到 5 秒，避免每个普通会话都在高频轮询
fetchResponses = []
for (let i = 0; i < 14; i += 1) fetchResponses.push({ status: 200, json: { ok: true, enabled: false } })
timers.length = 0; fetchCalls.length = 0; effects.length = 0; stateWrites.length = 0
hookQueue = [null, '', null, 'tree', null]
Chip({ sessionId: 's2' })
const stop = effects[0]()
await flush() // 先让首次 tick 落地，才会排出下一个定时器
let cursor = 0
for (let i = 0; i < 14; i += 1) {
  const pending = timers.filter((t) => t.kind === 'timeout')
  if (cursor >= pending.length) break
  pending[cursor].fn()
  cursor += 1
  await flush()
}
const delays = timers.filter((t) => t.kind === 'timeout').map((t) => t.delay)
check('普通会话：快节奏会退到 5 秒（长期不打扰）', delays.includes(5000), delays.slice(0, 16))
check('清理函数存在（切会话/卸载能停轮询）', typeof stop === 'function')
stop()

// ══════════════════════════════════════════════════════════════════════════
// 环境上报（写进 host 的 rpc.log）
// 存在的理由：前端出问题只能看 console，而 console 不落盘 —— 本项目栽过两次
// "单测全绿、真机功能是死的"。这条通道让 DOM/服务形态有离线判据。
// ══════════════════════════════════════════════════════════════════════════
servicesState.binding = { session: { loadThrough: () => {} } }
chatRows = [fakeRow(3), fakeRow(4)]
const envProbe = await pollProbe([{ status: 200, json: { ok: true, enabled: true, tree: null, trees: [], usage: '' } }])
const envLine = envProbe.lines.find((l) => l.startsWith('env ')) || ''
check('拿到 state 后上报一次真实环境（写进 rpc.log）', envLine !== '', envProbe.lines)
check('上报里带"会话流渲染了多少轮"（DOM 形态的判据）', envLine.includes('"turnRows":2') && envLine.includes('"turnMax":4'), envLine)
check('上报里带"官方滚动容器在不在"', envLine.includes('"scroll":true'), envLine)
check('上报里带 loadThrough 可达性（跨分页跳转的前提）', envLine.includes('"loadThrough":"function"'), envLine)

// ══════════════════════════════════════════════════════════════════════════
// 「↩ 原文」：从树上的知识点跳回"讲它的那一轮对话"
// 坐标是 (sid, turn, seq) —— 外壳按 turn 分行（data-chat-turn），更早的分页用 loadThrough(seq) 补。
// ══════════════════════════════════════════════════════════════════════════
function collectByClass(node, className, out) {
  const acc = out || []
  if (node === null || node === undefined || typeof node !== 'object') return acc
  if (Array.isArray(node)) { for (const child of node) collectByClass(child, className, acc); return acc }
  if (node.__el !== true) return acc
  if (typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes(className)) acc.push(node.props)
  if (typeof node.type === 'function') { collectByClass(node.type(node.props), className, acc); return acc }
  collectByClass(node.children, className, acc)
  return acc
}
/** 深拷贝 STATE 并给某个节点挂上来源坐标（null = 没有来源）。 */
function withOrigin(nodeId, origin) {
  const clone = JSON.parse(JSON.stringify(STATE))
  const hit = findInTree(clone.tree.nodes, nodeId)
  hit.origin = origin
  hit.originCount = origin === null ? 0 : 1
  return clone
}
/** 渲染一棵树并按 className 取元素 props。 */
function renderTree(state, sessionId) {
  hookQueue = [state, '', 'panel', 'tree', null]
  return Chip({ sessionId: sessionId || 's1' })
}
const ORIGIN = { sid: 's1', turn: 12, seq: 345, time: '2026-09-18T05:51:12.147Z', why: 'capture' }

const originEl = renderTree(withOrigin('n2', ORIGIN))
const jumpProps = collectByClass(originEl, 'lm-jump')
check('有来源坐标的节点渲染「↩ 原文」', jumpProps.length === 1, jumpProps.length)
check('只给有来源的那个节点渲染（别的节点没有 ↩）', collectByClass(renderTree(withOrigin('n3', null)), 'lm-jump').length === 0)
check('↩ 的悬停提示写明第几轮（可核对）', typeof jumpProps[0].title === 'string' && jumpProps[0].title.includes('第 12 轮'), jumpProps[0] && jumpProps[0].title)
check('同会话的提示是"跳到这一轮"', String(jumpProps[0].title).includes('跳到这一轮'), jumpProps[0].title)

// ① 同会话：直接找到那一轮 → 滚到视口中间 + 闪一下
timers.length = 0
fetchCalls.length = 0
openedSessions.length = 0
chatRows = [fakeRow(12)]
fakeScroller._top = 100
jumpProps[0].onClick({ stopPropagation() {} })
await flush()
check('同会话跳转：真的滚了（写 scrollTop，而不是 scrollIntoView）', fakeScroller._top === 350, fakeScroller._top)
check('同会话跳转：用的是外壳的滚动容器，不是整页 scrollIntoView', chatRows[0]._rawScrolled === undefined, chatRows[0]._rawScrolled)
check('跳过去以后那一行闪一下高亮', chatRows[0].classList.contains('lm-flash'))
check('高亮 1.8 秒后自己摘掉（不留痕迹）', timers.some((t) => t.delay === 1800), timers.map((t) => t.delay))
check('同会话跳转不切会话', openedSessions.length === 0, openedSessions)
check('同会话跳转写了 rpc.log 判据', diagLines().some((l) => l.startsWith('jump ok ')), diagLines())

// ② 跨会话：先 open 那次会话，等聊天区挂载出来再滚（不能只找一次）
timers.length = 0
fetchCalls.length = 0
openedSessions.length = 0
chatRows = []
fakeScroller._top = 100
const crossEl = renderTree(withOrigin('n2', { sid: 'other-session', turn: 12, seq: 345, time: ORIGIN.time }))
const crossProps = collectByClass(crossEl, 'lm-jump')
check('跨会话来源的提示是"跳回那次对话"', String(crossProps[0].title).includes('跳回那次对话'), crossProps[0].title)
crossProps[0].onClick({ stopPropagation() {} })
await flush()
check('跨会话跳转：先切到那次会话', openedSessions.length === 1 && openedSessions[0] === 'other-session', openedSessions)
check('切完不立刻放弃：排了一次"再看一眼"（聊天区是异步挂载的）', timers.some((t) => t.delay === 150), timers.map((t) => t.delay))
chatRows = [fakeRow(12)] // 模拟切换后聊天区挂载完成
timers.filter((t) => t.delay === 150).pop().fn()
await flush()
check('跨会话跳转：挂载后照样滚到那一轮', fakeScroller._top === 350, fakeScroller._top)
check('跨会话跳转写了 rpc.log 判据（ok-after-switch）', diagLines().some((l) => l.includes('jump ok-after-switch')), diagLines())

// ③ 目标会话已经不在（删除/归档）→ 必须明确告诉用户，不能点了没反应
timers.length = 0
fetchCalls.length = 0
stateWrites.length = 0
servicesState.openThrows = true
const goneProps = collectByClass(renderTree(withOrigin('n2', { sid: 'gone-session', turn: 3, seq: 9, time: ORIGIN.time })), 'lm-jump')
goneProps[0].onClick({ stopPropagation() {} })
await flush()
check('目标会话打不开时给用户一句明确提示（不静默）', stateWrites.some((w) => typeof w === 'string' && w.includes('已经不在了')), stateWrites)
check('目标会话打不开也写 rpc.log 判据', diagLines().some((l) => l.includes('jump session-gone')), diagLines())
servicesState.openThrows = false

// ④ 那一轮在更早的分页里（DOM 里没有）→ 用官方 loadThrough(seq) 补页
timers.length = 0
fetchCalls.length = 0
loadedThrough.length = 0
servicesState.binding = { session: { loadThrough: (seq) => loadedThrough.push(seq) } }
chatRows = []
const oldProps = collectByClass(renderTree(withOrigin('n2', { sid: 's1', turn: 77, seq: 999, time: ORIGIN.time })), 'lm-jump')
oldProps[0].onClick({ stopPropagation() {} })
await flush()
let guard = 0
while (guard < 14 && loadedThrough.length === 0) {
  const pending = timers.filter((t) => t.kind === 'timeout' && t.delay === 120)
  if (pending.length === 0) break
  pending[pending.length - 1].fn()
  guard += 1
  await flush()
}
check('找不到那一轮时用官方 loadThrough(seq) 补页（更早的分页）', loadedThrough.includes(999), loadedThrough)

// ⑤ 拿不到会话服务 → 不假装成功（放在最后：会把 svc.sessions 重置掉）
plugin.apply({ slots, get: () => undefined })
fetchCalls.length = 0
stateWrites.length = 0
const noSvcProps = collectByClass(renderTree(withOrigin('n2', { sid: 'other-session', turn: 5, seq: 50, time: ORIGIN.time })), 'lm-jump')
noSvcProps[0].onClick({ stopPropagation() {} })
await flush()
check('拿不到会话服务时明确告知（而不是点了没反应）', stateWrites.some((w) => typeof w === 'string' && w.includes('拿不到会话服务')), stateWrites)
check('拿不到会话服务也写 rpc.log 判据', diagLines().some((l) => l.includes('jump no-sessions')), diagLines())

// ⑥ 没有 ctx.get 的环境（可选服务探测失败）也不能拖垮插件
check('apply 在没有 ctx.get 的环境下不抛', (() => { try { plugin.apply({}); return true } catch (e) { return false } })())

// ══════════════════════════════════════════════════════════════════════════
// 面板窗口：可拖动 + 可调大小 + 记住上次的样子
// ══════════════════════════════════════════════════════════════════════════
function renderPanel(state, sessionId) {
  hookQueue = [state, '', 'panel', 'tree', null]
  return Chip({ sessionId: sessionId || 's1' })
}
const GEOM_TITLE_DRAG = '按住这里可以拖动面板'
const GEOM_TITLE_RESET = '恢复默认位置和大小'
fakeStore.clear()
stateWrites.length = 0
let panelEl = renderPanel(STATE)
let panel = propsByClass(panelEl, 'lm-panel')
check('面板根元素带 lm-panel（拖动/缩放靠它定位）', panel !== null)
check('默认：不写 left（还是老样子贴右 16px）', panel.style.left === undefined && panel.style.right === '16px', panel.style.left)
check('默认：宽度 392px、高度仍走 maxHeight（没有显式高度）', panel.style.width === '392px' && panel.style.maxHeight === '76vh', panel.style)
check('默认：头部是拖动入口（按住能拖）', findByTitle(panelEl, GEOM_TITLE_DRAG) !== null)
check('默认：没有 ⟲（用户没动过窗口就不给多余按钮）', findByTitle(panelEl, GEOM_TITLE_RESET) === null)
check('默认：三个缩放手柄都在（右 / 下 / 右下角）',
  propsByClass(panelEl, 'lm-rs-r') !== null && propsByClass(panelEl, 'lm-rs-b') !== null && propsByClass(panelEl, 'lm-rs-c') !== null)
const cssNow = cssTextOf(panelEl)
check('CSS 里有拖动光标与缩放手柄（类名回归守卫，同入口按钮那次的坑）',
  cssNow.includes('.lm-head{cursor:grab}') && cssNow.includes('.lm-rs-c{') && cssNow.includes('nwse-resize'), cssNow.length)

// 记住上次的样子
fakeStore.set('lm.panel.geom', JSON.stringify({ x: 120, y: 40, w: 520, h: 420 }))
panelEl = renderPanel(STATE)
panel = propsByClass(panelEl, 'lm-panel')
check('读回上次调的窗口：left/top/width/height 都生效',
  panel.style.left === '120px' && panel.style.top === '40px' && panel.style.width === '520px' && panel.style.height === '420px', panel.style)
check('显式高度时不再叠加 maxHeight（否则拉不高）', panel.style.maxHeight === 'none', panel.style.maxHeight)
check('动过窗口后出现 ⟲ 恢复默认', findByTitle(panelEl, GEOM_TITLE_RESET) !== null)

// 换显示器 / 缩窗口：读回来时按视口钳制，不许跑到屏幕外
fakeStore.set('lm.panel.geom', JSON.stringify({ x: 99999, y: -50, w: 10, h: 10 }))
panel = propsByClass(renderPanel(STATE), 'lm-panel')
check('钳制：尺寸不低于最小值、y 不为负、x 不出屏',
  panel.style.width === '260px' && panel.style.height === '160px' && panel.style.top === '0px' && panel.style.left === (1400 - 260 - 8) + 'px',
  panel.style)

// 拖动：mousedown 挂 window 监听 → mousemove 改几何 → mouseup 才落盘
fakeStore.clear()
winListeners = {}
stateWrites.length = 0
panelEl = renderPanel(STATE)
const dragHandle = findByTitle(panelEl, GEOM_TITLE_DRAG)
const fakeBox = { getBoundingClientRect: () => ({ left: 100, top: 60, width: 392, height: 500 }) }
const pressHeader = (target, x, y) => dragHandle.onMouseDown({
  currentTarget: { closest: (sel) => (sel === '.lm-panel' ? fakeBox : null) },
  target, clientX: x || 0, clientY: y || 0, preventDefault() {},
})
pressHeader({ tagName: 'BUTTON' })
check('按在按钮/下拉框上不算拖动窗口', (winListeners.mousemove || []).length === 0 && (winListeners.mouseup || []).length === 0)
pressHeader({ tagName: 'SPAN' }, 100, 60)
check('按住头部开始拖动（move/up 挂到 window 上）', (winListeners.mousemove || []).length === 1 && (winListeners.mouseup || []).length === 1)
winListeners.mousemove[0]({ clientX: 130, clientY: 80 })
check('拖动中几何跟着鼠标走（基准是 DOM 量出来的真实位置）',
  stateWrites.length === 1 && stateWrites[0].x === 130 && stateWrites[0].y === 80 && stateWrites[0].w === 392, stateWrites[0])
check('拖动中不落盘（mousemove 里写 localStorage 会卡）', fakeStore.size === 0, [...fakeStore.keys()])
winListeners.mouseup[0]()
check('松手才落盘：位置被记住', fakeStore.has('lm.panel.geom') && JSON.parse(fakeStore.get('lm.panel.geom')).x === 130, fakeStore.get('lm.panel.geom'))
check('松手卸掉 window 监听（不留全局副作用）', (winListeners.mousemove || []).length === 0 && (winListeners.mouseup || []).length === 0)

// 缩放：右下角同时改宽高
winListeners = {}
stateWrites.length = 0
propsByClass(panelEl, 'lm-rs-c').onMouseDown({ currentTarget: { closest: () => fakeBox }, clientX: 0, clientY: 0, preventDefault() {} })
winListeners.mousemove[0]({ clientX: 60, clientY: 40 })
check('右下角：同时改宽高', stateWrites[0].w === 452 && stateWrites[0].h === 540, stateWrites[0])
winListeners.mouseup[0]()
winListeners = {}
stateWrites.length = 0
propsByClass(panelEl, 'lm-rs-r').onMouseDown({ currentTarget: { closest: () => fakeBox }, clientX: 0, clientY: 0, preventDefault() {} })
winListeners.mousemove[0]({ clientX: 60, clientY: 40 })
check('右边缘：只改宽（高不动）', stateWrites[0].w === 452 && stateWrites[0].h === 500, stateWrites[0])
winListeners.mouseup[0]()
winListeners = {}
stateWrites.length = 0
propsByClass(panelEl, 'lm-rs-b').onMouseDown({ currentTarget: { closest: () => fakeBox }, clientX: 0, clientY: 0, preventDefault() {} })
winListeners.mousemove[0]({ clientX: 60, clientY: 40 })
check('下边缘：只改高（宽不动）', stateWrites[0].w === 392 && stateWrites[0].h === 540, stateWrites[0])
winListeners.mouseup[0]()

// 只点一下头部（没移动）不该把当前矩形固化成"用户设定"
fakeStore.clear()
winListeners = {}
panelEl = renderPanel(STATE)
findByTitle(panelEl, GEOM_TITLE_DRAG).onMouseDown({ currentTarget: { closest: () => fakeBox }, target: { tagName: 'SPAN' }, clientX: 0, clientY: 0, preventDefault() {} })
winListeners.mouseup[0]()
check('只是点了一下头部（没移动）不写盘（否则平白多出 ⟲）', fakeStore.size === 0, [...fakeStore.keys()])

// ⟲ 恢复默认
fakeStore.set('lm.panel.geom', JSON.stringify({ x: 5, y: 5, w: 300, h: 200 }))
stateWrites.length = 0
panelEl = renderPanel(STATE)
findByTitle(panelEl, GEOM_TITLE_RESET).onClick()
check('⟲ 恢复默认：清掉记录', fakeStore.size === 0, [...fakeStore.keys()])
check('⟲ 恢复默认：状态回到空几何（下次渲染即贴右自适应高）',
  stateWrites.length === 1 && Object.keys(stateWrites[0]).length === 0, stateWrites[0])
check('恢复默认后 ⟲ 自己消失（只在该出现的时候出现）',
  findByTitle(renderPanel(STATE), GEOM_TITLE_RESET) === null)

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES')
process.exit(failures === 0 ? 0 : 1)
