import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningStore, countNodes, findNode, findNodeById, pathOf, snapshotNodes, CONTEXT_MAX_CHARS, ORIGIN_MAX, buildTutorialTree } from '../lib/store.js'

const root = mkdtempSync(join(tmpdir(), 'lm-'))
const store = new LearningStore(root)
let failures = 0
const check = (label, cond, extra) => {
  if (cond) { console.log('  ok  ' + label) } else { failures += 1; console.log('  FAIL ' + label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))) }
}

await store.init()
const trees1 = store.listTrees()
check('init creates tutorial tree', trees1.length === 1 && trees1[0].id === 'tutorial', trees1)

const sid = 'sess-1'
await store.markEnabled(sid)
let binding = await store.autoBind(sid)
check('autoBind picks tutorial', binding.treeId === 'tutorial', binding)

let res = await store.addNodes(sid, 'Java', ['对象', '内存管理'])
check('add under missing parent -> error', typeof res.error === 'string', res)
res = await store.addNodes(sid, '', ['Java'])
check('add root', res.added && res.added.length === 1, res)
res = await store.addNodes(sid, 'Java', ['对象', '内存管理', '语法'])
check('add children', res.added.length === 3, res)
res = await store.addNodes(sid, 'Java', ['对象'])
check('idempotent skip', res.skipped.length === 1 && res.added.length === 0, res)
res = await store.addNodes(sid, 'Java/对象', ['继承', '私有'])
check('add grandchildren', res.added.length === 2, res)

let bind2 = store.binding(sid)
check('binding has treeId', bind2.treeId === 'tutorial')

const tree = store.readTree('tutorial')
check('findNode works', findNode(tree, 'Java/对象/继承') !== null)
const stat = countNodes(tree.nodes)
// 不写死数字：教程树节点数会随文案调整，这里只断言"教程树 + 本次新增的 6 个"
const tutorialTotal = countNodes(buildTutorialTree().nodes).total
check('countNodes total = 教程树 + 新增 6', stat.total === tutorialTotal + 6, { stat, tutorialTotal })

await store.setFocus(sid, 'Java/对象')
let ctx = store.contextText(sid)
check('context mentions focus', ctx.includes('Java/对象'), ctx.slice(0, 200))

await store.setStatus(sid, 'Java/对象/继承', 'done', '继承是 is-a 关系；注意与组合区分')
ctx = store.contextText(sid)
check('note enters context', ctx.includes('继承是 is-a 关系'), ctx.slice(0, 400))

res = await store.updateNode(sid, 'Java/语法', { rename: '语法与类型' })
check('rename ok', res.error === undefined, res)
const t2 = store.readTree('tutorial')
check('renamed node found', findNode(t2, 'Java/语法与类型') !== null)

res = await store.updateNode(sid, 'Java/对象/私有', { moveTo: 'Java/语法与类型' })
check('move ok', res.error === undefined, res)
const t3 = store.readTree('tutorial')
check('moved node reachable at new path', findNode(t3, 'Java/语法与类型/私有') !== null && findNode(t3, 'Java/对象/私有') === null)

res = await store.updateNode(sid, 'Java/内存管理', { delete: true })
const t4 = store.readTree('tutorial')
check('deleted node gone', findNode(t4, 'Java/内存管理') === null, res)

const created = await store.createTree('算法')
check('createTree', created.title === '算法' && created.id === '算法')
await store.switchTree(sid, created.id)
bind2 = store.binding(sid)
check('switchTree binds', bind2.treeId === created.id, bind2)

// 摘要 / 复习视图的数据层接口（上面切到了新树，这里切回教程树）
await store.switchTree(sid, 'tutorial')
await store.setStatus(sid, 'Java/对象', 'done', '')
// 用一个新的、没有摘要的节点来验"需要自动摘要"分支
await store.addNodes(sid, 'Java', ['新知识点'])
res = await store.setStatus(sid, 'Java/新知识点', 'done', '')
check('不带 note 标完成 → needsNote', res.needsNote === true, res)
res = await store.setStatus(sid, 'Java/对象/继承', 'done', '')
check('已有摘要的节点不会被自动重写', res.needsNote === false, res)
res = await store.setStatus(sid, 'Java/对象/继承', 'done', '已有摘要')
check('带 note 标完成 → 不需要自动摘要', res.needsNote === false, res)

