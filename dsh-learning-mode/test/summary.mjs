/**
 * 摘要管道单测：门槛 / 生成 / 落盘 / 失败重试 / 会话窗口过滤。
 *
 * 全部用假对象：
 *   - 假 session：只提供 snapshotEvents()，事件形状与真实 SessionEventMap 一致；
 *   - 假 llm：只提供 stream()，按需吐 text-delta / finish；
 *   - 真 store：写进临时目录，落盘结果真读回来校验。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningStore, findNode } from '../lib/store.js'
import {
  SummaryPipeline,
  extractTranscript,
  meetsThreshold,
  resolveRoute,
  clipTranscript,
  narrowTranscript,
  normalizeHeading,
  MIN_MESSAGES,
  MAX_ATTEMPTS,
  isEffortError,
} from '../lib/summary.js'

let failures = 0
const check = (label, cond, extra) => {
  if (cond) console.log('  ok  ' + label)
  else { failures += 1; console.log('  FAIL ' + label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 300))) }
}

const root = mkdtempSync(join(tmpdir(), 'lm-summary-'))
const store = new LearningStore(root)
await store.init()
const sid = 'sess-1'
await store.markEnabled(sid)
await store.autoBind(sid)
await store.addNodes(sid, '', ['Java'])
await store.addNodes(sid, 'Java', ['对象'])

// ── 假会话：事件带 time，plugin 注入的 user 消息必须被过滤 ────────────────
const t0 = Date.parse('2026-09-18T10:00:00.000Z')
function evUser(time, text, kind) {
  return { type: 'user/message', time, data: { role: 'user', content: [{ type: 'text', text }], source: { kind: kind || 'user' } } }
}
function evAssistant(time, text) {
  return { type: 'assistant/message', time, data: { message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } } }
}
function fakeSession(events) {
  return { snapshotEvents: () => events }
}
const richEvents = [
  evUser(t0 + 1000, '什么是继承？'),
  { type: 'user/message', time: t0 + 1500, data: { role: 'user', content: [{ type: 'text', text: '（插件注入的学习模式上下文，不该进摘要）' }], source: { kind: 'plugin', plugin: 'dsh-learning-mode' } } },
  evAssistant(t0 + 2000, '继承是 is-a 关系，子类复用父类的行为。'),
  evUser(t0 + 3000, '那组合呢？'),
  evAssistant(t0 + 4000, '组合是 has-a，比继承更松耦合。'),
]

const transcript = extractTranscript(fakeSession(richEvents), 0)
check('抽取到 4 条真人/模型消息（注入的那条被过滤）', transcript.messages === 4, transcript.messages)
check('抽取到窗口时间范围', transcript.from === t0 + 1000 && transcript.to === t0 + 4000, transcript)
check('门槛：4 条消息达标', meetsThreshold(transcript) === true)
check('门槛：窗口外的事件不算', extractTranscript(fakeSession(richEvents), t0 + 3500).messages === 1)
check('门槛：1 条短消息不达标', meetsThreshold({ messages: 1, chars: 20 }) === false)
check('门槛：字多也算达标', meetsThreshold({ messages: 1, chars: 260 }) === true)
check('截断保留最近的内容', clipTranscript(['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)], 150).length === 1)

check('路由回退到默认模型', JSON.stringify(resolveRoute({}, { currentSelection: () => ({ provider: 'p', model: 'm' }) })) === '{"provider":"p","model":"m"}')
check('路由优先用会话实际请求的路由', resolveRoute({ requestContext: () => ({ provider: 's', model: 'x' }) }, { currentSelection: () => ({ provider: 'p', model: 'm' }) }).provider === 's')
check('没有路由时返回 null', resolveRoute({}, {}) === null)

// ── 假 llm ────────────────────────────────────────────────────────────────
function fakeLlm(text, options) {
  const opts = options || {}
  return {
    calls: [],
    async *stream(request) {
      this.calls.push(request)
      if (opts.throwAt === 'stream') throw new Error('boom')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: opts.finish || { kind: 'stop' } }
    },
  }
}

/** 依次按脚本演出的假 llm：每次调用取下一个脚本。 */
function scriptedLlm(scripts) {
  return {
    calls: [],
    async *stream(request) {
      this.calls.push(request)
      const at = Math.min(this.calls.length - 1, scripts.length - 1)
      const script = scripts[at]
      if (script.throwMessage !== undefined) throw new Error(script.throwMessage)
      if (script.text) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: script.text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: script.text } }
      }
      yield { type: 'finish', reason: script.finish || { kind: 'stop' } }
    },
  }
}

