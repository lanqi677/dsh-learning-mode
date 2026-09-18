/**
 * 宿主半边的集成自检：模拟 cordis 上下文，跑通
 * agent/created → 绑定 → 工具调用 → 摘要管道 → 动态注入 → 面板 RPC。
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'lmhome-'))
process.env.DSH_HOME = home
const mod = await import('../lib/index.js')

let failures = 0
const check = (label, cond, extra) => {
  if (cond) console.log('  ok  ' + label)
  else { failures += 1; console.log('  FAIL ' + label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 300))) }
}

// ── 假会话（摘要原料）与假 llm（证明"插件自己调模型"这条路真的通） ────────
// 事件带 seq / data.turn：来源坐标（面板「↩ 原文」跳转的依据）就是**倒扫事件日志**算出来的，
// 所以假会话必须长得跟真的一样（SessionEvent：{type, seq, time, data}）。
// ⚠️ 假会话的事件时间必须是"现在之后"，不能写死。
// 摘要窗口的起点由 store.windowStart() 三级兜底给出（自己 lastEnteredAt → 最近进过的
// 祖先 → 节点 createdAt），三者都是**真实 Date.now()**；extractTranscript 会把
// `time < floor` 的事件整条丢掉。这里原来写死 Date.parse('2026-09-18T10:00:00Z')，
// 系统时钟一走过那一刻，全部假事件就落到窗口之前 → 门槛不过 → 不调模型 → 断言必挂
// （时间炸弹，2026-09-18T10:00:04Z 之后每次跑都失败）。
const t0 = Date.now() + 1000
const sessionEvents = [
  { type: 'turn/start', seq: 1, time: t0 + 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: t0 + 1000, data: { role: 'user', content: [{ type: 'text', text: '讲讲继承' }], source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 3, time: t0 + 2000, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '继承是 is-a 关系' }], source: { kind: 'model' } } } },
  { type: 'turn/end', seq: 4, time: t0 + 2500, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 5, time: t0 + 2600, data: { turn: 2 } },
  { type: 'user/message', seq: 6, time: t0 + 3000, data: { role: 'user', content: [{ type: 'text', text: '那组合呢' }], source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 7, time: t0 + 4000, data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '组合是 has-a，更松耦合' }], source: { kind: 'model' } } } },
]
const fakeSession = {
  id: 's1',
  requestContext: () => ({ provider: 'fake', model: 'fake-1' }),
  snapshotEvents: () => sessionEvents,
  // 来源坐标只走公开契约：session.seq（最后一个事件号）+ eventAt(seq)
  seq: 7,
  eventAt: (seq) => sessionEvents.find((e) => e.seq === seq),
}
const llmCalls = []
const fakeLlm = {
  async *stream(request) {
    llmCalls.push(request)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '继承是 is-a；组合是 has-a；易错：重载≠重写' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

const tools = []
const contexts = []
const sections = []
const listeners = new Map()
const routes = []
const restrictions = []
const sessionsMap = new Map([['s1', fakeSession]])
const services = {
  llm: fakeLlm,
  sessions: { get: (id) => sessionsMap.get(id) },
  agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) },
}
let currentAgent

const registeredCtx = {
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  on: (evt, fn) => { listeners.set(evt, fn); return () => {} },
  get: (name) => services[name],
  tools: {
    register: (t) => { tools.push(t) },
    // 全局工具清单（学习会话要在这里面挑出 dev_* 屏蔽掉）
    schemas: () => [{ name: 'dev_inject_plugin' }, { name: 'dev_plugin_status' }, { name: 'bash' }, { name: 'outline_show' }],
    restrict: (filter) => { restrictions.push(filter); return () => {} },
  },
  systemPrompt: {
    section: (s) => { sections.push(s); return () => {} },
    context: (c) => { contexts.push(c); return () => {} },
  },
  inject: (names, cb) => cb({
    effect: (fn) => fn(),
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    sessions: { get: (id) => sessionsMap.get(id) },
  }),
  // 这里**故意不提供** `agents` 属性：真实 Cordis 代理对没写进 inject 的服务会抛
  // `cannot get property "agents" without inject`（真机实测），老测试桩却直接塞了个
  // 普通属性，比真实运行时宽松 —— 于是"动态状态段每轮注入"在真机上静默失效好几轮，
  // 单测全绿。现在用 Proxy 复刻真实代理的严格性：未声明的属性一律抛。
}
const ctx = new Proxy(registeredCtx, {
  get: (target, prop, receiver) => {
    if (typeof prop === 'symbol' || prop.startsWith('_') || prop === 'then' || prop === 'prototype') {
      return Reflect.get(target, prop, receiver)
    }
    if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver)
    throw new Error('cannot get property "' + String(prop) + '" without inject')
  },
})

mod.apply(ctx)

check('注册了 9 个工具', tools.length === 9, tools.map((t) => t.name))
check('注册了规则段', sections.length === 1 && sections[0].name === 'learning-mode:rules')
check('注册了动态状态段', contexts.length === 1 && contexts[0].name === 'learning-mode:state')
check('注册了 agent/created 监听', listeners.has('agent/created'))
check('注册了面板 RPC 路由', routes.length === 1 && routes[0].path === '/api/learning-mode/rpc')

// 触发会话绑定
// agent 自带 ctx（真实 Agent 有 `readonly ctx`）——屏蔽 dev_* 要靠这个作用域
currentAgent = { session: fakeSession, ctx: { get: (name) => (name === 'tools' ? registeredCtx.tools : undefined) } }
listeners.get('agent/created')({ agent: currentAgent })
await new Promise((r) => setTimeout(r, 200))

// 学习会话屏蔽开发向工具（dev_*）：只按前缀挑，全局注册不受影响
check('agent/created 时按 agent 作用域屏蔽 dev_* 工具',
  restrictions.length === 1 && JSON.stringify(restrictions[0].deny) === '["dev_inject_plugin","dev_plugin_status"]',
  restrictions)

// ── 动态状态段：框架每轮都调 text(assemblyContext) 拿要注入的正文 ──────────
// 真机事故回归：老实现走 `ctx.agents.currentInitiator()`（未 inject）→ 真代理抛错 →
// 裸 catch 吞掉 → 面板聚焦永远送不到模型。这里按框架真实契约调用（只传 agent）。
const stateProvider = contexts.find((c) => c.name === 'learning-mode:state')
const stateText = stateProvider.text({ agent: { session: fakeSession }, scope: { session: fakeSession } })
check('动态状态段：用装配上下文里的 agent 能渲染出注入正文', typeof stateText === 'string' && stateText.length > 0, stateText.slice(0, 120))
check('动态状态段：注入正文带进度', stateText.includes('【进度】'), stateText.slice(0, 200))
check('动态状态段：没有 agent 时返回空串（不抛、也不注入噪声）', stateProvider.text({}) === '', stateProvider.text({}))

const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
const exec = { agent: { session: fakeSession } }
const call = async (name, args) => JSON.parse(await byName[name].execute(args, exec))

let out = await call('outline_projects', {})
check('首轮绑定到教程树', out.current !== null && out.current.treeId === 'tutorial', out.current)

let res = await byName.outline_add.execute({ items: ['Java'] }, exec)
check('outline_add 建根节点', res.includes('Java'), res)
res = await byName.outline_add.execute({ parent: 'Java', items: ['对象', '内存管理'] }, exec)
check('outline_add 建子节点', res.includes('对象'), res)
res = await byName.outline_add.execute({ parent: 'Java/对象', items: ['继承'] }, exec)
check('outline_add 建孙节点', res.includes('继承'), res)
res = await byName.outline_add.execute({ parent: 'Java', items: ['对象'] }, exec)
check('outline_add 幂等', JSON.parse(res).skipped.length === 1, res)

res = await byName.outline_show.execute({ include_done: false }, exec)
check('outline_show 含 Java', res.includes('Java/对象') || res.includes('对象'), res.split('\n')[0])

res = await byName.outline_focus.execute({ node: 'Java/对象' }, exec)
check('outline_focus 成功', JSON.parse(res).ok === true, res)
res = await byName.outline_focus.execute({ node: '不存在/的节点' }, exec)
check('outline_focus 对不存在的节点报错', JSON.parse(res).ok === false, res)

res = await byName.outline_done.execute({ node: 'Java/对象/继承', note: 'is-a 关系，注意与组合区分' }, exec)
check('outline_done 写摘要', JSON.parse(res).note.length > 0, res)

// 框架总是带着装配上下文调 text(context)；这里按真实契约传（不再裸调 text()）
const injected = contexts[0].text({ agent: { session: fakeSession } })
check('注入含焦点路径', injected.includes('Java/对象'), injected.split('\n').slice(0, 3))
check('注入含节点摘要', injected.includes('is-a 关系'), injected)
check('注入含进度', injected.includes('已完成'), injected)

// ── 无感整理：outline_capture 顺着当前焦点就地挂（用户给的真实场景） ──────
await byName.outline_focus.execute({ node: 'Java' }, exec)
res = await byName.outline_capture.execute({ title: '计算机地址' }, exec)
check('outline_capture 回执极简（不往上下文灌树）', res === 'captured: Java/计算机地址', res)
// 真机 bug 回归：整理不该夺走用户的位置（介绍父节点时顺带挂子节点，焦点被搬走，
// 下一轮注入就告诉模型"用户在看子节点"，它于是接着讲子节点）
check('outline_capture 默认不搬焦点（用户的位置不被整理动作带走）',
  (await rpc({ sessionId: 's1', op: 'state' })).body.focus === 'Java',
  (await rpc({ sessionId: 's1', op: 'state' })).body.focus)
res = await byName.outline_capture.execute({ title: '同一层顺带提到的概念' }, exec)
check('焦点没动 → 下一个知识点仍挂在同一层', res === 'captured: Java/同一层顺带提到的概念', res)
// 用户这一问的主题就是它 → 显式把视线移过去（工具侧 focus:true）
res = await byName.outline_capture.execute({ title: '计算机地址', focus: true }, exec)
check('capture 显式 focus=true 才搬焦点', (await rpc({ sessionId: 's1', op: 'state' })).body.focus === 'Java/计算机地址', res)
res = await byName.outline_capture.execute({ title: '内存寻址' }, exec)
check('连问连挂：下一问的知识点挂在当前焦点下', res === 'captured: Java/计算机地址/内存寻址', res)
res = await byName.outline_capture.execute({ title: 'Java' }, exec)
check('同名节点复用（回执是 exists:）', res === 'exists: Java', res)
res = await byName.outline_capture.execute({ title: '   ' }, exec)
check('空标题回执 error（不抛异常）', res.startsWith('error:'), res)

// ── 来源坐标：capture / done 时记下"这是第几轮对话"（面板 ↩ 跳转的唯一依据） ──
// 坐标是 (sid, turn, seq)：外壳按 turn 分行、更早的分页用 loadThrough(seq) 补页。
const originState = await rpc({ sessionId: 's1', op: 'state' })
const originJava = originState.body.tree.nodes.find((n) => n.title === 'Java')
const addrNode = originJava.children.find((n) => n.title === '计算机地址')
check('capture 记下来源对话（会话 id + 第几轮 + seq）',
  addrNode.origin !== null && addrNode.origin.sid === 's1' && addrNode.origin.turn === 2 && addrNode.origin.seq === 7,
  addrNode.origin)
check('来源是倒扫事件日志算出来的（取最近一个带 turn 的事件）', addrNode.origin.time === new Date(t0 + 4000).toISOString(), addrNode.origin.time)
check('outline_add 建的节点没有来源（面板于是不渲染 ↩）', originJava.children.find((n) => n.title === '对象').origin === null)
check('同名复用也会刷新来源（reused 不等于跳过）',
  originJava.children.find((n) => n.title === '同一层顺带提到的概念').origin !== null,
  originJava.children.find((n) => n.title === '同一层顺带提到的概念').origin)

// ── 摘要管道：不带 note 标完成 → 插件自己调 llm 写摘要 ────────────────────
// 上面的 capture 会把焦点搬走，从而顺带触发若干"离开旧节点"的摘要（这是设计行为），
// 先让它们落定，再用一个**全新的干净节点**验证 needsNote 分支。
await new Promise((r) => setTimeout(r, 200))
await byName.outline_focus.execute({ node: 'Java' }, exec)   // 回到这一层，样本节点挂在 Java 下
res = await byName.outline_capture.execute({ title: '自动摘要样本', focus: true }, exec)
const samplePath = 'Java/自动摘要样本'
const focusCheck = await rpc({ sessionId: 's1', op: 'state' })
check('capture(focus:true) 后焦点在样本节点上（下一问会挂在它下面）', focusCheck.body.focus === samplePath, focusCheck.body.focus)
const callsBefore = llmCalls.length
res = await byName.outline_done.execute({ node: samplePath }, exec)
check('outline_done 不带 note → needsNote', JSON.parse(res).needsNote === true, res)
await new Promise((r) => setTimeout(r, 150))
check('插件自己调了模型（不进聊天记录）', llmCalls.length === callsBefore + 1, llmCalls.length)
check('模型入参带知识点路径', llmCalls[llmCalls.length - 1].messages[0].content[0].text.includes('学习树里的位置：' + samplePath))
check('模型入参点名本次要总结的知识点', llmCalls[llmCalls.length - 1].messages[0].content[0].text.includes('本次要总结的知识点：自动摘要样本'))
check('模型入参带该节点的对话原料', llmCalls[llmCalls.length - 1].messages[0].content[0].text.includes('继承是 is-a 关系'))

let stateAfterNote = await rpc({ sessionId: 's1', op: 'state' })
const javaNode = stateAfterNote.body.tree.nodes.find((n) => n.title === 'Java')
const objNode = javaNode.children.find((n) => n.title === '自动摘要样本')
check('自动摘要落到节点上', objNode.note.includes('is-a；组合是 has-a'), objNode.note)
check('快照带 noteState=done', objNode.noteState === 'done', objNode.noteState)

res = await byName.outline_review.execute({}, exec)
check('outline_review 列出已完成 + 摘要', res.includes('Java/对象') && res.includes('is-a；组合是 has-a'), res.slice(0, 200))
res = await byName.outline_review.execute({ missing_note_only: true }, exec)
check('outline_review 可只列缺摘要的', !res.includes('Java/对象') || res.includes('(无摘要)'), res.slice(0, 200))

// 焦点切换 **不再** 触发摘要（用户确认：只有点 ✓ 才总结）
await byName.outline_focus.execute({ node: 'Java/对象/继承' }, exec)
res = await byName.outline_done.execute({ node: 'Java/对象/继承', undo: true }, exec)
check('outline_done undo 取消完成', JSON.parse(res).status === 'todo', res)
await new Promise((r) => setTimeout(r, 120))
const beforeSwitch = llmCalls.length
await byName.outline_focus.execute({ node: 'Java/对象' }, exec)
await new Promise((r) => setTimeout(r, 180))
check('切走焦点不再生成摘要（blur 已删）', llmCalls.length === beforeSwitch, { beforeSwitch, after: llmCalls.length })
const beforeCapture = llmCalls.length
await byName.outline_capture.execute({ title: '不该触发摘要的节点', focus: true }, exec)
await new Promise((r) => setTimeout(r, 180))
check('capture 搬焦点也不再生成摘要', llmCalls.length === beforeCapture, { beforeCapture, after: llmCalls.length })

// ✓ 完成后自动回到上一层（这就是用户要的"返回原来的地方"）
let focusNow = (await rpc({ sessionId: 's1', op: 'state' })).body.focus
check('前置：焦点在刚 capture 的子节点上', focusNow === 'Java/对象/不该触发摘要的节点', focusNow)
await rpc({ sessionId: 's1', op: 'done', path: 'Java/对象/不该触发摘要的节点', done: true })
focusNow = (await rpc({ sessionId: 's1', op: 'state' })).body.focus
check('点子节点 ✓ 后焦点自动上移到父节点', focusNow === 'Java/对象', focusNow)

// 顶层节点被完成 → 焦点不动；撤销完成 → 焦点也不动
await byName.outline_focus.execute({ node: 'Java' }, exec)
await rpc({ sessionId: 's1', op: 'done', path: 'Java', done: true })
focusNow = (await rpc({ sessionId: 's1', op: 'state' })).body.focus
check('顶层节点完成 → 焦点不动（没有父可回）', focusNow === 'Java', focusNow)
await rpc({ sessionId: 's1', op: 'done', path: 'Java', done: false })
focusNow = (await rpc({ sessionId: 's1', op: 'state' })).body.focus
check('撤销完成 → 焦点不动（不会又跳下去）', focusNow === 'Java', focusNow)

// 非当前焦点节点被完成 → 只完成，不搬焦点
await byName.outline_focus.execute({ node: 'Java/对象' }, exec)
await rpc({ sessionId: 's1', op: 'done', path: 'Java/内存管理', done: true })
focusNow = (await rpc({ sessionId: 's1', op: 'state' })).body.focus
check('非焦点节点完成 → 焦点不动', focusNow === 'Java/对象', focusNow)
const doneOriginState = await rpc({ sessionId: 's1', op: 'state' })
const memOrigin = doneOriginState.body.tree.nodes.find((n) => n.title === 'Java').children.find((n) => n.title === '内存管理')
check('标完成时也记来源（用户此刻正在讨论它）', memOrigin.origin !== null && memOrigin.origin.turn === 2, memOrigin.origin)

// ── 每轮结束把"当前聚焦的节点"记成本轮的来源 ──────────────────────────────
// 用户定的语义：对话1 建了 a/b/c/d（都指对话1）；对话2 聚焦了 a → a 改指对话2。
// 挂在 agent/turn-stopping（而不是"聚焦那一刻"）：面板点选发生在提问**之前**，
// 那一刻日志里最后一个 turn 还是上一轮，照它记会指到错的一轮。
check('注册了 agent/turn-stopping 监听', listeners.has('agent/turn-stopping'))
const nodeOfJava = (state, title) => state.body.tree.nodes.find((n) => n.title === 'Java').children.find((n) => n.title === title)
const focusTitle = (await rpc({ sessionId: 's1', op: 'state' })).body.focus
check('前置：焦点在 Java/对象 上', focusTitle === 'Java/对象', focusTitle)
const focusedBefore = nodeOfJava(await rpc({ sessionId: 's1', op: 'state' }), '对象')
check('前置：焦点节点此刻还没有来源（只被 outline_add 建过）', focusedBefore.origin === null, focusedBefore.origin)
listeners.get('agent/turn-stopping')({ agent: currentAgent, turn: 9, signal: {} })
await new Promise((r2) => setTimeout(r2, 80))
const focusedAfter = nodeOfJava(await rpc({ sessionId: 's1', op: 'state' }), '对象')
check('每轮结束：聚焦节点被记上这一轮（第 9 轮）',
  focusedAfter.origin !== null && focusedAfter.origin.turn === 9 && focusedAfter.origin.sid === 's1', focusedAfter.origin)
check('记的来源是 why=turn（区别于 capture/done）', focusedAfter.origin.why === 'turn', focusedAfter.origin)
check('seq 取会话当前最后一个事件号（本轮之内）', focusedAfter.origin.seq === 7, focusedAfter.origin)
check('没被聚焦的节点不受影响（还是它自己的 done 来源）',
  nodeOfJava(await rpc({ sessionId: 's1', op: 'state' }), '内存管理').origin.why === 'done')
await rpc({ sessionId: 's1', op: 'create', title: '焦点空测试树' })
check('前置：切到新树后焦点被清空', (await rpc({ sessionId: 's1', op: 'state' })).body.focus === '')
listeners.get('agent/turn-stopping')({ agent: currentAgent, turn: 11, signal: {} })
await new Promise((r2) => setTimeout(r2, 80))
await rpc({ sessionId: 's1', op: 'open', treeId: 'tutorial' })
check('焦点为空（在根上）时不写来源：第 11 轮没落到任何节点上',
  nodeOfJava(await rpc({ sessionId: 's1', op: 'state' }), '对象').origin.turn === 9,
  nodeOfJava(await rpc({ sessionId: 's1', op: 'state' }), '对象').origin)
await rpc({ sessionId: 's1', op: 'focus', path: 'Java/对象' })

// ── 含斜杠标题：面板用 id 聚焦，工具用路径寻址（真机 bug 回归） ──────────
await byName.outline_add.execute({ parent: 'Java', items: ['插入/删除'] }, exec)
let st = await rpc({ sessionId: 's1', op: 'state' })
const javaN = st.body.tree.nodes.find((n) => n.title === 'Java')
const slashNode = javaN.children.find((n) => n.title === '插入/删除')
check('树里存在含斜杠标题的节点', slashNode !== undefined && typeof slashNode.id === 'string', slashNode)
let rp = await rpc({ sessionId: 's1', op: 'focus', id: slashNode.id })
check('RPC 用 id 聚焦含斜杠标题的节点', rp.body.ok === true && rp.body.focus === 'Java/插入/删除', rp.body)
const injectedSlash = contexts[0].text({ agent: { session: fakeSession } })
check('注入块认得含斜杠的焦点（bug 前当前节点摘要整段丢失）', injectedSlash.includes('Java/插入/删除'), injectedSlash.split('\n').slice(0, 2))
check('注入块带"没指明对象＝当前聚焦"的行动提示', injectedSlash.includes('用户没指明对象'), injectedSlash)
res = await byName.outline_done.execute({ node: 'Java/插入/删除' }, exec)
check('工具用路径也能寻到含斜杠节点', JSON.parse(res).path === 'Java/插入/删除', res)
rp = await rpc({ sessionId: 's1', op: 'focus', id: 'n-not-exist' })
check('RPC 聚焦不存在的 id → 明确报错（不是静默）', rp.body.ok === false, rp.body)

// 面板 RPC
async function rpc(body) {
  const handler = routes[0].handler
  const req = new EventEmitter()
  let payload = ''
  const res = { statusCode: 0, setHeader() {}, end(text) { payload = text } }
  const done = handler(req, res)
  req.emit('data', Buffer.from(JSON.stringify(body)))
  req.emit('end')
  await done
  return { status: res.statusCode, body: JSON.parse(payload) }
}

let r = await rpc({ sessionId: 's1', op: 'state' })
check('RPC state: enabled', r.body.enabled === true, r.body.enabled)
check('RPC state: 带树与使用说明', r.body.tree !== null && typeof r.body.usage === 'string')

r = await rpc({ sessionId: 'unknown', op: 'state' })
check('RPC 未知会话 -> 404', r.status === 404, r)

r = await rpc({ sessionId: 's1', op: 'done', path: 'Java/内存管理', done: true })
check('RPC done', r.body.ok === true, r.body)

r = await rpc({ sessionId: 's1', op: 'review' })
check('RPC review 返回已完成清单', r.body.ok === true && Array.isArray(r.body.items) && r.body.items.length >= 2, r.body.items && r.body.items.length)
check('RPC review 带统计', r.body.stats.done >= 2, r.body.stats)

r = await rpc({ sessionId: 's1', op: 'note', path: 'Java/内存管理' })
check('RPC note 强制重写（force）', r.body.ok === true, r.body)
await new Promise((r2) => setTimeout(r2, 150))
check('RPC note = 完全重写（fresh：不带旧摘要，错的摘要才有救）',
  llmCalls[llmCalls.length - 1].messages[0].content[0].text.includes('已有摘要：（无）'),
  llmCalls[llmCalls.length - 1].messages[0].content[0].text.slice(0, 160))
check('RPC note 用的是该节点自己的窗口提示（点名知识点）',
  llmCalls[llmCalls.length - 1].messages[0].content[0].text.includes('本次要总结的知识点：内存管理'),
  llmCalls[llmCalls.length - 1].messages[0].content[0].text.slice(0, 160))
r = await rpc({ sessionId: 's1', op: 'review' })
const memItem = r.body.items.find((item) => item.path === 'Java/内存管理')
check('重写后的摘要出现在复习视图里', memItem !== undefined && memItem.note.includes('has-a'), memItem)

r = await rpc({ sessionId: 's1', op: 'state' })
check('state 带 seenAt（面板红点/NEW 的水位线）', typeof r.body.seenAt === 'string' && r.body.tree.nodes.length > 0, r.body.seenAt)
r = await rpc({ sessionId: 's1', op: 'seen' })
check('RPC seen 推进水位线', r.body.ok === true && typeof r.body.seenAt === 'string', r.body)
check('RPC seen 之后 state 里的水位线跟着变', (await rpc({ sessionId: 's1', op: 'state' })).body.seenAt === r.body.seenAt)

r = await rpc({ sessionId: 's1', op: 'focus', path: 'Java' })
check('RPC focus', r.body.ok === true, r.body)

// 浏览器半边的诊断通道（前端 DOM/服务形态落盘，console 不落盘）
r = await rpc({ sessionId: 's1', op: 'diag', line: '单测写入的判据' })
check('RPC diag 接受前端上报并落 rpc.log', r.body.ok === true, r.body)
check('RPC diag 的内容进了 rpc.log', readFileSync(join(home, 'learning-mode', 'rpc.log'), 'utf8').includes('diag: 单测写入的判据'))

r = await rpc({ sessionId: 's1', op: 'create', title: '算法' })
check('RPC create + 绑定', r.body.ok === true, r.body)
const after = await rpc({ sessionId: 's1', op: 'state' })
check('切到新树后为空树', after.body.tree !== null && after.body.tree.nodes.length === 0, after.body.tree)
check('切树后焦点被清空（不会串树）', after.body.focus === '', after.body.focus)
r = await rpc({ sessionId: 's1', op: 'review' })
check('新树没有已完成节点', r.body.ok === true && r.body.items.length === 0, r.body)

// ── 会话对象拿不到 eventAt 时：来源记不上，但**必须留痕**（不许静默）──────
// 这条防的正是本插件栽过两次的那个坑：功能在真机上静默失效、单测却全绿。
const noEvtSession = { id: 's-noevt', requestContext: () => ({ provider: 'fake', model: 'fake-1' }), snapshotEvents: () => [] }
sessionsMap.set('s-noevt', noEvtSession)
listeners.get('agent/created')({ agent: { session: noEvtSession, ctx: { get: (name) => (name === 'tools' ? registeredCtx.tools : undefined) } } })
await new Promise((r2) => setTimeout(r2, 50))
await rpc({ sessionId: 's-noevt', op: 'create', title: '无事件日志测试树' })
res = await byName.outline_capture.execute({ title: '没有事件日志的会话' }, { agent: { session: noEvtSession } })
check('没有 eventAt 的会话：capture 照样成功（来源只是附加信息）', res.startsWith('captured:'), res)
const rpcLog = readFileSync(join(home, 'learning-mode', 'rpc.log'), 'utf8')
check('没有 eventAt 的会话：写 rpc.log 的 origin diag（不静默）', rpcLog.includes('origin diag:'), rpcLog.slice(-300))

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES')
process.exit(failures === 0 ? 0 : 1)