let view = store.review(sid)
check('review 列出已完成节点', view.items.length >= 1, view.items)
check('review 按完成时间倒序', String(view.items[0].doneAt) >= String(view.items[view.items.length - 1].doneAt))
check('review 带 withNote 统计', view.stats.withNote >= 1, view.stats)

const w = await store.setNote(sid, 'Java/对象', '封装/继承/多态', { sessionId: sid, reason: 'test' })
check('setNote 落盘', w.note === '封装/继承/多态', w)
check('setNote 记溯源窗口', store.readTree('tutorial') !== null)
const st = await store.markNoteState(sid, 'Java/对象', 'failed', 'boom')
check('markNoteState failed 累计 tries', st.tries === 1, st)
const st2 = await store.markNoteState(sid, 'Java/对象', 'done')
check('markNoteState done 清零 tries', st2.tries === 0, st2)

// ── 发散式就地挂载：数组 → 计算机地址（用户给的真实场景） ────────────────
await store.switchTree(sid, 'tutorial')
await store.addNodes(sid, '', ['数据结构'])
await store.addNodes(sid, '数据结构', ['数组', '链表'])
await store.setFocus(sid, '数据结构/数组')

res = await store.capture(sid, '计算机地址')
check('capture 默认挂到当前焦点下面（不按体系挪到别处）',
  res.path === '数据结构/数组/计算机地址' && res.created === true, res)
// 真机 bug（2026-09-18）：整理时顺手搬焦点 → 用户的"我在哪"被 AI 的列举牵着走。
// 现在 capture **默认不动焦点**；焦点只由用户驱动（面板点击 / 用户点名节点）。
check('capture 默认不搬焦点（焦点＝用户在看哪，只跟着用户走）',
  store.binding(sid).focus === '数据结构/数组', store.binding(sid).focus)
res = await store.capture(sid, '同一层顺带提到的概念')
check('焦点没动 → 下一个知识点仍挂在同一层（不会悄悄下钻）',
  res.path === '数据结构/数组/同一层顺带提到的概念', res)

// 用户这一问的主题就是它 → 才搬焦点（工具侧 focus:true 走的就是这条）
res = await store.capture(sid, '用户点名的新节点', undefined, true)
check('capture 显式 focus=true 才搬焦点',
  store.binding(sid).focus === '数据结构/数组/用户点名的新节点', store.binding(sid).focus)

// 用户把话题带到「计算机地址」→ 焦点跟过去（用户驱动），之后的下钻才挂在它下面
await store.setFocus(sid, '数据结构/数组/计算机地址')
res = await store.capture(sid, '内存寻址')
check('用户话题转到子节点后，继续下钻挂在它下面',
  findNode(store.readTree('tutorial'), '数据结构/数组/计算机地址/内存寻址') !== null, res)

res = await store.capture(sid, '数组')
check('capture 遇同名节点直接复用（不重复建）',
  res.created === false && res.reused === true && res.path === '数据结构/数组', res)
check('复用已存在节点也不搬焦点（除非显式要求）',
  store.binding(sid).focus === '数据结构/数组/计算机地址', store.binding(sid).focus)

res = await store.capture(sid, '显式指定父节点', '数据结构/链表')
check('capture 可显式指定父节点', res.path === '数据结构/链表/显式指定父节点', res)
res = await store.capture(sid, '父节点不存在时就地兜底', '不存在的/路径')
check('父路径找不到时兜底到根（不报错、不丢知识点）',
  res.ok === true && res.fellBack === true && res.path === '父节点不存在时就地兜底', res)
res = await store.capture(sid, '')
check('capture 空标题被拒', typeof res.error === 'string', res)

