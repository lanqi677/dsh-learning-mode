/**
 * dsh-learning-mode — 浏览器端（client half）
 *
 * 座位：conversation.session.header.actions
 *   —— session 作用域，props 里**直接带 sessionId**（标准 session props），
 *      不需要靠猜 SessionListState 的字段，也不会在"没有会话"时被渲染。
 *
 * 行为：
 *   - 拿不到 enabled=true 就 render null → 普通会话里什么都不出现（零侵入）
 *   - enabled=true 时，在会话头部显示一个「学习树」小按钮，点开是浮层面板
 *
 * ── 面板设计原则（这一版重做前端时定的，改 UI 前先读） ────────────────────
 * 这个面板的**目的**是"导航 + 进度"，不是"阅读器"：
 *   ① 一眼看到"我在哪"（▶ 当前聚焦 + 左侧强调条 + 高亮底）；
 *   ② 一眼看到"还剩多少"（顶部进度条 + 每个父节点的 3/7 角标）；
 *   ③ 树必须保持**一行的节奏** —— 摘要不默认展开，挂在 `摘要` 小按钮后面，
 *      点了才在该行下面展开（旧版把 4-5 行摘要直接铺在树里，整棵树被顶散，
 *      实拍反馈"总结的占空显示不合理"）；
 *   ④ 复习页才是读摘要的地方：卡片式，标题/上级路径/日期/正文分层。
 * 所有颜色都走主题 CSS 变量（portal 到 body 也必须跟主题走，见下面的 V）。
 *
 * 诊断：所有关键步骤都打 [learning-mode] 前缀的 console 日志。
 *   有 apply 但没有 chip → 看紧跟其后的 state 日志。
 *   ⚠️ 但**一条都没有**并不等于"模块没被加载"：apply 自己抛错时也一条都看不到，
 *   而前端 boot 只会显示 `web boot: 1 entry did not activate / <包名>: failed`，
 *   **不打印原始异常**。要拿原始异常见 skill `dsh-troubleshooting` 的 `scripts/diag-console.mjs`（单一来源）。
 */
