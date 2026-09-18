/**
 * 宿主侧的**英文行为**测试：语言切成 en 之后，真正生成出来的文案是不是英文。
 *
 * `test/i18n.mjs` 只做静态检查（key 齐不齐 / 值是不是英文 / 占位符对齐）；
 * 这个文件做**行为**检查：真跑一遍 store，把「每轮注入块」——也就是每轮发给模型的
 * 那段"我在哪 + 这一层摘要 + 还没学完"——渲染出来，断言里面不含中文。
 * 字典齐全 ≠ 取值链正确（比如 zh 表没做恒等映射、或某处忘了 t()），只有真渲染才发现。
 *
 * ⚠️ 必须独立成文件：`lib/i18n.js` 的当前语言是**模块级单例**，
 * 一旦 setLocale('en')，同进程里其它断言中文的测试就全挂了。
 * 所以英文路径要在自己的进程里跑。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setLocale, getLocale, t } from '../lib/i18n.js'
import { LearningStore } from '../lib/store.js'

let failures = 0
const check = (label, cond, extra) => {
  if (cond) console.log('  ok  ' + label)
  else { failures += 1; console.log('  FAIL ' + label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 300))) }
}

/** CJK 统一表意文字 + 中日韩标点（守卫口径与 test/i18n.mjs 一致）。 */
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/

// 语言在 import 之后设也没问题：store 的文案全是**调用时**取 t()，
// 教程树种子也在 buildTutorialTree() 里才求值（见 store.js 的 TUTORIAL_TITLE 注释）。
setLocale('en')
check('setLocale 生效', getLocale() === 'en')

const root = mkdtempSync(join(tmpdir(), 'lm-i18n-en-'))
const store = new LearningStore(root)
await store.init()

// 教程树是 init() 现场播种的 → 它必须按**当前语言**播种（这正是 TUTORIAL_TITLE 不能
// 在模块加载期求值的原因）。
const trees = store.listTrees()
check('英文：播种出来的教程树标题不含中文',
  trees.length > 0 && trees.every((x) => !CJK.test(x.title)), trees.map((x) => x.title))

await store.markEnabled('s1')
await store.autoBind('s1')

// 每轮注入块：本插件最重要的模型侧表面
const block = store.contextText('s1')
check('英文：每轮注入块渲染出来了', block !== '', block)
check('英文：注入块不含中文（用户数据也没用中文，所以"含中文"只可能是漏翻）',
  !CJK.test(block), block.slice(0, 500))
check('英文：注入块表头是英文', block.includes('Learning tree:'), block.slice(0, 200))

// 工具回执 / 错误文案（这些也会进模型上下文）
const noFocus = await store.setFocusById('s1', 'definitely/missing/node')
check('英文：找不到节点的错误是英文', typeof noFocus.error === 'string' && !CJK.test(noFocus.error), noFocus)

// 未绑定会话的错误（"尚未绑定学习树"这条路）
const unbound = await store.setFocusById('s-never-bound', 'whatever')
check('英文：未绑定会话的错误是英文', typeof unbound.error === 'string' && !CJK.test(unbound.error), unbound)

// 教程树的**节点标题**也要跟着语言走（这是新用户看到的第一屏内容）
const tutorial = store.readTree('tutorial')
const titles = []
const walk = (nodes) => {
  for (const node of nodes || []) { titles.push(node.title); walk(node.children) }
}
walk(tutorial === null ? [] : tutorial.nodes)
check('英文：教程树节点标题不含中文（入门内容已本地化）',
  titles.length > 0 && titles.every((x) => !CJK.test(x)), titles.slice(0, 6))

// 复习视图的数据面：标题是用户数据（可以是中文），这里只确认接口没被 i18n 改坏
const review = store.review('s1')
check('英文：复习视图仍可读（i18n 没改坏数据层）',
  review !== null && typeof review === 'object' && Array.isArray(review.items), review === null ? 'null' : typeof review)

// `scripts/verify-live.mjs` 靠这几个**标记**在真机会话日志里核查"每轮注入到底生效没有"。
// 英文模式下它认的是英文标记 —— 所以译文改动不能把这些标记弄丢，
// 否则真机核查会在英文环境下变成假阴性。这里把它钉住（大小写不敏感，容忍译文大小写差异）。
const hasMark = (text, mark) => String(text).toLowerCase().includes(mark.toLowerCase())
if (tutorial !== null && Array.isArray(tutorial.nodes) && tutorial.nodes.length > 0) {
  await store.setFocusById('s1', tutorial.nodes[0].id)
  const focusBlock = store.contextText('s1')
  check('英文：注入块带 "▶ 当前聚焦" 的英文标记（verify-live 的判据）',
    hasMark(focusBlock, '▶ current focus'), focusBlock.slice(0, 200))
  check('英文：注入块带 "[Progress]" 标记（verify-live 的判据）',
    hasMark(focusBlock, '[progress]'), focusBlock.slice(0, 300))
  check('英文：注入块带 "Learning tree:" 表头（verify-live 的判据）',
    hasMark(focusBlock, 'learning tree:'), focusBlock.slice(0, 200))
} else {
  check('英文：教程树可读（verify-live 标记检查的前置条件）', false, 'tutorial 为 null 或没有节点')
}

// 一条最典型的手工抽查：插值 + 英文值
check('英文：插值渲染正确（不留 {占位符}）',
  t('找不到节点：{path}', { path: 'Java/Object' }).includes('Java/Object')
    && !t('找不到节点：{path}', { path: 'Java/Object' }).includes('{path}'),
  t('找不到节点：{path}', { path: 'Java/Object' }))

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES')
process.exit(failures === 0 ? 0 : 1)
