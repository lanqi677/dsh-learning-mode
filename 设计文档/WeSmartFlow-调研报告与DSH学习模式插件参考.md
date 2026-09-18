# WeSmartFlow 调研报告 —— 兼 DSH「学习模式」插件参考

> 调研对象：<https://github.com/Tencent/WeSmartFlow>
> 方式：GitHub REST API 逐目录读取（raw.githubusercontent 在本机 DNS 不可达，改用 api.github.com/contents）
> 覆盖：README / agent_core README / KG README / tutor.md 提示词 / SKILL.md × 5 / tool_catalog.py / registry.py / interaction.py / database.py / 工具源码
> 说明：以下"引文"均为原文摘录或忠实转述，非推测。

---

## 0. 一句话结论

WeSmartFlow 是**腾讯开源的 Agent-native 自适应学习框架**（Python + Vue3，MIT，~1.0k star）。它的价值不在"能聊天"，而在于**把学习过程本身结构化**：

1. **个人知识图谱**（掌握度 + SM-2 间隔重复 + 四类关系）作为长期记忆；
2. **规则优先的交互模式判定器**（对话 / 卡片 / 测验 / 可视化，零 LLM 调用，结果只作建议注入 system）；
3. **声明式 Skill**（SKILL.md + frontmatter，与 DSH Skill 几乎同构）；
4. **多 Agent 课程生成流水线**（规划/研究/撰写/插图/出题，Agent-as-Tool + 预算向下传导）；
5. **公共 KG 反馈闭环**（Observation → 聚合 → Facet → Proposal → 审核），检索侧零 LLM、写入侧才花 LLM。

对 DSH 插件而言：**直接移植代码不划算**（Python + 自研 agent_core，与 DSH 技术栈无关），但**产品规则、数据模型、提示词工程可以 1:1 借鉴**；而 DSH 有它没有的接缝（`agent/pre-step` 注入本轮建议、`tools/*` 治理流水线、Skill 系统、本地文件与多会话），可以做得更轻、更私密、更贴本地。

---

## 1. 仓库基本盘

| 项 | 值 |
|---|---|
| 仓库 | `Tencent/WeSmartFlow`（organization: Tencent） |
| 定位描述 | "Every question can open a new path. WeSmartFlow turns learning into conversation, exploration, stories, and hands-on discovery." |
| 语言 | Python 2.11 MB / Vue 1.02 MB / JS 120 KB / CSS 9 KB |
| Star / Fork / Open issues | **1037 / 7 / 108** |
| 创建 / 最近推送 | 2026-05-15 / **2026-09-15**（近 3 个月仍在推，活跃） |
| 默认分支 / 仓库体积 | `main` / ~160 MB（PNG、MP4 走 Git LFS） |
| 许可 | **MIT**（LICENSE 原文："WeSmartFlow is licensed under MIT. WeSmartFlow does not impose any additional restrictions beyond those specified in the license." Copyright (C) 2026 Tencent） |
| 官网 / 体验 | <http://wesmartflow.cn> |
| 其他 | has_issues / has_wiki，无 discussions |

**一个关键商业观察**：官网是**积分制商业服务**（注册赠 500 万积分；为仓库点 Star 并验证 GitHub 再赠 500 万；次月起每月补至 500 万余额上限）。也就是说——**仓库是"框架开源 + 官方 SaaS 变现"**。自己部署完全可行（模型走任意 OpenAI 兼容端点），但它强绑定的在线能力（探索模式、公共 KG、课程市场）在本地部署里是残缺的。这一点直接影响你的差异化定位。

### 顶层目录

```
WeSmartFlow/
├── backend/            agent_core(通用 Agent 库) / agents(教育 Agent+工具+提示词)
│                       services / channels(微信) / routers / repositories / models / kg
├── frontend/           Vue3 应用（Chat / Immersive / Graph / Quiz / Explore）
├── examples/           6 个独立互动学习世界 + explore-catalog.json + build.mjs
├── knowledge/          公共知识目录
├── assets/             截图与架构图
├── environment.yml · README.md · README_EN.md · LICENSE
```