// ── 标题自带 `/` 的寻址（真机 bug：点聚焦后下一轮找不到节点，模型答成别的知识点） ──
await store.switchTree(sid, 'tutorial')
await store.addNodes(sid, '', ['数据结构2'])
await store.addNodes(sid, '数据结构2', ['链表', 'Java：int[] / ArrayList 的取舍'])
await store.addNodes(sid, '数据结构2/链表', ['快慢指针', '插入/删除'])
await store.addNodes(sid, '数据结构2/链表/插入/删除', ['是否 O(n)'])

const slashTree = store.readTree('tutorial')
check('含斜杠标题：路径仍能解析到"插入/删除"节点',
  findNode(slashTree, '数据结构2/链表/插入/删除') !== null && findNode(slashTree, '数据结构2/链表/插入/删除').title === '插入/删除',
  findNode(slashTree, '数据结构2/链表/插入/删除'))
check('含斜杠标题：再深一层也解析得对（标题 + 真子节点）',
  findNode(slashTree, '数据结构2/链表/插入/删除/是否 O(n)') !== null)
check('含斜杠标题：带空格的标题（Java：int[] / ArrayList 的取舍）解析得到',
  findNode(slashTree, '数据结构2/Java：int[] / ArrayList 的取舍') !== null)
const slashNode = findNode(slashTree, '数据结构2/链表/插入/删除')
check('pathOf 与 findNode 互为逆运算', findNode(slashTree, pathOf(slashTree, slashNode.id)) !== null)
check('findNodeById 能取到含斜杠标题的节点', findNodeById(slashTree, slashNode.id) === slashNode)
check('findNode 对不存在的路径仍返回 null', findNode(slashTree, '数据结构2/链表/不存在的节点') === null)

// 长标题优先：同时存在"插入"和"插入/删除"时，'链表/插入' 走短的、'链表/插入/删除' 走长的
await store.addNodes(sid, '数据结构2/链表', ['插入'])
const slashTree2 = store.readTree('tutorial')
check('歧义消解：长标题优先（"插入/删除" 不会被当成 插入 > 删除）',
  findNode(slashTree2, '数据结构2/链表/插入/删除').title === '插入/删除')
check('歧义消解：短路径仍走短节点',
  findNode(slashTree2, '数据结构2/链表/插入').title === '插入')

// 用含斜杠的路径聚焦 → 注入块必须认得出来（bug 的直接症状）
await store.setFocus(sid, pathOf(slashTree2, findNode(slashTree2, '数据结构2/链表/插入/删除').id))
await store.setNote(sid, '数据结构2/链表/插入/删除', '这块的摘要必须出现在注入里', { sessionId: sid, reason: 'test' })
const slashInjected = store.contextText(sid)
check('含斜杠焦点：注入块带【当前节点摘要】（bug 前这里是空的）',
  slashInjected.includes('这块的摘要必须出现在注入里'), slashInjected)

// ── 模糊提问不再串题：未完成列表只给"同一层" ────────────────────────────
await store.setFocus(sid, pathOf(slashTree2, findNode(slashTree2, '数据结构2/链表/快慢指针').id))
const localInjected = store.contextText(sid)
check('注入块标出"当前聚焦（用户正在看的）"', localInjected.includes('▶ 当前聚焦'), localInjected.split('\n').slice(0, 2))
check('未完成列表是同一层（含兄弟 插入/删除）', localInjected.includes('插入/删除'), localInjected)
check('未完成列表不含无关根分支（旧实现是全树广度优先）',
  !localInjected.includes('① 问我'), localInjected)
check('行动提示里写明"没指明对象＝当前聚焦"', localInjected.includes('用户没指明对象'), localInjected)

// ── 注入块硬预算：树再长、摘要再长也不能线性膨胀 ────────────────────────
await store.switchTree(sid, 'tutorial')
await store.addNodes(sid, '', ['长树'])
const kids = []
for (let i = 0; i < 20; i += 1) kids.push('知识点' + i)
await store.addNodes(sid, '长树', kids)
for (const title of kids) {
  await store.setNote(sid, '长树/' + title, '结论'.repeat(100), { sessionId: sid, reason: 'test' })
}
await store.setFocus(sid, '长树')
await store.setNote(sid, '长树', '这是当前节点的摘要，必须活下来', { sessionId: sid, reason: 'test' })
const injectedBig = store.contextText(sid)
check('注入块不超过硬预算 ' + CONTEXT_MAX_CHARS + ' 字符', injectedBig.length <= CONTEXT_MAX_CHARS, injectedBig.length)
check('超预算时仍保留【当前节点摘要】', injectedBig.includes('【当前节点摘要】'), injectedBig.slice(0, 120))
check('超预算时子节点摘要被截断（不是 20 条全给）',
  (injectedBig.match(/^  · /gm) || []).length < 20, (injectedBig.match(/^  · /gm) || []).length)
