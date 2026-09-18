/**
 * dsh-learning-mode — 数据层
 *
 * 多棵学习树 + 会话绑定。纯 Node 模块，不依赖 cordis，可独立测试。
 *
 * 目录布局（默认 <DSH_HOME>/learning-mode/）：
 *   index.json          树清单：{ trees: [{id,title,createdAt,lastUsedAt}], lastUsed }
 *   trees/<id>.json     一棵树：{ id, title, nodes: [node...] }
 *   sessions.json       会话绑定：{ <sessionId>: { enabled, treeId, focusId, focusSince } }
 *
 * node: { id, title, status, order, note, noteAt, doneAt, children: [] }
 *
 * 摘要相关字段（v1.1 摘要管道新增，缺省时按空值处理，旧数据无需迁移）：
 *   noteState  'done'（摘要已生成）| 'pending'（生成中/失败待重试）| null（无摘要）
 *   noteTries  失败累计次数（≥3 不再自动重试）
 *   noteError  最近一次失败原因（截断，仅供诊断）
 *   noteSource { sessionId, from, to, reason } —— 摘要原料的溯源窗口
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const STATUS_TODO = 'todo'
export const STATUS_DOING = 'doing'
export const STATUS_DONE = 'done'

export const TUTORIAL_TITLE = '如何使用学习模式'

function nowIso() {
  return new Date().toISOString()
}

export function newId() {
  return 'n' + Math.random().toString(36).slice(2, 10)
}

/** 新建节点的统一形状（新增字段都从这里出去，避免两处写法漂移）。 */
export function newNode(title) {
  return {
    id: newId(),
    title,
    status: STATUS_TODO,
    order: 0,
    note: '',
    noteAt: null,
    noteState: null,
    noteTries: 0,
    noteError: null,
    noteSource: null,
    doneAt: null,
    // 建出来的时间：摘要窗口的兜底起点（内容不可能早于"这个节点被建出来"）。
    createdAt: nowIso(),
    children: [],
  }
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    const raw = readFileSync(file, 'utf8')
    if (raw.trim() === '') return fallback
    return JSON.parse(raw)
  } catch {
    try { renameSync(file, file + '.broken-' + Date.now()) } catch { /* ignore */ }
    return fallback
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

function slug(text) {
  const cleaned = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'tree-' + Math.random().toString(36).slice(2, 6) : cleaned.slice(0, 40)
}

/**
 * 切路径，**保留段内的空格**（"Java：int[] / ArrayList" 里那个空格是标题的一部分）。
 * 只丢掉纯空白的段。
 */
export function rawSegments(path) {
  return String(path || '')
    .split('/')
    .filter((s) => s.trim() !== '')
}

export function splitPath(path) {
  return rawSegments(path).map((s) => s.trim())
}

function matchTitle(nodes, title) {
  const target = String(title).trim()
  const exact = nodes.find((n) => n.title === target)
  if (exact !== undefined) return exact
  const lower = target.toLowerCase()
  return nodes.find((n) => n.title.toLowerCase() === lower) || null
}

/**
 * 按标题路径查节点；path 为空返回 null（代表树根）。
 *
 * ⚠️ **标题里可以带 `/`**（真实数据里就有："插入/删除"、"时间/空间复杂度对照"、
 * "Java：int[] / ArrayList 的取舍"）。早先的实现直接 `split('/')` 逐段匹配，
 * 于是这类节点**永远无法用路径寻址**，症状是：
 *   点面板聚焦 → 焦点写进 sessions.json → 下一轮 findNode(focus) == null
 *   → 注入块里没有"当前节点摘要"，模型只能从【未完成】列表里抓一个话题来答
 *   （实拍：手动聚焦「快慢指针」说"介绍"，被介绍成了「插入/删除是否 O(n)」）。
 *
 * 现在改成**最长段优先 + 回溯**：解析 "链表/插入/删除" 时先试整串，
 * 再试 "链表/插入"，最后落到 "链表"，然后递归时把 "插入/删除" 当成**一个标题**。
 * 因此含斜杠的标题和普通多级路径都能解析，歧义时**长标题优先**。
 */
export function findNode(tree, path) {
  const parts = rawSegments(path)
  if (parts.length === 0) return null
  const resolve = (nodes, from) => {
    for (let take = parts.length - from; take >= 1; take -= 1) {
      const hit = matchTitle(nodes, parts.slice(from, from + take).join('/'))
      if (hit === null) continue
      if (from + take === parts.length) return hit
      const deeper = resolve(hit.children, from + take)
      if (deeper !== null) return deeper
    }
    return null
  }
  return resolve(tree.nodes, 0)
}

/** 按 id 查节点（面板点选走这条，彻底绕开标题歧义）。 */
export function findNodeById(tree, id) {
  const target = String(id || '')
  if (target === '') return null
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.id === target) return node
      const deeper = walk(node.children)
      if (deeper !== null) return deeper
    }
    return null
  }
  return walk(tree.nodes)
}

/** 全树按标题找节点（发散式整理靠它复用同名节点，避免重复建）。 */
export function findAnywhere(tree, title) {
  const target = String(title || '').trim()
  if (target === '') return null
  const lower = target.toLowerCase()
  const walk = (nodes, prefix) => {
    for (const node of nodes) {
      const here = prefix === '' ? node.title : prefix + '/' + node.title
      if (node.title === target || node.title.toLowerCase() === lower) return { node, path: here }
      const deeper = walk(node.children, here)
      if (deeper !== null) return deeper
    }
    return null
  }
  const hit = walk(tree.nodes, '')
  return hit
}

