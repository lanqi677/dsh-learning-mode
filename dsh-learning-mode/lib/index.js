/**
 * dsh-learning-mode — 宿主侧插件（node 平面）
 *
 * 职责：
 *   1. 注册 8 个学习清单工具（outline_*）；
 *   2. 注册静态规则段（systemPrompt.section）；
 *   3. 注册动态状态段（systemPrompt.context）——每轮自动带上"焦点 + 摘要 + 待办"；
 *   4. agent/created 时把会话标记为学习模式并绑定上次使用的树；
 *   5. 摘要管道：标完成 / 切换焦点时用 ctx.llm 自动写 node.note（异步、不阻塞）；
 *   6. 为浏览器面板注册一个 RPC 端点（树 / 复习 / 摘要重写）。
 *
 * 隔离：本插件只写进"学习模式"这个 agent 预设的 agent.cordis.yml，
 * 因此它的工具 / 提示段 / 监听器都只对使用该预设的会话生效
 * （scope 过滤派发），普通会话完全看不到。
 *
 * 挂载纪律：apply() 里不做任何同步 I/O —— 只注册。磁盘读取全部走 init()
 * 的异步 Promise；llm / sessions / agentDefaultModel 一律用 ctx.get() 惰性取，
 * 避免"某个辅助服务缺席 = 整个预设挂不上 = 学习模式开不了会话"。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  LearningStore,
  countNodes,
  findNode,
  parentOfPath,
  pathOf,
  snapshotNodes,
  renderTreeLines,
} from './store.js'
import { SummaryPipeline } from './summary.js'

export const name = 'dsh-learning-mode'
export const inject = ['tools', 'systemPrompt']

const RPC_PATH = '/api/learning-mode/rpc'

/**
 * 所有工具的统一输出声明：单纯的字符串正文。
 * defineTool 要求 output.schema + output.render（缺了会在挂载时直接抛错，
 * 那会连带让整个「学习模式」预设无法创建会话——已在 test/probe.mjs 里验过）。
 */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
}
const SECTION_ORDER = 8500

const RULES = [
  '# 学习模式（当前会话已开启）',
  '',
  '本会话有一棵「学习树」：节点=知识点，用户在右侧面板聚焦/标完成，每个节点带一句摘要。',
  '',
  '## 第一优先级：静默整理（用户不想为"记笔记"操心）',
  '- 每次解答完一个问题后，把**这个问题引入的知识点**用 `outline_capture` 挂到**当前聚焦节点**下面。',
  '- **`outline_capture` 不搬焦点**（默认就是不动）：焦点＝"用户在看哪"，**只有用户能改变它**（面板点击，或用户的话明确指向别的节点）。你顺手整理时如果搬了焦点，用户的"我在哪"就被你的列举牵着走了。',
  '- **焦点什么时候该动**：① 用户的话明确指向某个**已有节点** → 先 `outline_focus` 它再回答；② 用户这一问的主题就是一个**新知识点**（他问的就是它）→ `outline_capture({ focus: true })`。除此之外都不动焦点。',
  '- **子概念只点到为止**：回答的主体永远是当前聚焦节点。顺带引入的子概念挂上去 + 一两句交代"它是什么、为什么在这儿"就够了，**不要**在同一条回答里替用户把它展开成完整的一节——他想深入会自己点进去或问你。',
  '- **发散优先于体系**：用户由「数组」问到「计算机地址」，就把「计算机地址」挂在「数组」下面（即使它是前置知识），**不要**为了"体系正确"挪到别处——树记录的是当时的思路路径。',
  '- **不要向用户报告**：不写"已添加 X"、不复述树、不问要不要记录。只有确实引入了新知识点才 capture；寒暄、元问题、纯确认不 capture。',
  '- 一轮最多 capture 一个节点，不要为了整齐批量补全。',
  '- **摘要不用你写**：只有用户点 [✓ 学会]（或你调 `outline_done`）时，插件才会自动生成摘要。不要在聊天里替用户总结、也不要为了摘要而标完成。',
  '',
  '## 元决策：一律用 ask_user_question 出选项，不要用对话来回问',
  '- 选哪棵树 / 要不要新建 / 树叫什么 这类**与学习内容无关**的确认，**必须**用 `ask_user_question` 给结构化选项'
    + '（第一个＝你推荐的那项，label 后加「(Recommended)」），让用户一点就完，用户也可以自己填。',
  '- 理由（用户的明确要求）：这些往返会在上下文里留下噪音、也让用户分心。**不要**用普通对话问、不要聊两轮才定下来。',
  '- 只有"必须澄清才能继续"的**学习内容**问题，才用普通方式问。',
  '',
  '## 其它',
  '1. **用户的话没指明对象时（"介绍/讲讲/继续/详细说说/然后呢"），说的就是当前聚焦节点**——不要跳到"这一层还没学完"里别的知识点，也不要反过来问"你想了解哪个"（除非确实没有聚焦节点）。',
  '2. 用户问"X 要学什么"：先 `outline_show` 查重 → `outline_add` 只补缺失 → 1-2 句说明，不复述整棵树。',
  '3. 用户说"学完了"：`outline_done`（可带一句 note）。你自己判断的先问一句。',
  '4. 改结构（改名/移位/删除）用 `outline_update`，不要重建已有节点。',
  '5. 不要为"整齐"重构已有树。',
  '6. 用户说"复习 / 我学过什么"：`outline_review` 读摘要，按摘要复述要点，不要重讲。',
  '7. 节点地址=标题路径，例如 "数据结构/数组/计算机地址"；标题里可能自带 `/`（如"插入/删除"），照原样写即可。',
].join('\n')