---

## 2. 产品形态：一个入口，四种学法

READM 里"五种能力"：**理解目标 / 陪伴练习 / 记住成长（个人知识图谱）/ 调整路径 / 进入情境**。落到界面是四种学法：

| # | 学法 | 机制 |
|---|---|---|
| 1 | **自由辅导** | 从一个问题开始，Agent 按需生成知识卡片、交互式演示、小测验，并把新理解写入知识图谱 |
| 2 | **沉浸课程** | 输入主题 → 多 Agent 协作产出资料研究、章节规划、课件、插图、语音、练习（可导出 PDF/音频） |
| 3 | **主题探索** | 6 个独立"学习世界"：魔法英语小镇、走进数学花园、追剧搭子 BingeMate、化学实验室、知识之境、生成世界·历史。每个世界有角色/地图/规则/进度，主站只提供 Agent 与后端能力 |
| 4 | **知识图谱** | 概念关系 + 掌握度 + 下次复习时间可视化 |

已上线探索主题的代码目录：`Magic_English_Town`、`dive_into_math_garden`、`English_clip_mate`、`chemastry_lab`、`live_science`、`living_history`。

---

## 3. 工程范式（架构层可借鉴的部分）

分层（README 的架构图）：**多端学习入口 → 教育业务服务 → `agent_core`（通用 Agent 基础库） → 存储 / 模型 / 工具接入**；个人学习记忆与公共知识图谱**独立管理**。

### 3.1 agent_core：五个核心部件

> "一个 Agent 跑起来只需要五样东西，缺一不可、多一不必"

| # | 部件 | 职责 | 位置 |
|---|---|---|---|
| 1 | LLM | messages → response | `llm/` |
| 2 | Tools | 登记 / schema 投影 / 执行 | `tool/` |
| 3 | History | 存消息，按预算产出**纯 history** | `memory/` |
| 4 | Assemble | **拼出最终 messages** | `context/assemble.py` |
| 5 | Loop | think → act → 重复 | `agent/loop.py` |

横切支撑 `runtime/RunContext`（预算 / 取消 / 追踪 / 事件）。定位自述："介于 LangChain / AutoGen 与裸写循环之间——只保留跑通一个工业级 Agent 所必需的抽象"。

### 3.2 ★ 三条边界铁律（最值得抄的设计约束）

| 来源 | 提供方 | 进入位置 |
|---|---|---|
| 指令 | `SystemPromptBuilder` | system 段 |
| 知识 | `ContextProvider`（业务实现） | system 段 |
| 历史 | `memory.render()` | history 段 |
| 工具 | `ToolRegistry.get_definitions()` | tools 参数（**计入预算**） |

1. **只有 `context.assemble` 能产生 `role="system"`**；记忆若越界返回 system，装配层剔除并告警（"曾因此出现两条 system，部分模型原生 API 直接拒绝"）。
2. **SystemPromptBuilder 只出 `str`，永不出 `Message`**。
3. **Memory 不决定自己能占多少 token，只执行下发的预算**（"曾因漏算 system 与 tool schema，token 上限形同虚设"）。

这三条同样适用于 DSH 插件：**别在插件里偷偷往 messages 里塞第二条 system，别自己猜 token 预算**。

### 3.3 ReAct 循环与多 Agent

- `ReActAgent` 三个入口（`run` / `async_run` / `async_stream`）**共享同一份流式实现**，行为必然一致；固定 DAG 用 `agent/workflow.py`。
- **Agent-as-Tool**：`agent.as_tool(name, description)` 注册进父 Agent；`ctx.child()` 派生上下文——**预算与取消向下传导（子 Agent 消耗计入父预算），对话历史相互隔离**。
- Agent 定义**声明化**（`agents/registry.py` 的 `AgentSpec`）：prompt 文件 + 工具名列表 + provider 列表 + memory + budget。工具名经 `tool_catalog.py` 解析成实例，**未知工具告警跳过而非中断装配**（降级策略）。

