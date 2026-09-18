/**
 * dsh-learning-mode — 摘要管道（方案 §8 / P4）
 *
 * 触发：节点被标记"学会"（且没带人工摘要），或焦点从一个停留够久的节点上移开。
 * 生成：**插件自己调 ctx.llm**，不进聊天记录、不占 Agent 轮次、不打断用户思路。
 * 落盘：写进 node.note / noteAt / noteState / noteSource。
 *
 * 三条纪律（方案里的硬要求）：
 *   1. 全程异步、绝不阻塞调用方 —— schedule() 立刻返回，失败只记状态；
 *   2. 门槛防"空摘要"和烧钱 —— 太少内容不生成；同一节点 5 分钟内不重复生成；
 *   3. 失败不丢 —— 标 pending + 累计 tries，≤3 次，下次触发重试。
 *
 * 所有对会话数据的读取都只取叶子标量（role / text / time），绝不把 Session、
 * Message、Event 这些活对象存起来或序列化出去。
 *
 * ⚠️ 本模块**不在顶层 import '@deepseek-ai/dsh-llm'**：import 是挂载期解析，
 * 一旦该包在当前 DSH 版本里改名/缺失，整个「学习模式」预设都会加载失败
 * （= 学习模式根本无法创建会话），而这只为了一个辅助功能，代价完全不对称。
 * 改为首次真正要生成摘要时动态 import，拿不到就用内置的最小实现兜底。
 */

/** 摘要请求的 plugin 标识（写进 Message.source，也用于日志）。 */
export const NOTE_PLUGIN_ID = 'dsh-learning-mode'

/** 门槛：消息条数或字符数任一达标即认为"有实质内容"。 */
export const MIN_MESSAGES = 4
export const MIN_CHARS = 200
/** 送进模型的对话片段上限（防止把整场会话塞进去）。 */
export const MAX_INPUT_CHARS = 6000
/** 同一节点两次自动摘要之间的最短间隔。 */
export const COOLDOWN_MS = 5 * 60 * 1000
/** 单节点失败重试上限。 */
export const MAX_ATTEMPTS = 3
/** 单次 LLM 调用超时。 */
export const TIMEOUT_MS = 60 * 1000
/** 摘要输出上限 token。注意：这是**含思考在内**的总预算——所以下面必须关思考。 */
export const MAX_OUTPUT_TOKENS = 1200
/** 摘要这种小任务不要开推理：默认 high 会把 token 预算烧光（真机实测）。 */
export const SUMMARY_REASONING_EFFORT = 'off'

const SYSTEM_PROMPT = [
  '你在为一个「学习树」写知识点的复习摘要。用户刚学完**一个**知识点，你要留下以后能直接看懂的一段话。',
  '',
  '要求：',
  '- **只写属于「本次要总结的知识点」的内容**。原料是一段连续对话，里面很可能同时讲了同层的好几个知识点（甚至是整篇论文的全景概览）；那些不属于本次目标，一个字都不要写进来。',
  '- 写 2-4 句中文，只写：核心结论、关键机制、易错点、还没解决的问题。',
  '- 不要复述对话过程，不要出现"用户问""我回答"这类叙述，不要客套，不要 markdown 标题或列表符号。',
  '- 已有摘要时，是**增量合并**：保留仍然正确的旧结论，补上这次新增/修正的内容，不要丢掉信息。',
  '- 如果原料里关于**这一个**知识点的内容不足以沉淀结论（只是顺带提了一句、或者讲的其实是别的知识点），只回复两个字：无内容',
  '- 直接输出摘要正文，不要任何前缀。',
].join('\n')

/**
 * 从会话里抽出"聚焦窗口内"的真人对话文本。
 *
 * 用 session.snapshotEvents() 而不是 deriveMessages()：只有事件带 time，
 * 而"窗口起点之后"正是摘要原料区间的定义（方案 §4.2 的 cursor）。
 * 窗口起点由 `store.windowStart()` 三级兜底给出（自己 → 最近进过的祖先 → 节点 createdAt）。
 *
 * @param session 活会话对象（只读其事件）
 * @param sinceMs 窗口起点（毫秒时间戳），0 表示整场会话
 * @returns {{ lines: string[], items: {role:string,text:string,time:number}[], messages: number, chars: number, from: number, to: number }}
 */