let llm = fakeLlm('继承是 is-a；组合是 has-a；易错：重载≠重写')
let pipeline = new SummaryPipeline({
  store,
  getLlm: () => llm,
  getDefaultModel: () => ({ currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) }),
  getSessions: () => ({ get: () => fakeSession(richEvents) }),
})

const req = { sessionId: sid, treeId: 'tutorial', path: 'Java/对象', reason: 'done', sinceMs: 0, existingNote: '' }
const first = await pipeline.run(req)
check('生成成功并落盘', first.ok === true && first.note.length > 0, first)

let tree = store.readTree('tutorial')
let node = findNode(tree, 'Java/对象')
check('node.note 写进树文件', node.note.includes('is-a'), node.note)
check('node.noteState = done', node.noteState === 'done', node.noteState)
check('noteSource 记录窗口', node.noteSource !== null && node.noteSource.to === t0 + 4000, node.noteSource)
check('模型入参带 system 与 maxTokens', llm.calls[0].system.length > 0 && llm.calls[0].maxTokens > 0)
check('模型入参带已有摘要字段', llm.calls[0].messages[0].content[0].text.includes('已有摘要'))
check('模型入参带时间线文本', llm.calls[0].messages[0].content[0].text.includes('继承是 is-a 关系'))
check('关闭推理：请求带 reasoningEffort=off（否则预算会被思考吃光）', llm.calls[0].reasoningEffort === 'off', llm.calls[0].reasoningEffort)
check('输出预算放宽到千级', llm.calls[0].maxTokens >= 1000, llm.calls[0].maxTokens)

// ── 门槛：内容太少不生成 ────────────────────────────────────────────────
llm = fakeLlm('不该被调用')
pipeline = new SummaryPipeline({ store, getLlm: () => llm, getDefaultModel: () => ({ currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) }) })
const thin = await pipeline.run({ ...req, session: fakeSession([evUser(t0, '嗯')]) })
check('内容太少 → too-little 且不调模型', thin.ok === false && thin.error === 'too-little' && llm.calls.length === 0, thin)

// ── 没有 llm 服务：静默跳过 ─────────────────────────────────────────────
const noLlm = new SummaryPipeline({ store, getLlm: () => undefined })
const skipped = await noLlm.run({ ...req, session: fakeSession(richEvents) })
check('没有 llm 服务 → no-llm（不抛错）', skipped.ok === false && skipped.error === 'no-llm', skipped)

// ── 模型失败 / 异常结束：标 pending 且累计次数 ──────────────────────────
llm = fakeLlm('x', { throwAt: 'stream' })
pipeline = new SummaryPipeline({ store, getLlm: () => llm, getDefaultModel: () => ({ currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) }) })
const failed = await pipeline.run({ ...req, session: fakeSession(richEvents) })
tree = store.readTree('tutorial')
node = findNode(tree, 'Java/对象')
check('模型抛错 → 返回失败但不抛给调用方', failed.ok === false, failed)
check('失败后 noteState = failed', node.noteState === 'failed', node.noteState)
check('失败后 tries 累计', node.noteTries === 1, node.noteTries)
check('失败不会把错误写进 note（保留原摘要）', node.note.includes('is-a'), node.note)
check('失败原因留档（截断）', typeof node.noteError === 'string' && node.noteError.includes('boom'), node.noteError)

// 再失败两次 → 达到上限
await pipeline.run({ ...req, session: fakeSession(richEvents) })
llm = fakeLlm('y', { finish: { kind: 'error', failure: { message: 'quota' } } })
pipeline = new SummaryPipeline({ store, getLlm: () => llm, getDefaultModel: () => ({ currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) }) })
const third = await pipeline.run({ ...req, session: fakeSession(richEvents) })
tree = store.readTree('tutorial')
node = findNode(tree, 'Java/对象')
check('非 stop 结束视为失败', third.ok === false && third.error.includes('quota'), third)
check('tries 到 ' + MAX_ATTEMPTS, node.noteTries === MAX_ATTEMPTS, node.noteTries)

