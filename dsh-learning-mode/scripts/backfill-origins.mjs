#!/usr/bin/env node
/**
 * 回填「来源坐标」：把树上**已有**的节点对回"它是在哪轮对话里被讲出来的"。
 *
 * 为什么需要它：来源坐标（`origins`）是这个版本新加的字段，之前建的节点都没有 →
 * 面板上就不会出现「↩ 原文」按钮。但坐标**根本不用猜**：会话日志里本来就有
 *   - `outline_capture` 调用的 `title`
 *   - `outline_add` 调用的 `items[]`
 * 而这些工具调用事件自己就带 `turn` / `seq` / `time` —— 正是跳转需要的三个数。
 *
 * 用法：
 *   node scripts/backfill-origins.mjs              # 只看报告（dry-run，不写盘）
 *   node scripts/backfill-origins.mjs --write      # 写盘（先把树文件备份成 .bak-<时间>）
 *   node scripts/backfill-origins.mjs --write --tree ai-agent-论文
 *
 * 会话日志 `session.v3.jsonl.zstd` 是**多帧 zstd**（每帧一个 flush），不能整体解压：
 * 按 magic 28 B5 2F FD 切帧、逐帧解压再拼（与 scripts/verify-live.mjs 同一套算法）。
 */
import { copyFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { LearningStore, pathOf, findNode } from '../lib/store.js'

const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
const LEARNING_DIR = join(DSH_HOME, 'learning-mode')
const WRITE = process.argv.includes('--write')
const TREE_FILTER = (() => {
  const at = process.argv.indexOf('--tree')
  return at >= 0 && typeof process.argv[at + 1] === 'string' ? process.argv[at + 1] : ''
})()

/** 会话日志目录：~/.dsh/sessions/<项目目录编码>/<sessionId>/session.v3.jsonl.zstd */
function findSessionLog(sessionId) {
  const root = join(DSH_HOME, 'sessions')
  let dirs = []
  try { dirs = readdirSync(root) } catch { return '' }
  for (const dir of dirs) {
    const file = join(root, dir, sessionId, 'session.v3.jsonl.zstd')
    try { if (statSync(file).isFile()) return file } catch { /* 换下一个 */ }
  }
  return ''
}

function decodeZstdFrames(file) {
  const buf = readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const chunks = []
  let at = 0
  while (at < buf.length) {
    const found = buf.indexOf(magic, at)
    if (found < 0) break
    const next = buf.indexOf(magic, found + 4)
    const to = next < 0 ? buf.length : next
    try { chunks.push(zstdDecompressSync(buf.subarray(found, to)).toString('utf8')) } catch { /* 坏帧跳过 */ }
    at = to
  }
  return chunks.join('')
}

/**
 * 扫一个会话日志，收集"哪些标题是在哪一轮被写进树的"。
 * 后出现的覆盖先出现的（= 最新一次讨论），这正是面板要显示的那一条。
 * @returns Map<title, { sid, turn, seq, time, why }>
 */
function collectFromLog(sessionId, file) {
  const out = new Map()
  const text = decodeZstdFrames(file)
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed
    try { parsed = JSON.parse(line) } catch { continue }
    const event = parsed.type === 'event' ? parsed.event : parsed
    if (event === null || event === undefined || event.type !== 'tool/call') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    if (data.name !== 'outline_capture' && data.name !== 'outline_add') continue
    let args = {}
    try { args = JSON.parse(data.arguments || '{}') } catch { /* 参数坏了就跳过这条 */ }
    const titles = []
    if (typeof args.title === 'string' && args.title.trim() !== '') titles.push(args.title.trim())
    if (Array.isArray(args.items)) for (const item of args.items) if (typeof item === 'string' && item.trim() !== '') titles.push(item.trim())
    const turn = Number(data.turn)
    const seq = Number(event.seq)
    const time = Number(event.time)
    if (!Number.isFinite(turn) || !Number.isFinite(seq) || titles.length === 0) continue
    const entry = {
      sid: sessionId,
      turn: Math.floor(turn),
      seq: Math.floor(seq),
      time: new Date(Number.isFinite(time) ? time : Date.now()).toISOString(),
      why: data.name === 'outline_capture' ? 'capture' : 'add',
    }
    for (const title of titles) out.set(title, entry)
  }
  return out
}