辅导 Agent 的声明（参考值）：`memory=window(24)`、`budget=max_steps 20 / max_tool_calls 40`。
课程流水线四个子 Agent：planner(10) / researcher(8) / tex_writer(15) / exercises(8)。

### 3.4 声明式技能（SKILL.md）——与 DSH Skill 高度同构 ★

```markdown
---
description: 将 TeX 编译为 PDF
always: false
requires:
  bins: [xelatex, latexmk]
  env:  [BEAMER_TEMPLATE_DIR]
---
# TeX Beamer 撰写规范 ...
```

规则：**缺依赖的技能自动从可用列表剔除**；`workspace/skills/` 优先于 `builtins/skills/`（用户可覆盖默认）；`always: true` 常驻 system，其它按需读取（**渐进式披露**，省 token）。`knowledge_base` 这个 skill 甚至用 `status: draft` 标记为"未启用 WIP"——**技能可以带状态**。

### 3.5 记忆工程

三种短期策略：`FullMemory`（默认）/ `WindowMemory`（按轮次边界安全裁剪）/ `SummaryMemory`（滚动摘要）。
跨 run 的 `SessionMemory`：`[system+摘要] + [游标后历史·窗口兜底] + [锚点(本轮任务)] + [运行轨迹]`，**懒压缩（render 驱动）**——正常轮次零 LLM 调用，撞窗才压缩。
**截断安全 `safe_cut`**：OpenAI 兼容 API 要求 `assistant(tool_calls)` 与随后的 `tool` 消息严格配对，裁剪切断配对会直接 400——所有策略把切点前移到安全轮次边界。（DSH 侧同类坑：工具调用配对，插件裁剪历史时必须注意。）

### 3.6 工具系统三种定义方式

1. `@tool` 装饰器：函数签名 + docstring 自动生成 Function Calling schema；
2. 继承 `BaseTool`：需要注入 DB / user_id 时用（`name` / `description` / `parameters` / `run` 或 `async_run`）；
3. `MCPToolWrapper`：对接外部 MCP（stdio / SSE / streamableHttp）。

**治理 Hook 与工具实例解耦**：`tool_catalog.py` 用 `_TOOL_HOOK_NEEDS` 声明"哪个工具需要哪种 hook"，由 `ToolRegistry.register(before_call=, on_result=)` 在注册时绑定。需要 `on_result` 的恰好是那 5 个"会产出业务事件"的工具：`create_node` / `update_mastery` / `create_quiz` / `generate_html_card` / `generate_viz`。搜索/图像类工具的额度拦截下沉到**工厂产出的客户端**上。→ 这套"**声明式装配计划 ToolPlan**"的设计，DSH 的插件化工具注册可以照搬思路。

---

## 4. 学习域核心设计（真正的可迁移资产）

### 4.1 ★ 交互模式判定器 `backend/services/policy/interaction.py`（13 KB，零 LLM）

> "规则优先，零 LLM 调用。判定发生在主对话路径上，每轮都要执行，用 LLM 会增加一次往返延迟与成本……结果只作为 system prompt 的**建议**，不硬拦工具调用。"

四种模式：`chat` / `card` / `quiz` / `visualization`，各自有一段 `MODE_GUIDANCE`。判定优先级（命中即返回）：

```
first_turn（首轮固定出卡片组）
  → quiz_intent（考考我/出题/练习/小测/刷题）
  → rich_content（公式/推导/表格/插图/流程图/动画/总结/梳理…）
  → viz_intent（交互/动态演示/模拟/拖动）
  → explicit_card（"卡片"+动词）
  → greeting（你好/谢谢/再见）
  → followup_after_card（近 4 条 assistant 里出过 html_card，且是追问）
  → new_knowledge（"什么是X"，排除"为什么是X"）
  → dialogue_intent（为什么/没懂/换个说法/举例…）
  → short_input（去空格后 ≤18 字 → 先对话澄清）
  → default_card
```

状态探测用两个工具函数：`is_first_turn(chat_history)`、`has_recent_card(chat_history, session, lookback=4)`（通过 `session.files` 里 `file_type=='html_card'` 的 `from_message_id` 反查落在最近 assistant 消息）。

