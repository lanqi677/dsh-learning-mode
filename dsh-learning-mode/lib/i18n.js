/**
 * dsh-learning-mode — 宿主半边的文案表（中 / 英）+ 当前语言状态。
 *
 * ── 为什么"中文原文就是字典 key" ───────────────────────────────────────────
 * 英文表 EN 的 key 是**代码里的中文原文**，值是对应英文：
 *
 *     export const EN = { '摘要生成中…': 'Generating summary…' }
 *
 * 代码里写 `t('摘要生成中…')`。这样有三个好处：
 *   ① 中文路径零风险：zh 的取值就是 key 本身，改动不会动到已经调好的中文行为；
 *   ② 漏翻必被抓：字典缺 key 时英文界面会露出中文，而 test/i18n.mjs 直接扫
 *      `t('…')` 的第一参数并断言"每个 key 都在 EN 里"，漏翻会让测试红；
 *   ③ 新增文案不用同步改两处（key 就是文案）。
 * 代价是代码里保留了中文串（这个仓库的注释本来也是中文），换来的是不会漏 key。
 *
 * ── 为什么 host 自己实现 translate，而不用 ctx.locale ──────────────────────
 * `locale` 是**浏览器侧**的 Cordis 服务（字典注册 + 当前语言 + 订阅），host 半边
 * 没有它。而本插件的模型侧文案（每轮注入块、工具描述、回退消息、摘要提示词）
 * 必须在 host 侧生成，所以这里自带一份同规则的实现：
 *   取值链 = 当前语言 → （zh 时不再往下）→ 缺失则原样返回 key。
 * 当前语言由 index.js 决定（见下方 setLocale 的注释），store.js / summary.js
 * 只 import `t`，不需要知道语言是怎么来的。
 *
 * ⚠️ 浏览器半边不能 import 本文件：`lib/client.js` 是
 * `window.__ModuleLoader__.load({ factory })` 的闭包模块（只能 require("react") 这类外部依赖），
 * 不是 ESM。所以客户端自带一份**只覆盖 UI 文案**的内嵌字典（两边的 key 集合基本不相交：
 * 面板 UI 的串只由浏览器半边用，模型侧/存储侧的串只由 host 用）。
 */

/** 当前语言（'zh' | 'en'）。默认中文：没拿到任何语言信号时的行为与升级前一致。 */
let current = 'zh'

/**
 * 归一化 locale id。
 * DSH 内置语言只有 `zh` / `en`（见 dsh-client-locale 的 LOCALE_IDS），
 * 且 `zh` 的 fallback 声明就是 `en` —— 所以除 zh 外的一切都归到 en。
 * @param {unknown} id BCP 47 风格的 locale id，或任意值
 * @returns {'zh' | 'en'}
 */
export function pickLocale(id) {
  return typeof id === 'string' && /^zh/i.test(id.trim()) ? 'zh' : 'en'
}

/**
 * 设置当前语言（host 侧唯一入口）。
 * 由 index.js 按优先级调用：客户端上报的 active locale > settings 的显式偏好 > 'zh'。
 * @param {unknown} id
 * @returns {'zh' | 'en'} 归一化后的结果
 */
export function setLocale(id) {
  current = pickLocale(id)
  return current
}

/** @returns {'zh' | 'en'} 当前语言 */
export function getLocale() {
  return current
}

/**
 * 英文表：key = 代码里的中文原文，value = 英文译文。
 * 用 `{name}` 形式做插值（与 dsh-client-locale 的 Translate 同语法）。
 * @type {Record<string, string>}
 */