/** "Java/对象/继承" → "Java/对象"；顶层节点 → ""。 */
export function parentOfPath(path) {
  const parts = splitPath(path)
  parts.pop()
  return parts.join('/')
}

/** 节点的标题路径，例如 "Java/对象/继承"。 */
export function pathOf(tree, id) {
  const walk = (nodes, prefix) => {
    for (const node of nodes) {
      const here = prefix === '' ? node.title : prefix + '/' + node.title
      if (node.id === id) return here
      const deeper = walk(node.children, here)
      if (deeper !== null) return deeper
    }
    return null
  }
  return walk(tree.nodes, '')
}

/**
 * 从某节点出发，返回**由近到远**的祖先 id 列表（不含自己）。找不到该 id 时返回 []。
 * 用途：摘要原料窗口的兜底——子节点自己没被聚焦过时，退到"最近进过的祖先"。
 */
export function ancestorIds(tree, id) {
  const walk = (nodes, trail) => {
    for (const node of nodes) {
      if (node.id === id) return trail
      const deeper = walk(node.children, trail.concat(node.id))
      if (deeper !== null) return deeper
    }
    return null
  }
  const trail = walk(tree.nodes, [])
  if (trail === null) return []
  return trail.slice().reverse()
}

/** 递归统计 { total, done }。 */
export function countNodes(nodes) {
  let total = 0
  let done = 0
  for (const node of nodes) {
    total += 1
    if (node.status === STATUS_DONE) done += 1
    const inner = countNodes(node.children)
    total += inner.total
    done += inner.done
  }
  return { total, done }
}

/** 渲染成缩进清单文本（给模型看，紧凑）。 */
export function renderTreeLines(nodes, options) {
  const opts = options || {}
  const includeDone = opts.includeDone !== false
  const maxDepth = typeof opts.maxDepth === 'number' ? opts.maxDepth : 6
  const lines = []
  const walk = (list, depth) => {
    for (const node of list) {
      if (node.status === STATUS_DONE && !includeDone) continue
      const mark = node.status === STATUS_DONE ? '[x]' : node.status === STATUS_DOING ? '[>]' : '[ ]'
      lines.push('  '.repeat(depth) + '- ' + mark + ' ' + node.title)
      if (depth + 1 < maxDepth) walk(node.children, depth + 1)
    }
  }
  walk(nodes, 0)
  return lines
}

/** 面板用的精简快照（含摘要，供 hover）。 */
export function snapshotNodes(nodes) {
  return nodes.map((node) => ({
    id: node.id,
    title: node.title,
    status: node.status,
    note: node.note || '',
    noteAt: node.noteAt || null,
    noteState: node.noteState || (node.note ? 'done' : null),
    // 失败原因也发给面板：hover 提示里能直接看到"为什么没生成出来"（诊断靠它）
    noteError: node.noteError || null,
    doneAt: node.doneAt || null,
    // createdAt 发给面板 → 面板据此算"比上次看过的时间更新的节点"（= 新增标记）
    createdAt: node.createdAt || null,
    // 来源坐标（最新一条）+ 总条数：面板据此渲染「↩ 跳回讲这个的那轮对话」。
    // 没记到来源就是 null —— 面板**不显示** ↩（不给假按钮）。
    origin: Array.isArray(node.origins) && node.origins.length > 0 ? node.origins[0] : null,
    originCount: Array.isArray(node.origins) ? node.origins.length : 0,
    children: snapshotNodes(node.children),
  }))
}

export class LearningStore {
  constructor(root) {
    this.root = root
    this.indexFile = join(root, 'index.json')
    this.sessionsFile = join(root, 'sessions.json')
    this.treesDir = join(root, 'trees')
    this.queue = Promise.resolve()
  }