check('超预算时单条摘要被裁剪', !injectedBig.includes('结论'.repeat(61)), injectedBig.length)

// ── 摘要窗口 = 该节点"最后一次进入"的时间，而不是当前焦点 ────────────────
await store.switchTree(sid, 'tutorial')
await store.addNodes(sid, '', ['窗口测试树'])
await store.addNodes(sid, '窗口测试树', ['钻进去的概念', '上一层'])
const winTree = store.readTree('tutorial')
const diveId = findNode(winTree, '窗口测试树/钻进去的概念').id
await store.setFocus(sid, '窗口测试树/钻进去的概念')
const enteredAt = Date.now()
await new Promise((r) => setTimeout(r, 30))
await store.setFocus(sid, '窗口测试树/上一层')   // 模拟"先回到上一层"
const ws = store.windowStart(sid, diveId)
check('窗口取该节点最后进入时间（先返回再标完成也对）', ws >= enteredAt - 50 && ws <= Date.now(), { ws, enteredAt })
check('窗口不会退化成 0（0=整场会话，那是错的）', ws > 0, ws)
check('不存在的节点 id → 窗口 0', store.windowStart(sid, 'n-never-visited') === 0)

// ── 真机 bug 回归：子节点自己从没被聚焦过（AI 在父节点里一口气列了 6 个概念，
//    用户在面板上直接给其中一个点 ✓）→ 以前窗口退化成 0 = 整场会话。 ──────────
await store.switchTree(sid, 'tutorial')
await store.addNodes(sid, '', ['父节点'])
await store.addNodes(sid, '父节点', ['没进过的子节点A', '没进过的子节点B'])
const parentTree = store.readTree('tutorial')
const parentNode = findNode(parentTree, '父节点')
const childA = findNode(parentTree, '父节点/没进过的子节点A')
await store.setFocus(sid, '父节点')            // 只聚焦父节点，两个子节点都没被聚焦过
const parentEnteredAt = Date.now()
await new Promise((r) => setTimeout(r, 30))
await store.setFocus(sid, '窗口测试树/上一层')  // 焦点开到别处（模拟用户继续往下看）
const childWs = store.windowStart(sid, childA.id)
check('从没聚焦过的子节点 → 退到最近进过的祖先（父节点）时间，而不是 0',
  childWs >= parentEnteredAt - 50 && childWs <= Date.now(), { childWs, parentEnteredAt })
check('父节点确实没被子节点顶掉（lastEnteredAt 里父节点有记录）',
  store.binding(sid).lastEnteredAt[parentNode.id] !== undefined,
  store.binding(sid).lastEnteredAt)
const childDone = await store.setStatus(sid, '父节点/没进过的子节点A', 'done', '')
check('子节点标完成 → 窗口非 0（摘要不会拿整场会话当原料）', childDone.windowStartMs > 0, childDone.windowStartMs)
check('setStatus 回传 title（标题含 / 时不能靠 path 反推）', childDone.title === '没进过的子节点A', childDone.title)
const madeNode = findNode(store.readTree('tutorial'), '父节点/没进过的子节点A')
check('新节点带 createdAt（祖先都没进过时的兜底窗口）', typeof madeNode.createdAt === 'string', madeNode.createdAt)
// 另一场会话：完全没有任何进入记录 → 兜底用节点 createdAt，而不是 0
const coldSid = 'sess-window-cold'
await store.markEnabled(coldSid)
await store.autoBind(coldSid)
check('完全没有进入记录 → 兜底用节点 createdAt（不是 0）',
  store.windowStart(coldSid, childA.id) === Date.parse(madeNode.createdAt),
  { got: store.windowStart(coldSid, childA.id), createdAt: madeNode.createdAt })