// ── 模型回"无内容"：不写 note ───────────────────────────────────────────
llm = fakeLlm('无内容')
pipeline = new SummaryPipeline({ store, getLlm: () => llm, getDefaultModel: () => ({ currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) }) })
await store.addNodes(sid, 'Java', ['语法'])
const empty = await pipeline.run({ ...req, path: 'Java/语法', session: fakeSession(richEvents) })
tree = store.readTree('tutorial')
node = findNode(tree, 'Java/语法')
check('模型答"无内容" → 不写摘要', empty.ok === false && empty.error === 'empty' && node.note === '', { empty, note: node.note })
check('模型答"无内容" → 状态标 skipped', node.noteState === 'skipped', node.noteState)

// ── i18n：英文会话用的是英文提示词，哨兵词与"摘要："前缀词都跟着变 ─────────
// 英文提示词让模型回 NO_CONTENT（见 lib/i18n.js 的英文摘要提示词），
// 只认中文"无内容"的话，英文会话会把字面量 "NO_CONTENT" 当成摘要存下来。
llm = fakeLlm('NO_CONTENT')
pipeline = new SummaryPipeline({ store, getLlm: () => llm, getDefaultModel: () => ({ currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) }) })
await store.addNodes(sid, 'Java', ['语法英文'])
const emptyEn = await pipeline.run({ ...req, path: 'Java/语法英文', session: fakeSession(richEvents) })
tree = store.readTree('tutorial')
node = findNode(tree, 'Java/语法英文')
check('英文会话：模型答 NO_CONTENT → 同样不写摘要（哨兵中英都认）',
  emptyEn.ok === false && emptyEn.error === 'empty' && node.note === '', { emptyEn, note: node.note })

// 英文会话下模型可能回 "Summary: …"，这个前缀也必须清掉（否则摘要开头多一句废话）
llm = fakeLlm('Summary: 继承是 is-a 关系')
pipeline = new SummaryPipeline({ store, getLlm: () => llm, getDefaultModel: () => ({ currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) }) })
await store.addNodes(sid, 'Java', ['前缀英文'])
await pipeline.run({ ...req, path: 'Java/前缀英文', session: fakeSession(richEvents) })
tree = store.readTree('tutorial')
node = findNode(tree, 'Java/前缀英文')
check('英文会话：Summary: 前缀被清掉（中文的"摘要："同样仍被清）',
  node.note === '继承是 is-a 关系', node.note)

// ── 真机踩过的坑①：max-tokens 截断 ──────────────────────────────────────
// 有部分文本 → 收下；一个字都没有 → 明确报错（而不是写一条空摘要）
await store.addNodes(sid, 'Java', ['内存'])
llm = scriptedLlm([{ text: '继承是 is-a（被截断', finish: { kind: 'max-tokens' } }])
pipeline = new SummaryPipeline({ store, getLlm: () => llm, getDefaultModel: () => ({ currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) }) })
const truncated = await pipeline.run({ ...req, path: 'Java/内存', session: fakeSession(richEvents) })
check('max-tokens 但有文本 → 收下已产出部分', truncated.ok === true && truncated.note.includes('is-a'), truncated)

llm = scriptedLlm([{ finish: { kind: 'max-tokens' } }])
pipeline = new SummaryPipeline({ store, getLlm: () => llm, getDefaultModel: () => ({ currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) }) })
const starved = await pipeline.run({ ...req, path: 'Java/内存', session: fakeSession(richEvents) })
check('max-tokens 且无文本 → 失败并说清原因', starved.ok === false && starved.error.includes('token'), starved)

// ── 真机踩过的坑②：模型不认 reasoningEffort=off → 去掉 effort 重试 ────────
llm = scriptedLlm([
  { finish: { kind: 'error', failure: { message: 'unsupported reasoning effort: off', code: 'INVALID_EFFORT' } } },
  { text: '回退后成功写下的摘要' },
])
pipeline = new SummaryPipeline({ store, getLlm: () => llm, getDefaultModel: () => ({ currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) }) })
const fellBack = await pipeline.run({ ...req, path: 'Java/内存', session: fakeSession(richEvents) })
check('effort 被拒 → 自动去掉 effort 重试一次', fellBack.ok === true && llm.calls.length === 2, { fellBack, calls: llm.calls.length })
check('第一次带 off、第二次不带 effort', llm.calls[0].reasoningEffort === 'off' && llm.calls[1].reasoningEffort === undefined, llm.calls.map((c) => c.reasoningEffort))