const USAGE = [
  '① 直接问我：「我要学 Java，要学什么」——清单会自动长到上面的树里。',
  '② 你问什么、我答什么，树就顺着**你的思路**往下长：由「数组」问出「计算机地址」，它就挂在数组下面，不按教科书目录摆放。',
  '③ 点节点标题 = 聚焦（之后的对话围绕这个节点）；点 [⟳] 让模型重写该节点摘要。',
  '④ 点 [✓ 学会] 标记完成：会写一句复习摘要，**并自动回到上一层**（父节点）——钻进概念学完就能原地返回。',
  '⑤ 点 [复习] 看已完成知识点 + 摘要——不用翻聊天记录。',
  '⑥ 想改名 / 挪位置 / 删除，直接跟我说，不要手动改文件。',
  '⑦ 顶部下拉框可以切换 / 新建学习树。',
].join('\n')

function rootDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'learning-mode')
}

/**
 * 同层其它知识点的标题（≤10 条）。
 * 给摘要模型划边界用："原料里讲到这些的时候，讲的是别人，别写进来"——
 * AI 一口气用 `## 1./## 2.…` 讲完 6 个前置概念时，这是把摘要钉在该子节点上的关键信息。
 */
function siblingTitles(tree, node) {
  try {
    const path = pathOf(tree, node.id)
    if (path === null) return []
    const parentPath = parentOfPath(path)
    const parent = parentPath === '' ? null : findNode(tree, parentPath)
    const list = parent === null ? tree.nodes : parent.children
    return list
      .filter((n) => n !== null && n.id !== node.id && typeof n.title === 'string')
      .map((n) => n.title)
      .slice(0, 10)
  } catch {
    return []
  }
}

function sessionIdOf(exec) {
  const agent = exec === undefined || exec === null ? undefined : exec.agent
  if (agent !== undefined && agent !== null && agent.session !== undefined && agent.session !== null) {
    const id = agent.session.id
    if (typeof id === 'string' && id !== '') return id
  }
  return ''
}

/** 取工具调用里的活会话对象（只读；摘要管道要它的消息事件）。 */
function sessionOfExec(exec) {
  if (exec === undefined || exec === null) return undefined
  if (exec.agent === undefined || exec.agent === null) return undefined
  return exec.agent.session
}

/** 倒扫上限（防御性）：日志里每个 step/tool 事件都带 turn，正常几步就命中。 */
const ORIGIN_SCAN_MAX = 400
let originDiagLogged = false

/**
 * 从活会话的事件日志里倒着找**最近一个带 `turn` 的事件** → 当前所在的那一轮。
 *
 * 为什么不从 exec/agent 上取"当前 turn"：那是内部字段，没写进任何对外契约；
 * 而事件日志是框架保证的（Session.get seq() / eventAt(seq)，host Service 契约里写着），
 * 事件的 `data.turn` 也是 SessionEventMap 明写的。所以这条路只用公开契约。
 *
 * @returns { turn, seq, time } | null —— 拿不到就 null（面板于是不给 ↩ 按钮）
 */
function sessionOrigin(session, store) {
  const diag = (msg) => {
    if (originDiagLogged) return
    originDiagLogged = true
    logRpc(store, 'origin diag: ' + msg)
  }
  try {
    if (session === null || session === undefined) return null
    if (typeof session.eventAt !== 'function') { diag('session 没有 eventAt'); return null }
    const last = Math.floor(Number(session.seq))
    if (!Number.isFinite(last) || last <= 0) { return null }
    for (let seq = last; seq > 0 && seq > last - ORIGIN_SCAN_MAX; seq -= 1) {
      const ev = session.eventAt(seq)
      if (ev === null || ev === undefined) continue
      const data = ev.data
      const turn = data !== null && typeof data === 'object' ? Number(data.turn) : NaN
      if (Number.isFinite(turn)) {
        return { turn: Math.floor(turn), seq, time: new Date(Number(ev.time) || Date.now()).toISOString() }
      }
    }
    diag('倒扫 ' + ORIGIN_SCAN_MAX + ' 条也没找到带 turn 的事件')
    return null
  } catch (err) {
    diag('扫描会话失败: ' + String(err !== null && err !== undefined && err.message ? err.message : err))
    return null
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try { resolve(JSON.parse(text)) } catch (err) { reject(err) }
    })
    request.on('error', reject)
  })
}