export const EN = {
  // ── lib/index.js ──
  "# 学习模式（当前会话已开启）": "# Learning Mode (enabled in this session)",
  "本会话有一棵「学习树」：节点=知识点，用户在右侧面板聚焦/标完成，每个节点带一句摘要。": "This session has a \"learning tree\": a node is a topic, the user focuses and marks nodes learned in the right-hand panel, and every node carries a one-line summary.",
  "## 第一优先级：静默整理（用户不想为\"记笔记\"操心）": "## Top priority: silent organizing (the user does not want to fret over note-taking)",
  "- 每次解答完一个问题后，把**这个问题引入的知识点**用 `outline_capture` 挂到**当前聚焦节点**下面。": "- After answering each question, attach the **topic that this question introduced** under the **currently focused node** with `outline_capture`.",
  "- **`outline_capture` 不搬焦点**（默认就是不动）：焦点＝\"用户在看哪\"，**只有用户能改变它**（面板点击，或用户的话明确指向别的节点）。你顺手整理时如果搬了焦点，用户的\"我在哪\"就被你的列举牵着走了。": "- **`outline_capture` does not move the focus** (it leaves it untouched by default): the focus is \"what the user is looking at\", and **only the user can change it** (a panel click, or the user’s words clearly pointing at another node). If you move the focus while tidying up, the user’s sense of \"where I am\" gets dragged along by your enumeration.",
  "- **焦点什么时候该动**：① 用户的话明确指向某个**已有节点** → 先 `outline_focus` 它再回答；② 用户这一问的主题就是一个**新知识点**（他问的就是它）→ `outline_capture({ focus: true })`。除此之外都不动焦点。": "- **When the focus should move**: 1. the user’s words clearly point at an **existing node** → `outline_focus` it first, then answer; 2. the subject of this question is itself a **new topic** (that is exactly what they asked about) → `outline_capture({ focus: true })`. Otherwise never move the focus.",
  "- **子概念只点到为止**：回答的主体永远是当前聚焦节点。顺带引入的子概念挂上去 + 一两句交代\"它是什么、为什么在这儿\"就够了，**不要**在同一条回答里替用户把它展开成完整的一节——他想深入会自己点进去或问你。": "- **Introduce sub-concepts only in passing**: the body of the answer is always the currently focused node. Attaching a sub-concept you brought in along the way plus one or two sentences on \"what it is and why it sits here\" is enough; do **not** expand it into a full section for the user inside the same answer - if they want depth they will click into it or ask you.",
  "- **发散优先于体系**：用户由「数组」问到「计算机地址」，就把「计算机地址」挂在「数组」下面（即使它是前置知识），**不要**为了\"体系正确\"挪到别处——树记录的是当时的思路路径。": "- **Divergence beats taxonomy**: when the user goes from \"arrays\" to \"computer addresses\", attach \"computer addresses\" under \"arrays\" (even though it is prerequisite knowledge); do **not** relocate it for the sake of a \"correct\" taxonomy - the tree records the path the thinking actually took at the time.",
  "- **不要向用户报告**：不写\"已添加 X\"、不复述树、不问要不要记录。只有确实引入了新知识点才 capture；寒暄、元问题、纯确认不 capture。": "- **Do not report to the user**: do not write \"added X\", do not recite the tree, do not ask whether to record it. Capture only when a new topic really was introduced; small talk, meta questions and plain confirmations are not captured.",
  "- 一轮最多 capture 一个节点，不要为了整齐批量补全。": "- Capture at most one node per turn; do not batch-fill for the sake of tidiness.",
  "- **摘要不用你写**：只有用户点 [✓ 学会]（或你调 `outline_done`）时，插件才会自动生成摘要。不要在聊天里替用户总结、也不要为了摘要而标完成。": "- **You do not write summaries**: the plugin auto-generates a summary only when the user clicks [✓ Learn] (or you call `outline_done`). Do not summarize for the user in the chat, and do not mark anything learned just to get a summary.",
  "## 元决策：一律用 ask_user_question 出选项，不要用对话来回问": "## Meta decisions: always offer options with ask_user_question, never ask back and forth in chat",
  "- 选哪棵树 / 要不要新建 / 树叫什么 这类**与学习内容无关**的确认，**必须**用 `ask_user_question` 给结构化选项（第一个＝你推荐的那项，label 后加「(Recommended)」），让用户一点就完，用户也可以自己填。": "- For confirmations **unrelated to the learning content** - which tree to pick, whether to create one, what to name it - you **must** give structured options with `ask_user_question` (the first = the option you recommend, with \"(Recommended)\" appended to its label) so the user can settle it with one click; they may also fill in their own answer.",
  "- 理由（用户的明确要求）：这些往返会在上下文里留下噪音、也让用户分心。**不要**用普通对话问、不要聊两轮才定下来。": "- Why (the user’s explicit requirement): those round trips leave noise in the context and distract the user. Do **not** ask in ordinary conversation, and do not take two exchanges to settle it.",
  "- 只有\"必须澄清才能继续\"的**学习内容**问题，才用普通方式问。": "- Ask in the ordinary way only for **learning content** questions that \"cannot continue without clarification\".",
  "## 其它": "## Other",
  "1. **用户的话没指明对象时（\"介绍/讲讲/继续/详细说说/然后呢\"），说的就是当前聚焦节点**——不要跳到\"这一层还没学完\"里别的知识点，也不要反过来问\"你想了解哪个\"（除非确实没有聚焦节点）。": "1. **When the user’s words name no object (\"introduce it / talk about it / continue / more detail / and then\"), they mean the currently focused node** - do not jump to another topic from \"not finished at this level\", and do not ask back \"which one do you mean\" (unless there really is no focused node).",
  "2. 用户问\"X 要学什么\"：先 `outline_show` 查重 → `outline_add` 只补缺失 → 1-2 句说明，不复述整棵树。": "2. When the user asks \"what should I learn for X\": check for duplicates with `outline_show` first → add only what is missing with `outline_add` → explain in 1-2 sentences; do not recite the whole tree.",
  "3. 用户说\"学完了\"：`outline_done`（可带一句 note）。你自己判断的先问一句。": "3. When the user says \"I am done learning this\": `outline_done` (may carry a one-line note). If it is your own judgement, ask one question first.",
  "4. 改结构（改名/移位/删除）用 `outline_update`，不要重建已有节点。": "4. Use `outline_update` to change structure (rename / move / delete); do not rebuild existing nodes.",
  "5. 不要为\"整齐\"重构已有树。": "5. Do not restructure an existing tree \"for tidiness\".",
  "6. 用户说\"复习 / 我学过什么\"：`outline_review` 读摘要，按摘要复述要点，不要重讲。": "6. When the user says \"review / what have I learned\": read the summaries with `outline_review`, restate the key points from those summaries, do not re-teach.",
  "7. 节点地址=标题路径，例如 \"数据结构/数组/计算机地址\"；标题里可能自带 `/`（如\"插入/删除\"），照原样写即可。": "7. A node address = its title path, e.g. \"data structures/arrays/computer addresses\"; a title may itself contain `/` (such as \"insert/delete\"), so just write it as it is.",
  "① 直接问我：「我要学 Java，要学什么」——清单会自动长到上面的树里。": "1. Ask me directly: \"I want to learn Java, what should I learn\" - the list grows into the tree above by itself.",
  "② 你问什么、我答什么，树就顺着**你的思路**往下长：由「数组」问出「计算机地址」，它就挂在数组下面，不按教科书目录摆放。": "2. You ask and I answer, and the tree grows along **your line of thought**: ask from \"arrays\" on to \"computer addresses\" and it hangs under arrays, not arranged like a textbook table of contents.",
  "③ 点节点标题 = 聚焦（之后的对话围绕这个节点）；点 [⟳] 让模型重写该节点摘要。": "3. Clicking a node title = focus (later conversation revolves around that node); click [⟳] to have the model rewrite that node’s summary.",
  "④ 点 [✓ 学会] 标记完成：会写一句复习摘要，**并自动回到上一层**（父节点）——钻进概念学完就能原地返回。": "4. Click [✓ Learn] to mark it learned: a review summary is written, **and you automatically return one level up** (to the parent node) - dive into a concept, finish it, and come back to where you were.",
  "⑤ 点 [复习] 看已完成知识点 + 摘要——不用翻聊天记录。": "5. Click [Review] to see learned topics + summaries - no need to scroll back through the chat log.",
  "⑥ 想改名 / 挪位置 / 删除，直接跟我说，不要手动改文件。": "6. To rename / move / delete, just tell me; do not edit the files by hand.",
  "⑦ 顶部下拉框可以切换 / 新建学习树。": "7. The dropdown at the top switches / creates learning trees.",
  "列出所有学习树，以及当前会话绑定的是哪一棵。用于首轮确认要学哪棵树。": "List all learning trees, and which one the current session is bound to. Used on the first turn to confirm which tree to learn.",
  "把当前会话绑定到某一棵学习树；或新建一棵树并绑定。首次使用学习模式时先调用它。": "Bind the current session to a learning tree, or create a new tree and bind it. Call this first when learning mode is used for the first time.",
  "已有树的 id 或标题。与 new 二选一。": "Id or title of an existing tree. Use either this or new.",
  "新建一棵树并绑定，值为树名（例如 \"Java\"）。与 project 二选一。": "Create a tree and bind it; the value is the tree name (for example \"Java\"). Use either this or project.",
  "找不到学习树：{project}": "Learning tree not found: {project}",
  "请提供 project（已有树）或 new（新建树）": "Provide either project (an existing tree) or new (a new tree)",
  "读取当前学习树的清单。**建树前必须先调用它查重。** 返回缩进清单：[ ]未完成 [>]进行中 [x]已完成。": "Read the current learning tree’s list. **You must call this to check for duplicates before adding anything.** Returns an indented list: [ ] not finished [>] in progress [x] learned.",
  "可选：只看某个节点下的子树，例如 \"Java/对象\"。省略则看整棵树。": "Optional: look only at the subtree under one node, e.g. \"Java/objects\". Omit to see the whole tree.",
  "是否包含已完成节点，默认 true。": "Whether to include learned nodes; defaults to true.",
  "尚未绑定学习树。先调用 outline_projects 看看有没有现成的树，或 outline_open 新建。": "No learning tree bound yet. Call outline_projects first to see whether a tree already exists, or outline_open to create one.",
  "学习树文件缺失：{treeId}": "Learning tree file is missing: {treeId}",
  "树：{title}（已完成 {done}/{total}）": "Tree: {title} (learned {done}/{total})",
  "(空)": "(empty)",
  "在学习树的某个节点下追加子项（幂等：同名兄弟已存在会跳过并回报）。parent 省略表示加在根上。": "Append child items under a node of the learning tree (idempotent: a sibling with the same name is skipped and reported). Omitting parent means adding at the root.",
  "父节点标题路径，例如 \"Java/对象\"。省略表示加在根上。": "Parent node title path, e.g. \"Java/objects\". Omit to add at the root.",
  "要新增的子项标题列表。": "List of titles of the child items to add.",
  "items 为空，没有新增。": "items is empty; nothing was added.",
  "调整学习树结构：改名、挪位置、删除。用户要求整理结构时使用，不要重建节点。": "Adjust the learning tree structure: rename, move, delete. Use when the user asks to reorganize the structure; do not rebuild nodes.",
  "目标节点标题路径，例如 \"Java/对象/私有\"。": "Target node title path, e.g. \"Java/objects/private\".",
  "改成的新闻标题。": "The new title to rename it to.",
  "移动到哪个父节点下（标题路径；空字符串表示移到根）。": "Which parent node to move it under (title path; an empty string moves it to the root).",
  "为 true 时删除该节点及其子树。": "When true, delete this node and its subtree.",
  "没有指定任何修改（rename / move_to / delete）。": "No change was specified (rename / move_to / delete).",
  "把刚学到的知识点就地挂进学习树：默认挂在**当前聚焦节点**下面，**焦点留在原地不动**（焦点＝用户在看哪，只有用户能改变它）。这是\"无感整理\"用的工具——顺着用户当时的思路挂，不必符合知识体系；同名节点自动复用。输出极简，不要向用户复述。": "Attach a just-learned topic into the learning tree in place: by default it goes under the **currently focused node**, and the **focus stays exactly where it is** (the focus is what the user is looking at; only the user can change it). This is the tool for \"frictionless organizing\" - attach it along the line of thought the user was following; it does not have to match a knowledge taxonomy, and a node with the same name is reused automatically. Keep the output minimal and do not recite it back to the user.",
  "知识点标题，尽量短，例如 \"计算机地址\"。": "Topic title, as short as possible, e.g. \"computer addresses\".",
  "可选：显式指定父节点标题路径。省略 = 当前聚焦节点。": "Optional: explicitly specify the parent node’s title path. Omit = the currently focused node.",
  "默认 false＝只挂节点、不动焦点。**只有\"用户这一问的主题就是它\"**（他问的就是这个新知识点，你替他移动视线）时才传 true；节点已存在时改用 outline_focus。": "Defaults to false = attach the node only, without touching the focus. Pass true **only when \"the subject of this question is exactly it\"** (they asked about this very new topic and you are moving their view for them); if the node already exists, use outline_focus instead.",
  "把某个知识点标记为学会 / 取消学会，可附带一句摘要（note）留作复习。不带 note 时插件会自动生成摘要。": "Mark a topic as learned / unlearned, optionally with a one-line summary (note) to keep for review. Without a note the plugin generates the summary automatically.",
  "节点标题路径。": "Node title path.",
  "可选：这次学到的核心结论 / 易错点，供以后复习。不填则由插件自动总结。": "Optional: the core conclusion / common pitfall learned this time, for later review. Leave it empty and the plugin summarizes automatically.",
  "为 true 时取消完成状态。": "When true, unmark the learned status.",
  "切换当前聚焦的知识点（等价于用户在面板里点某个节点）。之后的对话围绕它展开。": "Switch the currently focused topic (equivalent to the user clicking a node in the panel). Later conversation revolves around it.",
  "节点标题路径；传 \"根\" 或空字符串表示回到整棵树。": "Node title path; pass \"root\" or an empty string to go back to the whole tree.",
  "找不到节点：{path}": "Node not found: {path}",
  "复习视图：列出当前学习树里已完成的知识点及其摘要（按完成时间倒序）。用户说\"复习 / 我之前学过什么\"时用。": "Review view: list the learned topics in the current learning tree with their summaries (most recently learned first). Use when the user says \"review / what have I learned before\".",
  "最多返回多少条，默认 30。": "Maximum number of entries to return; defaults to 30.",
  "为 true 时只列\"已完成但没有摘要\"的节点。": "When true, list only nodes that are learned but have no summary.",
  "尚未绑定学习树。": "No learning tree bound yet.",
  "树：{title}（已完成 {done}/{total}，其中有摘要 {withNote}）": "Tree: {title} (learned {done}/{total}, {withNote} of them with summaries)",
  "(还没有已完成的知识点)": "(no learned topics yet)",
  "(摘要生成中/待补)": "(summary generating / pending)",
  "(无摘要)": "(no summary)",
  "{index}. {path}（{when}）\n   {note}": "{index}. {path} ({when})\n   {note}",
  "尚未绑定学习树": "No learning tree bound yet",
  "找不到学习树": "Learning tree not found",
  "新学习树": "New learning tree",
  "找不到节点": "Node not found",

  // ── lib/store.js ──
  "尚未绑定学习树，请先 outline_projects / outline_open": "No learning tree bound yet; call outline_projects / outline_open first",
  "找不到父节点：{path}": "Parent node not found: {path}",
  "标题为空": "Title is empty",
  "学习树文件缺失": "Learning tree file is missing",
  "找不到目标父节点：{path}": "Target parent node not found: {path}",
  "来源坐标不完整": "Origin coordinates are incomplete",
  "摘要为空，已丢弃": "Summary is empty; discarded",
  "找不到节点 id：{id}": "Node id not found: {id}",
  "{title}（{total} 节点·{date}）": "{title} ({total} nodes · {date})",
  "【现有学习树】{list}": "[Existing learning trees] {list}",
  "（还没有树）": "(no trees yet)",
  "、": ", ",
  "【开场·只做一次】用户第一句若与上述某棵树相关 → 用 ask_user_question 出选项：第一个＝你推荐的那棵树（label 带「(Recommended)」），其后是其它相关的树，再给「新建一棵（名字建议：<从问题里提炼的主题>）」；用户也可以自己填。选完调 outline_open（已有树用 project，新建用 new），然后正常回答，不要再问第二次。若与任何老树都无关 → 同样用选项问：第一个＝你建议的树名，第二个＝让用户自己填名字。": "[Opening · do this only once] If the user’s first sentence relates to one of the trees above → offer options with ask_user_question: the first = the tree you recommend (label it with \"(Recommended)\"), then the other related trees, then \"create a new one (suggested name: <the theme distilled from the question>)\"; the user may also fill in their own. After they choose, call outline_open (project for an existing tree, new for a new one), then answer normally; do not ask a second time. If it relates to none of the old trees → ask with options in the same way: the first = the tree name you suggest, the second = let the user type a name.",
  "## 学习模式": "## Learning Mode",
  "学习树：{title}（尚未选择聚焦节点）": "Learning tree: {title} (no focused node chosen yet)",
  "学习树：{title} ｜ ▶ 当前聚焦（用户正在看的）：{path}": "Learning tree: {title} | ▶ current focus (what the user is looking at): {path}",
  "【当前节点摘要】{note}": "[Current topic summary] {note}",
  "【子节点摘要】": "[Child topic summaries]",
  "  · {title}：{note}": "  · {title}: {note}",
  "【进度】已完成 {done}/{total}": "[Progress] learned {done}/{total}",
  "【这一层还没学完】{list}": "[Not finished at this level] {list}",
  "{title}（{date}）": "{title} ({date})",
  "【最近完成】{list}": "[Recently learned] {list}",
  "（复习用 outline_review 读摘要清单）": "(use outline_review to read the summary list for review)",
  "（用户没指明对象时＝上面那个\"当前聚焦\"；答完静默把新知识点 outline_capture 到聚焦节点下，**不要搬焦点**——焦点只跟着用户走）": "(when the user names no object = the \"current focus\" above; after answering, silently outline_capture the new topic under the focused node, **do not move the focus** - the focus only follows the user)",
  "① 问我：我要学 X，要学什么": "1. Ask me: I want to learn X, what should I learn",
  "AI 会把清单直接生成到右侧的树里": "The AI grows the list straight into the tree on the right",
  "不用你手动建节点，也不用复制粘贴": "No manual node building for you, and no copy-pasting",
  "② 你问什么我答什么，树顺着你的思路长": "2. You ask and I answer, and the tree grows along your line of thought",
  "由「数组」问到「计算机地址」，它就挂在数组下面": "Ask from \"arrays\" on to \"computer addresses\" and it hangs under arrays",
  "不按教科书目录摆放——记录的是你当时怎么想的": "Not arranged like a textbook table of contents - it records how you were thinking at the time",
  "挂节点这件事我来做，你不用管、也不用确认": "Attaching nodes is my job; you do not manage it and do not need to confirm it",
  "③ 点节点标题 = 聚焦": "3. Clicking a node title = focus",
  "聚焦后，对话就围绕这个节点展开": "Once focused, the conversation revolves around that node",
  "也可以直接对我说\"我们来看继承\"": "You can also just tell me \"let us look at inheritance\"",
  "④ 点 [✓ 学会] 标记完成": "4. Click [✓ Learn] to mark it learned",
  "标完成时我会自动写一句摘要（几秒后出现）": "When you mark it learned I write a one-line summary automatically (it appears a few seconds later)",
  "再点一次撤销；点 ⟳ 可以让模型重写摘要": "Click again to undo; click ⟳ to have the model rewrite the summary",
  "⑤ 复习：点面板顶部的 [复习] 标签": "5. Review: click the [Review] tab at the top of the panel",
  "⑥ 想改结构（改名/移位/删除）直接跟我说": "6. To change the structure (rename / move / delete), just tell me",
  "如何使用学习模式": "How to use Learning Mode",

  // ── lib/summary.js ──
  "【我】": "[Me]",
  "【AI】": "[AI]",
  "本次要总结的知识点：{title}": "Topic to summarize this time: {title}",
  "它在学习树里的位置：{path}": "Its position in the learning tree: {path}",
  "同层其它知识点（**不属于**本次总结；原料里讲到它们时请跳过）：{siblings}": "Other topics at the same level (**not part of** this summary; skip them when the material mentions them): {siblings}",
  "已有摘要：{note}": "Existing summary: {note}",
  "（无）": "(none)",
  "下面是这段时间的对话。**只**挑与「{title}」直接相关的内容来写；这段对话很可能同时讲了上面列出的其它知识点甚至整篇论文，那些一个字都不要写进来。": "Below is the conversation from this period. Write **only** about what is directly related to \"{title}\"; this conversation very likely also covered the other topics listed above, or even a whole paper - do not write a single word about those.",
  "内容太少（{messages} 条 / {chars} 字）": "Too little content ({messages} messages / {chars} characters)",
  "没有可用的模型路由": "No model route available",
  "模型认为没有可沉淀的结论": "The model found no conclusion worth keeping",
  "输出 token 用尽且没有产出文本（模型把预算花在别处了）": "Output tokens ran out with no text produced (the model spent the budget elsewhere)",
  "模型意外请求了工具调用": "The model unexpectedly requested tool calls",
  "你在为一个「学习树」写知识点的复习摘要。用户刚学完**一个**知识点，你要留下以后能直接看懂的一段话。\n\n要求：\n- **只写属于「本次要总结的知识点」的内容**。原料是一段连续对话，里面很可能同时讲了同层的好几个知识点（甚至是整篇论文的全景概览）；那些不属于本次目标，一个字都不要写进来。\n- 写 2-4 句中文，只写：核心结论、关键机制、易错点、还没解决的问题。\n- 不要复述对话过程，不要出现\"用户问\"\"我回答\"这类叙述，不要客套，不要 markdown 标题或列表符号。\n- 已有摘要时，是**增量合并**：保留仍然正确的旧结论，补上这次新增/修正的内容，不要丢掉信息。\n- 如果原料里关于**这一个**知识点的内容不足以沉淀结论（只是顺带提了一句、或者讲的其实是别的知识点），只回复两个字：无内容\n- 直接输出摘要正文，不要任何前缀。": "You are writing a review summary for one topic of a \"learning tree\". The user has just finished learning **one** topic, and you must leave behind a passage that will still be directly understandable later.\n\nRequirements:\n- **Write only what belongs to \"the topic to summarize this time\".** The material is one continuous conversation and very likely also covered several topics at the same level (possibly even a bird's-eye view of a whole paper); those are not this target, so do not write a single word about them.\n- Write 2-4 sentences in English, covering only: the core conclusion, the key mechanism, common pitfalls, and questions still open.\n- Do not retell the flow of the conversation; do not write narration such as \"the user asked\" or \"I answered\"; no pleasantries; no markdown headings and no bullet markers.\n- When an existing summary is present, **merge incrementally**: keep the old conclusions that are still correct, add what is new or corrected this time, and do not lose information.\n- If the material does not hold enough about **this one** topic to settle a conclusion (it was only mentioned in passing, or it was really about a different topic), reply with exactly `NO_CONTENT`\n- Output the summary body directly, with no prefix of any kind.",

  "{index}. {path}（{when}）\n   {note}": "{index}. {path} ({when})\n   {note}",
}

/**
 * 中文表 = 对 EN 的 key 集合做恒等映射。
 * **必须显式提供**：dsh-client-locale 的取值链是"当前语言 → 其声明的 fallback"，
 * 而 zh 的 fallback 就是 en —— 若 zh 表里没有这个 key，中文界面会显示英文。
 * @type {Record<string, string>}
 */
export const ZH = Object.fromEntries(Object.keys(EN).map((key) => [key, key]))

/**
 * 取值 + 插值。规则与 dsh-client-locale 的 translate 保持一致：
 * 缺失的 key 原样返回，缺失的插值参数保留 `{name}` 占位符。
 * @param {'zh' | 'en'} locale
 * @param {string} key 中文原文
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
export function translate(locale, key, params) {
  const table = locale === 'en' ? EN : ZH
  const template = typeof table[key] === 'string' ? table[key] : key
  if (params === undefined || params === null) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}

/**
 * 按**当前**语言翻译（store.js / summary.js / index.js 都直接用这个）。
 * 读的是模块级 current，所以语言切换后新发起的调用立刻生效。
 * @param {string} key 中文原文
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
export function t(key, params) {
  return translate(current, key, params)
}
