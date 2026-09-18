# dsh-learning-mode · DSH 学习模式

给 [DSH](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）用的 agent 插件：一棵由 AI 维护、**可无限下钻的学习树**。

它解决的是一个很具体的痛点：**学习时钻进支线，回头找不到原来的位置**。
复习链表时看到"跳表"就去研究跳表，研究完要翻很久聊天记录才能回到链表；
要复习十个知识点，每学完一个都得回去找下一个。

## 它做什么

- **树是持久的**：今天学 Java，明天开新会话继续，树还在（可以有多棵树）。
- **AI 直接往树里写**：你说"我要学 Java，要学什么"，清单就长出来了，不用手抄。
- **无限下钻**：对着"对象"再问一句，继承 / 私有 / 面向对象思想就挂到它下面。
- **树顺着你的思路长**，不按教科书目录 —— 你由「数组」问到「计算机地址」，它就挂在数组下面；
  记录的是当时怎么想的。挂节点由 AI 做，你只管问。
- **每轮对话自动带上**"我在哪 + 这一层的摘要 + 还没学完什么"（不用你复述上下文）。
- **标 [✓ 学会] 时插件自己调模型写一句摘要**（不进聊天记录，省上下文），
  复习页签集中读；摘要不对可以 [⟳] 重写。
- **点 [↩] 跳回讲它的那一轮对话**：每个知识点都记着"它是在哪轮对话里讲到的"，
  点一下切回那次会话、滚到那一轮并高亮。
- 面板是**玻璃浮层**，可以**拖动 / 调大小**，并且**记住你上次调的样子**。
- **零侵入**：普通会话里不显示任何东西 —— 只有挂了「学习模式」预设的会话才有入口。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `dsh-learning-mode/` | **插件本体**：宿主半边 + 浏览器半边 + 测试 + 安装脚本 |
| `继续开发说明.md` | 开发台账：每轮做了什么 + 16 个**真实踩过的坑**（含根因与判据） |
| `设计文档/` | 方案 v1/v2、插件全貌与运行时对齐、调研报告 |
| `预设参考/` | 生成的 agent 预设（`agent.cordis.yml`），可对照 |
| `数据备份（可选）/` | 教程树的数据备份（示例数据） |

想直接看实现细节和每个坑，读 `dsh-learning-mode/README.md` 与 `继续开发说明.md`。

## 装起来（5 步）

前置：DSH 已装好能跑（`dsh web`），Node 18+。

```bash
cd dsh-learning-mode

# 1. 建依赖 junction：把 harness 的 @deepseek-ai 包"借"给本插件
node scripts/link-harness-deps.mjs

# 2. 自检（五套断言 + 探针，全绿再往下走）
npm test

# 3. 生成 agent 预设（复制底预设 + 追加插件行 + 逐行校验）
node install.mjs standard

# 4. 注册进 profile（dependencies + bundles + junction，幂等）
node scripts/setup-profile.mjs

# 5. 重启 dsh web，刷新页面，新建会话时选「学习模式」
```

> ⚠️ **`node_modules/` 故意没有进仓库**：它是指向本机 harness 安装目录的软链
> （`node_modules/@deepseek-ai` → dsh 的包目录），换了机器必须重新跑第 1 步。
> 脚本会自动探测 DSH 安装位置；探测不到时用环境变量指定：
> `DSH_HOME`（默认 `~/.dsh`）、`DSH_PROFILE`（默认 `web`）、`DSH_CHECKOUT`（dsh 包目录）。

## 自检与运维脚本

| 命令 | 作用 |
|---|---|
| `npm test` | **353 条断言**：数据层 / 宿主集成 / 摘要管道 / 浏览器渲染 / 探针 |
| `npm run verify:live [会话id前缀]` | **真机核查**：直接解多帧 zstd 会话日志，核对"每轮注入真的在不在""开发向工具是否已屏蔽" |
| `npm run backfill:origins` | 回填来源坐标（扫会话日志里的 `outline_capture`/`outline_add` 调用；默认 dry-run，`--write` 才写盘并备份） |
| `npm run validate:preset` | 逐行校验预设里每个 specifier 能否解析 |

## 设计上的两条硬约束

1. **零侵入**：插件只挂在「学习模式」预设里，普通会话连按钮都不渲染。
2. **失败不许静默**：面向模型的功能一旦静默失败，界面上和"正常工作"长得一模一样
   —— 这个项目为此栽过两次（见 `继续开发说明.md` 坑 13）。
   所以关键步骤都往 `$DSH_HOME/learning-mode/rpc.log` 留判据（`inject diag` / `origin diag` / `jump …` / `env …`）。

## 状态

个人项目，跟着本机 DSH 版本走（peer dependency：`@deepseek-ai/cordis ^4.0.1`）。
`lib/` 是手写的普通 JavaScript（没有构建步骤、没有 TypeScript）。

## 许可

MIT，见 `LICENSE`。
