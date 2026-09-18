/**
 * 校验一个预设组合里每个 row 的 name 能不能被解析。
 *
 * 用法：
 *   node scripts/validate-preset.mjs            # 校验默认的 learning-mode 预设
 *   node scripts/validate-preset.mjs <路径>     # 校验指定 agent.cordis.yml
 *
 * 跨平台：harness / profile 的 node_modules 位置全部由 scripts/harness.mjs 推断
 * （旧版这里硬编码了 Windows 的 C:/Users/<user>/... 路径，换机器必挂）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome, harnessNodeModules, profileDir } from './harness.mjs'

const harness = harnessNodeModules()
const profileModules = join(profileDir(), 'node_modules')
const file = process.argv[2] || join(dshHome(), '.agent-presets', 'learning-mode', 'agent.cordis.yml')

if (!existsSync(file)) {
  console.error('找不到预设文件：' + file)
  console.error('先跑 node install.mjs 生成，或把预设路径作为参数传入。')
  process.exit(1)
}
if (harness === undefined) {
  console.error('找不到 harness 的 node_modules（可设 DSH_CHECKOUT 指定 dsh 包目录）。')
  process.exit(1)
}

// yaml 从 harness 的依赖里借（本插件自身不装依赖）。
const require = createRequire(join(harness, 'noop.js'))
const yaml = require('yaml')
const presetDir = dirname(file)
const doc = yaml.parse(readFileSync(file, 'utf8'))

const rows = []
const walk = (list, group) => {
  if (!Array.isArray(list)) return
  for (const row of list) {
    if (row === null || typeof row !== 'object') continue
    if (typeof row.name === 'string') rows.push({ id: row.id, name: row.name, group })
    if (Array.isArray(row.config)) walk(row.config, row.id || group)
  }
}
walk(doc, null)

function resolvable(name) {
  if (name.startsWith('cordis:')) return { ok: true, how: 'builtin' }
  if (name.startsWith('file:')) {
    // 同 install.mjs：fileURLToPath 才是跨平台正确的写法
    // （旧版正则剥 "file:///" 会在 POSIX 上把开头的 "/" 一起剥掉）。
    try { return { ok: existsSync(fileURLToPath(name)), how: 'file ' + fileURLToPath(name) } } catch { return { ok: false, how: 'bad file url' } }
  }
  if (isAbsolute(name)) return { ok: existsSync(name), how: 'abs' }
  if (name.startsWith('./') || name.startsWith('../')) return { ok: existsSync(join(presetDir, name)), how: 'rel' }
  // 包内子路径（@scope/pkg/sub 或 pkg/sub）按包根判定
  const parts = name.split('/')
  const root = name.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  for (const [base, label] of [[harness, 'harness'], [profileModules, 'profile']]) {
    if (existsSync(join(base, root, 'package.json'))) {
      return { ok: true, how: label + (root === name ? '' : ' (' + root + ' 子路径)') }
    }
  }
  return { ok: false, how: 'harness/profile 的 node_modules 里都没有' }
}

console.log('预设：' + file)
console.log('harness：' + harness)
console.log('row 总数：' + rows.length)
let bad = 0
for (const row of rows) {
  const r = resolvable(row.name)
  if (!r.ok) { bad += 1; console.log('  ✗ ' + String(row.id) + '  -> ' + row.name + '   (' + r.how + ')') }
}
console.log(bad === 0 ? '全部可解析' : ('不可解析：' + bad + ' 行'))
process.exit(bad === 0 ? 0 : 1)