export function extractTranscript(session, sinceMs) {
  const out = { lines: [], items: [], messages: 0, chars: 0, from: 0, to: 0 }
  if (session === null || session === undefined) return out
  let events = []
  try {
    events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
  } catch {
    return out
  }
  if (!Array.isArray(events)) return out
  const floor = Number.isFinite(sinceMs) ? sinceMs : 0
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const type = event.type
    let message = null
    if (type === 'user/message') message = event.data
    else if (type === 'assistant/message') message = event.data === null || typeof event.data !== 'object' ? null : event.data.message
    if (message === null || typeof message !== 'object') continue
    const time = Number(event.time) || 0
    if (time < floor) continue
    // 只留真人发言与模型发言：plugin 注入的上下文、tool 结果都不是"学到的内容"。
    const kind = message.source === null || typeof message.source !== 'object' ? undefined : message.source.kind
    const role = message.role
    if (role === 'user' && kind !== 'user') continue
    if (role === 'assistant' && kind !== 'model') continue
    if (role !== 'user' && role !== 'assistant') continue
    const text = textOfBlocks(message.content)
    if (text === '') continue
    out.messages += 1
    out.chars += text.length
    if (out.from === 0) out.from = time
    out.to = Math.max(out.to, time)
    out.lines.push((role === 'user' ? '【我】' : '【AI】') + text)
    out.items.push({ role, text, time })
  }
  return out
}

/** 只取 text 块的正文；reasoning / tool-call / image 一律跳过。 */
function textOfBlocks(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'text') continue
    if (typeof block.text !== 'string') continue
    parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 门槛判定（导出便于单测）。 */
export function meetsThreshold(transcript) {
  return transcript.messages >= MIN_MESSAGES || transcript.chars >= MIN_CHARS
}

/** 收窄后至少要有这么多字，否则宁可退回整段原料（避免把模型饿到只能答"无内容"）。 */
export const MIN_SECTION_CHARS = 120

/** markdown 小节标题：`## 1. rollout 的交互税` */
const MD_HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/
/** 没有 markdown 标题时的退化形态：`1. rollout 的交互税` / `1、xxx` / `**2) xxx**` */
const NUM_HEADING_RE = /^\s{0,3}(?:\*\*|__)?\s*(\d{1,2})\s*[.、)）]\s*(\S.*?)\s*(?:\*\*|__)?\s*$/