function textOf(result) {
  return JSON.stringify(result, null, 2)
}

export function apply(ctx) {
  const store = new LearningStore(rootDir())
  let ready = false
  const readyPromise = Promise.resolve()
    .then(() => store.init())
    .then(() => { ready = true })
    .catch(() => { ready = true })
  const awaitReady = () => (ready ? Promise.resolve() : readyPromise)

  /** 辅助服务的惰性读取：缺席时返回 undefined，绝不抛错。 */
  const optional = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  const pipeline = new SummaryPipeline({
    store,
    getLlm: () => optional('llm'),
    getDefaultModel: () => optional('agentDefaultModel'),
    getSessions: () => optional('sessions'),
    log: (line) => logRpc(store, line),
  })

  /**
   * 触发一次摘要（永远 fire-and-forget）。
   * @param session 活会话对象（只读其事件，不保存）
   * @param pathOverride 要总结的节点路径；缺省用当前焦点
   */
  const triggerNote = (session, sid, reason, pathOverride, options) => {
    const opts = options === undefined || options === null ? {} : options
    try {
      if (!ready) return
      const binding = store.binding(sid)
      if (binding === null || typeof binding.treeId !== 'string') return
      const path = typeof pathOverride === 'string' && pathOverride !== ''
        ? pathOverride
        : (typeof binding.focus === 'string' ? binding.focus : '')
      if (path === '') return
      const tree = store.readTree(binding.treeId)
      if (tree === null) return
      const node = findNode(tree, path)
      if (node === null) return
      // 原料窗口：调用方给就用（标完成时给的是"该节点最后进入时间"）；
      // 否则一律走 store.windowStart 的三级兜底（自己 → 最近进过的祖先 → 节点创建时间）。
      // ⚠️ 不要退回 focusSince：面板上给"从没聚焦过的子节点"重写摘要时会退化成整场会话。
      let sinceMs = typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs) ? opts.sinceMs : null
      if (sinceMs === null) sinceMs = store.windowStart(sid, node.id)
      pipeline.schedule({
        sessionId: sid,
        session,
        treeId: binding.treeId,
        path,
        title: node.title,
        siblings: siblingTitles(tree, node),
        reason,
        sinceMs,
        // fresh = 丢掉旧摘要重写（面板 [⟳] 用它）。默认走增量合并：同一个知识点
        // 以后又学了一遍，新结论应该**叠加**在旧结论上，而不是把它冲掉。
        existingNote: opts.fresh === true ? '' : (node.note || ''),
        force: opts.force === true,
      })
    } catch { /* 摘要永远不影响主流程 */ }
  }

  /**
   * 标记完成 / 撤销完成的**唯一入口**（面板 ✓ 与 outline_done 共用）。
   *
   * 顺序按用户确认过的语义：读窗口 → 写状态 → 触发摘要 → 再搬焦点。
   * 搬焦点规则：完成的正是当前焦点节点、且它有父节点 → 焦点自动**上移到父节点**
   * （这就是"返回原来的地方"，不需要焦点栈）；顶层节点、非焦点节点、撤销完成都不搬。
   */
  /**
   * 把"当前这一轮对话"记到这个节点上 —— 「↩ 跳回讲这个的那轮」唯一的数据来源。
   *
   * 无感原则：它只是**附加信息**，失败绝不能让 capture / 标完成本身失败；
   * 但也绝不静默（写一行 rpc.log），否则又会变成"功能死了没人知道"。
   */
  const stampOrigin = async (session, sid, path, why) => {
    try {
      if (typeof path !== 'string' || path === '') return null
      const at = sessionOrigin(session, store)
      if (at === null) return null
      const result = await store.markOrigin(sid, path, { sid, turn: at.turn, seq: at.seq, time: at.time, why })
      if (result !== null && result !== undefined && typeof result.error === 'string') {
        logRpc(store, 'origin skipped(' + why + '): ' + result.error)
      }
      return result
    } catch (err) {
      logRpc(store, 'origin failed(' + why + '): ' + String(err !== null && err !== undefined && err.message ? err.message : err))
      return null
    }
  }

  const completeNode = async (session, sid, target, status, note) => {
    const result = await store.setStatus(sid, target, status, note)
    if (result === null || result === undefined || typeof result.error === 'string') return result
    // 标完成的这一刻，用户【正在】跟模型讨论这个知识点 → 这一轮就是它的来源之一
    await stampOrigin(session, sid, result.path, 'done')
    if (result.needsNote === true) {
      triggerNote(session, sid, 'done', result.path, { sinceMs: result.windowStartMs })
    }
    if (status === 'done' && result.isFocus === true && result.parentPath !== '') {
      try { await store.setFocus(sid, result.parentPath) } catch { /* 搬焦点失败不影响完成 */ }
    }
    return result
  }

  // ── 1. 静态规则段（对本预设的每个 agent 生效） ───────────────────────────
  ctx.systemPrompt.section({
    name: 'learning-mode:rules',
    order: SECTION_ORDER,
    text: RULES,
    interpolate: false,
  })

  // ── 2. 动态状态段：焦点 / 摘要 / 待办（数据未就绪时返回空串，不注入噪声） ──
  //
  //  ⚠️⚠️ 这里只能从**装配上下文参数** `context.agent` 拿会话（框架每次 assemble 都会传：
  //  `assembleContextFor(agent)` → `{ agent, scope, signal }`；官方 sandbox-policy /
  //  user-approval 都是这么写的）。**绝对不要碰 `ctx.agents`** —— 它没写进 `inject`，
  //  真实 Cordis 代理会抛 `cannot get property "agents" without inject`。
  //
  //  真机事故（本插件至今最严重的一个）：这里原来写的是 `ctx.agents.currentInitiator()`，
  //  外面套一个裸 `catch { return '' }`，于是"每轮自动注入焦点/摘要/待办"这个**核心功能在
  //  真机上静默失效了好几轮**——面板点了聚焦，模型那头什么都没收到，答的自然是别的东西。
  //  单测没发现是因为测试桩把 `agents` 直接塞成了普通属性，比真实运行时宽松。
  //
  //  教训落地为两条：① 只走框架保证的契约；② 异常**不许静默**，按原因记一次 rpc.log。
  const injectDiag = new Set()
  const noteInjectDiag = (reason) => {
    if (injectDiag.has(reason)) return
    injectDiag.add(reason)
    try { logRpc(store, 'inject diag: ' + reason) } catch { /* 记日志失败也不能影响注入 */ }
  }
  ctx.systemPrompt.context({
    name: 'learning-mode:state',
    order: SECTION_ORDER,
    text: (context) => {
      try {
        if (!ready) { noteInjectDiag('not-ready'); return '' }
        let agent = context !== null && typeof context === 'object' ? context.agent : undefined
        if (agent === undefined || agent === null) {
          // 兜底：极少数装配路径可能不带 agent 参数（其它插件手动 assemble）。
          // 走到这里只说明契约有变，不是死路——用服务注册表再试一次，并留痕。
          const registry = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
          agent = registry !== undefined && registry !== null && typeof registry.currentInitiator === 'function'
            ? registry.currentInitiator()
            : undefined
          noteInjectDiag(agent === undefined || agent === null ? 'no-agent' : 'agent-from-registry-fallback')
        }
        const sid = agent !== undefined && agent !== null && agent.session ? agent.session.id : ''
        if (typeof sid !== 'string' || sid === '') { noteInjectDiag('no-session-id'); return '' }
        const block = store.contextText(sid)
        if (block === '') { noteInjectDiag('empty-block:' + sid); return '' }
        return block
      } catch (error) {
        const message = String(error !== null && error !== undefined && error.message ? error.message : error).slice(0, 120)
        noteInjectDiag('throw:' + message)
        return ''
      }
    },
  })

  /**
   * 学习会话里屏蔽**开发向工具**（super-injector 的 `dev_*`）。
   *
   * 实测：62 个工具里有 18 个 `dev_*`，占工具 schema **5567 字符（14.5%，约 1.4k token）**，
   * 每轮都在花；而且它们会诱导学习会话的模型想着"去改插件"。
   * 屏蔽是**按 agent 作用域**的（`tools.restrict`）：全局注册不受影响，
   * 用户在 cordis 预设里照常能用注入器。
   * 失败绝不影响学习模式本体，只留一条 `rpc.log`（`deny-dev-tools*`）。
   */
  const DEV_TOOL_PREFIX = 'dev_'
  const denyDevTools = (agent) => {
    try {
      const agentCtx = agent !== null && agent !== undefined && agent.ctx !== undefined ? agent.ctx : null
      const fromAgent = agentCtx !== null && typeof agentCtx.get === 'function' ? agentCtx.get('tools') : undefined
      // 兜底：本插件自己声明的 tools 服务（作用域可能不是 agent，restrict 会因此报错并被下面的 catch 记下）
      const svc = fromAgent !== undefined && fromAgent !== null ? fromAgent : optional('tools')
      if (svc === null || svc === undefined || typeof svc.restrict !== 'function' || typeof svc.schemas !== 'function') return
      const schemas = svc.schemas()
      const deny = (Array.isArray(schemas) ? schemas : [])
        .map((s) => (s !== null && typeof s === 'object' && typeof s.name === 'string' ? s.name : ''))
        .filter((name) => name.startsWith(DEV_TOOL_PREFIX))
      if (deny.length === 0) return
      svc.restrict({ deny })
      noteInjectDiag('deny-dev-tools:' + deny.length)
    } catch (error) {
      const message = String(error !== null && error !== undefined && error.message ? error.message : error).slice(0, 120)
      noteInjectDiag('deny-dev-tools-failed:' + message)
    }
  }

  // ── 3. 会话进入学习模式：标记 + 绑定上次使用的树 ────────────────────────
  ctx.effect(() => ctx.on('agent/created', (payload) => {
    const agent = payload !== undefined && payload !== null && payload.agent !== undefined ? payload.agent : payload
    const sid = agent !== undefined && agent !== null && agent.session ? agent.session.id : ''
    if (typeof sid !== 'string' || sid === '') return
    denyDevTools(agent)
    void (async () => {
      try {
        await awaitReady()
        await store.markEnabled(sid)
        await store.autoBind(sid)
      } catch (error) {
        // 绑定失败 → 注入块整段为空、面板也不会亮。以前这里同样是静默的，
        // 留一条痕，免得下次又是"看起来没坏、其实整个功能没工作"。
        const message = String(error !== null && error !== undefined && error.message ? error.message : error).slice(0, 120)
        noteInjectDiag('bind-failed:' + message)
      }
    })()
  }), 'learning-mode: session binding')

  /**
   * 每轮对话**结束时**，把"当前聚焦的节点"记成本轮的来源。
   *
   * 用户定的语义：「对话1 建了 a/b/c/d（都指向对话1）；对话2 聚焦了 a → a 的跳转改为对话2」。
   *
   * 为什么不写在"聚焦那一刻"（面板点选 / outline_focus）：
   *   ① 面板点选发生在**提问之前** —— 那一刻会话日志里最后一个 turn 还是**上一轮**，
   *      照它记会把 a 指到上一轮（那一轮聊的可能是别的），跳过去正好跳错；
   *      turn-stopping 的 `payload.turn` 才是**这一轮**。
   *   ② 不该指望模型每次都老实调 outline_focus（规则里要求了，但那只是规则）。
   *
   * 已知代价（接受，写在这里免得后人当 bug）：一轮里如果聊的是别的事，聚焦节点也会被记上这一轮；
   * 但一轮最多记一个节点，且列表"最新在前、最多 3 条"，下一次真正讨论会把它盖掉。
   */
  ctx.effect(() => ctx.on('agent/turn-stopping', (payload) => {
    try {
      const agent = payload === null || payload === undefined ? null : payload.agent
      const session = agent === null || agent === undefined ? null : agent.session
      const sid = session === null || session === undefined ? '' : session.id
      if (typeof sid !== 'string' || sid === '') return
      const binding = store.binding(sid)
      if (binding === null || typeof binding.focus !== 'string' || binding.focus === '') return
      const turn = Math.floor(Number(payload.turn))
      if (!Number.isFinite(turn)) return
      // seq 用会话当前最后一个事件号（就在这一轮里）；拿不到就退回倒扫事件日志
      let seq = Math.floor(Number(session.seq))
      if (!Number.isFinite(seq)) {
        const scanned = sessionOrigin(session, store)
        seq = scanned === null ? 0 : scanned.seq
      }
      if (!Number.isFinite(seq) || seq <= 0) return
      void store.markOrigin(sid, binding.focus, {
        sid,
        turn,
        seq,
        time: new Date().toISOString(),
        why: 'turn',
      }).catch(() => { /* 记来源失败绝不影响对话 */ })
    } catch { /* 同上：附加信息不许影响主流程 */ }
  }), 'learning-mode: stamp focus origin at turn end')

  // ── 4. 工具 ────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'outline_projects',
    output: TEXT_OUTPUT,
    description: '列出所有学习树，以及当前会话绑定的是哪一棵。用于首轮确认要学哪棵树。',
    parameters: {},
    async execute(_args, exec) {
      await awaitReady()
      const sid = sessionIdOf(exec)
      const binding = store.binding(sid)
      return textOf({
        current: binding === null ? null : { treeId: binding.treeId, focus: binding.focus || '' },
        trees: store.listTrees().map((t) => {
          const tree = store.readTree(t.id)
          const stat = tree === null ? { total: 0, done: 0 } : countNodes(tree.nodes)
          return { id: t.id, title: t.title, done: stat.done, total: stat.total, lastUsedAt: t.lastUsedAt }
        }),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'outline_open',
    output: TEXT_OUTPUT,
    description: '把当前会话绑定到某一棵学习树；或新建一棵树并绑定。首次使用学习模式时先调用它。',
    parameters: {
      project: { type: 'string', description: '已有树的 id 或标题。与 new 二选一。' },
      new: { type: 'string', description: '新建一棵树并绑定，值为树名（例如 "Java"）。与 project 二选一。' },
    },
    async execute(args, exec) {
      await awaitReady()
      const sid = sessionIdOf(exec)
      if (typeof args.new === 'string' && args.new.trim() !== '') {
        const tree = await store.createTree(args.new)
        await store.switchTree(sid, tree.id)
        await store.markOpened(sid)
        return textOf({ ok: true, created: { id: tree.id, title: tree.title } })
      }
      if (typeof args.project === 'string' && args.project.trim() !== '') {
        const wanted = args.project.trim()
        const hit = store.listTrees().find((t) => t.id === wanted || t.title === wanted)
        if (hit === undefined) return textOf({ ok: false, error: '找不到学习树：' + wanted })
        await store.switchTree(sid, hit.id)
        await store.markOpened(sid)
        return textOf({ ok: true, opened: { id: hit.id, title: hit.title } })
      }
      return textOf({ ok: false, error: '请提供 project（已有树）或 new（新建树）' })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'outline_show',
    output: TEXT_OUTPUT,
    description: '读取当前学习树的清单。**建树前必须先调用它查重。** 返回缩进清单：[ ]未完成 [>]进行中 [x]已完成。',
    parameters: {
      path: { type: 'string', description: '可选：只看某个节点下的子树，例如 "Java/对象"。省略则看整棵树。' },
      include_done: { type: 'boolean', description: '是否包含已完成节点，默认 true。' },
    },
    async execute(args, exec) {
      await awaitReady()
      const binding = store.binding(sessionIdOf(exec))
      if (binding === null || typeof binding.treeId !== 'string') return '尚未绑定学习树。先调用 outline_projects 看看有没有现成的树，或 outline_open 新建。'
      const tree = store.readTree(binding.treeId)
      if (tree === null) return '学习树文件缺失：' + binding.treeId
      const from = typeof args.path === 'string' && args.path.trim() !== '' ? findNode(tree, args.path) : null
      const nodes = from === null ? tree.nodes : from.children
      const lines = renderTreeLines(nodes, { includeDone: args.include_done !== false, maxDepth: 6 })
      const stat = countNodes(tree.nodes)
      const head = '树：' + tree.title + '（已完成 ' + stat.done + '/' + stat.total + '）'
      if (lines.length === 0) return head + '\n(空)'
      return head + '\n' + lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'outline_add',
    output: TEXT_OUTPUT,
    description: '在学习树的某个节点下追加子项（幂等：同名兄弟已存在会跳过并回报）。parent 省略表示加在根上。',
    parameters: {
      parent: { type: 'string', description: '父节点标题路径，例如 "Java/对象"。省略表示加在根上。' },
      items: { type: 'array', items: { type: 'string' }, required: true, description: '要新增的子项标题列表。' },
    },
    async execute(args, exec) {
      await awaitReady()
      const items = Array.isArray(args.items) ? args.items : []
      if (items.length === 0) return 'items 为空，没有新增。'
      const result = await store.addNodes(sessionIdOf(exec), typeof args.parent === 'string' ? args.parent : '', items)
      return textOf(result)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'outline_update',
    output: TEXT_OUTPUT,
    description: '调整学习树结构：改名、挪位置、删除。用户要求整理结构时使用，不要重建节点。',
    parameters: {
      node: { type: 'string', required: true, description: '目标节点标题路径，例如 "Java/对象/私有"。' },
      rename: { type: 'string', description: '改成的新闻标题。' },
      move_to: { type: 'string', description: '移动到哪个父节点下（标题路径；空字符串表示移到根）。' },
      delete: { type: 'boolean', description: '为 true 时删除该节点及其子树。' },
    },
    async execute(args, exec) {
      await awaitReady()
      const changes = {}
      if (typeof args.rename === 'string') changes.rename = args.rename
      if (typeof args.move_to === 'string') changes.moveTo = args.move_to
      if (args.delete === true) changes.delete = true
      if (Object.keys(changes).length === 0) return '没有指定任何修改（rename / move_to / delete）。'
      const result = await store.updateNode(sessionIdOf(exec), String(args.node || ''), changes)
      return textOf(result)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'outline_capture',
    output: TEXT_OUTPUT,
    description: '把刚学到的知识点就地挂进学习树：默认挂在**当前聚焦节点**下面，**焦点留在原地不动**（焦点＝用户在看哪，只有用户能改变它）。这是"无感整理"用的工具——顺着用户当时的思路挂，不必符合知识体系；同名节点自动复用。输出极简，不要向用户复述。',
    parameters: {
      title: { type: 'string', required: true, description: '知识点标题，尽量短，例如 "计算机地址"。' },
      under: { type: 'string', description: '可选：显式指定父节点标题路径。省略 = 当前聚焦节点。' },
      focus: { type: 'boolean', description: '默认 false＝只挂节点、不动焦点。**只有"用户这一问的主题就是它"**（他问的就是这个新知识点，你替他移动视线）时才传 true；节点已存在时改用 outline_focus。' },
    },
    async execute(args, exec) {
      await awaitReady()
      const sid = sessionIdOf(exec)
      const result = await store.capture(
        sid,
        String(args.title || ''),
        typeof args.under === 'string' ? args.under : undefined,
        args.focus === true,
      )
      if (result !== null && result.error !== undefined) return 'error: ' + result.error
      // 记来源：AI 新建这个知识点时，用户【正在】问它 → 这一轮就是它的出处
      await stampOrigin(sessionOfExec(exec), sid, result.path, 'capture')
      // 注意：把焦点搬到新节点**不**触发摘要（同上）。这里只负责"挂 + 跟着往下走"。
      // 极简回执：工具结果是每轮上下文的一部分，不要在这里灌树
      return (result.created === true ? 'captured: ' : 'exists: ') + result.path
    },
  }))

  ctx.tools.register(defineTool({
    name: 'outline_done',
    output: TEXT_OUTPUT,
    description: '把某个知识点标记为学会 / 取消学会，可附带一句摘要（note）留作复习。不带 note 时插件会自动生成摘要。',
    parameters: {
      node: { type: 'string', required: true, description: '节点标题路径。' },
      note: { type: 'string', description: '可选：这次学到的核心结论 / 易错点，供以后复习。不填则由插件自动总结。' },
      undo: { type: 'boolean', description: '为 true 时取消完成状态。' },
    },
    async execute(args, exec) {
      await awaitReady()
      const sid = sessionIdOf(exec)
      const status = args.undo === true ? 'todo' : 'done'
      const result = await completeNode(sessionOfExec(exec), sid, String(args.node || ''), status, typeof args.note === 'string' ? args.note : '')
      return textOf(result)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'outline_focus',
    output: TEXT_OUTPUT,
    description: '切换当前聚焦的知识点（等价于用户在面板里点某个节点）。之后的对话围绕它展开。',
    parameters: {
      node: { type: 'string', required: true, description: '节点标题路径；传 "根" 或空字符串表示回到整棵树。' },
    },
    async execute(args, exec) {
      await awaitReady()
      const sid = sessionIdOf(exec)
      const raw = String(args.node || '')
      const path = raw === '根' || raw === '(根)' ? '' : raw
      const binding = store.binding(sid)
      if (binding !== null && typeof binding.treeId === 'string' && path !== '') {
        const tree = store.readTree(binding.treeId)
        if (tree !== null && findNode(tree, path) === null) return textOf({ ok: false, error: '找不到节点：' + path })
      }
      await store.setFocus(sid, path)
      // 注意：**不**在离开旧节点时生成摘要。
      // 用户确认过：摘要只在他点 [✓ 学会] 时生成——钻进一个概念时不该顺手总结上一节，
      // 而且每次切焦点都打一次 10~27 秒的模型调用会拖慢主对话。
      return textOf({ ok: true, focus: path })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'outline_review',
    output: TEXT_OUTPUT,
    description: '复习视图：列出当前学习树里已完成的知识点及其摘要（按完成时间倒序）。用户说"复习 / 我之前学过什么"时用。',
    parameters: {
      limit: { type: 'number', description: '最多返回多少条，默认 30。' },
      missing_note_only: { type: 'boolean', description: '为 true 时只列"已完成但没有摘要"的节点。' },
    },
    async execute(args, exec) {
      await awaitReady()
      const view = store.review(sessionIdOf(exec))
      if (view.tree === null) return '尚未绑定学习树。'
      let items = view.items
      if (args.missing_note_only === true) items = items.filter((item) => item.note === '')
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 30
      const shown = items.slice(0, limit)
      const head = '树：' + view.tree.title + '（已完成 ' + view.stats.done + '/' + view.stats.total
        + '，其中有摘要 ' + view.stats.withNote + '）'
      if (shown.length === 0) return head + '\n(还没有已完成的知识点)'
      const lines = shown.map((item, index) => {
        const when = typeof item.doneAt === 'string' && item.doneAt.length >= 10 ? item.doneAt.slice(0, 10) : '—'
        const note = item.note === '' ? (item.noteState === 'pending' ? '(摘要生成中/待补)' : '(无摘要)') : item.note
        return (index + 1) + '. ' + item.path + '（' + when + '）\n   ' + note
      })
      return head + '\n' + lines.join('\n')
    },
  }))

  // ── 5. 面板 RPC（仅 web 组合存在 webServer；headless 静默跳过） ──────────
  ctx.inject(['webServer', 'sessions'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: RPC_PATH,
      handler: (request, response) => handleRpc(scope, store, awaitReady, { triggerNote, completeNode, stampOrigin }, request, response),
    }), 'learning-mode: rpc route')
  })
}

/**
 * 面板每次调用都落一行日志：这是"浏览器半边到底有没有运行"的离线判据。
 * 有日志 = 客户端模块已加载并跑起来了；没有 = 模块压根没被加载。
 */
function logRpc(store, line) {
  try {
    appendFileSync(join(store.root, 'rpc.log'), new Date().toISOString() + ' ' + line + String.fromCharCode(10), 'utf8')
  } catch { /* 诊断日志失败绝不影响主流程 */ }
}

async function handleRpc(scope, store, awaitReady, hooks, request, response) {
  const respond = (status, body) => {
    response.statusCode = status
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(body))
  }
  let payload
  try {
    payload = await readJsonBody(request)
  } catch {
    return respond(400, { ok: false, error: 'bad-request' })
  }
  const sid = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  logRpc(store, 'op=' + String(payload.op || 'state') + ' session=' + sid.slice(0, 18))
  if (sid === '') return respond(400, { ok: false, error: 'missing-session' })
  const session = scope.sessions.get(sid)
  if (session === undefined) return respond(404, { ok: false, error: 'session-not-found' })
  await awaitReady()
  try {
    return respond(200, await dispatch(store, sid, session, payload, hooks))
  } catch (err) {
    return respond(500, { ok: false, error: String(err !== null && err !== undefined && err.message ? err.message : err) })
  }
}

async function dispatch(store, sid, session, payload, hooks) {
  const op = typeof payload.op === 'string' ? payload.op : 'state'
  if (op === 'state') {
    const binding = store.binding(sid)
    const enabled = binding !== null && binding.enabled === true
    const trees = store.listTrees().map((t) => {
      const tree = store.readTree(t.id)
      const stat = tree === null ? { total: 0, done: 0 } : countNodes(tree.nodes)
      return { id: t.id, title: t.title, total: stat.total, done: stat.done, lastUsedAt: t.lastUsedAt }
    })
    if (!enabled) return { ok: true, enabled: false }
    const tree = binding !== null && typeof binding.treeId === 'string' ? store.readTree(binding.treeId) : null
    return {
      ok: true,
      enabled: true,
      usage: USAGE,
      trees,
      focus: binding !== null && typeof binding.focus === 'string' ? binding.focus : '',
      // seenAt = 该会话上次"看过树"的水位线；面板拿它和节点 createdAt 比，算出新增。
      seenAt: binding !== null && typeof binding.seenAt === 'string' ? binding.seenAt : null,
      tree: tree === null ? null : { id: tree.id, title: tree.title, nodes: snapshotNodes(tree.nodes) },
    }
  }
  if (op === 'review') {
    const view = store.review(sid)
    const limit = typeof payload.limit === 'number' && payload.limit > 0 ? Math.floor(payload.limit) : 200
    return {
      ok: true,
      tree: view.tree,
      stats: view.stats,
      items: view.items.slice(0, limit),
    }
  }
  if (op === 'seen') {
    // 面板打开/关闭时调用：把"已看过"水位线推到 now（payload.at 可显式指定）。
    const stamp = await store.markSeen(sid, typeof payload.at === 'string' ? payload.at : undefined)
    return stamp === null ? { ok: false, error: '尚未绑定学习树' } : { ok: true, seenAt: stamp.seenAt }
  }
  if (op === 'open') {
    const hit = store.listTrees().find((t) => t.id === payload.treeId || t.title === payload.treeId)
    if (hit === undefined) return { ok: false, error: '找不到学习树' }
    await store.switchTree(sid, hit.id)
    await store.markOpened(sid)
    return { ok: true }
  }
  if (op === 'create') {
    const title = typeof payload.title === 'string' && payload.title.trim() !== '' ? payload.title.trim() : '新学习树'
    const tree = await store.createTree(title)
    await store.switchTree(sid, tree.id)
    await store.markOpened(sid)
    return { ok: true, treeId: tree.id }
  }
  if (op === 'focus') {
    // 面板点选带 node id（标题可能含 `/`，路径有歧义）；工具/脚本走路径。
    const target = store.resolvePath(sid, payload.id, payload.path)
    if (target === null) return { ok: false, error: '找不到节点' }
    await store.setFocus(sid, target)
    return { ok: true, focus: target }
  }
  if (op === 'done') {
    const target = store.resolvePath(sid, payload.id, payload.path)
    if (target === null) return { ok: false, error: '找不到节点' }
    const status = payload.done === false ? 'todo' : 'done'
    const result = await hooks.completeNode(session, sid, target, status, typeof payload.note === 'string' ? payload.note : '')
    // 面板拿到回执后会立刻拉一次 state（乐观更新 + 立即刷新），所以这里不必回状态
    return { ok: true }
  }
  if (op === 'note') {
    // 面板上的 [⟳ 重写摘要]：人工强制重跑一次（跳过冷却，不需要先标完成），
    // 且 **fresh**（丢掉旧摘要重写）——你会按这个按钮，通常就是因为这条摘要不对，
    // 而增量合并会把错的那段继续留在里面。
    const target = store.resolvePath(sid, payload.id, payload.path)
    if (target === null) return { ok: false, error: '找不到节点' }
    hooks.triggerNote(session, sid, 'manual', target, { force: true, fresh: true })
    // 人工重写摘要 = 此刻正在讨论这个节点 → 更新来源（面板上的 ↩ 跟着指到这一轮）
    await hooks.stampOrigin(session, sid, target, 'note')
    return { ok: true }
  }
  if (op === 'diag') {
    // 浏览器半边把"它看到的真实环境"写进 rpc.log。
    // 存在的理由：前端 debug 只能靠 console，而 console 不是离线的（这个项目已经栽过
    // 两次"单测全绿、真机是死的"）。有了这条通道，前端 DOM/服务形态就有了**落盘判据**。
    const line = typeof payload.line === 'string' ? payload.line : ''
    if (line !== '') logRpc(store, 'diag: ' + line.slice(0, 600))
    return { ok: true }
  }
  return { ok: false, error: 'unknown-op:' + op }
}