/** 树里所有节点的 { path, title, hasOrigin } */
function walkNodes(nodes, prefix, out) {
  for (const node of nodes) {
    const path = prefix === '' ? node.title : prefix + '/' + node.title
    out.push({ path, title: node.title, hasOrigin: Array.isArray(node.origins) && node.origins.length > 0 })
    walkNodes(node.children || [], path, out)
  }
  return out
}

const store = new LearningStore(LEARNING_DIR)
const sessions = JSON.parse(readFileSync(join(LEARNING_DIR, 'sessions.json'), 'utf8'))
/** treeId → 绑过它的会话（来源只可能出自这些会话） */
const byTree = new Map()
for (const [sid, binding] of Object.entries(sessions)) {
  const treeId = binding === null || typeof binding !== 'object' ? '' : binding.treeId
  if (typeof treeId !== 'string' || treeId === '') continue
  if (!byTree.has(treeId)) byTree.set(treeId, [])
  byTree.get(treeId).push(sid)
}

let totalWritten = 0
let totalNodes = 0
let totalFilled = 0
for (const meta of store.listTrees()) {
  if (TREE_FILTER !== '' && meta.id !== TREE_FILTER && meta.title !== TREE_FILTER) continue
  const tree = store.readTree(meta.id)
  if (tree === null) continue
  const sids = byTree.get(meta.id) || []
  const coordinates = new Map()
  for (const sid of sids) {
    const file = findSessionLog(sid)
    if (file === '') { console.log('  (跳过：找不到会话日志) ' + sid); continue }
    for (const [title, entry] of collectFromLog(sid, file)) coordinates.set(title, entry)
  }
  const nodes = walkNodes(tree.nodes, '', [])
  const missing = nodes.filter((n) => !n.hasOrigin && coordinates.has(n.title))
  const unmatched = nodes.filter((n) => !n.hasOrigin && !coordinates.has(n.title))
  totalNodes += nodes.length
  totalFilled += missing.length
  console.log('# ' + meta.title + '  (' + meta.id + ')')
  console.log('  节点 ' + nodes.length + ' ｜ 会话 ' + sids.length + ' ｜ 日志里的坐标 ' + coordinates.size)
  console.log('  可回填 ' + missing.length + ' ｜ 已有来源 ' + (nodes.length - missing.length - unmatched.length) + ' ｜ 对不上 ' + unmatched.length)
  for (const node of missing.slice(0, 8)) {
    const at = coordinates.get(node.title)
    console.log('    + ' + node.path + '  ← 第 ' + at.turn + ' 轮 (' + at.why + ', ' + at.time + ')')
  }
  if (missing.length > 8) console.log('    … 其余 ' + (missing.length - 8) + ' 个同类')
  if (unmatched.length > 0) console.log('    对不上：' + unmatched.map((n) => n.title).join('、').slice(0, 200))
  if (!WRITE || missing.length === 0) continue
  const backup = join(LEARNING_DIR, 'trees', meta.id + '.json.bak-' + Date.now())
  copyFileSync(join(LEARNING_DIR, 'trees', meta.id + '.json'), backup)
  console.log('  备份 → ' + backup)
  for (const node of missing) {
    const at = coordinates.get(node.title)
    // 走正式写入路径（store.markOrigin），跟线上同一个代码分支
    const res = await store.markOrigin(sids[0], node.path, at)
    if (res !== null && res !== undefined && typeof res.error === 'string') console.log('    ! ' + node.path + ' :: ' + res.error)
    else totalWritten += 1
  }
}

console.log('\n' + (WRITE ? '已写入 ' + totalWritten + ' 条来源坐标' : '（dry-run：加 --write 才写盘）') + ' ｜ 覆盖 ' + totalFilled + '/' + totalNodes + ' 个节点')