// ── 冷却：同一节点 5 分钟内不重复触发 ───────────────────────────────────
llm = fakeLlm('第二次摘要')
pipeline = new SummaryPipeline({ store, getLlm: () => llm, getDefaultModel: () => ({ currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) }) })
const s1 = pipeline.schedule({ ...req, path: 'Java/语法', session: fakeSession(richEvents) })
check('第一次 schedule 启动', s1.started === true, s1)
await new Promise((r) => setTimeout(r, 60))
const s2 = pipeline.schedule({ ...req, path: 'Java/语法', session: fakeSession(richEvents) })
check('冷却期内第二次 schedule 被拒', s2.started === false && s2.reason === 'cooldown', s2)
const s3 = pipeline.schedule({ ...req, path: 'Java/语法', session: fakeSession(richEvents), force: true })
check('force 可绕过冷却（面板 [重写] 用）', s3.started === true, s3)

// ── store.review / setNote 直接调用 ─────────────────────────────────────
await store.setStatus(sid, 'Java/对象', 'done', '')
let view = store.review(sid)
check('review 列出已完成节点', view.items.length === 1 && view.items[0].path === 'Java/对象', view.items)
check('review 带统计', view.stats.done === 1 && view.stats.total >= 2, view.stats)
await store.setNote(sid, 'Java/对象', '人工写的摘要', { sessionId: sid, reason: 'manual' })
view = store.review(sid)
check('setNote 后 review 能看到摘要', view.items[0].note === '人工写的摘要', view.items[0])
check('review 的 withNote 统计正确', view.stats.withNote === 1, view.stats)

// 文件里确实落了盘（不是只在内存）
const raw = JSON.parse(readFileSync(join(root, 'trees', 'tutorial.json'), 'utf8'))
check('落盘文件里的 note 与内存一致', JSON.stringify(raw).includes('人工写的摘要'))

// ══════════════════════════════════════════════════════════════════════════
// 真机 bug 回归（2026-09-18「AI Agent 论文」会话）：
//   AI 在父节点里用 `## 1./## 2.…` 一口气讲了 6 个前置概念，树里存成 6 个子节点；
//   用户在面板上给其中一个子节点（rollout 的交互税）点 ✓ —— 它自己从没被聚焦过。
//   结果：① 窗口退化成 0（整场会话，含整篇论文的导览）；
//        ② 原料是 6 节合体的一条消息，模型去总结了"共同的上一层主题"。
//   期望：窗口退到父节点进入时间；原料收窄到命中标题的那一节。
// ══════════════════════════════════════════════════════════════════════════
const multiTopicAnswer = [
  '# 前置知识：为什么需要一台"模拟器"',
  '',
  '## 1. rollout 的交互税（一切问题的起点）',
  'RL 里学任何东西都要靠交互，一整条轨迹叫 rollout，交互是有价格的。',
  '在 Dream-RSI 里一次交互=一次 discovery-agent 调用；算一次"探索策略好不好"要一整轮 110-640 次调用，交互税在元层被放大两个数量级。整篇论文就是在打这个税。',
  '',
  '## 2. model-free vs model-based RL',
  'model-free 直接学值函数，样本效率低；model-based 额外学动力学模型当替身，代价是模型偏差。',
  'MODEL_BASED_SENTINEL 这段属于兄弟知识点，不该出现在 rollout 的总结里。',
  '这条分界线就是 Dream-RSI 的立论基础：与其在线试策略，不如先造一个环境的替身，这样才有机会把交互税打下来。',
  '',
  '## 3. World Model 与 Dreamer 的 dreaming',
  'World Model 用神经网络学一个紧凑的隐空间世界，Dreamer 把 actor-critic 训练全搬到 latent imagination 里做。',
  'WORLD_MODEL_SENTINEL 这段也属于兄弟知识点，同样不该进 rollout 的总结。',
  '论文里的 dreaming 就是直接从 Dreamer 借的隐喻，所以读 §2 时不要被这个词绊住。',
].join('\n')

await store.switchTree(sid, 'tutorial')
await store.addNodes(sid, '', ['论文'])
await store.addNodes(sid, '论文', ['rollout 的交互税', 'model-free 与 model-based RL', 'World Model 与 Dreamer 的 dreaming'])
await store.setFocus(sid, '论文')
const focusAt = Date.now()
await new Promise((r) => setTimeout(r, 30))
await store.setFocus(sid, 'Java/对象')   // 用户继续看别的：焦点不在父节点上
const bugTree = store.readTree('tutorial')
const taxNode = findNode(bugTree, '论文/rollout 的交互税')
const taxWindow = store.windowStart(sid, taxNode.id)
check('回归①：从没聚焦过的子节点 → 窗口取父节点进入时间（不是 0）',
  taxWindow >= focusAt - 50 && taxWindow <= Date.now(), { taxWindow, focusAt })

