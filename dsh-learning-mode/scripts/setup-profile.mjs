/**
 * 把本插件注册进目标 profile（换机器时跑这个）。
 *
 * 做三件事，全部幂等：
 *   1. profile/package.json 的 dependencies 加 "dsh-learning-mode": "link:<插件绝对路径>"
 *   2. profile/package.json 的 dsh.profile.bundles 加 "dsh-learning-mode"
 *      —— 必须有！否则 dsh-client-modules 扫描不到本包，浏览器半边不会加载
 *   3. 建 profile/node_modules/dsh-learning-mode -> <插件> 的 junction
 *      （绕过 pnpm 的网络往返；也可以改用官方 dsh plugin --profile web add <路径>）
 *
 * 注意：包名/行名必须是**包根** dsh-learning-mode，不能写子路径：
 *   exactPackageSpecifier() 对含斜杠的说明符返回 undefined，该行会被静默跳过。
 *
 * 用法：node scripts/setup-profile.mjs [profile名]
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome, profileName } from './harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const pluginName = pkg.name
const profile = process.argv[2] || profileName()
// 旧版这里用 process.env.USERPROFILE（Windows 专有）兜底——在 Linux/macOS 上会退化成
// 相对路径 '.dsh/profiles/web'，直接找不到 profile 清单。统一交给 harness.dshHome()。
const target = join(dshHome(), 'profiles', profile)
const manifestPath = join(target, 'package.json')

if (!existsSync(manifestPath)) {
  console.error('找不到 profile 清单：' + manifestPath)
  console.error('可用环境变量 DSH_HOME / DSH_PROFILE 覆盖。')
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.dependencies = manifest.dependencies || {}
manifest.dsh = manifest.dsh || {}
manifest.dsh.profile = manifest.dsh.profile || {}
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles || []

const linkValue = 'link:' + packageRoot.replace(/\\/g, '/')
const changed = []
if (manifest.dependencies[pluginName] !== linkValue) {
  manifest.dependencies[pluginName] = linkValue
  changed.push('dependencies')
}
if (!manifest.dsh.profile.bundles.includes(pluginName)) {
  manifest.dsh.profile.bundles.push(pluginName)
  changed.push('bundles')
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + String.fromCharCode(10), 'utf8')

const linkDir = join(target, 'node_modules')
const link = join(linkDir, pluginName)
mkdirSync(linkDir, { recursive: true })
if (!existsSync(link)) {
  symlinkSync(packageRoot, link, 'junction')
  changed.push('junction')
}

console.log('profile：' + target)
console.log('改动：' + (changed.length === 0 ? '(无，已是最新)' : changed.join(', ')))
console.log('提示：前端改动需要重启 dsh ' + profile + ' 才会生效。')