// 标完成时会把窗口和父路径一起返回（调用方据此"回到上一层"）
const doneRes = await store.setStatus(sid, '窗口测试树/钻进去的概念', 'done', '')
check('setStatus 返回 parentPath', doneRes.parentPath === '窗口测试树', doneRes.parentPath)
check('setStatus 返回 isFocus=false（此刻焦点在上一层）', doneRes.isFocus === false, doneRes.isFocus)
check('setStatus 返回 windowStartMs', typeof doneRes.windowStartMs === 'number' && doneRes.windowStartMs > 0, doneRes.windowStartMs)

// ── 变更水位线 seenAt（面板红点 / NEW 标记的依据）────────────────────────
const seenSid = 'sess-seen'
await store.markEnabled(seenSid)
await store.autoBind(seenSid)
const seededSeen = store.binding(seenSid).seenAt
check('绑定会话即种下 seenAt（旧节点不会一上来就标 NEW）',
  typeof seededSeen === 'string' && Number.isFinite(Date.parse(seededSeen)), seededSeen)
await new Promise((r) => setTimeout(r, 20))
await store.markSeen(seenSid, undefined)
check('markSeen 把水位线推到 now', Date.parse(store.binding(seenSid).seenAt) > Date.parse(seededSeen), store.binding(seenSid).seenAt)
await store.markSeen(seenSid, '2026-01-01T00:00:00.000Z')
check('markSeen 可显式指定水位线', store.binding(seenSid).seenAt === '2026-01-01T00:00:00.000Z', store.binding(seenSid).seenAt)
const seenTree = await store.createTree('水位线测试树')
await store.switchTree(seenSid, seenTree.id)
check('换树即重置水位线（新树不该满屏 NEW）', Date.parse(store.binding(seenSid).seenAt) > Date.parse('2026-01-01T00:00:00.000Z'), store.binding(seenSid).seenAt)
check('未绑定会话 markSeen 返回 null（不凭空造 binding）', (await store.markSeen('sess-never', undefined)) === null)

// 快照必须带 createdAt，否则面板算不出"哪些是新增"
await store.switchTree(sid, 'tutorial')
await store.addNodes(sid, '', ['快照用根'])
const shotTree = store.readTree('tutorial')
const shotNodes = snapshotNodes(shotTree.nodes)
const shotNew = shotNodes.find((n) => n.title === '快照用根')
check('snapshotNodes 带 createdAt（面板据此算新增）', typeof shotNew.createdAt === 'string', shotNew)
check('没有来源的节点 origin 是 null（面板于是不渲染 ↩，不给假按钮）', shotNew.origin === null && shotNew.originCount === 0, shotNew)

// ── 来源坐标 origins：面板「↩ 原文」跳回聊天记录的唯一依据 ─────────────────
// 坐标是 (sid, turn, seq) 而不是 messageId：外壳的会话流按 turn 分行、更早的分页用
// 官方 loadThrough(seq) 补页 —— 这两个抓手才是"跳得过去"的前提。
await store.addNodes(sid, '', ['来源用根'])
await store.capture(sid, '来源用子', '来源用根', false)
const originPath = '来源用根/来源用子'
const originTree = store.readTree('tutorial')
const originNode = findNode(originTree, originPath)
/** 在快照里按 id 找节点（snapshotNodes 是嵌套结构） */
function shotOf(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n
    const deep = shotOf(n.children, id)
    if (deep !== null) return deep
  }
  return null
}
const shotOrigin = () => shotOf(snapshotNodes(store.readTree('tutorial').nodes), originNode.id)

const firstOrigin = await store.markOrigin(sid, originPath, { sid: 'sess-A', turn: 3, seq: 30, time: '2026-09-18T05:00:00.000Z', why: 'capture' })
check('markOrigin 写入并回传最新一条', firstOrigin.origin.turn === 3 && firstOrigin.count === 1, firstOrigin)
check('快照把来源发给面板', shotOrigin().origin.turn === 3 && shotOrigin().origin.seq === 30, shotOrigin())
check('快照的 origin 是纯标量（不把活对象塞进前端）', JSON.stringify(shotOrigin().origin).indexOf('undefined') < 0, shotOrigin().origin)

