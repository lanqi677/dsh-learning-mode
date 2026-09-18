/**
 * 跨机器发现 DSH 安装位置的小工具。所有脚本共用，避免硬编码用户名/盘符。
 *
 * 解析顺序（找到第一个可用即返回）：
 *   1. 环境变量 DSH_CHECKOUT（指向 dsh 包安装目录）
 *   2. 从 profile 的 package.json 解析 @deepseek-ai/dsh-tools
 *   3. 从本插件目录向上解析
 *   4. 常见全局 npm 目录
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function dshHome() {
  const env = process.env.DSH_HOME
  return env !== undefined && env !== '' ? env : join(homedir(), '.dsh')
}

export function profileName() {
  const env = process.env.DSH_PROFILE
  return env !== undefined && env !== '' ? env : 'web'
}

export function profileDir() {
  return join(dshHome(), 'profiles', profileName())
}

/** 从某个模块入口路径里切出“包含 @deepseek-ai 的那个 node_modules 目录”。 */
function nodeModulesOf(entry) {
  const normalized = String(entry).replace(/\\/g, '/')
  const marker = normalized.lastIndexOf('/@deepseek-ai/')
  return marker < 0 ? undefined : normalized.slice(0, marker)
}

function fromRequire(base) {
  try {
    const req = createRequire(join(base, 'package.json'))
    return nodeModulesOf(req.resolve('@deepseek-ai/dsh-tools'))
  } catch {
    return undefined
  }
}

/** 返回 harness 的 node_modules 目录（其下应有 @deepseek-ai/dsh-tools）。 */
export function harnessNodeModules() {
  const seen = []
  const push = (v) => { if (v !== undefined && v !== '' && !seen.includes(v)) seen.push(v) }

  const checkout = process.env.DSH_CHECKOUT
  if (checkout !== undefined && checkout !== '') {
    push(join(checkout, 'node_modules'))
    push(join(checkout, '..', 'node_modules'))
  }
  push(fromRequire(profileDir()))
  push(fromRequire(join(dshHome(), 'profiles')))
  push(fromRequire(process.cwd()))

  const globalRoot = process.env.APPDATA !== undefined && process.env.APPDATA !== ''
    ? join(process.env.APPDATA, 'npm', 'node_modules')
    : undefined
  if (globalRoot !== undefined) {
    push(join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules'))
  }

  for (const base of seen) {
    if (existsSync(join(base, '@deepseek-ai', 'dsh-tools', 'package.json'))) return base
  }
  return undefined
}

/** 官方自带预设目录（含 minimal / standard / cordis / ptc）。 */
export function shippedPresetsRoot() {
  const nm = harnessNodeModules()
  if (nm === undefined) return undefined
  const root = join(nm, '@deepseek-ai', 'dsh-agent-presets', 'presets')
  return existsSync(root) ? root : undefined
}

/** harness 的 @deepseek-ai 包目录（供插件做依赖 junction）。 */
export function harnessScopeDir() {
  const nm = harnessNodeModules()
  return nm === undefined ? undefined : join(nm, '@deepseek-ai')
}

/** 读一个 package.json，失败返回 undefined。 */
export function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
}

export { dirname }
