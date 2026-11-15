/**
 * nissi-brand —— 浏览器半区。
 *
 * 三件事，全都可逆（`ctx.effect` 的清理器把它们全部收回）：
 *   1. 左栏标识：`sidebar.brand.mark` / `sidebar.brand.name` 换成 Nissi 的旌旗与名称
 *   2. 配色：只覆盖**语义别名层**（`--dsw-alias-*`），不动 --dsw-static-* 色阶
 *   3. favicon：运行时插一个 <link rel="icon">，不改内核 frontend dist 一个字节
 *
 * ── 为什么覆盖别名层而不是色阶 ──────────────────────────────────────────────
 * 实测：`--dsw-static-*` 是原始色阶（neutral-bluish-00..1000 / deepseek-* / blue-*），
 * 深色与浅色通过换整套色阶实现。改色阶要重排上百个值，且会连带影响我没想到的组件。
 * `--dsw-alias-*` 是语义层（bg-base / label-primary / border-l1..l4 / brand-primary），
 * 组件读的是它 —— 只改这一层，意图清楚、影响面可枚举。
 *
 * ── 标识几何 ────────────────────────────────────────────────────────────────
 * 唯一权威值见 `brand/MARK.md` §2：64 画布 = 16 网格 × 4。
 * 横梁 M8 8 H56（描边 8）· 竖杆 M32 8 V60（描边 8）· 旗面 rect(20,16,24,24)（描边 4，留空）。
 * 禁则（MARK.md §5）：旗面不许放东西、全笔画同色、不裁横梁探头、杆必须穿出旗面下方。
 *
 * 模块 id 必须等于包名 —— `dsh-client-modules` 的 arrive() 拿 boot 表里的 id
 * 去比对 bundle 内 `__ModuleLoader__.load({id})`，不等就整条挂不上（且只报 404）。
 */