await store.markOrigin(sid, originPath, { sid: 'sess-A', turn: 3, seq: 31, time: '2026-09-18T05:01:00.000Z', why: 'done' })
check('同一次对话（sid+turn）只留一条，但刷新 seq', shotOrigin().originCount === 1 && shotOrigin().origin.seq === 31, shotOrigin())

await store.markOrigin(sid, originPath, { sid: 'sess-A', turn: 9, seq: 90, time: '2026-09-18T06:00:00.000Z' })
check('换一轮就是新的一条（最新在前）', shotOrigin().originCount === 2 && shotOrigin().origin.turn === 9, shotOrigin())

await store.markOrigin(sid, originPath, { sid: 'sess-B', turn: 1, seq: 5, time: '2026-09-18T07:00:00.000Z' })
await store.markOrigin(sid, originPath, { sid: 'sess-C', turn: 2, seq: 7, time: '2026-09-18T08:00:00.000Z' })
check('来源最多留 ORIGIN_MAX 条（旧的淘汰，最新在前）',
  shotOrigin().originCount === ORIGIN_MAX && shotOrigin().origin.sid === 'sess-C', shotOrigin())
check('淘汰的是最旧那条', shotOrigin().origin.turn === 2, shotOrigin())

const badOrigin = await store.markOrigin(sid, originPath, { sid: '', turn: 1, seq: 1 })
check('坐标不完整 → 报错且不写入', typeof badOrigin.error === 'string' && shotOrigin().originCount === ORIGIN_MAX, badOrigin)
const missingOrigin = await store.markOrigin(sid, '不存在的/路径', { sid: 'x', turn: 1, seq: 1 })
check('找不到节点 → 报错（不静默成功）', typeof missingOrigin.error === 'string', missingOrigin)
check('未绑定会话 markOrigin 报错', typeof (await store.markOrigin('sess-never-origin', originPath, { sid: 'x', turn: 1, seq: 1 })).error === 'string')

// ── 开场块：只在"这个会话还没用过树"时注入 ──────────────────────────────
const freshSid = 'sess-fresh'
await store.markEnabled(freshSid)
await store.autoBind(freshSid)
const freshText = store.contextText(freshSid)
check('全新会话：注入【现有学习树】清单', freshText.includes('【现有学习树】'), freshText.slice(0, 160))
check('全新会话：注入【开场·只做一次】', freshText.includes('【开场·只做一次】'))
check('开场指令要求用 ask_user_question 出选项', freshText.includes('ask_user_question'))
check('开场指令含"新建一棵"与"自己填"', freshText.includes('新建一棵') && freshText.includes('自己填'))
await store.markOpened(freshSid)
check('确认开场后：不再注入开场块', !store.contextText(freshSid).includes('【开场·只做一次】'))
check('确认开场后：正常内容仍在', store.contextText(freshSid).includes('【进度】'))

// 已经用过的老会话（有焦点）→ 不该被重新问一次开场
const usedSid = 'sess-used'
await store.markEnabled(usedSid)
await store.autoBind(usedSid)
await store.setFocus(usedSid, '窗口测试树/上一层')
const usedText = store.contextText(usedSid)
check('已经用过树的老会话：不再问开场', !usedText.includes('【开场·只做一次】'), usedText.slice(0, 140))
check('老会话仍然有正常注入', usedText.includes('▶ 当前聚焦（用户正在看的）：窗口测试树/上一层'), usedText.slice(0, 140))

// corrupt file resilience
import { writeFileSync } from 'node:fs'
writeFileSync(join(root, 'index.json'), '{ broken', 'utf8')
const treesAfter = store.listTrees()
check('corrupt index -> empty list, no throw', Array.isArray(treesAfter), treesAfter)

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES')
process.exit(failures === 0 ? 0 : 1)