输出 `InteractionDecision(mode, reason, rule)`，`render_hint()` 渲染成可直接注入 system 的段落：

```markdown
## 本轮交互建议

推荐模式：生成知识卡片
判断依据：用户提出新的知识讲解请求，适合沉淀为知识卡片。
执行要求：本轮应生成知识卡片。若是快速学习首轮：必须先自主判断需要几页……
```

关键词表是**模块级常量 dataclass、可覆盖**（"新增一个交互模式必须改代码"的老问题被消解）。文件里还留了扩展点注释：规则全落空时可接 LLM 兜底，但"当前刻意不接"。

> **可直接搬到 DSH**：在 `agent/pre-step`（waterfall，可改写本步 messages）里算一次模式，把 `render_hint()` 追加/注入；成本为 0 次 LLM 调用，且与 DSH"每步都会派发 pre-step"完全对齐。这是整套方案里**性价比最高的一个零件**。

### 4.2 个人知识图谱 + SM-2

`backend/database.py` 的 nodes 表带完整 SM-2 状态：

```sql
ease_factor REAL NOT NULL DEFAULT 2.5,
interval INTEGER NOT NULL DEFAULT 1,
repetitions INTEGER NOT NULL DEFAULT 0,
due_date TEXT,
last_review_at TEXT,
mastery_level REAL NOT NULL DEFAULT 0.0,
```

- **掌握度** `mastery_level ∈ [0,1]`，通过 `update_mastery(node_id, delta, reason)` **小步增减**（delta 范围 −0.5~+0.5）；skill 里给了标准表：答对清晰 +0.1~+0.2 / 答对犹豫 +0.05 / 答错讲解后理解 0~+0.05 / 答错困惑 −0.05~−0.1 / 明确不懂 −0.1~−0.2。
- **四类关系**：`prerequisite` / `related` / `extends` / `contrasts`，通过 `create_node` 的 `parent_node_ids` / `related_node_ids` / `contrast_node_ids` 建立。
- **节点粒度铁律**："**一个节点 = 一个独立概念**"。✅ 极限 / 导数 / 快速排序；❌ 极限和导数 / 栈与队列。多概念要拆分后连关系。
- **防孤立**：创建前至少用 2 种以上搜索词（概念名 / 上位学科 / 前置概念）找关联；极端情况下先建学科父节点。
- **时机**：新概念**必须当轮创建**（先搜索→建关系→再讲解），不要等下一轮。

### 4.3 ★ 公共 KG 反馈闭环 `backend/kg/`（最有想法的一块，14 KB README）

模型从"概念+展品+信源切块"重构为**反馈闭环**：`Concept`（稳定本体）+ `Facet`（教法/共性反馈切面）+ `Observation`（Agent 对用户的观察流）+ `Proposal`（硬变更审核队列）。

设计取舍（原文要点）：
- **KG 是公共的**：所有用户共享 concept/facet/edge；**用户态（掌握度/SM-2/会话历史）完全不进 KG**。
- **写入收敛**：对 concept/facet/edge 的硬变更**必须先变成 Proposal**，审核通过才落库（`AutoApproveGate` 决定是否自动放行）。
- **教学 Agent = 发现者 + 观察者，不是知识工程师**：对话中只允许两个写入口——
  1. `kg_propose_missing_concept`（"KG 里缺一个概念"，只传名 + 理由）；
  2. `kg_record_observation`（`concept_text` + `observation_type` + `description` + `agent_confidence`）。
  **没有"直写 facet/edge/concept 元数据"的入口**。
- **检索路径轻量**：Graph RAG 只跑 embedding 余弦 + 子图扩展，**不引入额外 LLM 调用**；LLM 只在写入侧（聚合器归纳 / 建档员产出 / Auto-Gate 评审）触发。

两条后台周期 loop（`services/kg_background.py` 拉动）：

