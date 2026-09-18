/**
 * dsh-learning-mode / client-host —— 空插件。
 *
 * 为什么需要它：浏览器半边由 @deepseek-ai/dsh-client-modules 提供，而它的发现规则是
 * "扫描 host Loader 已挂载的条目里声明了 dsh.client 的包"。
 * 也就是说：如果本包没有任何 host 平面行，浏览器半边永远不会被加载。
 *
 * 而这个包真正的宿主半边（7 个 outline_* 工具 + 提示段）必须**只**挂在
 * 「学习模式」agent 预设里，绝不能全局注册（否则所有会话的工具表都会被污染）。
 *
 * 注意：bundle patch 里的行名必须是**包根**（'dsh-learning-mode'）。
 * client-modules 的 exactPackageSpecifier() 对含 "/" 的说明符返回 undefined，
 * 会把该行当作"不是客户端包"直接跳过——写成子路径会静默失效、连报错都没有。
 *
 * 于是拆成两半：
 *   - 本文件（host 平面，bundle patch 插入）：什么都不注册，只让本包被扫到；
 *   - lib/index.js（agent 平面，预设用 file: 说明符引入）：真正的工具与注入。
 */
export const name = 'dsh-learning-mode-client-host'

export function apply() {
  // 故意为空。不要在这里注册任何东西。
}