// 事件时间按真实时序排：论文导览在窗口**之前**（该被切掉），多概念回答在窗口**之内**。
const bugEvents = [
  evUser(taxWindow - 5000, '我想学习一下这篇论文'),
  evAssistant(taxWindow - 4000, 'PAPER_OVERVIEW_SENTINEL 这篇论文针对的是"怎么决定下一步去哪里找解"。'),
  evUser(taxWindow + 1000, '先讲一下前置知识'),
  evAssistant(taxWindow + 2000, multiTopicAnswer),
]
const bugsession = fakeSession(bugEvents)

const bugReq = {
  sessionId: sid,
  treeId: 'tutorial',
  path: '论文/rollout 的交互税',
  title: 'rollout 的交互税',
  siblings: ['model-free 与 model-based RL', 'World Model 与 Dreamer 的 dreaming'],
  reason: 'done',
  sinceMs: taxWindow,
  existingNote: '',
}
const bugTranscript = extractTranscript(bugsession, taxWindow)
check('回归①：窗口内不含窗口之前的整篇论文导览',
  !bugTranscript.lines.join('\n').includes('PAPER_OVERVIEW_SENTINEL') && bugTranscript.items.length === 2,
  { items: bugTranscript.items.length })

const narrowed = narrowTranscript(bugTranscript.items, 'rollout 的交互税')
check('回归②：原料被收窄到命中标题的小节', narrowed.narrowed === true, narrowed)
check('回归②：收窄后含本节内容', narrowed.items[0].text.includes('交互税在元层被放大两个数量级'), narrowed.items[0].text)
check('回归②：收窄后不含兄弟小节', !narrowed.items[0].text.includes('MODEL_BASED_SENTINEL') && !narrowed.items[0].text.includes('WORLD_MODEL_SENTINEL'), narrowed.items[0].text)
check('回归②：标题归一化能吃下 "## 1. 标题（补充说明）"', normalizeHeading('1. rollout 的交互税（一切问题的起点）').includes(normalizeHeading('rollout 的交互税')))
check('回归②：换成兄弟标题就收窄到兄弟那一节',
  narrowTranscript(bugTranscript.items, 'World Model 与 Dreamer 的 dreaming').items.map((i) => i.text).join('\n').includes('WORLD_MODEL_SENTINEL'))
check('回归②：没有小标题的普通对话 → 不收窄（保持原样）',
  narrowTranscript(bugTranscript.items, '一个压根没出现在标题里的概念').narrowed === false)
check('回归②：数字式小节标题（无 markdown #）也能收窄',
  narrowTranscript([{ role: 'assistant', text: '1. rollout 的交互税\n正文A'.padEnd(130, '甲') + '\n2. 别的概念\n正文B', time: taxWindow }], 'rollout 的交互税').narrowed === true)

llm = fakeLlm('交互税：一次交互=一次 agent 调用；元层评估要把 110-640 次调用放大两个数量级。')
pipeline = new SummaryPipeline({ store, getLlm: () => llm, getDefaultModel: () => ({ currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) }) })
const bugRun = await pipeline.run({ ...bugReq, session: bugsession })
const bugPrompt = llm.calls[0].messages[0].content[0].text
check('回归③：摘要落盘成功', bugRun.ok === true, bugRun)
check('回归③：提示词点名"本次要总结的知识点"', bugPrompt.includes('本次要总结的知识点：rollout 的交互税'), bugPrompt.slice(0, 200))
check('回归③：提示词列了同层其它知识点（划边界）', bugPrompt.includes('同层其它知识点') && bugPrompt.includes('model-free 与 model-based RL'))
check('回归③：提示词里不含兄弟小节正文', !bugPrompt.includes('MODEL_BASED_SENTINEL') && !bugPrompt.includes('WORLD_MODEL_SENTINEL'))
check('回归③：提示词里不含整篇论文导览', !bugPrompt.includes('PAPER_OVERVIEW_SENTINEL'))
const taxSaved = findNode(store.readTree('tutorial'), '论文/rollout 的交互税')
check('回归③：摘要写进树文件', taxSaved.note.includes('交互税'), taxSaved.note)

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES')
process.exit(failures === 0 ? 0 : 1)
