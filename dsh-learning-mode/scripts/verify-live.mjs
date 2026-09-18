#!/usr/bin/env node
/**
 * 真机效果核查：这个插件在**真实会话**里到底生效了没有。
 *
 * 为什么需要它：单测能全绿而真机全死——本插件踩过两次
 *  ① `ctx.agents` 未声明 → 真代理抛错 → 裸 catch 吞成空串 → **每轮注入从未生效**；
 *  ② 测试桩把服务当普通属性提供，比真实运行时宽松 → 没人发现。
 * 真机判据只在**会话日志**里：注入是运行时上下文快照（一条 user/message），
 * 工具清单在 request/header 里。所以这里直接解会话日志来核对。
 *
 * 用法：
 *   node scripts/verify-live.mjs                      # 自动找最近改动过的学习模式会话
 *   node scripts/verify-live.mjs <sessionId 前缀>      # 指定会话
 *   DSH_HOME=/path node scripts/verify-live.mjs
 *
 * 会话日志 `session.v3.jsonl.zstd` 是**多帧 zstd**（每帧一个 flush），
 * 不能整体解压：按 magic 28 B5 2F FD 切帧、逐帧解压再拼。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
const LEARNING_DIR = join(DSH_HOME, 'learning-mode')

/** 会话日志目录：~/.dsh/sessions/<项目目录编码>/<sessionId>/session.v3.jsonl.zstd */
function findSessionLogs() {
  const root = join(DSH_HOME, 'sessions')
  const out = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.name.endsWith('.zstd')) {
        try { out.push({ file: full, mtime: statSync(full).mtimeMs }) } catch { /* 忽略 */ }
      }
    }
  }
  walk(root, 0)
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** 多帧 zstd → 文本。 */
function decodeZstdFrames(file) {
  const buf = readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let at = 0
  while (true) {
    const found = buf.indexOf(magic, at)
    if (found < 0) break
    starts.push(found)
    at = found + 1
  }
  const chunks = []
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : buf.length
    try { chunks.push(zstdDecompressSync(buf.subarray(from, to)).toString('utf8')) } catch { /* 坏帧跳过 */ }
  }
  return { text: chunks.join(''), frames: starts.length }
}

const needle = process.argv[2] || ''
const logs = findSessionLogs().filter((entry) => needle === '' || entry.file.includes(needle))
if (logs.length === 0) {
  console.error('没找到会话日志（找 ' + join(DSH_HOME, 'sessions') + '）' + (needle === '' ? '' : '，过滤=' + needle))
  process.exit(1)
}
const target = logs[0]
const { text, frames } = decodeZstdFrames(target.file)

const lines = text.split('\n').filter((line) => line.length > 0)
const events = []
for (const line of lines) {
  try { events.push(JSON.parse(line)) } catch { /* 非 JSON 行忽略 */ }
}

const count = (haystack, needleText) => haystack.split(needleText).length - 1
const lastFocus = (() => {
  try {
    const sessions = JSON.parse(readFileSync(join(LEARNING_DIR, 'sessions.json'), 'utf8'))
    for (const [sid, binding] of Object.entries(sessions)) {
      if (target.file.includes(sid)) return { sid, focus: binding.focus, treeId: binding.treeId, focusSince: binding.focusSince }
    }
  } catch { /* 忽略 */ }
  return null
})()

const headers = events.filter((event) => event.type === 'request/header')
const snapshotMessages = events.filter((event) => {
  if (event.type !== 'user/message') return false
  const source = event.data === null || typeof event.data !== 'object' ? null : event.data.source
  const plugin = source !== null && typeof source === 'object' ? source.plugin : ''
  return plugin === '@deepseek-ai/dsh-system-prompt'
})
const lastHeader = headers.length === 0 ? null : headers[headers.length - 1]
const toolNames = lastHeader === null ? [] : (lastHeader.data.header.tools || []).map((tool) => tool.name)
const devTools = toolNames.filter((name) => name.startsWith('dev_'))