```
观察轨道 AggregatorService：
  bucket by (concept_id, observation_type)
  桶 < 阈值 → 留待下轮；桶 ≥ 阈值 → LLM 归纳
    should_propose=true  → add_facet Proposal + AutoGate
    should_propose=false → 全部 mark_processed
发现轨道 ConceptBuilderService：
  pending_build → ①向量/别名二次去重 ②LLM 生成 concept 元数据 ③LLM 生成 PEDAGOGY facet 套件
  → ④关系驱动 8 路向量召回 → LLM 选关系类型+方向 → 双向 add_edge
  全部产出打 origin=agent_authored，待人工精修
```

Facet 的两个 layer：
- `pedagogy`（教法层）：definition / intuition / analogy / example / counter_example / derivation / visualization / teaching_strategy
- `feedback`（共性反馈层）：pitfall / confusion / effective_strategy / ineffective_strategy / prerequisite_gap

Observation 的 5 类闭集（聚合分桶维度）：`struggle` / `breakthrough` / `misconception` / `effective_metaphor` / `emotional_block`。
`Facet.origin`：`manual` / `dialog_aggregated` / `agent_authored`（`agent_proposed` 已废弃）。
存储完全独立（`kg.db` + `sqlite-vec` 的 `kg_vec.db`），**不暴露任何 HTTP 路由**，统一同进程 `import kg_facade`。

> 这套设计的精华是**"Agent 只能提议、不能定稿"+"观察与定稿异步分离"**：把"教学过程中随口发现的洞见"和"进入教材的稳定知识"用一条审核队列隔开。单机 DSH 插件可以退化实现（本地 facet 文件 + 简单 gate），但**这个概念值得保留**——它天然回答了"AI 学到的东西怎么沉淀、怎么不污染"。

### 4.4 ★ tutor.md 提示词（5.8 KB，完整教法规则，可直接改写成 DSH 提示词）

核心是"**先判断，再行动**"：

1. **首轮固定卡片组**：第一次有效交流必须自主判断页数，生成 **3-5 张图文并茂的入门卡片组**（简单 3 / 常规 4 / 复杂 5），文字只做简短串联。
2. **对话优先**：首轮之后的追问、澄清、纠错、确认、闲聊、元问题 → 直接文字对话。
3. **卡片优先**：明确要求卡片，或回复预计 >200 字，或需要公式/表格/插图 → 出卡片。
4. **测验模式**：用户要求考/练习 → **必须调用 `create_quiz`，严禁在文字里直接写题目、选项、答案**。
5. **可视化模式**：动态过程、状态变化、几何/算法演示 → `generate_interactive_viz`。
6. 若 system 里出现「本轮交互建议」或「推荐模式」，**必须优先遵循**。

卡片规范：`title` 简洁有力；`content` **只承载一个概念**（定义 + 1-2 个核心要点 + 一个例子/公式/流程/对比）；禁止把多个子概念塞进一张卡；禁止为了丰富塞无关内容；**禁止在文字回复中复制卡片正文**；卡片生成后"文字回复要短 + 一个开放性引导问题"。
对话风格：中文、简洁直接、先帮助理解再考虑沉淀材料、不确定先问澄清、**"不要虚构工具调用结果；调用了工具才可以说已经生成"**。

技能加载：判断需要某技能时，用 `read_file` 读对应 SKILL.md 再照做（渐进式披露）。

### 4.5 工具清单（tool_catalog.py 全量）

| 工具名 | 作用 | 关键参数 |
|---|---|---|
| `now` | 当前时间 | — |
| `search_nodes` / `get_node` | 图谱检索节点（返回 id/标题/描述/掌握度） | 关键词 / node_id |
| `create_node` | 建节点 + 建关系 | `parent_node_ids` / `related_node_ids` / `contrast_node_ids` |
| `update_node` | 改标题/笔记/标签 | — |
| `update_mastery` | 掌握度增减 | `node_id`, `delta`(−0.5~0.5), `reason` |
| `create_quiz` | 生成交互式答题卡片 | `node_id`, `quiz_type`(multiple_choice/fill_in/true_false/open_ended), `question`, `options`, `correct_answer`, `explanation` |
| `generate_html_card` | 生成单页 HTML 知识卡片 | `title`, `content`(越具体越好), `node_ids` |
| `generate_viz` | 生成交互式可视化（EduViz） | — |
| `kg_search` / `kg_resolve` | 公共 KG Graph RAG 检索 / 实体链接 | query / terms |
| `kg_propose_missing` | 提议"KG 缺这个概念" | concept_name + reason_brief |
| `kg_record_observation` | 记录对用户的观察 | concept_text + observation_type + description |
| `tavily` / `arxiv` / `web_fetch` / `smart_search` | 联网检索 | query |
| `read_file` / `list_dir` / `read_file_any` / `write_file` | 文件（前两个限定在 SKILL 目录内） | — |
| `image_gen` / `latex_compile` | 插图 / LaTeX Beamer 编译 | — |

