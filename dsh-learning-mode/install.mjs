/**
 * dsh-learning-mode — 安装/修复学习模式预设。
 *
 * 做四件事：
 *   1. 选底预设（默认用户自己的 router，没有则回退官方 standard），
 *      把它的完整组合复制过来，追加一行指向本插件宿主入口的 row；
 *   2. 写 preset.yml；
 *   3. **逐行校验组合里每个 row 的 name 能否解析** —— 解析不了就报错退出，
 *      不写出一个"加载失败"的预设；
 *   4. 刷新本插件的依赖 junction（换机器后必须，否则预设加载会 import 失败）。
 *
 * 为什么是"复制+追加"而不是只写一行：预设是完整组合，只写自己那一行
 * 会让学习模式会话失去全部常规工具（读写文件、shell、子代理……）。
 *
 * 跨机器：本脚本不硬编码任何用户名/盘符，harness 位置由 scripts/harness.mjs 推断
 * （DSH_CHECKOUT > profile 解析 > 全局 npm）。
 *
 * 用法：
 *   node install.mjs              # 底预设：router（无则 standard）
 *   node install.mjs standard     # 显式指定底预设
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname } from 'node:path'
import { dshHome, harnessNodeModules, profileName, shippedPresetsRoot } from './scripts/harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const presetsRoot = join(dshHome(), '.agent-presets')
const shipped = shippedPresetsRoot()
const harnessModules = harnessNodeModules()
const profileModules = join(dshHome(), 'profiles', profileName(), 'node_modules')

const targetId = 'learning-mode'
const ROW_ID = 'learning-mode'
const NL = String.fromCharCode(10)

const requested = process.argv[2]
const candidates = requested ? [requested] : ['router', 'standard']
let sourceId = null
let sourceFile = null
for (const id of candidates) {
  const roots = shipped === undefined ? [presetsRoot] : [presetsRoot, shipped]
  for (const root of roots) {
    const f = join(root, id, 'agent.cordis.yml')
    if (existsSync(f)) { sourceId = id; sourceFile = f; break }
  }
  if (sourceFile !== null) break
}
if (sourceFile === null) {
  const userPresets = existsSync(presetsRoot)
    ? readdirSync(presetsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : []
  console.error('找不到底预设。已尝试：' + candidates.join(', '))
  console.error('用户预设：' + (userPresets.length === 0 ? '(无)' : userPresets.join(', ')))
  process.exit(1)
}

const entryPath = join(here, 'lib', 'index.js')
if (!existsSync(entryPath)) {
  console.error('找不到插件入口：' + entryPath)
  process.exit(1)
}

/** 移除上一次插入的 learning-mode row（及其上方紧邻的注释块）。 */
function stripRow(text) {
  const lines = text.split(/\r?\n/)
  const kept = []
  for (let i = 0; i < lines.length; i += 1) {
    if (/^- id:\s*learning-mode\s*$/.test(lines[i])) {
      while (i + 1 < lines.length && !/^- /.test(lines[i + 1])) i += 1
      while (kept.length > 0 && /^\s*#/.test(kept[kept.length - 1])) kept.pop()
      while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
      continue
    }
    kept.push(lines[i])
  }
  return kept.join(NL)
}

/** 收集组合里所有 row 的 name（含 group 内的嵌套 row）。 */
function collectNames(text) {
  const names = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*-?\s*name:\s*(.+?)\s*$/.exec(lines[i])
    if (m !== null) {
      let value = m[1].trim()
      if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
        value = value.slice(1, -1)
      }
      names.push({ line: i + 1, name: value })
    }
  }
  return names
}

/** 一个 name 能否解析（与 scripts/validate-preset.mjs 同规则）。 */
function resolvable(name, presetDir) {
  if (name.startsWith('cordis:')) return true
  if (name.startsWith('file:')) {
    // ⚠️ 不要用正则剥 "file:///"：在 Windows 上剥完正好剩 "C:/..."，但在 POSIX 上
    // 会把开头的 "/" 一起剥掉，变成相对路径 → 插件自己那一行永远"解析不了"。
    // fileURLToPath 是唯一跨平台正确的写法（会顺带处理 %7E、中文等百分号编码）。
    try { return existsSync(fileURLToPath(name)) } catch { return false }
  }
  if (isAbsolute(name)) return existsSync(name)
  if (name.startsWith('./') || name.startsWith('../')) return existsSync(join(presetDir, name))
  const parts = name.split('/')
  const root = name.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const bases = [harnessModules, profileModules].filter((b) => b !== undefined)
  return bases.some((base) => existsSync(join(base, root, 'package.json')))
}

const specifier = pathToFileURL(entryPath).href
const row = [
  '',
  '# ── 学习模式插件（本预设独有；普通预设不受影响） ──────────────────',
  '# 用 file: 说明符直接指向工作区里的插件文件，因此本预设不依赖 profile 安装。',
  '- id: ' + ROW_ID,
  "  name: '" + specifier + "'",
].join(NL)

const base = readFileSync(sourceFile, 'utf8')
const composed = stripRow(base).replace(/\s*$/, NL) + row + NL

const presetDir = join(presetsRoot, targetId)
const unresolved = collectNames(composed).filter((item) => !resolvable(item.name, presetDir))
if (unresolved.length > 0) {
  console.error('组合里有 ' + unresolved.length + ' 行无法解析，已中止（不写出加载失败的预设）：')
  for (const bad of unresolved) console.error('  第 ' + bad.line + ' 行  ' + bad.name)
  console.error('把底预设里这些 row 换成当前版本可解析的（参考官方 standard）后重试。')
  process.exit(1)
}

mkdirSync(presetDir, { recursive: true })
writeFileSync(join(presetDir, 'agent.cordis.yml'), composed, 'utf8')
writeFileSync(join(presetDir, 'preset.yml'), 'name: 学习模式' + NL + 'description: 带「学习树」的学习会话；基于 ' + sourceId + ' 预设组合。' + NL, 'utf8')

console.log('底预设：' + sourceFile)
console.log('插件入口：' + entryPath)
console.log('row 校验：' + collectNames(composed).length + ' 行全部可解析')
console.log('已写入：' + join(presetDir, 'agent.cordis.yml'))
console.log('已写入：' + join(presetDir, 'preset.yml'))
console.log('新建会话时选择「学习模式」预设即可。')