let failures = 0
const line = (ok, label, detail) => {
  if (!ok) failures += 1
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail === undefined ? '' : ' :: ' + detail))
}

console.log('会话日志：' + target.file)
console.log('  帧数 ' + frames + ' ｜ 事件 ' + events.length + ' ｜ 对话轮 ' + count(text, '"turn/start"'))
if (lastFocus !== null) console.log('  学习模式绑定：' + lastFocus.treeId + ' ｜ 当前聚焦 = ' + (lastFocus.focus || '(空)'))
console.log('\n真机核查（判据都在日志里，不看代码推断）：')

// ① 每轮注入：运行时上下文快照里应当有【进度】/▶ 当前聚焦
// ⚠️ 判据同时认**中英文**：插件文案跟随 DSH 的语言（见 lib/i18n.js），
// 英文会话里注入块整个是英文的。只认中文会让英文环境下核查结果假阴性。
const FOCUS_MARKS = ['▶ 当前聚焦', '▶ Current focus']
const PROGRESS_MARKS = ['【进度】', '[Progress]']
const TREE_HEAD_MARKS = ['学习树：', 'Learning tree:']
const PENDING_LEVEL_MARKS = ['这一层还没学完', 'Not finished at this level']
// 大小写不敏感：诊断脚本不该因为译文把 "current focus" 写成 "Current focus" 就失灵。
const anyMark = (body, marks) => marks.some((mark) => String(body).toLowerCase().includes(mark.toLowerCase()))

const injectedBlocks = snapshotMessages.filter((event) => {
  const body = JSON.stringify(event.data)
  return anyMark(body, FOCUS_MARKS) || anyMark(body, PROGRESS_MARKS)
})
line(injectedBlocks.length > 0, '每轮注入生效（快照里出现 ▶ 当前聚焦 / 【进度】，中英文均认）', injectedBlocks.length + ' 次')
const fullBlocks = snapshotMessages.filter((event) => anyMark(JSON.stringify(event.data), TREE_HEAD_MARKS))
line(fullBlocks.length > 0, '注入块是完整的学习模式状态块（含"学习树："表头，中英文均认）', fullBlocks.length + ' 次')
console.log('     （"这一层还没学完" / "Not finished at this level" 出现 '
  + (count(text, PENDING_LEVEL_MARKS[0]) + count(text, PENDING_LEVEL_MARKS[1]))
  + ' 次；当前聚焦节点若没有未完成的子节点，这一行本就不该出现）')

// ② 学习会话不该有 super-injector 的开发向引导（mutePresets 生效）
const injectorGuide = count(text, '本环境装有 dsh-super-injector')
line(injectorGuide === 0, 'super-injector 引导已静音（学习会话不该出现）', injectorGuide + ' 次')

// ③ 学习会话不该挂 dev_* 工具
line(devTools.length === 0, 'dev_* 工具已屏蔽（schema 省下来）', devTools.length === 0 ? '工具数 ' + toolNames.length : devTools.length + ' 个：' + devTools.join(','))
console.log('     （工具总数 ' + toolNames.length + '；dev_* 为 0 说明 tools.restrict 在该会话作用域里成功了）')

// ④ 最近的 RPC 诊断
try {
  const rpc = readFileSync(join(LEARNING_DIR, 'rpc.log'), 'utf8').split('\n')
  const diag = rpc.filter((entry) => entry.includes('inject diag:') || entry.includes('deny-dev-tools')).slice(-6)
  console.log('\n最近的注入诊断（rpc.log）：')
  if (diag.length === 0) console.log('  （无——没有任何静音/异常留痕，属于正常）')
  for (const entry of diag) console.log('  ' + entry)
} catch {
  console.log('\n（读不到 rpc.log）')
}

console.log('\n' + (failures === 0 ? '真机核查通过（' + '改写前/后都看同一份日志即可）' : failures + ' 项未通过——重启 dsh web 后再跑一次'))
process.exit(failures === 0 ? 0 : 1)