工具实现的几个**防御性细节**值得抄：
- `create_quiz` 收到臆造的 `node_id` 时**不抛异常中断对话**，而是 `strict_node=False` 回退 + 返回 `{"error": ...}` JSON 让 Agent 自行修正重试；
- 工具构造失败 / 未知工具名 → **告警跳过**，Agent 带着剩余工具继续工作；
- 同步兜底 `run()` 内部 `asyncio.run(async_run())`，正常路径走 `async_run`。

### 4.6 EduViz（交互可视化）的质量护栏

README 明确区分两类产物：**HTML 卡片**适合整理一个知识点；**EduViz** 适合通过操作理解概念（改参数、逐步执行算法、观察状态变化）。EduViz 是"基于 SDK 生成 JavaScript，**经过检查后按具体问题修复**"——有 `validate_viz_code.py` / `viz_quality.py` / `viz_runtime.py`（Playwright 真跑一遍）。原文自带免责："检查通过不等于视觉效果或教学内容已经得到全面验证。"→ **生成式产物的两道闸（静态校验 + 浏览器真跑）**这个模式，比"让模型自己说没问题"可靠得多。

### 4.7 探索模式的三契约（多前端世界的低耦合接入）

```
内容契约：examples/explore-catalog.json
构建契约：build:wesmartflow + 约定的环境变量
服务契约：同源静态路径 + 可选的相对 /api 路径
```

接入新主题只需：在 `examples/` 建独立应用 → 提供 `build:wesmartflow` → 在 catalog 登记分类/入口/介绍 → 跑 `npm run validate:examples` + `npm run build:examples -- --only <id>`。主题可用 Vue/React/Svelte/Canvas/Three.js/原生 HTML。**课程作者保留自己的代码结构与设计语言**，作者信息随课程展示。→ 这是"**插件/内容生态**"的正确姿势：主站只定义 3 条窄契约，其余全自由。

### 4.8 WeClaw 微信通道

把 edu-agent 接成消息通道：扫码绑定（每用户自己的 bot）→ 每 bot 一个 async httpx 长轮询协程（由 ChannelManager 调度，单机可承载大量在线 bot）→ **消息直接走同一套 `TutorService`**（共享 ReAct 能力、知识图谱、用户画像）→ HTML 卡片/可视化/测验用 Playwright 渲染成图片发送，并附网页端交互链接。配置：`WECLAW_ENABLED` / `PUBLIC_BASE_URL` / `WECLAW_RENDER_CARDS`(默认 true) / `WECLAW_RENDER_WIDTH`(480)。

---

## 5. 映射到 DSH：哪些能搬、怎么搬