window.__ModuleLoader__.load({
	id: "nissi-brand",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react_jsx_runtime = require("react/jsx-runtime");

		//#region 标识
		/** MARK.md §2 的唯一权威几何（64 画布）。 */
		const MARK = {
			viewBox: "0 0 64 64",
			beam: "M8 8 H56",
			pole: "M32 8 V60",
			field: { x: 20, y: 16, width: 24, height: 24 },
		};

		/**
		 * 左栏图标：一面举起的标准 —— 横梁 + 竖杆 + 悬空的旗面（旗面留空）。
		 * 全部笔画用 currentColor，颜色由外层 CSS 变量决定。
		 */
		function NissiBrandMark({ size = 24 }) {
			return react_jsx_runtime.jsx("svg", {
				width: size,
				height: size,
				viewBox: MARK.viewBox,
				role: "img",
				"aria-label": "旌旗 · Nissi",
				style: { color: "var(--dsw-alias-brand-primary, #C9A227)", display: "block", flex: "0 0 auto" },
				children: [
					react_jsx_runtime.jsx("path", {
						key: "beam",
						d: MARK.beam,
						fill: "none",
						stroke: "currentColor",
						strokeWidth: 8,
						strokeLinecap: "butt",
					}),
					react_jsx_runtime.jsx("path", {
						key: "pole",
						d: MARK.pole,
						fill: "none",
						stroke: "currentColor",
						strokeWidth: 8,
						strokeLinecap: "butt",
					}),
					react_jsx_runtime.jsx("rect", {
						key: "field",
						x: MARK.field.x,
						y: MARK.field.y,
						width: MARK.field.width,
						height: MARK.field.height,
						fill: "none",
						stroke: "currentColor",
						strokeWidth: 4,
					}),
				],
			});
		}

		/** 左栏名称：独立于图标占位，两个 slot 各管一段。 */
		function NissiBrandName() {
			return react_jsx_runtime.jsx("span", {
				style: {
					fontSize: 15,
					fontWeight: 500,
					letterSpacing: "0.02em",
					color: "var(--dsw-alias-label-primary, #EDE6D6)",
					whiteSpace: "nowrap",
				},
				children: "旌旗 · Nissi",
			});
		}

		/**
		 * 新会话首屏（hero）的图标。
		 *
		 * `ui-conversation` 的 HeroShell 对 `conversation.hero.brand.mark` 传 `{ size, className }`
		 * 并带一个 `<HeroFish hovering>` 兜底 —— 官方品牌包**故意没占这个位**
		 * （它的注释写明 hero 留在"声明包自己的动画鱼"上），所以不占位就永远是那条鱼。
		 */
		function NissiHeroMark({ size = 34, className }) {
			return react_jsx_runtime.jsx("svg", {
				width: size,
				height: size,
				viewBox: MARK.viewBox,
				className,
				role: "img",
				"aria-label": "旌旗 · Nissi",
				style: { color: "var(--dsw-alias-brand-primary, #C9A227)", display: "block" },
				children: [
					react_jsx_runtime.jsx("path", {
						key: "beam",
						d: MARK.beam,
						fill: "none",
						stroke: "currentColor",
						strokeWidth: 8,
						strokeLinecap: "butt",
					}),
					react_jsx_runtime.jsx("path", {
						key: "pole",
						d: MARK.pole,
						fill: "none",
						stroke: "currentColor",
						strokeWidth: 8,
						strokeLinecap: "butt",
					}),
					react_jsx_runtime.jsx("rect", {
						key: "field",
						x: MARK.field.x,
						y: MARK.field.y,
						width: MARK.field.width,
						height: MARK.field.height,
						fill: "none",
						stroke: "currentColor",
						strokeWidth: 4,
					}),
				],
			});
		}

		/**
		 * 首屏标题文案（"探索未至之境" / "Explore the unexplored"）。
		 *
		 * ⚠ 这条**没有受支持的覆盖点**，是唯一一处"硬来"的地方，理由必须写清：
		 *   · `ui-conversation` 的 HeroShell 直接 `t("hero.headline")`，用的是它自己语言的命名空间；
		 *   · `dsh-client-locale` 的 `register(ns, locale, dict)` 对同一 (ns, locale)
		 *     **重复注册会抛错**（单一占用，注释原话 single occupant），
		 *     而查找链是「先条目命名空间、再 common」⇒ 外部无法盖掉条目自己的键。
		 *   所以只能在前端把那段文本换掉：监听 DOM，命中已知文案就替换。
		 *   它不在 React 的受控路径上（只改文本节点内容），React 重渲染时会再被这段拦一次。
		 *   想恢复原样：把 HERO_HEADLINES 清空或删掉这个 effect。
		 */
		const HERO_HEADLINES = ["探索未至之境", "Into the Unknown"];
		const HERO_HEADLINE_REPLACEMENT = "旌旗 · Nissi";

		function rewriteHeroHeadline(root) {
			let changed = 0;
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
				const text = node.textContent;
				if (text === null) continue;
				if (HERO_HEADLINES.includes(text.trim())) {
					node.textContent = HERO_HEADLINE_REPLACEMENT;
					changed += 1;
				}
			}
			return changed;
		}
		//#endregion

		//#region 配色
		/**
		 * 只覆盖语义别名。玄 #0B0F14 / 骨白 #EDE6D6 / 铜金 #C9A227；
		 * 红 #8C1D18 只作状态色，不进标识、不进主色板。
		 */
		const CSS = `
:root{
  --nissi-ink:#0B0F14;
  --nissi-bone:#EDE6D6;
  --nissi-brass:#C9A227;
  --nissi-brass-lift:#D9B64A;
  --nissi-alert:#8C1D18;
}

/* 启动画面（index.html 里写死的内联变量）*/
:root{
  --dsh-boot-bg:var(--nissi-ink);
  --dsh-boot-brand:var(--nissi-brass);
  --dsh-boot-label-primary:var(--nissi-bone);
  --dsh-boot-label-secondary:#B9B2A3;
  --dsh-boot-label-tertiary:#8C8779;
  --dsh-boot-border:rgba(201,162,39,.18);
}

/* 深色 = Nissi 主形态。双写属性选择器提高特异性，压过 ui-theme 注入的规则 */
[data-ds-dark-theme][data-ds-dark-theme]{
  --dsw-alias-bg-base:var(--nissi-ink);
  --dsw-alias-bg-layer-1:var(--nissi-ink);
  --dsw-alias-bg-layer-2:#10151C;
  --dsw-alias-bg-layer-3:#141A22;
  --dsw-alias-bg-module-platform:#10151C;
  --dsw-alias-bg-overlay:#0E131A;

  --dsw-alias-label-primary:var(--nissi-bone);
  --dsw-alias-label-primary-bluish:var(--nissi-bone);
  --dsw-alias-label-secondary:#B9B2A3;
  --dsw-alias-label-tertiary:#8C8779;
  --dsw-alias-label-caption:#6F6A5F;
  --dsw-alias-label-dimmed:#6F6A5F;

  --dsw-alias-border-l1:rgba(201,162,39,.10);
  --dsw-alias-border-l2:rgba(201,162,39,.16);
  --dsw-alias-border-l3:rgba(201,162,39,.24);
  --dsw-alias-border-l4:rgba(201,162,39,.34);

  --dsw-alias-brand-primary:var(--nissi-brass);
  --dsw-alias-brand-text:var(--nissi-brass);
  --dsw-alias-button-primary-fill:var(--nissi-brass);
  --dsw-alias-button-primary-hover:var(--nissi-brass-lift);
}

/* 浅色 = 骨白反向（与 MARK.md §3 的「浅底反向」一致）*/
html:not([data-ds-dark-theme]) body{
  --dsw-alias-bg-base:#EDE6D6;
  --dsw-alias-bg-layer-1:#EDE6D6;
  --dsw-alias-bg-layer-2:#E6DECB;
  --dsw-alias-bg-layer-3:#DED5C0;
  --dsw-alias-label-primary:#0B0F14;
  --dsw-alias-label-secondary:#3A3A32;
  --dsw-alias-label-tertiary:#5C5A4E;
  --dsw-alias-brand-primary:#8A6E14;
  --dsw-alias-brand-text:#8A6E14;
  --dsw-alias-border-l1:rgba(11,15,20,.08);
  --dsw-alias-border-l2:rgba(11,15,20,.14);
  --dsw-alias-border-l3:rgba(11,15,20,.20);
  --dsw-alias-border-l4:rgba(11,15,20,.28);
}
`;

		/** favicon：16 网格等价版（MARK.md §2），运行时插入，不碰内核 dist。 */
		const FAVICON_SVG =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
			'<g fill="none" stroke="#C9A227" stroke-linecap="butt">' +
			'<path d="M2 2 H14" stroke-width="2"/>' +
			'<path d="M8 2 V15" stroke-width="2"/>' +
			'<rect x="5" y="4" width="6" height="6" stroke-width="1"/>' +
			"</g></svg>";
		//#endregion

		//#region 插件
		/** 必需服务：UI slot 注册表。 */
		const inject = ["slots"];

		/**
		 * 占住左栏品牌位，并把配色与 favicon 挂上去。
		 * 每次注册都挂在自己的 fiber 上，fiber 释放时自动摘除。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			ctx.effect(() => {
				const style = document.createElement("style");
				style.setAttribute("data-nissi-brand", "");
				style.textContent = CSS;
				document.head.appendChild(style);

				// 顶掉内核自带的 favicon 链接：先移除同 rel 的，再插自己的
				const stale = [...document.querySelectorAll('link[rel~="icon"]')];
				for (const node of stale) node.remove();

				const icon = document.createElement("link");
				icon.rel = "icon";
				icon.type = "image/svg+xml";
				icon.setAttribute("data-nissi-brand", "");
				icon.href = "data:image/svg+xml," + encodeURIComponent(FAVICON_SVG);
				document.head.appendChild(icon);

				return () => {
					style.remove();
					icon.remove();
				};
			}, "nissi-brand: 配色与 favicon");

			ctx.slots.inject("sidebar.brand.mark", () =>
				ctx.slots.inject("sidebar.brand.name", function* () {
					yield ctx.slots.register({ name: "sidebar.brand.mark" }, NissiBrandMark);
					yield ctx.slots.register({ name: "sidebar.brand.name" }, NissiBrandName);
				})
			);

			// 新会话首屏的图标：不占位就一直是 ui-conversation 自己的动画鱼。
			ctx.slots.inject("conversation.hero.brand.mark", () =>
				ctx.slots.register({ name: "conversation.hero.brand.mark" }, NissiHeroMark)
			);

			// 首屏标题文案：没有受支持的覆盖点，只能盯 DOM（见 HERO_HEADLINES 注释）。
			ctx.effect(() => {
				rewriteHeroHeadline(document.body);
				const observer = new MutationObserver((records) => {
					for (const record of records) {
						for (const node of record.addedNodes) {
							if (node.nodeType === 1) rewriteHeroHeadline(node);
							else if (node.nodeType === 3 && HERO_HEADLINES.includes((node.textContent ?? "").trim())) {
								node.textContent = HERO_HEADLINE_REPLACEMENT;
							}
						}
					}
				});
				// 只监听新增节点与文本变化；替换后文本不再命中，所以不会自激循环。
				observer.observe(document.body, { childList: true, subtree: true, characterData: true });
				return () => observer.disconnect();
			}, "nissi-brand: 首屏文案");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