/** 标题归一化：去掉编号、强调符、标点与空白，只留字，用于宽松匹配。 */
export function normalizeHeading(text) {
  return String(text)
    .replace(/^\s{0,3}(?:#{1,6}\s*)?/, '')
    .replace(/^(?:\*\*|__)?\s*\d{1,2}\s*[.、)）]\s*/, '')
    .replace(/[\s`*_~【】\[\]（）()：:、，,。.．!！?？—\-–+/／|]+/g, '')
    .toLowerCase()
}

function headingMatches(headingText, title) {
  const h = normalizeHeading(headingText)
  const t = normalizeHeading(title)
  if (h === '' || t === '') return false
  return h === t || h.includes(t) || t.includes(h)
}

/** 一行是不是一个小节的开头？返回 {level, text, style}；不是则 null。 */
function sectionStart(line, style) {
  if (style === 'md') {
    const m = MD_HEADING_RE.exec(line)
    if (m === null) return null
    return { level: m[1].length, text: m[2], style: 'md' }
  }
  const m = NUM_HEADING_RE.exec(line)
  if (m === null) return null
  return { level: 7, text: m[2], style: 'num' }
}

/** 从一段正文里，切出所有"标题命中该知识点"的小节（找不到返回 []）。 */
export function pickSections(text, title, style) {
  const lines = String(text).split('\n')
  const kept = []
  const starts = []
  for (let i = 0; i < lines.length; i += 1) {
    const hit = sectionStart(lines[i], style)
    if (hit !== null && headingMatches(hit.text, title)) starts.push({ at: i, level: hit.level })
  }
  for (const start of starts) {
    for (let k = start.at; k < lines.length; k += 1) {
      if (k > start.at) {
        const next = sectionStart(lines[k], style)
        if (next !== null && next.level <= start.level) break
        // 数字式小节：遇到任何 markdown 标题也算结束
        if (style === 'num' && sectionStart(lines[k], 'md') !== null) break
      }
      kept.push(lines[k])
    }
  }
  return kept
}

/**
 * 把"整段对话"收窄到"只属于这个知识点的那几节"。
 *
 * 真机场景：AI 在父节点里一口气用 `## 1. / ## 2. …` 讲了 6 个前置概念，树里存成 6 个子节点。
 * 用户在其中一个子节点上点 ✓ 时，若不收窄，送进模型的是这 6 节合体的一整条消息，
 * 模型就会去总结"共同的上一层主题"（实测：给「rollout 的交互税」写出了整篇 Dream-RSI 的摘要）。
 *
 * 收窄策略：先按 markdown 标题找，找不到再按"1. / 1、"这类数字标题找；
 * 命中的消息**只保留命中的小节**，没命中的消息整条丢掉（那是别的知识点）。
 *
 * @returns {{ items: {role:string,text:string,time:number}[], narrowed: boolean, chars: number }}
 */
export function narrowTranscript(items, title) {
  const list = Array.isArray(items) ? items : []
  const cleanTitle = typeof title === 'string' ? title.trim() : ''
  if (cleanTitle === '' || list.length === 0) return { items: list, narrowed: false, chars: 0 }
  for (const style of ['md', 'num']) {
    const kept = []
    let chars = 0
    for (const item of list) {
      const sections = pickSections(item.text, cleanTitle, style)
      if (sections.length === 0) continue
      const text = sections.join('\n').trim()
      if (text === '') continue
      chars += text.length
      kept.push({ role: item.role, text, time: item.time })
    }
    if (kept.length > 0 && chars >= MIN_SECTION_CHARS) return { items: kept, narrowed: true, chars }
  }
  return { items: list, narrowed: false, chars: 0 }
}

/** 标题兜底：从 path 的最后一段猜（path 是用 "/" 拼的，标题里也可能含 "/"）。 */
function titleFromPath(path) {
  const parts = String(path).split('/')
  return parts[parts.length - 1] || String(path)
}

/**
 * 解析这次摘要该用哪个模型路由。
 * 优先用会话上一次请求实际用的路由（用户可能中途换过模型），
 * 回退到全局默认模型。
 */
export function resolveRoute(session, agentDefaultModel) {
  try {
    if (session !== null && session !== undefined && typeof session.requestContext === 'function') {
      const info = session.requestContext()
      if (info !== null && typeof info === 'object' && typeof info.provider === 'string' && typeof info.model === 'string') {
        return { provider: info.provider, model: info.model }
      }
    }
  } catch { /* 忽略：回退到默认模型 */ }
  try {
    if (agentDefaultModel !== null && agentDefaultModel !== undefined && typeof agentDefaultModel.currentSelection === 'function') {
      const sel = agentDefaultModel.currentSelection()
      if (sel !== null && typeof sel === 'object' && typeof sel.provider === 'string' && typeof sel.model === 'string') {
        return { provider: sel.provider, model: sel.model }
      }
    }
  } catch { /* 没有可用路由 */ }
  return null
}

/** 把对话片段截到上限（保留最近的部分，学习结论通常在后半段）。 */
export function clipTranscript(lines, maxChars) {
  const limit = typeof maxChars === 'number' ? maxChars : MAX_INPUT_CHARS
  let total = 0
  const kept = []
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (total + line.length > limit) break
    total += line.length
    kept.push(line)
  }
  kept.reverse()
  return kept
}

/** 摘要管道的请求描述。 */
export function summarizePrompt(options) {
  const title = typeof options.title === 'string' && options.title.trim() !== ''
    ? options.title.trim()
    : titleFromPath(options.path)
  const siblings = (Array.isArray(options.siblings) ? options.siblings : [])
    .filter((t) => typeof t === 'string' && t.trim() !== '' && t.trim() !== title)
    .slice(0, 10)
  const lines = [
    '本次要总结的知识点：' + title,
    '它在学习树里的位置：' + options.path,
  ]
  if (siblings.length > 0) {
    lines.push('同层其它知识点（**不属于**本次总结；原料里讲到它们时请跳过）：' + siblings.join(' / '))
  }
  lines.push('已有摘要：' + (options.existingNote === '' || options.existingNote === undefined ? '（无）' : options.existingNote))
  lines.push('')
  lines.push('下面是这段时间的对话。**只**挑与「' + title + '」直接相关的内容来写；'
    + '这段对话很可能同时讲了上面列出的其它知识点甚至整篇论文，那些一个字都不要写进来。')
  for (const line of options.transcript) lines.push(line)
  return lines.join('\n')
}

export class SummaryPipeline {
  /**
   * @param options.store            数据层（写 note）
   * @param options.getLlm           () => ctx.get('llm') | undefined，惰性取（服务可能后挂）
   * @param options.getDefaultModel  () => ctx.get('agentDefaultModel') | undefined
   * @param options.getSessions      () => ctx.get('sessions') | undefined
   * @param options.log              (line) => void，诊断日志（可缺省）
   */
  constructor(options) {
    this.store = options.store
    this.getLlm = typeof options.getLlm === 'function' ? options.getLlm : () => undefined
    this.getDefaultModel = typeof options.getDefaultModel === 'function' ? options.getDefaultModel : () => undefined
    this.getSessions = typeof options.getSessions === 'function' ? options.getSessions : () => undefined
    this.log = typeof options.log === 'function' ? options.log : () => {}
    // 'off' = 摘要不思考（见 generate 的注释）；显式传 null 可退回模型默认。
    this.reasoningEffort = options.reasoningEffort === undefined ? SUMMARY_REASONING_EFFORT : options.reasoningEffort
    this.lastRun = new Map()
    this.inflight = new Set()
    this.stats = { started: 0, ok: 0, failed: 0, skipped: 0 }
  }

  /** 取活会话对象（只读）。 */
  sessionOf(sessionId) {
    try {
      const sessions = this.getSessions()
      if (sessions === undefined || sessions === null) return undefined
      return sessions.get(sessionId)
    } catch {
      return undefined
    }
  }

  keyOf(treeId, path) {
    return String(treeId) + '::' + String(path)
  }

  /**
   * 触发一次摘要（fire-and-forget）。调用方永远不被阻塞、永远不会拿到异常。
   * @returns {{started: boolean, reason?: string}}
   */
  schedule(request) {
    const key = this.keyOf(request.treeId, request.path)
    if (this.inflight.has(key)) return { started: false, reason: 'inflight' }
    if (request.force === true) this.lastRun.delete(key)
    const last = this.lastRun.get(key) || 0
    if (Date.now() - last < COOLDOWN_MS) return { started: false, reason: 'cooldown' }
    this.inflight.add(key)
    this.stats.started += 1
    // 立刻标"生成中"：面板点完 ✓ 就能看到反馈，而不是干等 3 秒轮询。
    void Promise.resolve()
      .then(() => this.store.markNoteState(request.sessionId, request.path, 'running'))
      .catch(() => undefined)
    void this.run(request).catch(() => undefined).then(() => { this.inflight.delete(key) })
    return { started: true }
  }

  /** await 版（单测与"同步等一次摘要"的场景用）。 */
  async run(request) {
    const key = this.keyOf(request.treeId, request.path)
    this.lastRun.set(key, Date.now())
    try {
      const llm = this.getLlm()
      if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
        this.stats.skipped += 1
        await this.markSkipped(request, 'no-llm')
        return { ok: false, error: 'no-llm' }
      }
      const session = request.session !== undefined ? request.session : this.sessionOf(request.sessionId)
      const transcript = extractTranscript(session, request.sinceMs)
      if (!meetsThreshold(transcript)) {
        // 内容不够：不算失败（不累计 tried），下次内容够了再补。
        this.stats.skipped += 1
        await this.markSkipped(request, '内容太少（' + transcript.messages + ' 条 / ' + transcript.chars + ' 字）')
        return { ok: false, error: 'too-little', messages: transcript.messages, chars: transcript.chars }
      }
      const route = resolveRoute(session, this.getDefaultModel())
      if (route === null) {
        this.stats.skipped += 1
        await this.markSkipped(request, '没有可用的模型路由')
        return { ok: false, error: 'no-route' }
      }
      // 原料收窄：只留"标题命中该知识点"的小节（AI 一口气讲 6 个概念时的关键一步）。
      const narrowed = narrowTranscript(transcript.items, request.title)
      const lines = narrowed.narrowed
        ? narrowed.items.map((item) => (item.role === 'user' ? '【我】' : '【AI】') + item.text)
        : transcript.lines
      if (narrowed.narrowed) {
        this.log('note 原料收窄：' + transcript.chars + ' → ' + narrowed.chars + ' 字（命中标题小节，path=' + request.path + '）')
      }
      const note = await this.generate(llm, route, {
        path: request.path,
        title: request.title,
        siblings: request.siblings,
        existingNote: request.existingNote || '',
        transcript: clipTranscript(lines),
      })
      if (note === '') {
        this.stats.skipped += 1
        await this.markSkipped(request, '模型认为没有可沉淀的结论')
        return { ok: false, error: 'empty' }
      }
      const written = await this.store.setNote(request.sessionId, request.path, note, {
        sessionId: request.sessionId,
        from: transcript.from,
        to: transcript.to,
        reason: request.reason || '',
      })
      if (written !== null && written !== undefined && typeof written.error === 'string') {
        this.stats.failed += 1
        return { ok: false, error: written.error }
      }
      this.stats.ok += 1
      this.log('note ok path=' + request.path + ' chars=' + note.length + ' route=' + route.provider + '/' + route.model)
      return { ok: true, note }
    } catch (error) {
      this.stats.failed += 1
      const message = String(error !== null && error !== undefined && error.message ? error.message : error).slice(0, 200)
      // 失败标 failed：面板显示"没生成出来"，下次触发重试（≤MAX_ATTEMPTS）。
      try {
        const state = await this.store.markNoteState(request.sessionId, request.path, 'failed', message)
        const tries = state !== null && state !== undefined && typeof state.tries === 'number' ? state.tries : 1
        if (tries > MAX_ATTEMPTS) this.lastRun.set(key, Date.now() + COOLDOWN_MS * 11)
      } catch { /* 标状态也失败就算了，绝不能把异常抛给调用方 */ }
      this.log('note failed path=' + request.path + ' :: ' + message)
      return { ok: false, error: message }
    }
  }

  /** 跳过时也留个状态，免得面板永远显示"生成中"。 */
  async markSkipped(request, reason) {
    try {
      await this.store.markNoteState(request.sessionId, request.path, 'skipped', reason)
    } catch { /* 忽略 */ }
  }

  /**
   * 真正的一次模型调用：流式装配成一段文本。
   *
   * ⚠️ 两个真机踩过的坑（第一次跑就撞上）：
   *  1. **不能让模型"思考"**：默认 reasoningEffort 是 high，摘要这种小任务会把
   *     maxTokens 预算全烧在推理上，文本块一个 token 都不剩 → finish = max-tokens，
   *     摘要永远是空的。所以显式传 reasoningEffort: 'off'
   *     （官方 session-title 也是这么做的：purpose='session-title' 即关闭思考）。
   *  2. **模型不认 'off' 时不能把整条管道废掉**：显式 effort 会在 provider I/O 之前
   *     被校验拒绝，于是这里兜一次"去掉 effort 重试"。
   */
  async generate(llm, route, input) {
    const helpers = await loadLlmHelpers()
    const messages = [helpers.createUserMessage({
      content: [{ type: 'text', text: summarizePrompt(input) }],
      source: { kind: 'plugin', plugin: NOTE_PLUGIN_ID },
    })]
    const options = {
      provider: route.provider,
      model: route.model,
      messages,
      system: SYSTEM_PROMPT,
      maxTokens: MAX_OUTPUT_TOKENS,
    }
    const timeout = makeTimeoutSignal(TIMEOUT_MS)
    if (timeout !== null) options.signal = timeout

    let attempt = await this.streamOnce(llm, helpers, options, this.reasoningEffort)
    if (attempt.error !== null && this.reasoningEffort !== null && isEffortError(attempt.error)) {
      this.log('reasoningEffort=' + this.reasoningEffort + ' 不被接受，退回默认重试一次')
      attempt = await this.streamOnce(llm, helpers, options, null)
    }
    if (attempt.error !== null) throw attempt.error

    let text = attempt.text
    if (attempt.finish !== null && attempt.finish.kind === 'max-tokens') {
      // 截断但有内容 → 有总比没有好；一个字都没有 → 明确报"预算被吃光"。
      if (text.trim() === '') throw new Error('输出 token 用尽且没有产出文本（模型把预算花在别处了）')
      this.log('摘要被 max-tokens 截断，按已产出的部分落盘')
    }
    text = text.trim()
    if (text === '无内容') return ''
    // 模型偶尔会加引号或"摘要："前缀，这里只做最基本的清理。
    return text.replace(/^摘要[:：]\s*/, '').replace(/^["“](.*)["”]$/s, '$1').trim()
  }

  /** 一次流式装配；异常与 error/aborted 结束都收敛成 { error }，不往外抛。 */
  async streamOnce(llm, helpers, options, reasoningEffort) {
    const request = reasoningEffort === null ? options : { ...options, reasoningEffort }
    const assembler = new helpers.BlockAssembler()
    try {
      for await (const chunk of llm.stream(request)) assembler.push(chunk)
    } catch (error) {
      return { text: '', finish: null, error: new Error(String(error !== null && error !== undefined && error.message ? error.message : error)) }
    }
    const finish = assembler.finish === undefined ? null : assembler.finish
    const text = assembler.blocks()
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
    if (finish !== null && (finish.kind === 'error' || finish.kind === 'aborted')) {
      const failure = finish.failure !== undefined && finish.failure !== null ? finish.failure : null
      const detail = failure !== null && typeof failure.message === 'string' && failure.message !== ''
        ? failure.message
        : String(finish.kind)
      const code = failure !== null && typeof failure.code === 'string' ? failure.code : ''
      const error = new Error(detail)
      error.code = code
      return { text, finish, error }
    }
    if (finish !== null && finish.kind === 'tool-calls') {
      return { text, finish, error: new Error('模型意外请求了工具调用') }
    }
    return { text, finish, error: null }
  }
}

/** 显式 effort 被 provider 拒绝的错误（用于决定要不要退回默认重试）。 */
export function isEffortError(error) {
  const text = String(error !== null && error !== undefined && error.message ? error.message : error).toLowerCase()
  const code = String(error !== null && error !== undefined && error.code ? error.code : '').toLowerCase()
  return text.includes('effort') || text.includes('reasoning') || code.includes('effort') || code.includes('reasoning')
}

/**
 * 惰性加载官方 LLM 小工具（只加载一次）。
 * 加载失败 → 用内置等价实现：挂载期与"官方包改名"都绝不能拖垮整个插件。
 */
let helpersPromise = null
export function loadLlmHelpers() {
  if (helpersPromise === null) {
    helpersPromise = import('@deepseek-ai/dsh-llm')
      .then((mod) => ({ createUserMessage: mod.createUserMessage, BlockAssembler: mod.BlockAssembler }))
      .catch(() => ({ createUserMessage: fallbackUserMessage, BlockAssembler: FallbackAssembler }))
  }
  return helpersPromise
}

/** 官方 createUserMessage 的最小等价物：一个带 role/source 的普通消息对象。 */
function fallbackUserMessage(input) {
  return {
    id: 'note-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    role: 'user',
    content: input.content,
    source: input.source,
  }
}

/** 官方 BlockAssembler 的最小等价物：只关心文本块与结束原因。 */
class FallbackAssembler {
  constructor() {
    this.text = ''
    this.finish = undefined
  }

  push(chunk) {
    if (chunk === null || typeof chunk !== 'object') return
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') this.text += chunk.text
    else if (chunk.type === 'block-end' && chunk.block !== null && typeof chunk.block === 'object' && chunk.block.type === 'text') {
      if (this.text === '') this.text = String(chunk.block.text || '')
    } else if (chunk.type === 'finish') this.finish = chunk.reason
  }

  blocks() {
    return [{ type: 'text', text: this.text }]
  }
}

/** 单次调用超时信号（Node 18+ 有 AbortSignal.timeout）。 */
function makeTimeoutSignal(ms) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  } catch { /* 退化为无超时 */ }
  return null
}