  /** 所有写操作串行化（同一进程内），避免并发写坏文件。 */
  _serial(fn) {
    const next = this.queue.then(fn, fn)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  _treeFile(id) {
    return join(this.treesDir, id + '.json')
  }

  _index() {
    const raw = readJson(this.indexFile, { trees: [], lastUsed: null })
    if (!Array.isArray(raw.trees)) raw.trees = []
    return raw
  }

  _sessions() {
    return readJson(this.sessionsFile, {})
  }

  readTree(id) {
    return readJson(this._treeFile(id), null)
  }

  listTrees() {
    return this._index().trees
  }

  binding(sessionId) {
    const sessions = this._sessions()
    return sessions[sessionId] || null
  }

  /** 首次使用：没有任何树时建一棵"如何使用学习模式"教程树。 */
  init() {
    return this._serial(() => {
      const index = this._index()
      if (index.trees.length === 0) {
        const tree = buildTutorialTree()
        writeJson(this._treeFile(tree.id), tree)
        index.trees.push({ id: tree.id, title: tree.title, createdAt: tree.createdAt, lastUsedAt: tree.createdAt })
        index.lastUsed = tree.id
        writeJson(this.indexFile, index)
      }
      return index
    })
  }

  /** 会话被标记为学习模式（agent/created 时调用）。 */
  markEnabled(sessionId) {
    return this._serial(() => {
      const sessions = this._sessions()
      const current = sessions[sessionId] || {}
      // seenAt = "这个会话上次看过这棵树"的水位线（比它新的节点算新增）。
      // 首次进入时种成 now：旧节点不该一上来就满屏 NEW。
      sessions[sessionId] = { ...current, enabled: true, seenAt: typeof current.seenAt === 'string' ? current.seenAt : nowIso() }
      writeJson(this.sessionsFile, sessions)
      return sessions[sessionId]
    })
  }

  /** 默认绑定上次用的树；没有则用教程树。 */
  autoBind(sessionId) {
    return this._serial(() => {
      const sessions = this._sessions()
      const current = sessions[sessionId] || {}
      if (typeof current.treeId === 'string' && this.readTree(current.treeId) !== null) return current
      const index = this._index()
      const fallback = index.lastUsed || (index.trees[0] ? index.trees[0].id : null)
      // focus 必须一起清空：旧焦点是**另一棵树**里的路径，留着会让注入块显示一个
      // 本树不存在的焦点（旧版 bug）。
      sessions[sessionId] = { ...current, enabled: true, treeId: fallback, focus: '', focusId: null, focusSince: null, seenAt: nowIso() }
      writeJson(this.sessionsFile, sessions)
      return sessions[sessionId]
    })
  }

  /**
   * 面板"已看过"水位线：把 seenAt 推到 `at`（缺省 now）。
   * 面板打开/关闭时各调一次——打开时先清按钮红点，关闭时把"开着期间新增的"也一并划掉，
   * 于是"关掉再开，新增标记自然消失"（标记是算出来的，不是存出来的）。
   */
  markSeen(sessionId, at) {
    return this._serial(() => {
      const sessions = this._sessions()
      const current = sessions[sessionId]
      if (current === undefined || typeof current.treeId !== 'string') return null
      const stamp = typeof at === 'string' && at !== '' ? at : nowIso()
      sessions[sessionId] = { ...current, seenAt: stamp }
      writeJson(this.sessionsFile, sessions)
      return sessions[sessionId]
    })
  }

  createTree(title) {
    return this._serial(() => {
      const index = this._index()
      const base = slug(title)
      let id = base
      let n = 2
      while (index.trees.some((t) => t.id === id)) { id = base + '-' + n; n += 1 }
      const tree = { id, title: String(title).trim(), createdAt: nowIso(), nodes: [] }
      writeJson(this._treeFile(id), tree)
      index.trees.push({ id, title: tree.title, createdAt: tree.createdAt, lastUsedAt: null })
      writeJson(this.indexFile, index)
      return tree
    })
  }

  switchTree(sessionId, treeId) {
    return this._serial(() => {
      const tree = this.readTree(treeId)
      if (tree === null) return null
      const index = this._index()
      const entry = index.trees.find((t) => t.id === treeId)
      if (entry !== undefined) entry.lastUsedAt = nowIso()
      index.lastUsed = treeId
      writeJson(this.indexFile, index)
      const sessions = this._sessions()
      // 换树必须清焦点：否则注入块会拿旧树的路径去新树里找（找不到 = 白注入）。
      sessions[sessionId] = { ...(sessions[sessionId] || {}), enabled: true, treeId, focus: '', focusId: null, focusSince: null, seenAt: nowIso() }
      writeJson(this.sessionsFile, sessions)
      return tree
    })
  }

  /** 追加子项（幂等：同名兄弟已存在则跳过）。 */
  addNodes(sessionId, parentPath, items) {
    return this._serial(() => {
      const binding = this.binding(sessionId)
      if (binding === null || typeof binding.treeId !== 'string') return { error: '尚未绑定学习树，请先 outline_projects / outline_open' }
      const tree = this.readTree(binding.treeId)
      if (tree === null) return { error: '学习树文件缺失：' + binding.treeId }
      const parent = findNode(tree, parentPath)
      if (parent === null && splitPath(parentPath).length > 0) {
        return { error: '找不到父节点：' + parentPath }
      }
      const list = parent === null ? tree.nodes : parent.children
      const added = []
      const skipped = []
      for (const raw of items) {
        const title = String(raw || '').trim()
        if (title === '') continue
        if (matchTitle(list, title) !== null) { skipped.push(title); continue }
        list.push(newNode(title))
        added.push(title)
      }
      writeJson(this._treeFile(tree.id), tree)
      return { treeId: tree.id, parent: parentPath || '(根)', added, skipped }
    })
  }

  /**
   * 发散式就地挂载（学习模式的"无感整理"核心）。
   *
   * 与 addNodes 的区别，正是产品的核心决策：
   *   - 默认挂到**当前焦点节点**下面（不是根、也不是"体系正确"的位置）；
   *   - 全树范围内同名节点**直接复用**（不重复建，也不擅自搬家）；
   *   - 默认把焦点切到它 —— 于是"由数组发散到计算机地址"，下一问就自然落在
   *     计算机地址下面，继续列举。
   * 结果：树记录的是**当时的思路路径**，而不是教科书目录。
   *
   * @returns {{ ok, created, reused, path, parent }}
   */
  /**
   * 就地挂一个知识点。
   * ⚠️ `focusIt` **默认不搬焦点**（只有显式传 true 才搬）：焦点代表"用户正在看哪"，
   * 它只能被用户驱动（面板点击 / 用户的话明确指向别的节点）。AI 的整理动作如果顺手搬焦点，
   * 用户的"我在哪"就会被 AI 的列举牵着走 —— 真机就是这么丢掉位置的
   * （介绍「World Model 与 Dreamer」时顺带挂了个子节点，焦点被搬到子节点，
   *  下一轮注入就告诉模型"用户现在在看子节点"，它于是接着讲子节点）。
   */
  capture(sessionId, title, underPath, focusIt) {
    return this._serial(() => {
      const clean = String(title || '').trim()
      if (clean === '') return { error: '标题为空' }
      const sessions = this._sessions()
      const binding = sessions[sessionId] || null
      if (binding === null || typeof binding.treeId !== 'string') return { error: '尚未绑定学习树，请先 outline_projects / outline_open' }
      const tree = this.readTree(binding.treeId)
      if (tree === null) return { error: '学习树文件缺失：' + binding.treeId }

      // 1) 已存在同名节点？→ 复用（不重复建、不搬家，避免破坏用户的结构）
      const existing = findAnywhere(tree, clean)
      if (existing !== null) {
        if (focusIt === true) {
          sessions[sessionId] = { ...binding, enabled: true, focus: existing.path, focusSince: nowIso() }
          writeJson(this.sessionsFile, sessions)
        }
        return { ok: true, created: false, reused: true, path: existing.path, parent: parentOfPath(existing.path) }
      }

      // 2) 找父节点：显式 under > 当前焦点 > 根
      const wanted = typeof underPath === 'string' && underPath.trim() !== ''
        ? underPath.trim()
        : (typeof binding.focus === 'string' ? binding.focus : '')
      let parent = wanted === '' ? null : findNode(tree, wanted)
      let parentPathUsed = wanted
      let fellBack = false
      if (parent === null && wanted !== '') { parentPathUsed = ''; fellBack = true }

      const siblingList = parent === null ? tree.nodes : parent.children
      // 同名兄弟已存在（大小写差异）→ 也算复用
      const sibling = matchTitle(siblingList, clean)
      if (sibling !== null) {
        const path = pathOf(tree, sibling.id)
        if (focusIt === true) {
          sessions[sessionId] = { ...binding, enabled: true, focus: path, focusSince: nowIso() }
          writeJson(this.sessionsFile, sessions)
        }
        return { ok: true, created: false, reused: true, path, parent: parentPathUsed || '(根)' }
      }

      const node = newNode(clean)
      siblingList.push(node)
      writeJson(this._treeFile(tree.id), tree)
      const path = pathOf(tree, node.id)
      if (focusIt === true) {
        sessions[sessionId] = { ...binding, enabled: true, focus: path, focusSince: nowIso() }
        writeJson(this.sessionsFile, sessions)
      }
      return { ok: true, created: true, reused: false, path, parent: parentPathUsed || '(根)', fellBack }
    })
  }

  /** 改名 / 移位 / 删除。 */
  updateNode(sessionId, path, changes) {
    return this._serial(() => {
      const binding = this.binding(sessionId)
      if (binding === null) return { error: '尚未绑定学习树' }
      const tree = this.readTree(binding.treeId)
      if (tree === null) return { error: '学习树文件缺失' }
      const node = findNode(tree, path)
      if (node === null) return { error: '找不到节点：' + path }
      if (typeof changes.rename === 'string' && changes.rename.trim() !== '') node.title = changes.rename.trim()
      if (typeof changes.moveTo === 'string') {
        const parent = findNode(tree, changes.moveTo)
        if (parent === null && splitPath(changes.moveTo).length > 0) return { error: '找不到目标父节点：' + changes.moveTo }
        const siblings = parent === null ? tree.nodes : parent.children
        const detach = (list) => {
          const at = list.findIndex((n) => n.id === node.id)
          if (at >= 0) { list.splice(at, 1); return true }
          return list.some((n) => detach(n.children))
        }
        detach(tree.nodes)
        siblings.push(node)
      }
      if (changes.delete === true) {
        const remove = (list) => {
          const at = list.findIndex((n) => n.id === node.id)
          if (at >= 0) { list.splice(at, 1); return true }
          return list.some((n) => remove(n.children))
        }
        remove(tree.nodes)
      }
      writeJson(this._treeFile(tree.id), tree)
      return { treeId: tree.id, changed: Object.keys(changes) }
    })
  }

  setStatus(sessionId, path, status, note) {
    return this._serial(() => {
      const binding = this.binding(sessionId)
      if (binding === null) return { error: '尚未绑定学习树' }
      const tree = this.readTree(binding.treeId)
      if (tree === null) return { error: '学习树文件缺失' }
      const node = findNode(tree, path)
      if (node === null) return { error: '找不到节点：' + path }
      const hadNote = typeof node.note === 'string' && node.note !== ''
      const canonical = pathOf(tree, node.id)
      // 摘要原料窗口在**改状态之前**取（窗口 = 该节点最后一次被聚焦的时间）
      const windowStartMs = this.windowStart(sessionId, node.id)
      node.status = status
      if (status === STATUS_DONE) {
        node.doneAt = nowIso()
        if (typeof note === 'string' && note.trim() !== '') {
          node.note = note.trim()
          node.noteAt = nowIso()
          node.noteState = 'done'
          node.noteError = null
        }
      } else {
        node.doneAt = null
      }
      writeJson(this._treeFile(tree.id), tree)
      return {
        treeId: tree.id,
        path: canonical,
        // 标题单独回传：题目里可能含 "/"，用 path 反推标题不可靠。
        title: node.title,
        parentPath: parentOfPath(canonical),
        // 当前焦点节点是不是"刚被完成的这个"——只有是，才自动回到上一层
        isFocus: typeof binding.focus === 'string' && binding.focus === canonical,
        windowStartMs,
        status: node.status,
        note: node.note || '',
        // 调用方据此判断"该不该触发摘要管道"：标完成、没带 note、本来也没有摘要。
        needsNote: status === STATUS_DONE && (note === undefined || String(note).trim() === '') && !hadNote,
      }
    })
  }

  /**
   * 记一条「这个知识点是在哪次对话里讲到的」来源坐标（新→旧，最多 ORIGIN_MAX 条）。
   *
   * 为什么坐标是 (sid, turn, seq) 而**不是 messageId**：
   *   外壳的会话流是按 **turn** 分行的（每行带 `data-chat-turn`），未加载的 turn 还能用
   *   `loadThrough(seq)` 补页 —— 这是"能跳过去"的唯一两个抓手；而 messageId 在聊天
   *   DOM 里**没有任何锚点**（全前端 bundle 里没有 data-message-id）。所以记 turn + seq。
   *
   * 去重键 = sid#turn：同一次对话里反复讲同一个知识点只算一条（但会刷新 time），
   * 换一次对话（新 turn）就是新的一条 —— 面板只显示最新那条，旧条留着备用。
   *
   * @param origin { sid, turn, seq, time } —— 只存标量，绝不存活对象
   */
  markOrigin(sessionId, path, origin) {
    return this._serial(() => {
      const binding = this.binding(sessionId)
      if (binding === null || typeof binding.treeId !== 'string') return { error: '尚未绑定学习树' }
      const tree = this.readTree(binding.treeId)
      if (tree === null) return { error: '学习树文件缺失' }
      const node = findNode(tree, path)
      if (node === null) return { error: '找不到节点：' + path }
      const src = origin === null || origin === undefined ? {} : origin
      const sid = typeof src.sid === 'string' ? src.sid : ''
      const turn = Number(src.turn)
      const seq = Number(src.seq)
      if (sid === '' || !Number.isFinite(turn) || !Number.isFinite(seq)) return { error: '来源坐标不完整' }
      const entry = {
        sid,
        turn: Math.floor(turn),
        seq: Math.floor(seq),
        time: typeof src.time === 'string' ? src.time : nowIso(),
        why: typeof src.why === 'string' ? src.why : '',
      }
      const key = entry.sid + '#' + String(entry.turn)
      const list = (Array.isArray(node.origins) ? node.origins : [])
        .filter((item) => item !== null && typeof item === 'object' && String(item.sid) + '#' + String(item.turn) !== key)
      list.unshift(entry)
      node.origins = list.slice(0, ORIGIN_MAX)
      writeJson(this._treeFile(tree.id), tree)
      return { treeId: tree.id, path: pathOf(tree, node.id), origin: node.origins[0], count: node.origins.length }
    })
  }

  /**
   * 某节点摘要原料的窗口起点（毫秒）。**三级兜底**，任何一级都比"整场会话"强：
   *
   *  1. 该节点自己进过 → 用它最后一次进入的时间（`lastEnteredAt`）。
   *     ⚠️ 不用当前 `focusSince`：用户完全可能"先返回上一层、再给钻进去的节点标完成"，
   *     那时 focusSince 已经是别的节点了（真机流程确认过的坑）。
   *  2. 它自己没进过 → 退到**最近进过的祖先**的最后进入时间。
   *     ⚠️ 这一步修的是真机 bug：AI 在父节点里一次性列了 6 个前置概念，用户在面板上
   *     直接给其中一个点 ✓，那个子节点从没被聚焦过 → 以前直接退到 0 = 整场会话，
   *     模型于是拿着整篇论文去写「rollout 的交互税」。
   *  3. 祖先也没进过 → 用节点自己的创建时间（内容不可能早于它被建出来）。
   *  4. 实在没有 → 0（整场会话）。
   */
  windowStart(sessionId, nodeId) {
    const binding = this.binding(sessionId)
    if (binding === null) return 0
    const at = (id) => {
      const map = binding.lastEnteredAt
      if (map === null || map === undefined || typeof map !== 'object') return 0
      const iso = map[String(id)]
      if (typeof iso !== 'string') return 0
      const t = Date.parse(iso)
      return Number.isFinite(t) ? t : 0
    }
    const tree = typeof binding.treeId === 'string' ? this.readTree(binding.treeId) : null
    if (tree === null) return 0
    const self = at(nodeId)
    if (self > 0) return self
    for (const anc of ancestorIds(tree, nodeId)) {
      const t = at(anc)
      if (t > 0) return t
    }
    const node = findNodeById(tree, nodeId)
    if (node !== null && typeof node.createdAt === 'string') {
      const t = Date.parse(node.createdAt)
      if (Number.isFinite(t)) return t
    }
    return 0
  }

  /** 会话"开场确认"过了（选过树 / 新建过树）——用于只在开场注入一次选树提示。 */
  markOpened(sessionId) {
    return this._serial(() => {
      const sessions = this._sessions()
      const current = sessions[sessionId] || {}
      if (current.opened === true) return current
      sessions[sessionId] = { ...current, enabled: true, opened: true }
      writeJson(this.sessionsFile, sessions)
      return sessions[sessionId]
    })
  }

  /**
   * 写入（或更新）一个节点的摘要 —— 摘要管道的落盘点。
   * @param meta 溯源窗口 { sessionId, from, to, reason }，只存标量。
   */
  setNote(sessionId, path, note, meta) {
    return this._serial(() => {
      const binding = this.binding(sessionId)
      if (binding === null || typeof binding.treeId !== 'string') return { error: '尚未绑定学习树' }
      const tree = this.readTree(binding.treeId)
      if (tree === null) return { error: '学习树文件缺失' }
      const node = findNode(tree, path)
      if (node === null) return { error: '找不到节点：' + path }
      const text = String(note || '').trim()
      if (text === '') return { error: '摘要为空，已丢弃' }
      node.note = text
      node.noteAt = nowIso()
      node.noteState = 'done'
      node.noteTries = 0
      node.noteError = null
      if (meta !== null && typeof meta === 'object') {
        node.noteSource = {
          sessionId: String(meta.sessionId || ''),
          from: Number(meta.from) || 0,
          to: Number(meta.to) || 0,
          reason: String(meta.reason || ''),
        }
      }
      writeJson(this._treeFile(tree.id), tree)
      return { treeId: tree.id, path: pathOf(tree, node.id), note: node.note, noteAt: node.noteAt }
    })
  }

  /** 摘要状态机：running（生成中）/ done / skipped（内容太少或模型说无内容）/ failed。 */
  markNoteState(sessionId, path, state, detail) {
    return this._serial(() => {
      const binding = this.binding(sessionId)
      if (binding === null || typeof binding.treeId !== 'string') return { error: '尚未绑定学习树' }
      const tree = this.readTree(binding.treeId)
      if (tree === null) return { error: '学习树文件缺失' }
      const node = findNode(tree, path)
      if (node === null) return { error: '找不到节点：' + path }
      node.noteState = String(state)
      if (state === 'failed') {
        node.noteTries = (Number(node.noteTries) || 0) + 1
        node.noteError = String(detail || '').slice(0, 200)
      } else {
        node.noteError = detail === undefined || detail === null ? null : String(detail).slice(0, 200)
        if (state === 'done') node.noteTries = 0
      }
      writeJson(this._treeFile(tree.id), tree)
      return { treeId: tree.id, path: pathOf(tree, node.id), state: node.noteState, tries: node.noteTries || 0 }
    })
  }

  setFocus(sessionId, treePath) {
    return this._serial(() => {
      const sessions = this._sessions()
      const current = sessions[sessionId] || {}
      // 返回"上一个焦点"，调用方据此触发"离开旧节点"的摘要检查（方案 §8）。
      const previous = {
        focus: typeof current.focus === 'string' ? current.focus : '',
        focusSince: current.focusSince || null,
      }
      const stamp = nowIso()
      const next = { ...current, enabled: true, focus: String(treePath || ''), focusSince: stamp }
      // 记"该节点最后一次被聚焦的时间"：摘要窗口用它（见 windowStart 的说明）。
      // 只保留最近 LAST_ENTERED_MAX 个，避免 sessions.json 无限膨胀。
      if (next.focus !== '' && typeof next.treeId === 'string') {
        const tree = this.readTree(next.treeId)
        const node = tree === null ? null : findNode(tree, next.focus)
        if (node !== null) {
          const map = { ...(current.lastEnteredAt !== null && typeof current.lastEnteredAt === 'object' ? current.lastEnteredAt : {}) }
          delete map[node.id]
          map[node.id] = stamp
          const keys = Object.keys(map)
          for (const key of keys.slice(0, Math.max(0, keys.length - LAST_ENTERED_MAX))) delete map[key]
          next.lastEnteredAt = map
        }
      }
      sessions[sessionId] = next
      writeJson(this.sessionsFile, sessions)
      return { ...next, previous }
    })
  }

  /**
   * 把面板传来的 { id | path } 解析成**规范路径**。
   * id 优先：标题里含 `/`（"插入/删除"）时，纯路径是有歧义的，id 没有。
   */
  resolvePath(sessionId, id, path) {
    const binding = this.binding(sessionId)
    if (binding === null || typeof binding.treeId !== 'string') return null
    const tree = this.readTree(binding.treeId)
    if (tree === null) return null
    if (typeof id === 'string' && id !== '') {
      const byId = findNodeById(tree, id)
      return byId === null ? null : pathOf(tree, byId.id)
    }
    const byPath = findNode(tree, String(path || ''))
    return byPath === null ? null : pathOf(tree, byPath.id)
  }

  /**
   * 按 **node id** 聚焦（面板点选走这条）。
   * 标题里含 `/` 时路径是有歧义的，id 没有——所以人手的入口一律用 id。
   */
  setFocusById(sessionId, nodeId) {
    const binding = this.binding(sessionId)
    if (binding === null || typeof binding.treeId !== 'string') return Promise.resolve({ error: '尚未绑定学习树' })
    const tree = this.readTree(binding.treeId)
    if (tree === null) return Promise.resolve({ error: '学习树文件缺失' })
    const node = findNodeById(tree, nodeId)
    if (node === null) return Promise.resolve({ error: '找不到节点 id：' + String(nodeId) })
    return this.setFocus(sessionId, pathOf(tree, node.id))
  }

  /**
   * 复习视图：当前树里所有已完成节点 + 摘要，按完成时间倒序。
   * 一次遍历带上前缀路径（不要对每个节点调 pathOf，那是 O(n²)）。
   */
  review(sessionId) {
    const binding = this.binding(sessionId)
    if (binding === null || typeof binding.treeId !== 'string') return { tree: null, items: [], stats: { done: 0, total: 0, withNote: 0 } }
    const tree = this.readTree(binding.treeId)
    if (tree === null) return { tree: null, items: [], stats: { done: 0, total: 0, withNote: 0 } }
    const items = []
    let total = 0
    const walk = (list, prefix) => {
      for (const node of list) {
        total += 1
        const here = prefix === '' ? node.title : prefix + '/' + node.title
        if (node.status === STATUS_DONE) {
          items.push({
            id: node.id,
            path: here,
            title: node.title,
            note: node.note || '',
            noteAt: node.noteAt || null,
            noteState: node.noteState || (node.note ? 'done' : null),
            doneAt: node.doneAt || null,
          })
        }
        walk(node.children, here)
      }
    }
    walk(tree.nodes, '')
    items.sort((a, b) => String(b.doneAt || '').localeCompare(String(a.doneAt || '')))
    const withNote = items.filter((item) => item.note !== '').length
    return {
      tree: { id: tree.id, title: tree.title },
      items,
      stats: { done: items.length, total, withNote },
    }
  }

  /** 每轮注入给模型的动态上下文（未绑定/未开启时返回空串）。 */
  contextText(sessionId) {
    const binding = this.binding(sessionId)
    if (binding === null || binding.enabled !== true) return ''
    const tree = typeof binding.treeId === 'string' ? this.readTree(binding.treeId) : null
    const focusPath = typeof binding.focus === 'string' ? binding.focus : ''

    // ── 开场块：只在"这个会话还没用过树"时注入（问完一次就消失，不占长期上下文）──
    // 判定：显式 opened 标记，或已经有过焦点（focus/focusSince）都算"用过了"，
    // 这样老会话不会被重新问一次。
    const opening = []
    const needsOpening = binding.opened !== true
      && (typeof binding.focus !== 'string' || binding.focus === '')
      && typeof binding.focusSince !== 'string'
    if (needsOpening) {
      const parts = []
      for (const entry of this.listTrees().slice(0, 5)) {
        const t = this.readTree(entry.id)
        const stat = t === null ? null : countNodes(t.nodes)
        parts.push(entry.title + (stat === null ? '' : '（' + stat.total + ' 节点·' + shortDate(entry.lastUsedAt) + '）'))
      }
      opening.push('【现有学习树】' + (parts.length === 0 ? '（还没有树）' : parts.join('、')))
      opening.push('【开场·只做一次】用户第一句若与上述某棵树相关 → 用 ask_user_question 出选项：'
        + '第一个＝你推荐的那棵树（label 带「(Recommended)」），其后是其它相关的树，再给「新建一棵（名字建议：<从问题里提炼的主题>）」；'
        + '用户也可以自己填。选完调 outline_open（已有树用 project，新建用 new），然后正常回答，不要再问第二次。'
        + '若与任何老树都无关 → 同样用选项问：第一个＝你建议的树名，第二个＝让用户自己填名字。')
    }
    // 还没绑树：只把开场提示给出去（否则模型没有树的标题可参考）
    if (tree === null) return opening.join('\n')

    const head = [
      '## 学习模式',
      '学习树：' + tree.title + (focusPath === '' ? '（尚未选择聚焦节点）' : ' ｜ ▶ 当前聚焦（用户正在看的）：' + focusPath),
      ...opening,
    ]

    const focusNode2 = findNode(tree, focusPath)
    const pick = (limit) => {
      const out = { current: '', children: [], pending: [], done: [], hasFocus: focusNode2 !== null }
      if (focusNode2 !== null) {
        out.current = clip(focusNode2.note, CONTEXT_NOTE_CHARS)
        out.children = focusNode2.children
          .filter((n) => n.note)
          .slice(0, limit.childNotes)
          .map((n) => ({ title: n.title, note: clip(n.note, CONTEXT_NOTE_CHARS) }))
      }
      const stat = countNodes(tree.nodes)
      out.stat = stat
      // 【还没学完】**只给"这一层"**：聚焦节点的子节点 + 它的兄弟。
      // 早先是全树广度优先的前 8 条，于是用户说"介绍"这种没有宾语的话时，
      // 模型会从一堆无关知识点里挑一个来答（实拍：聚焦「快慢指针」被答成「插入/删除是否 O(n)」）。
      const pending = []
      const pushPending = (node) => {
        if (node.status === STATUS_DONE || pending.length >= limit.pending) return
        if (!pending.includes(node.title)) pending.push(node.title)
      }
      if (focusNode2 !== null) {
        for (const child of focusNode2.children) pushPending(child)
        const parent = parentOfPath(focusPath)
        const siblings = parent === '' ? tree.nodes : (findNode(tree, parent) === null ? [] : findNode(tree, parent).children)
        for (const sibling of siblings) {
          if (sibling.id !== focusNode2.id) pushPending(sibling)
        }
      } else {
        for (const node of tree.nodes) pushPending(node)
      }
      out.pending = pending
      const done = []
      const collectDone = (list, prefix) => {
        for (const node of list) {
          const here = prefix === '' ? node.title : prefix + ' > ' + node.title
          if (node.status === STATUS_DONE) done.push({ title: here, at: node.doneAt })
          collectDone(node.children, here)
        }
      }
      collectDone(tree.nodes, '')
      done.sort((a, b) => String(b.at).localeCompare(String(a.at)))
      out.done = done.slice(0, limit.done)
      return out
    }

    const render = (data, limit) => {
      const lines = head.slice()
      if (data.current !== '') lines.push('【当前节点摘要】' + data.current)
      if (data.children.length > 0) {
        lines.push('【子节点摘要】')
        for (const child of data.children) lines.push('  · ' + child.title + '：' + child.note)
      }
      lines.push('【进度】已完成 ' + data.stat.done + '/' + data.stat.total)
      if (data.pending.length > 0) lines.push('【这一层还没学完】' + data.pending.join('、'))
      if (data.done.length > 0) lines.push('【最近完成】' + data.done.map((d) => d.title + '（' + shortDate(d.at) + '）').join('、'))
      if (limit.hint && data.done.length > 0) lines.push('（复习用 outline_review 读摘要清单）')
      // 行动提示放在**最丰裕的一级**，超预算时第一个被砍掉。
      // 规则段里虽然写过，但在"行动当口"再点一句，模型跑偏/漏调 capture 的概率明显下降——
      // 这两条正是真机踩过的坑：vague 提问被答成别的知识点、以及 capture 漏调。
      if (limit.hint && data.hasFocus) {
        lines.push('（用户没指明对象时＝上面那个"当前聚焦"；答完静默把新知识点 outline_capture 到聚焦节点下，**不要搬焦点**——焦点只跟着用户走）')
      }
      return lines.join('\n')
    }

    // 逐级降级：内容依次减少，直到进入预算。最后一级硬切，保证绝不超过上限。
    const ladder = [
      { childNotes: CONTEXT_CHILD_NOTES, pending: CONTEXT_PENDING, done: 3, hint: true },
      { childNotes: CONTEXT_CHILD_NOTES, pending: CONTEXT_PENDING, done: 3, hint: false },
      { childNotes: 3, pending: 4, done: 2, hint: false },
      { childNotes: 1, pending: 2, done: 1, hint: false },
      { childNotes: 0, pending: 0, done: 0, hint: false },
    ]
    let text = ''
    for (const limit of ladder) {
      text = render(pick(limit), limit)
      if (text.length <= CONTEXT_MAX_CHARS) return text
    }
    // 兜底：头部 + 当前摘要如何都超预算，硬切（宁短不炸）
    const cut = text.slice(0, CONTEXT_MAX_CHARS)
    return cut
  }
}

/** sessions.json 里每个会话最多记多少个"节点最后进入时间"。 */
export const LAST_ENTERED_MAX = 80
/** 每个节点最多记几条"来源对话"（只显示最新那条，旧的留着以备将来做"相关讨论"）。 */
export const ORIGIN_MAX = 3
/** 单条摘要的字符上限（注入块里没必要给整段）。 */
export const CONTEXT_MAX_CHARS = 1200
export const CONTEXT_NOTE_CHARS = 120
export const CONTEXT_CHILD_NOTES = 6
export const CONTEXT_PENDING = 8

/** 截断长文本并加省略号。 */
function clip(text, max) {
  const value = String(text || '')
  return value.length <= max ? value : value.slice(0, max - 1) + '…'
}

/** ISO 时间 → "09-17"，给注入块用。 */
function shortDate(iso) {
  const text = String(iso || '')
  return text.length >= 10 ? text.slice(5, 10) : '—'
}

function tutorialNodes() {
  const mk = (title, children) => ({ ...newNode(title), children: children || [] })
  return [
    mk('① 问我：我要学 X，要学什么', [
      mk('AI 会把清单直接生成到右侧的树里'),
      mk('不用你手动建节点，也不用复制粘贴'),
    ]),
    mk('② 你问什么我答什么，树顺着你的思路长', [
      mk('由「数组」问到「计算机地址」，它就挂在数组下面'),
      mk('不按教科书目录摆放——记录的是你当时怎么想的'),
      mk('挂节点这件事我来做，你不用管、也不用确认'),
    ]),
    mk('③ 点节点标题 = 聚焦', [
      mk('聚焦后，对话就围绕这个节点展开'),
      mk('也可以直接对我说"我们来看继承"'),
    ]),
    mk('④ 点 [✓ 学会] 标记完成', [
      mk('标完成时我会自动写一句摘要（几秒后出现）'),
      mk('再点一次撤销；点 ⟳ 可以让模型重写摘要'),
    ]),
    mk('⑤ 复习：点面板顶部的 [复习] 标签'),
    mk('⑥ 想改结构（改名/移位/删除）直接跟我说'),
  ]
}

export function buildTutorialTree() {
  const createdAt = nowIso()
  return { id: 'tutorial', title: TUTORIAL_TITLE, createdAt, nodes: tutorialNodes() }
}
