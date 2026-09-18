/**
 * 给本插件建依赖 junction：<插件>/node_modules/@deepseek-ai -> harness 的 @deepseek-ai。
 *
 * 为什么需要：预设用 file: 说明符直接加载 <插件>/lib/index.js，
 * 而该文件 import '@deepseek-ai/dsh-tools'；Node 从该文件位置向上找 node_modules，
 * 工作区里没有，所以要靠这个 junction 把 harness 的包"借"过来。
 *
 * 目录名是 node_modules，打包时应排除；换机器后重新跑一次本脚本即可。
 */
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { harnessScopeDir } from './harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const target = harnessScopeDir()

if (target === undefined) {
  console.error('找不到 harness 的 @deepseek-ai 目录。')
  console.error('请设置 DSH_CHECKOUT 指向 dsh 包目录，或确认 @deepseek-ai/dsh 已安装。')
  process.exit(1)
}

const linkDir = join(packageRoot, 'node_modules')
const link = join(linkDir, '@deepseek-ai')
mkdirSync(linkDir, { recursive: true })
if (existsSync(link)) {
  console.log('已存在，跳过：' + link)
} else {
  symlinkSync(target, link, 'junction')
  console.log('已建立 junction：' + link + '  ->  ' + target)
}
console.log('目标校验：' + (existsSync(join(target, 'dsh-tools', 'package.json')) ? 'ok' : '缺少 dsh-tools'))