| WeSmartFlow 组件 | DSH 对应接缝 | 建议做法 |
|---|---|---|
| tutor.md 教法提示词 | 宿主插件注入 / Agent 预设 / Skill | 改写成 `learning-mode` Skill 的 SKILL.md（教法规则本来就是"知识/流程"，正好是 Skill 的定位） |
| **InteractionPolicy 模式判定** | `agent/pre-step`（waterfall，可改写 messages） | ★ 规则原样搬（中文关键词表可直接用），每步算 mode → 注入「本轮交互建议」；零 LLM 调用 |
| 首轮 3-5 张卡片组 / 200 字阈值规则 | 同上（建议段里声明） | 纯提示词规则，无需代码 |
| 个人知识图谱（SQLite nodes） | 插件私有数据目录（`~/.dsh/...` 或工作区） | 用 JSONL/SQLite 存节点+关系+掌握度；键用 `agent.id`/sessionId |
| SM-2 复习队列 | `agent/turn-stopping`（可插入额外工作）或 daemon-loop 形态插件（timer） | 每轮结束检查 due_date，需要复习时主动提示；或每日定时生成"今日复习" |
| `update_mastery` / `create_node` / `search_nodes` | 插件注册 tool | 直接照搬 schema（参数名都不用改） |
| `create_quiz` 交互答题卡 | `ask_user_question` 或 UI panel slot | DSH 没有"前端卡片渲染管道"，用 ask_user_question 最省事；要更好体验就走 ui-panel |
| `generate_html_card` | 写本地 HTML 文件 + `present` | DSH 天然有文件系统与工作区，比 WeSmartFlow 少一层"注册为文档"的管道 |
| EduViz 交互可视化 | UI panel slot / 本地 html | 需要浏览器侧插槽才有意义 |
| 多 Agent 课程生成流水线 | `ctx.agents` / `ctx.agentLoop` 子代理 | planner→researcher→writer→exercises，产物落文件；DSH 子代理本身就支持 |
| 公共 KG 反馈闭环 | 无直接对应 | 退化成本地 facet 库（自己的误区/有效类比沉淀）+ 简单 gate；别上"多用户公共 KG" |
| 探索世界（examples/） | UI panel 或独立本地网页 | 想做就做一个 panel，不必复刻 catalog/build 契约 |
| 微信通道 / 积分 / 额度 | — | **不做**（DSH 无对应，也没必要） |
| 三条边界铁律、ToolPlan 声明式装配、safe_cut、降级跳过 | 插件工程规范 | 作为编码约束直接遵守 |

DSH 侧现成能力（来自本机 `DSH插件开发指南.md`）：`agent/created|status|pre-step|request|turn-stopping`、`tools/pre-execute|execute|post-execute|result`（pre/post 可**否决/改参/注入上下文**）、`ctx.llm`、`ctx.agents`、`ctx.sessions`、`ctx.settings`、`ctx.commands`（斜杠命令，如 `/learn`、`/review`）、`ctx.skill`、`ctx.slots`（前端 UI 插槽）。三种形态选择口诀：**影响所有会话 → 宿主插件；只影响某类会话 → Agent 预设；只是"知识/流程" → Skill**。

---

## 6. 差异化定位建议（别重复造轮子）

| WeSmartFlow 强 | DSH 强 |
|---|---|
| 完整的沉浸课程生成流水线、公共 KG、6 个互动世界、SaaS 运营 | 本地文件系统 + 终端 + Skill 系统 + 可注入插件 + 多会话 + **零服务器、零账号、数据不出本机** |

**推荐切口：「本地学习教练」，而不是「复刻一个 WeSmartFlow」。**

- 它的核心用户价值是"**知识留在图谱里、下次能被遇见**"——这部分**完全可以在本地做**：一个 JSON/SQLite 文件 + SM-2 + 每轮一次零成本模式判定就够了；
- 它的重资产（课程流水线、公共 KG 自动建档、探索世界、积分体系）**单机用户用不上或做不动**，硬抄只会得到一个"半残的 SaaS"；
- DSH 独有的可做点：学习的产物直接就是**本地笔记文件**（Markdown/HTML 落到工作区，可 git、可编辑）；复习可以在**任何会话**里提醒；`/learn` 命令 + Skill 承载教法；必要时用 daemon-loop 形态做"每日学习计划"。

**明确不做**：SaaS 后台、积分/额度、多用户公共 KG、微信通道、Playwright 卡片渲染链路。

---

## 7. MVP 分期（建议）