window.__ModuleLoader__.load({
	id: "dsh-learning-mode",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var react = require("react");
		var h = react.createElement;
		// 面板必须 portal 到 body：直接内联渲染时它会被应用的分层/裁剪吞掉——
		// DOM 在、坐标正常、无障碍点击也能打中（Invoke 走 pattern，不看遮挡），
		// 但屏幕上就是看不见。portal + 极高 z-index 是唯一稳的做法。
		var ReactDOM = null;
		try { ReactDOM = require("react-dom"); } catch (e) { ReactDOM = null; }

		var RPC = "/api/learning-mode/rpc";
		var TAG = "[learning-mode]";

		var name = "dsh-learning-mode-client";
		// 必须声明 inject: ["slots"]。
		// cordis 对**未声明**的服务不是返回 undefined，而是直接抛
		// `cannot get property "slots" without inject` —— 所以
		// 「不声明 inject、运行时用 ctx.get('slots') 探测」这条路根本走不通：
		// apply 第一行就抛，插件 fiber 变 FAILED，前端 boot 直接
		// `web boot: 1 entry did not activate / dsh-learning-mode: failed`
		// （而前端不打印原始异常，只能靠 scripts/diag-console.mjs 掏出来）。
		// 声明后 cordis 保证 apply 运行时 slots 已就绪，直接用 ctx.slots。
		// 官方同座位的 dsh-client-ui-jobs 就是 inject: ["slots", "locale"]。
		var inject = ["slots"];

		function log() {
			var args = Array.prototype.slice.call(arguments);
			args.unshift(TAG);
			console.info.apply(console, args);
		}

		function rpc(sessionId, op, extra) {
			var body = Object.assign({ sessionId: sessionId, op: op }, extra || {});
			return fetch(RPC, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			}).then(function (res) {
				return res.text().then(function (text) {
					var parsed
					try { parsed = JSON.parse(text) } catch (e) { parsed = { ok: false, error: "bad-json:" + text.slice(0, 120) } }
					parsed.__status = res.status;
					return parsed;
				});
			});
		}

		/**
		 * 客户端服务句柄：apply 时**用可选访问**取一次，拿不到就是 null。
		 *
		 * ⚠️ 不写进 inject：这个功能是锦上添花，一旦把 sessions 声明成硬依赖，
		 * 它在某个启动阶段没就绪就会让整个「学习树」按钮消失 —— 影响面太大。
		 * 拿不到服务时面板**不渲染 ↩ 按钮**（宁可没有，也不给一个点了没反应的假按钮）。
		 */
		var svc = { sessions: null, uiWorkspace: null };

		/**
		 * 把"浏览器半边看到的真实环境"写进 host 的 rpc.log。
		 *
		 * 为什么要这条通道：前端出问题只能看 console，而 console **不落盘** ——
		 * 本项目已经栽过两次"单测全绿、真机功能是死的"。有了它，DOM/服务形态就有离线判据。
		 * 每个页面只报一次（模块级 flag），不刷屏。
		 */
		var envReported = false;
		var envFirstAt = 0;
		/** 会话流里已经渲染出来的行数（拿不到 DOM 就是 0）——判断"聊天区挂载好了没"。 */
		function countTurnRows() {
			try {
				if (typeof document === "undefined" || document === null || typeof document.querySelectorAll !== "function") return 0;
				return document.querySelectorAll("[data-chat-turn]").length;
			} catch (e) { return 0; }
		}
		function reportEnv(sessionId, force) {
			if (envReported) return;
			// 一行都还没渲染出来 → 这次先不上报，等下一轮轮询（聊天区是异步挂载的）；
			// force = 兜底时限到了，不管有没有行都报一次（否则"DOM 里根本没有这个属性"就永远查不出来）
			if (force !== true && countTurnRows() === 0) return;
			envReported = true;
			var info;
			try {
				var canQuery = typeof document !== "undefined" && document !== null && typeof document.querySelectorAll === "function";
				info = { session: String(sessionId).slice(0, 18) };
				info.scroll = canQuery ? (document.querySelector("[data-conversation-scroll]") !== null) : "no-dom";
				var turns = [];
				if (canQuery) {
					var rows = document.querySelectorAll("[data-chat-turn]");
					for (var i = 0; i < rows.length && turns.length < 500; i += 1) {
						var n = Number(rows[i].dataset.chatTurn);
						if (isFinite(n) && turns.indexOf(n) < 0) turns.push(n);
					}
				}
				turns.sort(function (a, b) { return a - b; });
				info.turnRows = turns.length;
				info.turnMin = turns.length > 0 ? turns[0] : null;
				info.turnMax = turns.length > 0 ? turns[turns.length - 1] : null;
				info.turnHead = turns.slice(0, 10).join(",");
				info.flowRows = canQuery ? document.querySelectorAll("[data-chat-flow] > [data-chat-flow-key]").length : "no-dom";
				info.sessions = svc.sessions === null || svc.sessions === undefined ? "absent" : typeof svc.sessions.open;
				var binding = null;
				if (svc.sessions !== null && svc.sessions !== undefined && typeof svc.sessions.binding === "function") {
					try { binding = svc.sessions.binding(sessionId); }
					catch (e) { info.bindingError = String(e !== null && e !== undefined && e.message ? e.message : e); }
				}
				info.binding = binding === null || binding === undefined ? "none" : "ok";
				info.loadThrough = binding !== null && binding !== undefined && binding.session !== null && binding.session !== undefined ? typeof binding.session.loadThrough : "n/a";
				try {
					info.hasMore = binding !== null && binding !== undefined && binding.session !== null && binding.session !== undefined && typeof binding.session.getSnapshot === "function"
						? String(binding.session.getSnapshot().hasMore) : "n/a";
				} catch (e) { info.hasMore = "snapshot-failed"; }
			} catch (e) {
				info = { error: String(e !== null && e !== undefined && e.message ? e.message : e) };
			}
			rpc(sessionId, "diag", { line: "env " + JSON.stringify(info) }).then(function (r) {
				log("env reported", r);
			}).catch(function (e) { log("env report failed", String(e)); });
		}

		// ── 跳回「讲这个知识点的那轮对话」 ──────────────────────────────────────
		//
		// 坐标为什么是 turn（而不是 messageId）：外壳的会话流**按 turn 分行**，每行都带
		// `data-chat-turn`；比当前分页更早的 turn 还能用官方 `loadThrough(seq)` 补页。
		// 而 messageId 在聊天 DOM 里**没有任何锚点**（整个前端 bundle 里没有 data-message-id）。
		//
		// 唯一依赖的非公开契约就是 `data-chat-turn` / `data-conversation-scroll` 这两个属性；
		// 拿不到就降级（会话照样切过去 + 提示），绝不静默失败：每一步都写 rpc.log 的 jump 行。
		/**
		 * 目标轮的那一行（user/assistant/tool 行都带 data-chat-turn）。
		 * @returns HTMLElement | null
		 */
		function turnRow(turn) {
			if (typeof document === "undefined" || document === null || typeof document.querySelectorAll !== "function") return null;
			var rows = document.querySelectorAll("[data-chat-turn]");
			for (var i = 0; i < rows.length; i += 1) {
				if (Number(rows[i].dataset.chatTurn) === turn) return rows[i];
			}
			return null;
		}

		/**
		 * 把行滚到视口中间：**直接写 scrollTop**，不用 scrollIntoView ——
		 * 外壳自己也在记账滚动（follow-end、阅读位置恢复、分页锚点），scrollIntoView 会
		 * 连带滚动祖先并和它打架；外壳内部也是算 flowTop 再写 scrollTop 的。
		 */
		function scrollRowToCenter(row) {
			var box = typeof row.closest === "function" ? row.closest("[data-conversation-scroll]") : null;
			if ((box === null || box === undefined) && typeof document !== "undefined" && document !== null && typeof document.querySelector === "function") {
				box = document.querySelector("[data-conversation-scroll]");
			}
			if (box === null || box === undefined) {
				row.scrollIntoView({ block: "center" });
				return "scrollIntoView";
			}
			var delta = row.getBoundingClientRect().top - box.getBoundingClientRect().top;
			box.scrollTop = Math.max(0, box.scrollTop + delta - (box.clientHeight - row.clientHeight) / 2);
			return "scrollTop=" + Math.round(box.scrollTop);
		}

		/** 闪一下高亮，1.8 秒后自己摘掉类（不留痕迹）。 */
		function flashRow(row) {
			if (row.classList === undefined || row.classList === null) return;
			row.classList.add("lm-flash");
			setTimeout(function () { row.classList.remove("lm-flash"); }, 1800);
		}

		/**
		 * 跳到 origin（{ sid, turn, seq }）那一轮：切会话 → 找行 → 滚到中间 → 闪一下。
		 *
		 * 降级链（每一步都有明确结局，不静默）：
		 *   ① 目标会话 ≠ 当前会话 → sessions.open()（失败再试 uiWorkspace.openSession()）；
		 *      都打不开 → notify("那次对话已经不在了")。
		 *   ② 轮询找行：切会话后聊天区是**异步挂载**的，不能只找一次。
		 *   ③ 600ms 还没找到 → 官方 `loadThrough(seq)` 补页（那一轮可能在更早的分页里），继续找。
		 *   ④ 8s 超时 → 记 rpc.log（若没切会话再给用户一句提示），不假装成功。
		 *
		 * @param notify 只在"**没有**切走会话"时用：切走后本面板会随旧会话卸载，setState 会告警
		 */
		function jumpToOrigin(sessionId, origin, notify) {
			var moved = [];
			var say = function (m) { moved.push(m); };
			var done = function (verdict, userMsg) {
				if (typeof notify === "function" && typeof userMsg === "string" && userMsg !== "") notify(userMsg);
				rpc(sessionId, "diag", { line: "jump " + verdict + " turn=" + turn + " sid=" + String(targetSid).slice(0, 18) + " :: " + moved.join(" | ") }).catch(function () { /* 诊断失败不影响跳转 */ });
			};
			var src = origin === null || origin === undefined ? {} : origin;
			var turn = Math.floor(Number(src.turn));
			var seq = Math.floor(Number(src.seq));
			var targetSid = typeof src.sid === "string" && src.sid !== "" ? src.sid : sessionId;
			if (!isFinite(turn) || turn < 0) { done("no-origin", "这个知识点没记到来源对话"); return; }

			var switched = false;
			if (targetSid !== sessionId) {
				if (svc.sessions === null || svc.sessions === undefined || typeof svc.sessions.open !== "function") {
					done("no-sessions", "跳不过去：拿不到会话服务（已记 rpc.log）");
					return;
				}
				try {
					svc.sessions.open(targetSid);
					switched = true;
					say("sessions.open");
				} catch (e) {
					say("open failed: " + String(e !== null && e !== undefined && e.message ? e.message : e));
				}
				if (!switched && svc.uiWorkspace !== null && svc.uiWorkspace !== undefined && typeof svc.uiWorkspace.openSession === "function") {
					try {
						svc.uiWorkspace.openSession(targetSid);
						switched = true;
						say("uiWorkspace.openSession");
					} catch (e) {
						say("uiWorkspace failed: " + String(e !== null && e !== undefined && e.message ? e.message : e));
					}
				}
				if (!switched) { done("session-gone", "那次对话已经不在了（可能被删除或归档）"); return; }
			}

			var waited = 0;
			var pulled = false;
			var attempt = function () {
				var row = turnRow(turn);
				if (row !== null) {
					say(scrollRowToCenter(row));
					flashRow(row);
					done(switched ? "ok-after-switch" : "ok", null);
					return;
				}
				if (!pulled && waited >= 600) {
					pulled = true;
					var binding = null;
					try {
						if (svc.sessions !== null && svc.sessions !== undefined && typeof svc.sessions.binding === "function") binding = svc.sessions.binding(targetSid);
					} catch (e) { say("binding failed: " + String(e !== null && e !== undefined && e.message ? e.message : e)); }
					var session = binding !== null && binding !== undefined ? binding.session : null;
					if (session !== null && session !== undefined && typeof session.loadThrough === "function" && isFinite(seq) && seq > 0) {
						try {
							session.loadThrough(seq);
							say("loadThrough(" + seq + ")");
						} catch (e) { say("loadThrough failed: " + String(e !== null && e !== undefined && e.message ? e.message : e)); }
					} else {
						say("no loadThrough");
					}
				}
				waited += 120;
				if (waited > 8000) {
					done(switched ? "switched-no-row" : "no-row", switched ? null : ("没找到第 " + turn + " 轮的聊天行（可能已改动或还没加载）"));
					return;
				}
				setTimeout(attempt, 120);
			};
			if (switched) setTimeout(attempt, 150); else attempt();
		}

		// ── 面板窗口：可拖动 + 可调大小 + 记住上次的样子 ─────────────────────────
		//
		// 动机：面板是浮层，想看树又不想被它挡住文字时，用户会把它拖开/拉窄；
		// 下次打开又弹回原位就很烦。所以几何存 localStorage（每浏览器一份），
		// 并且**读取时按视口钳制**（换显示器、缩窗口之后不会跑到屏幕外面去）。
		//
		// 默认态保持不变（贴右 16px、宽 392、高最多 76vh）；只有用户真的动过窗口，
		// 才会变成"显式的 left/top/width/height"，此时头部多一个 ⟲ 恢复默认。
		var GEOM_KEY = "lm.panel.geom";
		var GEOM_MIN_W = 260;
		var GEOM_MIN_H = 160;
		/** 几何的同步镜像：mouseup 时拿它落盘（setState 是异步的，闭包里读不到最新值）。 */
		var geomMirror = {};

		function clampGeom(geom) {
			var out = {};
			var keys = ["x", "y", "w", "h"];
			for (var i = 0; i < keys.length; i += 1) {
				var value = geom === null || geom === undefined ? undefined : geom[keys[i]];
				if (typeof value === "number" && isFinite(value)) out[keys[i]] = Math.round(value);
			}
			var vw = typeof window !== "undefined" && window !== null && typeof window.innerWidth === "number" ? window.innerWidth : 0;
			var vh = typeof window !== "undefined" && window !== null && typeof window.innerHeight === "number" ? window.innerHeight : 0;
			if (typeof out.w === "number" && vw > 0) out.w = Math.max(GEOM_MIN_W, Math.min(out.w, vw - 8));
			if (typeof out.h === "number" && vh > 0) out.h = Math.max(GEOM_MIN_H, Math.min(out.h, vh - 8));
			if (typeof out.x === "number" && vw > 0) {
				var room = vw - (typeof out.w === "number" ? out.w : GEOM_MIN_W) - 8;
				out.x = Math.max(0, Math.min(out.x, Math.max(0, room)));
			}
			if (typeof out.y === "number" && vh > 0) out.y = Math.max(0, Math.min(out.y, Math.max(0, vh - 40)));
			return out;
		}

		function loadGeom() {
			try {
				if (typeof localStorage === "undefined" || localStorage === null) return {};
				var raw = localStorage.getItem(GEOM_KEY);
				if (typeof raw !== "string" || raw === "") return {};
				var parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object") return {};
				return clampGeom(parsed);
			} catch (e) { return {}; }
		}

		function saveGeom(geom) {
			try {
				if (typeof localStorage === "undefined" || localStorage === null) return;
				if (!hasGeom(geom)) localStorage.removeItem(GEOM_KEY);
				else localStorage.setItem(GEOM_KEY, JSON.stringify(geom));
			} catch (e) { /* 存不上就算了：不影响本次使用 */ }
		}

		/** 用户动过窗口没有（决定 ⟲ 恢复默认按钮要不要出现）。 */
		function hasGeom(geom) {
			return geom !== null && geom !== undefined
				&& (typeof geom.x === "number" || typeof geom.w === "number" || typeof geom.h === "number");
		}

		/** 头部是不是按在了可交互控件上（那种情况不能当成拖动窗口）。 */
		function isInteractiveTarget(target) {
			var tag = target === null || target === undefined ? "" : String(target.tagName || "").toUpperCase();
			return tag === "BUTTON" || tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA" || tag === "OPTION" || tag === "A";
		}

		/**
		 * 开始拖动 / 缩放：move/up 直接挂在 window 上，松手立刻卸掉。
		 *
		 * 两个刻意的选择：
		 *   ① 不用 useEffect —— 离线测试靠 `effects[0]` 驱动轮询，多插一个 effect 会打乱它的顺序；
		 *   ② 基准矩形从 **DOM 读**（`getBoundingClientRect`）—— 默认态是"贴右 + 自适应高"，
		 *      根本没有 left/top 可用，只有量出来才知道它现在在哪。
		 *
		 * @param kind "move" | "size" | "size-w" | "size-h"
		 * @param applyGeom 拖动过程中调用（**不落盘**）；松手时才 saveGeom
		 */
		function startWindowAction(kind, event, applyGeom) {
			if (event === null || event === undefined || typeof window === "undefined" || window === null) return;
			if (typeof window.addEventListener !== "function") return;
			var node = event.currentTarget !== undefined && event.currentTarget !== null ? event.currentTarget : event.target;
			var box = node !== null && node !== undefined && typeof node.closest === "function" ? node.closest(".lm-panel") : null;
			if (box === null || box === undefined || typeof box.getBoundingClientRect !== "function") return;
			var rect = box.getBoundingClientRect();
			var base = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
			var x0 = Number(event.clientX) || 0;
			var y0 = Number(event.clientY) || 0;
			if (typeof event.preventDefault === "function") event.preventDefault();
			var moved = false;
			var setSelect = function (on) {
				try {
					if (typeof document !== "undefined" && document !== null && document.body !== null && document.body !== undefined) {
						document.body.style.userSelect = on ? "none" : "";
					}
				} catch (e) { /* 拖拽时选不选中文字只是体验问题 */ }
			};
			var move = function (ev) {
				moved = true;
				var dx = (Number(ev.clientX) || 0) - x0;
				var dy = (Number(ev.clientY) || 0) - y0;
				var next;
				if (kind === "move") next = { x: base.x + dx, y: base.y + dy, w: base.w, h: base.h };
				else if (kind === "size-w") next = { x: base.x, y: base.y, w: base.w + dx, h: base.h };
				else if (kind === "size-h") next = { x: base.x, y: base.y, w: base.w, h: base.h + dy };
				else next = { x: base.x, y: base.y, w: base.w + dx, h: base.h + dy };
				applyGeom(clampGeom(next));
			};
			var up = function () {
				var remove = typeof window.removeEventListener === "function" ? window.removeEventListener : null;
				if (remove !== null) { remove("mousemove", move); remove("mouseup", up); }
				setSelect(false);
				// 只是点了一下头部（没移动）不该把当前矩形"固化"成用户设定 —— 那会平白多出 ⟲
				if (moved) saveGeom(geomMirror);
			};
			setSelect(true);
			window.addEventListener("mousemove", move);
			window.addEventListener("mouseup", up);
		}

		// ⚠️ 面板是 portal 到 document.body 的浮层，**必须跟着应用主题走**：
		// 之前硬编码 rgba(40,40,44,0.96) + color:"inherit" 是写死的深色，
		// 浅色主题下就成了"深底深字"，实拍反馈"色彩不对"。
		// 统一用主题 CSS 变量（dsh-client-ui-theme 注入在 :root，portal 子节点能继承），
		// 每个变量都带兜底值：变量缺失也不会变成看不见的面板。
		var V = {
			bg: "var(--dsw-alias-bg-overlay, rgba(44,44,48,0.98))",
			border: "var(--dsw-alias-border-l1, rgba(127,127,127,0.28))",
			border2: "var(--dsw-alias-border-l2, rgba(127,127,127,0.45))",
			text: "var(--dsw-alias-label-primary, #e6e6e6)",
			dim: "var(--dsw-alias-label-secondary, #9a9a9a)",
			success: "var(--dsw-alias-state-success-primary, #4caf50)",
			danger: "var(--dsw-alias-state-error-primary, #d9534f)",
			brand: "var(--dsw-alias-brand-primary, #5b8def)",
			// ⚠️ brand 的**配对视色**，不能拿 "#fff" 顶。
			// --dsw-alias-brand-primary 是中性 brand：浅色 #0f1115（近黑）/ 暗色 #f9fafb（近白）。
			// 所以"brand 底 + 固定白字"在暗色主题下就是**白底白字** —— NEW 角标会渲染成
			// 一块没有文字的纯白色药丸（暗色模式真机实拍）。
			// 设计系统里 button-primary-fill(= brand-primary) 的配对前景正是
			// label-primary-foreground（浅色 #fff / 暗色 #0f1115），照它配两边都读得出来。
			brandFg: "var(--dsw-alias-label-primary-foreground, #fff)"
		};

		// 一点点"软背景"：用主题色带透明度的写法（to 关键字在旧浏览器不认，用 rgba 兜底）
		var SOFT = {
			brand: "rgba(91,141,239,0.16)",
			success: "rgba(76,175,80,0.14)",
			hover: "rgba(127,127,127,0.13)"
		};

		// ── 玻璃质感（"液态玻璃"在 Web 里的可行子集）─────────────────────────
		// 说明白边界：真正的"液态折射"（背景被透镜扭曲）在浏览器里做不到 ——
		// backdrop-filter 只吃 blur/saturate/... 这几种滤镜函数，**不接受 url(#svgFilter)**，
		// 所以 feDisplacementMap 那套折射实现不了。能做的是磨砂玻璃 + 高光边缘 + 流光，
		// 也就是 iOS 的 material 质感；而且 DSH 自己的浮层就是这么做的（打包 CSS 里是
		// `background: color-mix(in srgb, var(--dsw-alias-bg-base) 72%, transparent); backdrop-filter: blur(6px)`），
		// 所以这里同一个配方做厚一点，视觉上跟原生浮层是一家人。
		// color-mix + bg-overlay：浅/深主题自动适配，不用自己判色。
		// 会话头部那一排按钮的"原生配方"：直接抄邻居 dsh-undo-savepoint 的 .u_btn —
		// 它是同一排里的兄弟按钮，抄它才不会"一看就是外人"。
		// （图标偏上的坑也在它那儿写着：.u_icon{vertical-align:-2px;line-height:0}）
		var NATIVE = {
			bg: "var(--dsw-specific-tip, transparent)",
			hoverBg: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15))",
			border: "var(--dsw-alias-border-l1, rgba(128,128,128,.35))",
			label: "var(--dsw-alias-label-secondary, inherit)",
			labelStrong: "var(--dsw-alias-label-primary, inherit)",
			tertiary: "var(--dsw-alias-label-tertiary, #888)"
		};

		var GLASS = {
			panelBg: "color-mix(in srgb, var(--dsw-alias-bg-overlay) 74%, transparent)",
			blur: "blur(16px) saturate(1.7)",
			// 高光边：用主题"墨色"做内高光，浅/深主题都成立（深色主题 label 是浅色）
			inner: "inset 0 1px 0 color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent)",
			ring: "inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent)",
			shadow: "0 18px 44px rgba(0,0,0,0.30), 0 2px 8px rgba(0,0,0,0.18)"
		};
		// 不支持 backdrop-filter 时的兜底：退回不透明底（宁可"不玻璃"，也不能"看不清字"）
		var FALLBACK = "var(--dsw-alias-bg-overlay, rgba(44,44,48,0.98))";

		// 悬停/滚动条这类"状态样式"没法用 inline style 表达，注入一小段 scoped CSS。
		// 类名统一 lm- 前缀，只作用于面板内部。
		var CSS = [
			// 玻璃：面板与入口按钮各一层（内层卡片只用纯色半透明，叠两层会糊）
			".lm-glass{background:" + GLASS.panelBg + ";backdrop-filter:" + GLASS.blur + ";-webkit-backdrop-filter:" + GLASS.blur + "}",
			// 悬停流光（跟着鼠标的一团柔光，纯装饰）
			".lm-glyph{position:relative;overflow:hidden}",
			".lm-glyph::after{content:'';position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .2s ease;background:radial-gradient(320px circle at var(--lm-x,50%) var(--lm-y,0%),color-mix(in srgb, var(--dsw-alias-label-primary) 9%,transparent),transparent 60%)}",
			".lm-glyph:hover::after{opacity:1}",
			"@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))){.lm-glass{background:" + FALLBACK + "}}",
			// 会话头部入口按钮：与邻居 .u_btn / .u_badge 同款（同一排看起来是一家人）
			".lm-chip{cursor:pointer;border:1px solid " + NATIVE.border + ";background:" + NATIVE.bg + ";color:" + NATIVE.label + ";border-radius:8px;height:24px;padding:0 9px;font-size:12px;line-height:22px;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;flex:none;transition:background .12s ease,color .12s ease}",
			".lm-chip:hover{background:" + NATIVE.hoverBg + ";color:" + NATIVE.labelStrong + "}",
			".lm-chip:active{transform:translateY(1px)}",
			// ⚠️ 图标对齐：inline SVG 默认按基线坐，会"偏上"。邻居的解法就是这两句。
			".lm-chip-icon{display:inline-flex;align-items:center;vertical-align:-2px;flex:none;line-height:0}",
			".lm-chip-icon svg{display:block}",
			".lm-chip-num{color:" + NATIVE.tertiary + ";font-size:11px;font-variant-numeric:tabular-nums}",
			".lm-chip-new{display:inline-flex;align-items:center;gap:3px;color:" + V.brand + ";font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}",
			".lm-chip-newdot{width:6px;height:6px;border-radius:50%;background:" + V.brand + ";flex:none}",
			// 「↩ 原文」：树行里的跳转小按钮（平时极淡，hover 行才亮；**只有记到来源的节点**才有）
			".lm-jump{cursor:pointer;opacity:.38;transition:opacity .12s ease,color .12s ease;padding:0 2px}",
			".lm-row:hover .lm-jump,.lm-jump:focus{opacity:1}",
			".lm-jump:hover{color:" + V.brand + "}",
			// 跳过去以后在聊天区那一行闪一下（这个类作用于面板**外面**的会话行）
			".lm-flash{animation:lm-flash 1.6s ease-out}",
			"@keyframes lm-flash{0%{background:" + SOFT.brand + ";box-shadow:inset 3px 0 0 " + V.brand + "}70%{background:" + SOFT.brand + ";box-shadow:inset 3px 0 0 " + V.brand + "}100%{background:transparent;box-shadow:inset 3px 0 0 transparent}}",
			".lm-row{transition:background .12s ease}",
			".lm-row:hover{background:" + SOFT.hover + "}",
			".lm-act{opacity:.42;transition:opacity .12s ease}",
			".lm-row:hover .lm-act,.lm-act:focus{opacity:1}",
			".lm-click{cursor:pointer}",
			".lm-click:hover{color:" + V.brand + "}",
			".lm-note{animation:lm-fade .16s ease}",
			"@keyframes lm-fade{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}",
			".lm-body::-webkit-scrollbar{width:8px}",
			".lm-body::-webkit-scrollbar-thumb{background:" + V.border2 + ";border-radius:4px}",
			".lm-body::-webkit-scrollbar-track{background:transparent}",
			".lm-sel:hover{border-color:" + V.border2 + "}",
			// 面板窗口：头部可拖动（grab 光标本身就是"这里能拖"的提示），三个缩放手柄
			".lm-panel{position:fixed}",
			".lm-head{cursor:grab}",
			".lm-head:active{cursor:grabbing}",
			".lm-rs{position:absolute;z-index:5}",
			".lm-rs-r{top:0;right:0;width:6px;height:100%;cursor:ew-resize}",
			".lm-rs-b{left:0;bottom:0;width:100%;height:6px;cursor:ns-resize}",
			".lm-rs-c{right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize}",
			".lm-rs-c::after{content:'';position:absolute;right:3px;bottom:3px;width:7px;height:7px;border-right:2px solid " + V.border2 + ";border-bottom:2px solid " + V.border2 + ";border-radius:0 0 2px 0;opacity:.55;transition:opacity .12s ease,border-color .12s ease}",
			".lm-rs-c:hover::after{opacity:1;border-color:" + V.brand + "}"
		].join("\n");

		var S = {
			panel: {
				position: "fixed", right: "16px", top: "64px", width: "392px", maxHeight: "76vh",
				display: "flex", flexDirection: "column",
				border: "1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)", borderRadius: "14px",
				// background / backdrop-filter 由 .lm-glass 提供（带降级的那层）
				color: V.text, fontSize: "13px", lineHeight: "1.55",
				boxShadow: GLASS.shadow + ", " + GLASS.inner, pointerEvents: "auto", zIndex: 2147483000,
				overflow: "hidden"
			},
			// 头部两行：① 标题 + 树选择 + 操作；② 页签 + 进度条
			head: { padding: "9px 10px 8px 10px", borderBottom: "1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)", display: "flex", flexDirection: "column", gap: "7px" },
			headRow: { display: "flex", alignItems: "center", gap: "6px", minWidth: "0" },
			brandDot: { flex: "0 0 auto", width: "7px", height: "7px", borderRadius: "50%", background: V.brand, boxShadow: "0 0 0 3px " + SOFT.brand },
			brandText: { flex: "0 0 auto", fontWeight: 600, letterSpacing: "0.02em" },
			spacer: { flex: "1 1 auto", minWidth: "0" },
			body: { overflow: "auto", padding: "5px 6px 9px 6px", flex: "1 1 auto" },

			// 树行：**永远一行**（这是这一版最重要的约束）
			row: { display: "flex", alignItems: "center", gap: "2px", padding: "0 3px 0 0", borderRadius: "7px", minHeight: "25px" },
			guide: { flex: "0 0 auto", width: "13px", alignSelf: "stretch", borderLeft: "1px solid " + V.border },
			caret: {
				flex: "0 0 auto", width: "15px", textAlign: "center", cursor: "pointer",
				color: V.dim, fontSize: "10px", userSelect: "none"
			},
			glyph: { flex: "0 0 auto", width: "15px", textAlign: "center", fontSize: "11px" },
			title: { flex: "1 1 auto", minWidth: "0", cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", padding: "0 2px" },
			badge: {
				flex: "0 0 auto", fontSize: "10px", lineHeight: "15px", padding: "0 5px", borderRadius: "8px",
				border: "1px solid " + V.border, color: V.dim, cursor: "pointer", whiteSpace: "nowrap"
			},
			badgeOn: {
				flex: "0 0 auto", fontSize: "10px", lineHeight: "15px", padding: "0 5px", borderRadius: "8px",
				border: "1px solid " + V.border2, background: SOFT.brand, color: V.text, cursor: "pointer", whiteSpace: "nowrap"
			},
			badgeNew: {
				flex: "0 0 auto", fontSize: "9px", lineHeight: "15px", padding: "0 5px", borderRadius: "8px",
				background: V.brand, color: V.brandFg, fontWeight: 600, letterSpacing: "0.04em", whiteSpace: "nowrap"
			},
			badgeBusy: {
				flex: "0 0 auto", fontSize: "10px", lineHeight: "15px", padding: "0 5px", borderRadius: "8px",
				border: "1px solid " + V.border, color: V.dim, whiteSpace: "nowrap"
			},
			badgeFail: {
				flex: "0 0 auto", fontSize: "10px", lineHeight: "15px", padding: "0 5px", borderRadius: "8px",
				border: "1px solid " + V.danger, color: V.danger, cursor: "pointer", whiteSpace: "nowrap"
			},
			btn: {
				flex: "0 0 auto", cursor: "pointer", border: "1px solid " + V.border2, background: "transparent",
				color: V.dim, borderRadius: "6px", padding: "0 5px", fontSize: "11px", lineHeight: "17px", whiteSpace: "nowrap"
			},
			// 会话头部入口按钮：样式全在 CSS 的 .lm-chip* 里（跟邻居同款，见上面的 NATIVE）
			chip: {}, chipIcon: {}, chipNum: {}, chipNew: {}, chipNewDot: {},
			btnDone: {
				flex: "0 0 auto", cursor: "pointer", border: "1px solid " + V.success, background: SOFT.success,
				color: V.success, borderRadius: "6px", padding: "0 5px", fontSize: "11px", lineHeight: "17px", whiteSpace: "nowrap"
			},
			noteWrap: { margin: "1px 6px 5px 0", paddingLeft: "30px" },
			note: {
				padding: "6px 9px", borderRadius: "7px", borderLeft: "2px solid " + V.border2,
				background: "rgba(127,127,127,0.08)", fontSize: "12px", lineHeight: "1.62",
				color: V.text, whiteSpace: "pre-wrap", wordBreak: "break-word"
			},
			hint: {
				margin: "1px 6px 5px 30px", fontSize: "11px", color: V.dim,
				whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
			},

			// 头部控件
			select: {
				flex: "1 1 auto", minWidth: "0", background: "transparent", color: V.text,
				border: "1px solid " + V.border, borderRadius: "7px", fontSize: "12px", padding: "2px 5px"
			},
			iconBtn: {
				flex: "0 0 auto", cursor: "pointer", border: "1px solid transparent", background: "transparent",
				color: V.dim, borderRadius: "6px", padding: "0 5px", fontSize: "13px", lineHeight: "19px"
			},
			progressText: { flex: "0 0 auto", fontSize: "11px", color: V.dim, fontVariantNumeric: "tabular-nums" },
			tabs: { display: "flex", alignItems: "center", gap: "4px", minWidth: "0" },
			tab: {
				flex: "0 0 auto", cursor: "pointer", border: "1px solid transparent", background: "transparent",
				color: V.dim, borderRadius: "7px", padding: "1px 9px", fontSize: "12px", lineHeight: "19px", whiteSpace: "nowrap"
			},
			tabOn: {
				flex: "0 0 auto", cursor: "pointer", border: "1px solid " + V.brand, background: SOFT.brand,
				color: V.text, borderRadius: "7px", padding: "1px 9px", fontSize: "12px", lineHeight: "19px", whiteSpace: "nowrap"
			},
			bar: { flex: "1 1 auto", height: "4px", borderRadius: "3px", background: "rgba(127,127,127,0.22)", overflow: "hidden", minWidth: "24px" },
			barFill: { height: "100%", borderRadius: "3px", background: V.success, transition: "width .25s ease" },

			// 复习：卡片
			newBar: {
				display: "flex", alignItems: "center", gap: "6px",
				margin: "2px 4px 7px 4px", padding: "5px 8px", borderRadius: "8px",
				background: "color-mix(in srgb, " + V.brand + " 12%, transparent)",
				border: "1px solid color-mix(in srgb, " + V.brand + " 34%, transparent)",
				fontSize: "11.5px", color: V.text,
				whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
			},
			revWrap: { padding: "2px 4px 0 4px" },
			revCard: {
				padding: "9px 10px", margin: "0 2px 8px 2px", borderRadius: "9px",
				border: "1px solid " + V.border, background: "rgba(127,127,127,0.05)"
			},
			revTitle: { fontWeight: 600, color: V.text, cursor: "pointer", display: "flex", alignItems: "baseline", gap: "6px" },
			revTitleText: { minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			revMeta: { fontSize: "11px", color: V.dim, margin: "3px 0 5px 0", display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" },
			revPath: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "210px" },
			revNote: { fontSize: "12.5px", color: V.text, whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: "1.68" },
			empty: { padding: "18px 14px", color: V.dim, fontSize: "12.5px", textAlign: "center", lineHeight: "1.7" },

			foot: { padding: "6px 10px", borderTop: "1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)", fontSize: "11.5px", color: V.dim },
			err: { padding: "4px 10px", color: V.danger, fontSize: "11.5px" },
			// 「↩ 原文」跳转小按钮（只在节点有来源坐标时渲染）
			jump: { flex: "0 0 auto", fontSize: "11px", lineHeight: "15px", color: V.dim, userSelect: "none" },
			// 面板里的瞬时提示（跳转失败之类）：看一眼就够，不占位置在头部下面
			notice: {
				display: "flex", alignItems: "center", gap: "6px",
				margin: "7px 8px 2px 8px", padding: "5px 8px", borderRadius: "8px",
				background: "rgba(217,83,79,0.12)",
				border: "1px solid rgba(217,83,79,0.35)",
				fontSize: "11.5px", color: V.text
			}
		};

		// ── 小工具 ─────────────────────────────────────────────────────────
		function rollup(node) {
			// 子树的 {done,total}（44 个节点量级，渲染期直接算，不做缓存）
			var done = node.status === "done" ? 1 : 0;
			var total = 1;
			var kids = node.children || [];
			for (var i = 0; i < kids.length; i += 1) {
				var inner = rollup(kids[i]);
				done += inner.done;
				total += inner.total;
			}
			return { done: done, total: total };
		}

		function noteHint(node) {
			// 已完成但还没摘要时，让用户知道在发生什么（而不是一片空白）
			if (node.note) return null;
			if (node.status !== "done") return null;
			if (node.noteState === "running") return "摘要生成中…";
			if (node.noteState === "failed") return "摘要没生成出来（会自动重试；也可以点 ⟳ 立刻重试）";
			if (node.noteState === "skipped") return "这段内容还太少 / 没有可沉淀的结论（点 ⟳ 可强制重试）";
			return "还没有摘要（点 ⟳ 让模型总结）";
		}

		/**
		 * 比水位线（seenAt）新的节点 = "新增"标记的依据。
		 * 只认 createdAt：删除不产生标记（用户明确"删除就不管了"）。
		 * @returns {{ids: Object, count: number, ancestors: Object, titles: string[]}}
		 */
		function collectNew(nodes, sinceIso, into, ancestors, titles) {
			var acc = into || {};
			for (var i = 0; i < (nodes || []).length; i += 1) {
				var node = nodes[i];
				var isNew = typeof node.createdAt === "string" && typeof sinceIso === "string"
					&& Date.parse(node.createdAt) > Date.parse(sinceIso);
				if (isNew) {
					acc[node.id] = true;
					if (titles.length < 3) titles.push(node.title);
					// 新增节点的祖先要强制展开，否则它在折叠的分支里根本看不见
					for (var a = 0; a < (ancestors || []).length; a += 1) acc["^" + ancestors[a]] = true;
				}
				collectNew(node.children, sinceIso, acc, (ancestors || []).concat([node.id]), titles);
			}
			return acc;
		}
		function newInfo(tree, sinceIso) {
			var acc = {};
			var titles = [];
			if (tree !== null && tree !== undefined) collectNew(tree.nodes, sinceIso, acc, [], titles);
			var count = 0;
			for (var key in acc) if (key.charAt(0) !== "^") count += 1;
			return { ids: acc, count: count, titles: titles };
		}

		/**
		 * 树形小图标（内联 SVG，跟着 currentColor 走）。
		 *
		 * ⚠️ viewBox 必须**紧贴图形实际占的边界**（`2 0.8 12 9.6` = 路径包围盒再外扩半个线宽）。
		 * 实拍踩过：路径画在 16×16 里但 ink 只占 y 1.4~9.8（上半部分），
		 * 盒子再怎么 `align-items:center`，图形看着还是**偏上**——因为"居中"的是空盒子。
		 * 收紧 viewBox 后，盒子边界 == 图形边界，居中才是真的居中。
		 */
		function TreeGlyph() {
			return h("svg", { width: "12", height: "12", viewBox: "2 0.8 12 9.6", fill: "none", "aria-hidden": "true", focusable: "false" },
				h("path", { d: "M8 3.2v2.2M8 5.4H4.4v2.2M8 5.4h3.6v2.2M2.6 7.6h3.6v2.2H2.6zM9.8 7.6h3.6v2.2H9.8zM6.2 1.4h3.6v2.2H6.2z", stroke: "currentColor", "stroke-width": "1.2", "stroke-linejoin": "round" })
			);
		}

		function ProgressBar(props) {
			var percent = props.total > 0 ? Math.round((props.done / props.total) * 100) : 0;
			return h("div", { style: S.bar, title: "已完成 " + props.done + " / " + props.total },
				h("div", { style: Object.assign({}, S.barFill, { width: percent + "%" }) })
			);
		}

		/**
		 * 摘要块（点开才展开）。它是"参考材料"，不是树的一部分——
		 * 默认收着，才不会把树顶散（这是这一版修的核心问题）。
		 */
		function NoteBlock(props) {
			var wrap = Object.assign({}, S.noteWrap, { paddingLeft: (30 + (props.depth || 0) * 13) + "px" });
			return h("div", { style: wrap },
				h("div", { className: "lm-note", style: S.note }, props.text)
			);
		}

		/** ISO 时间 → "9/18 05:51"（只做 hover 提示，不带年份）。 */
		function shortTime(iso) {
			var t = Date.parse(String(iso));
			if (!isFinite(t)) return "";
			var d = new Date(t);
			var pad = function (n) { return (n < 10 ? "0" : "") + n; };
			return (d.getMonth() + 1) + "/" + d.getDate() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
		}

		function TreeRow(props) {
			var node = props.node;
			var depth = props.depth;
			var isFocus = props.focus === props.path;
			var hasKids = (node.children || []).length > 0;
			var isNew = props.newMarks !== undefined && props.newMarks[node.id] === true;
			// 有新增后代的分支强制展开（不然"新增在哪"看不见）；用户手动折叠的非新增分支照旧
			var forceOpen = props.newMarks !== undefined && props.newMarks["^" + node.id] === true;
			var folded = props.collapsed[node.id] === true && !forceOpen;
			var showNote = props.openNotes[node.id] === true;
			var stat = hasKids ? rollup(node) : null;

			var rowStyle = Object.assign({}, S.row, { paddingLeft: depth === 0 ? "3px" : "0" });
			if (isFocus) {
				rowStyle.background = SOFT.brand;
				rowStyle.boxShadow = "inset 2px 0 0 " + V.brand;
			} else if (isNew) {
				rowStyle.background = "color-mix(in srgb, " + V.brand + " 10%, transparent)";
				rowStyle.boxShadow = "inset 2px 0 0 " + V.brand;
			}
			var titleStyle = Object.assign({}, S.title);
			if (node.status === "done") {
				titleStyle.textDecoration = "line-through";
				titleStyle.color = V.dim;
			}
			if (isFocus) titleStyle.fontWeight = 600;

			var act = function (op, extra) { props.onAct(op, Object.assign({ id: node.id, path: props.path }, extra || {})); };

			// 「↩ 原文」：这个知识点是在哪轮对话里讲到的 —— 点一下跳回去、滚到那一轮并高亮。
			// 没记到来源（老节点 / 那次对话早于这个功能）就**不渲染**，不给点了没反应的假按钮。
			var origin = node.origin !== null && node.origin !== undefined && isFinite(Number(node.origin.turn)) ? node.origin : null;
			var crossSession = origin !== null && typeof origin.sid === "string" && origin.sid !== "" && origin.sid !== props.sessionId;
			var jumpBtn = origin === null ? null : h("span", {
				key: "jump",
				style: S.jump,
				className: "lm-jump",
				title: (crossSession ? "跳回那次对话" : "跳到这一轮的对话")
					+ "（第 " + Math.floor(Number(origin.turn)) + " 轮"
					+ (origin.time ? " ｜ " + shortTime(origin.time) : "")
					+ (typeof node.originCount === "number" && node.originCount > 1 ? " ｜ 共 " + node.originCount + " 次讨论" : "")
					+ "）",
				onClick: function (e) {
					// 别把点击冒泡给行的"聚焦"处理器（act("focus") 挂在标题上，这里只是保险）
					if (e !== null && e !== undefined && typeof e.stopPropagation === "function") e.stopPropagation();
					if (typeof props.onJump === "function") props.onJump(node, origin);
				}
			}, "↩");

			// 缩进导轨：每层一根细线（只画，不带点击）
			// 每层一根导轨（depth=1 也要有一根，否则第一层子节点看不出层级）
			var guides = [];
			for (var g = 0; g < depth; g += 1) guides.push(h("span", { key: "g" + g, style: S.guide }));

			var caret = hasKids
				? h("span", {
					style: S.caret,
					title: folded ? "展开" : "收起",
					onClick: function () { props.toggleFold(node.id); }
				}, folded ? "▸" : "▾")
				: h("span", { style: S.caret }, "");

			// ▶ 优先：无论完成与否，"我在哪"都要一眼可见
			// （完成状态靠划线 + 已完成按钮 + 左侧强调条表达，不抢这个位置）
			var glyphChar = isFocus ? "▶" : (node.status === "done" ? "✓" : "○");
			var glyphColor = isFocus ? V.brand : (node.status === "done" ? V.success : V.border2);
			var glyph = h("span", { style: Object.assign({}, S.glyph, { color: glyphColor }) }, glyphChar);

			// 右上角的"信息角标"：父节点显示进度，叶节点显示摘要状态
			var badge = null;
			if (isNew) {
				badge = h("span", {
					style: S.badgeNew, title: "上次看过之后新增的知识点"
				}, "NEW");
			} else if (hasKids && stat.total > 1) {
				badge = h("span", {
					style: S.badge, title: "这一支的进度 " + stat.done + "/" + stat.total,
					onClick: function () { props.toggleFold(node.id); }
				}, stat.done + "/" + stat.total);
			} else if (node.note) {
				badge = h("span", {
					style: showNote ? S.badgeOn : S.badge, className: "lm-click", title: "看这个知识点的摘要",
					onClick: function () { props.toggleNote(node.id); }
				}, showNote ? "摘要 ▾" : "摘要 ▸");
			} else if (noteHint(node) !== null) {
				var hint = noteHint(node);
				badge = h("span", {
					style: node.noteState === "failed" ? S.badgeFail : S.badgeBusy,
					className: node.noteState === "failed" ? "lm-click" : "",
					title: (node.noteError || "") + (node.noteError ? " ｜ " : "") + hint,
					onClick: node.noteState === "failed" ? function () { act("note", { force: true }); } : undefined
				}, node.noteState === "running" ? "生成中…" : (node.noteState === "failed" ? "摘要失败" : "无摘要"));
			}

			var kids = [];
			if (hasKids && !folded) {
				for (var i = 0; i < node.children.length; i += 1) {
					var child = node.children[i];
					kids.push(h(TreeRow, {
						key: child.id, node: child, depth: depth + 1,
						path: props.path + "/" + child.title,
						focus: props.focus, onAct: props.onAct,
						openNotes: props.openNotes, collapsed: props.collapsed,
						newMarks: props.newMarks,
						toggleNote: props.toggleNote, toggleFold: props.toggleFold,
						sessionId: props.sessionId, onJump: props.onJump
					}));
				}
			}

			// 长提示（"摘要没生成出来…"）只在**没有角标**时独占一行，避免行内被挤爆；
			// 有角标时完整文案放在 title 里（hover 可见）。
			var hintLine = noteHint(node) !== null && badge === null
				? h("div", {
					style: Object.assign({}, S.hint, { marginLeft: (30 + depth * 13) + "px" }),
					title: node.noteError || ""
				}, noteHint(node))
				: null;

			return h("div", { key: node.id },
				h("div", { style: rowStyle, className: "lm-row" },
					h("span", { style: { flex: "0 0 auto", display: "flex" } }, guides, caret),
					glyph,
					h("span", {
						style: titleStyle,
						className: "lm-click",
						title: (node.title || "") + (node.note ? "\n\n" + node.note : ""),
						onClick: function () { act("focus"); }
					}, node.title),
					badge,
					jumpBtn,
					// ⟳：重写摘要。平时压暗，hover 才亮（树里按钮太多会吵）
					h("button", {
						style: Object.assign({}, S.btn, { border: "1px solid transparent", padding: "0 4px" }),
						className: "lm-act",
						title: node.note ? "用模型重新总结这个知识点" : "让模型为这个知识点写摘要",
						onClick: function () { act("note", { force: true }); }
					}, "⟳"),
					h("button", {
						style: node.status === "done" ? S.btnDone : S.btn,
						title: node.status === "done" ? "取消完成" : "标记学会（会写一句摘要，并回到上一层）",
						onClick: function () { act("done", { done: node.status !== "done" }); }
					}, node.status === "done" ? "已完成" : "学会")
				),
				showNote && node.note ? h(NoteBlock, { text: node.note, depth: depth }) : null,
				hintLine,
				kids.length > 0 ? h("div", null, kids) : null
			);
		}

		/** 复习视图：卡片式列出已完成知识点 + 摘要（这里才是读摘要的地方）。 */
		function reviewBody(data, act, newMarks) {
			var items = (data && data.items) || [];
			var stats = (data && data.stats) || { done: 0, total: 0, withNote: 0 };
			if (items.length === 0) {
				return h("div", { style: S.empty },
					"还没有已完成的知识点。",
					h("br"),
					"在树里点节点右边的「学会」，这里就会攒出可复习的摘要。");
			}
			return h("div", { style: S.revWrap },
				items.map(function (item, index) {
					var when = item.doneAt ? String(item.doneAt).slice(0, 10) : "—";
					var missing = !item.note;
					var title = item.title || (item.path || "").split("/").pop();
					var where = item.path || parent;
					return h("div", { key: item.path + index, style: S.revCard },
						h("div", { style: S.revTitle },
							h("span", { style: { flex: "0 0 auto", color: V.success } }, "✓"),
							newMarks !== undefined && item.id !== undefined && newMarks[item.id] === true
								? h("span", { style: S.badgeNew }, "NEW")
								: null,
							h("span", {
								className: "lm-click", style: S.revTitleText, title: item.path,
								onClick: function () { act("focus", { id: item.id, path: item.path }); }
							}, title)
						),
						h("div", { style: S.revMeta },
							h("span", { style: S.revPath, title: item.path }, where),
							h("span", null, when),
							missing ? h("span", { style: { color: V.dim } }, "｜ 摘要待补") : null
						),
						h("div", { style: S.revNote }, item.note || "（无摘要）")
					);
				})
			);
		}

		/** 按 id 就地打补丁（乐观更新用）：返回新的节点数组，不修改原对象。 */
		function patchNodes(nodes, id, patch) {
			return (nodes || []).map(function (n) {
				if (n.id === id) return Object.assign({}, n, patch);
				var kids = (n.children || []).length > 0 ? patchNodes(n.children, id, patch) : n.children;
				return kids === n.children ? n : Object.assign({}, n, { children: kids });
			});
		}

		function panelBody(sessionId, data, act, open, setOpen, closePanel, view, setView, review, reloadReview, openNotes, toggleNote, collapsed, toggleFold, newMarks, newCount, newTitles, notice, onJump, win) {
			var trees = data.trees || [];
			var tree = data.tree;
			var stat = tree ? rollup({ id: "root", status: "todo", children: tree.nodes || [] }) : { done: 0, total: 0 };
			// 窗口几何（win = { geom, drag, reset }）：默认态贴右 + 自适应高；拖过之后变成显式 left/top/w/h
			var geom = win !== null && win !== undefined && typeof win.geom === "object" && win.geom !== null ? win.geom : {};
			var drag = win === null || win === undefined ? null : win.drag;
			var panelStyle = Object.assign({}, S.panel);
			if (typeof geom.x === "number") { panelStyle.left = geom.x + "px"; panelStyle.right = "auto"; }
			if (typeof geom.y === "number") panelStyle.top = geom.y + "px";
			if (typeof geom.w === "number") panelStyle.width = geom.w + "px";
			if (typeof geom.h === "number") { panelStyle.height = geom.h + "px"; panelStyle.maxHeight = "none"; }
			var head = [
				h("div", { key: "r1", style: S.headRow },
					h("span", { style: S.brandDot }),
					h("span", { style: S.brandText }, "学习树"),
					h("select", {
						key: "sel", style: S.select, className: "lm-sel", value: tree ? tree.id : "",
						title: "切换 / 新建学习树",
						onChange: function (e) { act("open", { treeId: e.target.value }); }
					}, (trees.length === 0 ? [{ id: "", title: "（还没有树）", done: 0, total: 0 }] : trees).map(function (t) {
						return h("option", { key: t.id, value: t.id }, t.title + "  " + t.done + "/" + t.total);
					})),
					h("button", {
						key: "new", style: S.iconBtn, title: "新建一棵学习树",
						onClick: function () {
							var t = window.prompt("新建学习树的名字（例如：Java）", "");
							if (t !== null && t.trim() !== "") act("create", { title: t.trim() });
						}
					}, "＋"),
					// ⟲ 只在"用户真动过窗口"时出现（否则头部白多一个按钮）
					hasGeom(geom) && win !== null && win !== undefined && typeof win.reset === "function"
						? h("button", { key: "resetwin", style: S.iconBtn, title: "恢复默认位置和大小", onClick: function () { win.reset(); } }, "⟲")
						: null,
					h("button", { key: "fold", style: S.iconBtn, title: "收起面板", onClick: function () { closePanel(); } }, "✕")
				),
				h("div", { key: "r2", style: S.headRow },
					h("div", { style: S.tabs },
						h("button", {
							key: "tabTree", style: view === "tree" ? S.tabOn : S.tab, title: "学习树：看位置与进度",
							onClick: function () { setView("tree"); }
						}, "树"),
						h("button", {
							key: "tabReview", style: view === "review" ? S.tabOn : S.tab, title: "复习：已完成知识点 + 摘要",
							onClick: function () { setView("review"); reloadReview(); }
						}, "复习")
					),
					h("span", { style: S.spacer }),
					view === "tree" ? h(ProgressBar, { key: "bar", done: stat.done, total: stat.total }) : null,
					h("span", { key: "num", style: S.progressText },
						view === "tree"
							? stat.done + "/" + stat.total
							: ((review && review.stats ? review.stats.done : 0) + " 个已完成"))
				)
			];
			var body;
			if (view === "review") {
				body = review === null
					? h("div", { style: S.empty }, "读取中…")
					: reviewBody(review, act, newMarks);
			} else if (tree === null || tree === undefined) {
				body = h("div", { style: S.empty },
					"还没有学习树。",
					h("br"),
					"点右上角 ＋ 新建一棵，或者直接对我说「我要学 X」。");
			} else {
				body = h("div", null,
					newCount > 0
						? h("div", { style: S.newBar, title: newTitles.join("、") },
							h("span", { style: S.brandDot }),
							"上次看过后新增 " + newCount + " 个知识点" + (newTitles.length > 0 ? "：" + newTitles.join("、") + (newCount > newTitles.length ? "…" : "") : ""))
						: null,
					(tree.nodes || []).map(function (node) {
						return h(TreeRow, {
							key: node.id, node: node, depth: 0, path: node.title,
							focus: data.focus || "",
							onAct: act, openNotes: openNotes, collapsed: collapsed,
							newMarks: newMarks,
							toggleNote: toggleNote, toggleFold: toggleFold,
							sessionId: sessionId, onJump: onJump
						});
					})
				);
			}
			return h("div", { style: panelStyle, className: "lm-glass lm-glyph lm-panel" },
				h("div", {
					style: S.head,
					className: "lm-head",
					title: "按住这里可以拖动面板",
					// 拖头部移动窗口；按在按钮/下拉框上时不算拖动
					onMouseDown: function (e) {
						if (drag === null || isInteractiveTarget(e === null || e === undefined ? null : e.target)) return;
						drag("move", e);
					}
				}, head),
				// 瞬时提示（跳转失败之类）：挂在头部下面、正文上面，不挤占树的位置
				notice === null || notice === undefined || notice === "" ? null : h("div", { style: S.notice }, notice),
				h("div", { style: S.body, className: "lm-body" }, body),
				h("div", { style: S.foot },
					h("span", {
						style: { cursor: "pointer", textDecoration: "underline dotted" },
						onClick: function () { setOpen(open === "usage" ? null : "usage"); }
					}, "使用说明 " + (open === "usage" ? "▾" : "▸")),
					open === "usage" ? h("div", { style: { marginTop: "6px", whiteSpace: "pre-wrap" } }, data.usage || "") : null
				),
				// 三个缩放手柄：右边缘（只改宽）/ 下边缘（只改高）/ 右下角（改宽高）
				drag === null ? null : h("div", { key: "rs-r", className: "lm-rs lm-rs-r", onMouseDown: function (e) { drag("size-w", e); } }),
				drag === null ? null : h("div", { key: "rs-b", className: "lm-rs lm-rs-b", onMouseDown: function (e) { drag("size-h", e); } }),
				drag === null ? null : h("div", { key: "rs-c", className: "lm-rs lm-rs-c", title: "拖动调整面板大小", onMouseDown: function (e) { drag("size", e); } })
			);
		}

		function Chip(props) {
			var sessionId = props.sessionId;
			var stateData = react.useState(null);
			var data = stateData[0];
			var setData = stateData[1];
			var stateErr = react.useState("");
			var err = stateErr[0];
			var setErr = stateErr[1];
			var stateOpen = react.useState(null);
			var open = stateOpen[0];
			var setOpen = stateOpen[1];
			var stateView = react.useState("tree");
			var view = stateView[0];
			var setView = stateView[1];
			var stateReview = react.useState(null);
			var review = stateReview[0];
			var setReview = stateReview[1];
			// 展开的摘要 / 收起的子树：都按 node.id 记，纯本地视图状态
			var stateNotes = react.useState({});
			var openNotes = stateNotes[0];
			var setOpenNotes = stateNotes[1];
			var stateFold = react.useState({});
			var collapsed = stateFold[0];
			var setCollapsed = stateFold[1];
			// 打开面板时把"水位线"冻结在那一刻：面板开着期间新增的也标 NEW，
			// 而下次再开（seenAt 已推进）自然干净 —— 用户要的"关掉再开就消失"。
			var stateFrozen = react.useState(null);
			var frozenSeen = stateFrozen[0];
			var setFrozenSeen = stateFrozen[1];
			// 一次性提示（跳转失败之类）。**加在最后**：离线测试用 hookQueue 按顺序喂状态，
			// 往中间插一个 useState 会让既有用例全部错位。点开面板时清空。
			var stateNotice = react.useState("");
			var notice = stateNotice[0];
			var setNotice = stateNotice[1];
			// 面板窗口几何（位置 + 大小）：从 localStorage 读回来 —— "上次调过的样子"
			var stateGeom = react.useState(loadGeom());
			var geom = stateGeom[0];
			var setGeomState = stateGeom[1];
			/**
			 * 面板窗口几何的唯一写入口。
			 * persist=false 用于拖动过程中（mousemove 里写 localStorage 会卡）；
			 * 松手时由 startWindowAction 用 geomMirror 落一次盘。
			 */
			var applyGeom = function (next, persist) {
				geomMirror = next;
				setGeomState(next);
				if (persist !== false) saveGeom(next);
			};

			/** 让 act 也能主动"立刻刷新一次"（tick 定义在 effect 里） */
			var tickRef = { current: null };
			/** 复习视图的读取（act 与页签都要用） */
			var reloadReview = function () {
				rpc(sessionId, "review", { limit: 200 }).then(function (result) {
					if (result && result.ok === true) setReview(result);
				}).catch(function () { /* 复习视图失败不影响主面板 */ });
			};

			/**
			 * 面板唯一的"操作"入口：先本地乐观更新（点完立刻变），再发 RPC，最后立刻拉一次 state。
			 * 旧版只发 RPC 不做本地更新，界面要等下一次轮询才变 —— 最多 3 秒，
			 * 这就是"操作有延迟"的来源。
			 */
			var act = function (op, extra) {
				var payload = extra || {};
				if (op === "done") {
					if (typeof payload.id === "string" && payload.id !== "") {
						var nextStatus = payload.done === false ? "todo" : "done";
						setData(function (prev) {
							if (prev === null || prev.tree === null || prev.tree === undefined) return prev;
							return Object.assign({}, prev, { tree: Object.assign({}, prev.tree, {
								nodes: patchNodes(prev.tree.nodes, payload.id, {
									status: nextStatus,
									doneAt: nextStatus === "done" ? new Date().toISOString() : null,
									noteState: nextStatus === "done" ? "running" : null
								})
							}) });
						});
					}
				} else if (op === "focus") {
					if (typeof payload.path === "string" && payload.path !== "") {
						setData(function (prev) { return prev === null ? prev : Object.assign({}, prev, { focus: payload.path }); });
					}
				}
				rpc(sessionId, op, payload).then(function (r) {
					log("op", op, r);
					// 立即对齐一次（~几十毫秒），不等 3 秒轮询：
					// 标完成会触发摘要 + 自动回到父节点，这两件事要尽快反映到界面上。
					if (tickRef.current !== null) tickRef.current();
					if (view === "review") reloadReview();
				}).catch(function (e) { log("op failed", op, String(e)); });
			};

			/** 打开面板：立刻清按钮红点（乐观）+ 冻结水位线 + 落盘 seen。 */
			var openPanel = function () {
				var threshold = data !== null && data !== undefined && typeof data.seenAt === "string" ? data.seenAt : null;
				setFrozenSeen(threshold);
				setNotice("");
				var stamp = new Date().toISOString();
				setData(function (prev) { return prev === null ? prev : Object.assign({}, prev, { seenAt: stamp }); });
				setOpen("panel");
				rpc(sessionId, "seen", {}).then(function (r) { log("op seen", r); }).catch(function (e) { log("seen failed", String(e)); });
			};
			/** 关闭面板：把"开着期间新增的"也划掉（下次打开不再标 NEW）。 */
			var closePanel = function () {
				setOpen(null);
				setFrozenSeen(null);
				rpc(sessionId, "seen", {}).then(function (r) { log("op seen(close)", r); }).catch(function () { /* 关窗失败无所谓，打开时还会再推一次 */ });
			};

			var toggleNote = function (id) {
				setOpenNotes(function (prev) {
					var next = Object.assign({}, prev);
					if (next[id] === true) delete next[id]; else next[id] = true;
					return next;
				});
			};
			var toggleFold = function (id) {
				setCollapsed(function (prev) {
					var next = Object.assign({}, prev);
					if (next[id] === true) delete next[id]; else next[id] = true;
					return next;
				});
			};

			/**
			 * 树行上的「↩ 原文」：跳到讲这个知识点的那轮对话（滚过去 + 高亮）。
			 * 失败信息只在"**没有**切走会话"时显示 —— 切走时本面板会随旧会话一起卸载，
			 * 在这之后 setState 只会换来 React 告警，用户也看不到。
			 */
			var jump = function (node, origin) {
				setNotice("");
				try {
					jumpToOrigin(sessionId, origin, function (msg) { setNotice(msg); });
				} catch (e) {
					setNotice("跳转失败：" + String(e !== null && e !== undefined && e.message ? e.message : e));
				}
			};

			// ⚠️ 轮询必须"自己回到节奏里"，不能依赖 enabledFlag 变化触发重跑。
			// 旧版拿到 enabled=false 就 return（不再轮询），而插件是在 agent/created 之后
			// 才把会话标成学习模式的 —— 面板比它早到时**永远不再重试**，
			// 于是"必须切一次聊天框才出现学习树按钮"（实拍反馈）。
			// 现在：未启用时快轮询（前 ~10 秒 0.8s，之后 5s），启用后 3s 常态轮询；
			// 404（会话还没进 host 会话表）也照常退避重试，不当作错误砸给用户。
			// ⚠️ 这个 effect 必须是**第 0 个**：离线测试用例靠 effects[0] 驱动轮询。
			react.useEffect(function () {
				if (sessionId === undefined || sessionId === null || sessionId === "") { log("no sessionId prop"); return; }
				var alive = true;
				var timer = null;
				var attempts = 0;
				var delay = 800;
				var schedule = function () {
					if (!alive) return;
					timer = setTimeout(tick, delay);
				};
				var tick = function () {
					rpc(sessionId, "state").then(function (result) {
						if (!alive) return;
						attempts += 1;
						if (result && result.ok === true) {
							setErr("");
							setData(result);
							// 一次性上报"浏览器看到的真实环境"（写进 host 的 rpc.log）。
							// 等聊天区渲染出第一行再报（DOM 没挂载时查出来的 turnRows 是 0，没意义）；
							// 超过 10 秒还没有行就兜底强报一次 —— 保证"根本没有 data-chat-turn 这个属性"
							// 也能查出来（否则这个探测会永远不上报，等于没做）。
							// ⚠️ 用轮询自己的节奏计时，不另开 setTimeout：额外定时器会污染
							// test/client.mjs 对"轮询节奏"的断言（那里就是靠 timers 数组断的）。
							if (envReported === false) {
								if (envFirstAt === 0) envFirstAt = Date.now();
								reportEnv(sessionId, Date.now() - envFirstAt > 10000);
							}
							delay = result.enabled === true ? 3000 : (attempts < 12 ? 800 : 5000);
						} else {
							var status = result ? result.__status : 0;
							// 404 = 会话尚未注册，属于"还没到时候"，不显示错误、继续退避重试
							if (status !== 404) setErr(String((result && result.error) || "rpc-failed") + " (status " + status + ")");
							delay = Math.min(Math.round(delay * 1.6), 5000);
						}
						schedule();
					}).catch(function (e) {
						if (!alive) return;
						setErr(String(e && e.message ? e.message : e));
						delay = Math.min(Math.round(delay * 1.6), 5000);
						schedule();
					});
				};
				// 复习视图轮询复用 reloadReview（它只 setReview，不需要 alive 守卫）
				tickRef.current = tick;
				tick();
				if (view === "review") reloadReview();
				var reviewTimer = setInterval(function () { if (view === "review") reloadReview(); }, 3000);
				return function () {
					alive = false;
					tickRef.current = null;
					if (timer !== null) clearTimeout(timer);
					clearInterval(reviewTimer);
				};
			}, [sessionId, view]);

			// Esc 收起面板（浮层的常规期待）。守卫齐全：离线测试环境的 window/document 是假的。
			react.useEffect(function () {
				if (open === null) return;
				if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
				var onKey = function (event) { if (event && event.key === "Escape") closePanel(); };
				window.addEventListener("keydown", onKey);
				return function () { window.removeEventListener("keydown", onKey); };
			}, [open]);

			if (err !== "") { log("state error:", err); }
			if (data === null || data.enabled !== true) return null;

			var stat = data.tree ? rollup({ id: "root", status: "todo", children: data.tree.nodes || [] }) : { done: 0, total: 0 };
			// "新增"判定：面板开着用冻结的水位线（新增会一直标着），关着用最新的 seenAt
			var badgeSince = open === null ? (typeof data.seenAt === "string" ? data.seenAt : null) : (frozenSeen !== null ? frozenSeen : (typeof data.seenAt === "string" ? data.seenAt : null));
			var newMarks = data.tree ? newInfo(data.tree, badgeSince) : { ids: {}, count: 0, titles: [] };
			var chipNew = open === null ? newMarks.count : 0;
			// 会话头部的入口按钮：玻璃药丸（图标 + 名称 + 进度 + 变更红点）
			var chip = h("button", {
				key: "chip",
				type: "button",   // 跟邻居一致：显式声明，避免任何隐式提交语义
				className: "lm-chip",
				style: S.chip,
				title: "学习树（点开面板）"
					+ (stat.total > 0 ? " ｜ 已完成 " + stat.done + "/" + stat.total : "")
					+ (chipNew > 0 ? " ｜ 新增 " + chipNew + " 个知识点" : ""),
				onClick: function () { if (open === null) openPanel(); else closePanel(); }
			},
				h("span", { key: "ico", className: "lm-chip-icon" }, h(TreeGlyph)),
				h("span", { key: "txt" }, "学习树"),
				stat.total > 0 ? h("span", { key: "num", className: "lm-chip-num" }, stat.done + "/" + stat.total) : null,
				chipNew > 0
					? h("span", { key: "dot", className: "lm-chip-new", title: "上次看过后有 " + chipNew + " 个新增知识点" },
						h("span", { className: "lm-chip-newdot" }), "+" + chipNew)
					: null
			);

			// ⚠️ CSS 必须挂在"永远渲染"的这一层：以前它挂在面板里，面板一收起
			// <style> 就从 DOM 消失 → 入口按钮的 .lm-chip 规则全没 → 退化成浏览器默认按钮
			// （实拍：直角框、UA 字号、图标贴着文字）。这类"样式随面板一起卸载"的坑，
			// 回归断言见 test/client.mjs 的"收起状态也带 CSS"。
			var cssTag = h("style", { key: "lm-css" }, CSS);
			if (open === null) return h("span", { key: "wrap" }, cssTag, chip);
			var panel = panelBody(sessionId, data, act, open, setOpen, closePanel, view, setView, review, reloadReview, openNotes, toggleNote, collapsed, toggleFold, newMarks.ids, newMarks.count, newMarks.titles, notice, jump, {
				geom: geom,
				// 拖动中：只更新状态，不落盘（松手才落盘）
				drag: function (kind, event) { startWindowAction(kind, event, function (next) { applyGeom(next, false); }); },
				reset: function () { applyGeom({}, true); }
			});
			if (ReactDOM !== null && ReactDOM.createPortal !== undefined && typeof document !== "undefined") {
				return h("span", { key: "wrap" }, cssTag, chip, ReactDOM.createPortal(panel, document.body));
			}
			return h("span", { key: "wrap" }, cssTag, chip, panel);
		}

		function registerInto(slots) {
			slots.inject("conversation.session.header.actions", function () {
				var dispose = slots.register({
					name: "conversation.session.header.actions",
					id: "learning-mode",
					order: 20
				}, Chip);
				log("registered into conversation.session.header.actions");
				return dispose;
			});
			// 曾在此处挂过一个 shell.overlay 兜底，已移除：它是 root 作用域、拿不到 sessionId，
			// 只能在 useEffect 回调里调 props.useSessions() 反推——而 hook 不能在渲染期外调用，
			// 结果是 slot entry crashed: Minified React error #321 (Invalid hook call)。
			// header 座位已验证可用，兜底没有存在价值。
		}

		function apply(ctx) {
			// inject: ["slots"] 已保证此处 slots 就绪；不再用 ctx.get("slots")
			// （未声明的服务 cordis 会抛错，而不是返回 undefined）。
			var slots = ctx.slots;
			log("apply() called; slots =", slots === undefined || slots === null ? "MISSING" : "ok");
			// 客户端服务用**可选访问**拿：拿不到只是"没有 ↩ 跳转"，绝不影响学习树本体。
			// （ctx.get 是框架给可选依赖的入口；未声明服务的**属性访问**才会抛。）
			try {
				if (typeof ctx.get === "function") {
					svc.sessions = ctx.get("sessions");
					svc.uiWorkspace = ctx.get("uiWorkspace");
				}
			} catch (e) {
				log("optional services unavailable:", String(e !== null && e !== undefined && e.message ? e.message : e));
			}
			log("services:", svc.sessions === undefined || svc.sessions === null ? "sessions=absent" : "sessions=ok",
				svc.uiWorkspace === undefined || svc.uiWorkspace === null ? "uiWorkspace=absent" : "uiWorkspace=ok");
			if (slots === undefined || slots === null) return;
			registerInto(slots);
		}

		module.exports = { name: name, inject: inject, apply: apply };
		return module.exports;
	}
});