| 阶段 | 内容 | 形态 |
|---|---|---|
| **P0（最小可用）** | 教法 Skill（`learning-mode`）+ 插件在 `agent/pre-step` 注入「本轮交互建议」（照抄 interaction.py 规则） | Skill + 宿主插件 |
| **P1** | 本地知识图谱（节点/关系/掌握度，JSONL）+ 三个工具（create_node / search_nodes / update_mastery）+ 卡片产物落工作区 | 插件 toolkit |
| **P2** | SM-2 复习队列 + `/learn`、`/review` 斜杠命令 + 每轮结束检查到期复习 | 插件 + commands |
| **P3** | UI 面板（图谱可视化 + 复习日历）+ 子代理课程生成流水线 | ui-panel / hybrid |
| **P4（可选）** | 本地 facet 库：把"误区/有效类比"按 concept 沉淀（KG 闭环的单机退化版） | 数据层 |

建议流程：`dev_plugin_status → dev_self_test → dev_scaffold_plugin → dev_build_plugin → dev_inject_plugin → dev_uninject_plugin`（本机 super-injector 闭环，无需重启即可试）。

---

## 8. 风险与注意

1. **许可**：代码 MIT（署名即可），但 LICENSE 保留 Tencent 版权声明；README 说"课程作者保留自己的代码结构、设计语言"，即 `examples/` 下的课程内容版权归各自作者——**抄代码可以，抄课程内容要看具体主题的授权**。
2. **它的"自动建档"依赖 LLM 审核 + 多用户数据，单机没法复现价值**；不要为了架构对齐而引入后台 LLM 循环（那是持续成本）。
3. **token/额度记账体系（usage_meter / credit_wallet / pricing）不要抄**——DSH 有自己的成本视图。
4. 全部依赖 Python 3.10+ / Node 24+ / conda / LSP；LFS 资源 ~160 MB；部署成本不低，**不建议为了"参考"而 clone 全仓**（用 API 读文件更快，本次调研即如此）。
5. 它的产品**规则类资产**（页数阈值、掌握度 delta 表、模式关键词、测验四型、facet 分类）是最值钱的部分，**这些没有技术栈绑定，可直接重写**。

---

## 9. 关键文件索引（按图索骥）

| 用途 | 路径 |
|---|---|
| 总览 | `README.md` / `README_EN.md` |
| 通用 Agent 库设计 | `backend/agent_core/README.md` |
| **教法提示词（必读）** | `backend/agents/prompts/tutor.md` |
| **交互模式判定（必读）** | `backend/services/policy/interaction.py` |
| 技能（教法/图谱/测验/卡片/检索） | `backend/agents/prompts/skills/{knowledge_card,quiz,knowledge_graph,eduviz_sdk,web_search,knowledge_base}/SKILL.md` |
| 工具实现 | `backend/agents/tools/`（`create_node.py` `update_mastery.py` `create_quiz.py` `generate_html_card.py` `generate_viz.py` `kg_tools.py`） |
| 工具装配 | `backend/agents/tool_catalog.py` / `backend/agents/registry.py` |
| 辅导服务编排 | `backend/services/tutor_service.py` |
| **公共 KG 设计（必读）** | `backend/kg/README.md` + `backend/services/kg_facade.py` |
| 掌握度/SM-2 表结构 | `backend/database.py` |
| 课程流水线提示词 | `backend/agents/prompts/immersive/{planner,researcher,tex_writer,exercises}.md` |
| 探索主题契约 | `examples/README.md` / `examples/explore-catalog.json` |
| 微信通道 | `backend/channels/` |

---

## 10. 参考链接

- 仓库：<https://github.com/Tencent/WeSmartFlow>
- 官网体验：<http://wesmartflow.cn>
- 后端指南：<https://github.com/Tencent/WeSmartFlow/blob/main/backend/README.md>
- agent_core 指南：<https://github.com/Tencent/WeSmartFlow/blob/main/backend/agent_core/README.md>
- KG 设计：<https://github.com/Tencent/WeSmartFlow/blob/main/backend/kg/README.md>
- 辅导提示词：<https://github.com/Tencent/WeSmartFlow/blob/main/backend/agents/prompts/tutor.md>
- 交互模式判定：<https://github.com/Tencent/WeSmartFlow/blob/main/backend/services/policy/interaction.py>

> 本机参考：`D:\AI工作区\DSH插件开发指南.md`（DSH 扩展点与三种插件形态）
