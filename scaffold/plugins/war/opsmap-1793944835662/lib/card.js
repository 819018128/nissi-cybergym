/**
 * opsmap — 浏览器半边：作战地图。
 *
 * 本文件做成两件事：
 *   1. `tool.call.toolview`（key = opsmap_refresh）—— 对话流里那张卡片；
 *   2. `conversation.view`（id = opsmap） —— 对话视图旁边那个「作战地图」页签。
 * 两者共用同一份解析与同一套渲染，所以显示的数字不可能互相矛盾。
 *
 * ★★ 页签是怎么拿到数据的（本会话新查清的，之前一直以为做不到）
 * ------------------------------------------------------------------
 * 上一轮删掉页签时的结论是「完整地图需要 370KB，preset 本地插件没有非 RPC 通路，
 * 所以不做」。**那个结论是错的** —— 通路一直存在，只是找错了地方。
 *
 * 我查过并排除的：
 *   · `host.call(...)`        动态 Cordis 插件私用 RPC，preset 插件没有 → 死
 *   · `ctx.remote['$call']`   preset 客户端没有这个面 → 死
 *   · `workspaces.listDirectory()`  只给目录项与路径，**不给文件内容** → 死
 *   · agent 作用域的远端端点（查了全部 5 个贡献模块）只有
 *     dynamicCordisRunner / fileReferences / commands / goals / sessionReferenceResolver
 *     —— **没有任何一个能取会话历史或工具结果** → 死
 *
 * 真正的通路是**槽位主人本来就发的标准 props**。`conversation.view` 的目录原文：
 *
 *     "Session scope: views read the conversation snapshot through the standard kit."
 *
 * 标准 props 里有 `useSession: SnapshotSelectorHook<ConversationSnapshot>`，
 * 而 `ConversationSnapshot.nodes: readonly ConversationNode[]` 就是会话里全部节点。
 * 工具结果节点带 `call.name` 与 `content`，于是：
 *
 *     从 nodes 里筛 kind==='tool-result' 且 call.name==='opsmap_refresh' 的最新一条
 *
 * 这就是「非 RPC 通路」。不需要宿主服务、不需要新的取数机制、不需要写静态文件、
 * 也不需要把 419KB 塞进模型上下文 —— 数据早就在浏览器里了，只是没人去读它。
 *
 * ★ 与 hive/plugins/board-ui 同一条原则
 * ------------------------------------------------------------------
 * 视图是「本轮已知数据」的纯函数：没有请求、没有缓存，因此视图不可能与模型
 * 看到的数字不一致（两者读同一份字节）。board-ui 的注释把这条写得很清楚：
 * "the view is a pure function of data the turn already holds"。
 *
 * ★ 页签不比卡片多「维度」，但比卡片多「条目」
 * ------------------------------------------------------------------
 * 页签里的数字来自 `opsmap_refresh` 的工具结果，而那是摘要 ——
 * 完整 payload（427,249 字节，第 8 轮实测）从头到尾没进过浏览器。
 * 所以页签里**没有**卡片没有的新维度。但条目数不一样，而且这个差别是必须的：
 *
 *   · 卡片 = 摘要里的 top，前 **8** 条（每轮都要进模型上下文，必须小）
 *   · 页签 = 摘要里的 all，全部 **22** 条（只在浏览器里，一个字节不进上下文）
 *
 * 第 8 轮实测：22 条里那 3 条 assault（工蜂唯一能执行的类别）排在第 20-22 位——
 * **只看前 8 条，永远看不见主攻方向**。所以宿主半边现在同时出 top 与 all
 * （见 lib/index.js 的 buildCard）。
 *
 * 页签的另一半价值是**钉住不动**：对话流里的卡片会随对话滚走、会折叠，
 * 页签永远在那儿，点一下就看到当前局势。
 *
 * ★ 一切都要能降级
 * ------------------------------------------------------------------
 * 结果不是预期 JSON、调用还在跑、页签从没刷新过 —— 都渲染成人话，
 * 而不是空白。**一块什么都不显示的视图比没有视图更糟**，用户会以为系统没问题。
 * 这条是 board-ui 的注释里点名写下的纪律，这里照办。
 *
 * 本文件是**手写**的，没有构建步骤。形状与出厂 bundle 一致：
 * window.__ModuleLoader__.load({ id, factory })，factory 是 CommonJS，
 * 返回 { apply, inject } —— 与宿主插件同一套契约。
 */

window.__ModuleLoader__.load({
  id: "opsmap",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /* ══ 拿到 React —— 拿不到也**不许抛**（2026-10-22 修）═════════════════
     *
     * ★ 为什么要这么写
     *
     *   原来这里是裸的 `var React = require("react")`。而本包的
     *   package.json 里 `dsh.client` **漏了 `external: ["react"]`**
     *   （对照：md-panel 有 `external:["react","…primitives"]`，它工作正常；
     *     hive-board-ui 也没有，而它的 board_* 同样没注册上）。
     *
     *   后果是**整个 factory 抛错 ⇒ 模块从不注册**，症状是：
     *     · 槽位里这个页签 `active: false`
     *     · tool.call.toolview 的已占用 key 里没有 `opsmap_refresh`
     *     · 人点页签"没东西"—— **而且没有任何报错**，最难查的一类
     *
     *   改成：拿不到就把原因**画在页签里**。查一个静默失败，
     *   最值钱的一步是让它开口说话 —— 而不是继续猜。
     *   顺带按可能性依次试几个来源：require → window 上的全局。
     */
    var REACT_SOURCES = [];
    var React = null;
    function tryReact(label, get) {
      if (React) return;
      try {
        var v = get();
        if (v && typeof v.createElement === "function") { React = v; REACT_SOURCES.push(label + " ✓"); }
        else REACT_SOURCES.push(label + " ✗（拿到的不是 React）");
      } catch (e) {
        REACT_SOURCES.push(label + " ✗（" + String((e && e.message) || e).slice(0, 60) + "）");
      }
    }
    tryReact('require("react")', () => require("react"));
    tryReact("window.React", () => (typeof window !== "undefined" ? window.React : null));
    tryReact("window.__DSH_BOOT__.react", () => (typeof window !== "undefined" && window.__DSH_BOOT__ ? window.__DSH_BOOT__.react : null));

    if (!React) {
      /* 诊断视图：不渲染地图，只把"为什么渲染不了"说清楚。
         它必须只依赖 module.exports 与最朴素的字符串 —— 不能再用 React。 */
      var diag = function () {
        return {
          __opsmapDiag: true,
          sources: REACT_SOURCES.slice(),
          hasLoader: typeof window !== "undefined" && !!window.__ModuleLoader__,
          bootKeys: (typeof window !== "undefined" && window.__DSH_BOOT__) ? Object.keys(window.__DSH_BOOT__) : [],
        };
      };
      exports.apply = function (ctx) {
        try {
          var el = document.createElement("div");
          el.setAttribute("data-opsmap-diag", "1");
          el.style.cssText = "padding:16px;font:13px/1.7 ui-monospace,Consolas,monospace;white-space:pre-wrap;color:var(--dsw-alias-label-secondary)";
          el.textContent =
            "作战地图 · 模块加载失败（自报）\n\n" +
            "拿不到 React，所以这个页签渲染不出地图。\n" +
            "各来源的结果：\n  " + REACT_SOURCES.join("\n  ") + "\n\n" +
            "根因很可能是本包 package.json 的 dsh.client 缺少 external: [\"react\"]\n" +
            "（对照 md-panel：external:[\"react\",\"@deepseek-ai/dsh-client-ui-primitives\"]）。\n" +
            "修好后需要重启 DSH 才会重新读取该声明。";
          document.body.appendChild(el);
        } catch (e) { /* 连 DOM 都没有就算了 */ }
      };
      exports.inject = [];
      if (typeof console !== "undefined") console.error("[opsmap] 拿不到 react：" + REACT_SOURCES.join(" | "));
      return module.exports;
    }

    var h = React.createElement;

    /* ── 样式（内联，只注入一次）─────────────────────────────────────
     * 只用 DSH 的设计变量（--dsw-alias-*），让视图跟随应用主题，
     * 不自己造色值。 */

    var css = [
      ".omCard{display:flex;flex-direction:column;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-markdown-code-block)}",
      ".omHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}",
      ".omTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
      ".omStamp{font-size:11px;color:var(--dsw-alias-label-caption);font-family:ui-monospace,Consolas,monospace}",
      ".omStats{display:flex;gap:6px;flex-wrap:wrap}",
      /* 决策块（第 10 轮）。第一屏第一块，边框稍重以表明它是「结论」而不是「数据」。 */
      ".omDecision{display:flex;flex-direction:column;gap:5px;padding:9px 11px;border-radius:8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1)}",
      ".omDecision.omDecisionHot{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l1))}",
      ".omDecH{display:flex;gap:6px;align-items:center;flex-wrap:wrap}",
      ".omDecK{font-size:10px;letter-spacing:.08em;color:var(--dsw-alias-label-secondary)}",
      ".omDecT{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);line-height:1.45}",
      ".omDecWhy{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}",
      ".omDecAct{font-size:12px;line-height:1.55;color:var(--dsw-alias-state-success-primary)}",
      ".omDecCounts{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);opacity:.85}",
      /* 打法层（第 11 轮）：一行一条，标签 + 名字 + 步数 + 命中的地址。 */
      ".omTactics{display:flex;flex-direction:column;gap:3px}",
      ".omTactic{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap;font-size:12px;line-height:1.5}",
      ".omTacticName{color:var(--dsw-alias-label-primary)}",
      ".omTacticMeta{font-size:10px;color:var(--dsw-alias-label-caption)}",
      ".omTacticAddr{font-size:10px;color:var(--dsw-alias-label-caption);font-family:ui-monospace,Consolas,monospace;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".omStat{display:flex;flex-direction:column;gap:1px;padding:5px 9px;border-radius:7px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);min-width:56px}",
      ".omStatN{font-size:15px;font-weight:600;line-height:1.1;color:var(--dsw-alias-label-secondary)}",
      ".omStatL{font-size:10px;color:var(--dsw-alias-label-caption)}",
      ".omStat.omWarn .omStatN{color:var(--dsw-alias-state-error-primary)}",
      ".omBanner{display:flex;gap:8px;align-items:flex-start;padding:7px 10px;border-radius:7px;font-size:12px;line-height:1.5}",
      ".omBanner.omBad{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-secondary)}",
      ".omBanner.omInfo{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary)}",
      ".omSec{display:flex;flex-direction:column;gap:4px}",
      ".omSecH{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-caption)}",
      ".omRow{display:flex;align-items:baseline;gap:7px;font-size:12px;line-height:1.5;min-width:0}",
      ".omRank{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-caption);flex:none;min-width:18px}",
      ".omBody{color:var(--dsw-alias-label-secondary);min-width:0;flex:1}",
      ".omVerb{color:var(--dsw-alias-label-caption);font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:34%}",
      ".omTag{flex:none;font-size:10px;padding:1px 5px;border-radius:4px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-caption);white-space:nowrap}",
      ".omTag.omBlock{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
      ".omFoot{font-size:11px;color:var(--dsw-alias-label-caption);line-height:1.5}",
      /* 数据源标注：页签现在有两个数据源（磁盘 / 对话），必须让人看得出
         当前这份是从哪来的 —— 否则出现差异时无从判断该查哪一边。 */
      ".omSrcNote{font-size:10px;color:var(--dsw-alias-label-caption);padding:2px 0 6px;letter-spacing:.02em}",
      /* 目标行：页签头部显示「这张图按哪个目标算的」。
         来源（会话绑定 / 默认）也要可见 —— 两者可信度不同。 */
      ".omGoal{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;padding:3px 0 1px}",
      ".omGoalK{font-size:10px;color:var(--dsw-alias-label-caption);letter-spacing:.04em}",
      ".omGoalV{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
      ".omGoalSrc{font-size:10px;color:var(--dsw-alias-label-caption)}",
      /* 目标判据块：页签里唯一随目标变化的部分。未达成的判据要能一眼看出来。 */
      ".omCrit{display:flex;flex-direction:column;gap:2px}",
      ".omCrit .omRow{font-size:11.5px}",
      ".omCritBad .omBody{color:var(--dsw-alias-state-error-primary)}",
      /* 卡片过旧：超过心跳周期（10 分钟）两倍就亮出来 —— 旧图当新图看是最贵的一种误读 */
      ".omStale{color:var(--dsw-alias-state-error-primary) !important}",
      /* 战况一览：放到最前面，让"局势"先于细节出现。只用设计变量。 */
      ".omBrief{display:flex;flex-direction:column;gap:3px;padding:6px 8px;margin:2px 0 4px;border-radius:6px;background:var(--dsw-alias-bg-elevated,#161b22)}",
      ".omBriefTop{font-size:12px;display:flex;align-items:baseline;gap:6px}",
      ".omBriefTop b{font-size:14px}",
      ".omBriefK{font-size:10px;color:var(--dsw-alias-label-caption);letter-spacing:.04em}",
      ".omBriefLine{font-size:11px;color:var(--dsw-alias-label-secondary)}",
      ".omBriefList{display:flex;flex-wrap:wrap;gap:4px}",
      ".omBriefChip{font-size:10.5px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-secondary,#30363d);color:var(--dsw-alias-label-secondary)}",
      ".omBriefHit{border-color:var(--dsw-alias-state-success-primary,#3fb950);color:var(--dsw-alias-state-success-primary,#3fb950)}",
      /* 战法库块：地图把"与当前主攻方向相关的战法"送到眼前。
         matchedBy（为什么命中）必须一起画 —— 否则读的人无法判断这条建议凭不凭得住。 */
      ".omKb{display:flex;flex-direction:column;gap:3px}",
      ".omKbCard{display:flex;flex-direction:column;gap:1px;padding:4px 7px;border-radius:6px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2)}",
      ".omKbId{font-size:10.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
      ".omKbWhy{font-size:10px;color:var(--dsw-alias-label-caption)}",
      ".omKbNote{font-size:10.5px;color:var(--dsw-alias-label-caption);line-height:1.5}",
      /* 战况总览（第 36 轮）：逐靶标阶段。
         ★ 只用 DSH 的设计变量，不引引擎给的 color 值 ——
           引擎的颜色（#3fb950 等）是数据层的东西，直接当样式用会让视图
           在换主题时花掉。要让视图跟随主题，颜色必须来自变量。 */
      ".omStages{display:flex;gap:6px;flex-wrap:wrap;margin-top:2px}",
      ".omStage{font-size:11px;padding:3px 8px;border-radius:999px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
      ".omStage.omStageHot{border-color:var(--dsw-alias-label-tertiary);color:var(--dsw-alias-label-secondary);font-weight:600}",
      ".omStageList{margin-top:2px}",
      ".omStageGrp{display:flex;flex-direction:column;gap:3px;margin-top:9px}",
      ".omStageH{font-size:11px;font-weight:600;color:var(--dsw-alias-label-caption);letter-spacing:.02em}",
      ".omUnit{display:flex;align-items:baseline;gap:7px;font-size:12px;line-height:1.5;min-width:0}",
      ".omUnitName{color:var(--dsw-alias-label-secondary);min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      /* 战场态势图（第 3 轮）：网格布点。没有经纬度，所以是拓扑布点不是地理图 ——
         每个点一块牌子，状态用标签表示（交战 / 弃兵 / 空位 / 待发）。
         只用 DSH 设计变量，不引引擎给的颜色值。 */
      ".omCop{display:grid;grid-template-columns:repeat(auto-fill,minmax(186px,1fr));gap:6px;margin-top:4px}",
      ".omNode{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);min-width:0}",
      ".omNode.omHot{border-color:var(--dsw-alias-state-error-primary)}",
      ".omNode.omScored{border-color:var(--dsw-alias-label-tertiary)}",
      ".omNodeH{display:flex;align-items:baseline;gap:5px;min-width:0}",
      ".omNodeNo{font-family:ui-monospace,Consolas,monospace;font-size:10px;color:var(--dsw-alias-label-caption);flex:none}",
      ".omNodeName{font-size:11px;color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}",
      ".omNodeAddr{font-size:10px;color:var(--dsw-alias-label-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".omNodeMeta{display:flex;gap:4px;flex-wrap:wrap;margin-top:1px}",
      ".omRaw{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0;max-height:220px;overflow:auto}",
      /* 页签布局：占满视图区，内部滚动 */
      ".omTab{display:flex;flex-direction:column;gap:12px;padding:14px 16px;overflow:auto;height:100%;box-sizing:border-box}",
      ".omTabHead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}",
      ".omTabTitle{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".omEmpty{display:flex;flex-direction:column;gap:8px;padding:16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}",
      ".omEmpty b{color:var(--dsw-alias-label-secondary);font-weight:600}",
      ".omCode{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-caption)}",
    ].join("");

    var tagId = "opsmap/card.css";
    if (
      typeof document !== "undefined" &&
      document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null
    ) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "opsmap";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    /* ── 结果访问 ──────────────────────────────────────────────────
     * 卡片拿到的是槽位主人给的冻结节点；页签自带节点。
     * 两者形状一致（都有 kind / content），所以下面这组函数两边共用。 */

    function resultText(block) {
      if (!block || block.kind !== "tool-result") return null;
      var content = block.content;
      if (!Array.isArray(content)) return null;
      var out = "";
      for (var i = 0; i < content.length; i++) {
        var c = content[i];
        if (c && c.type === "text" && typeof c.text === "string") out += c.text;
      }
      return out.length > 0 ? out : null;
    }

    /** 把一段文本解析成 { digest, card }；任何异常都退回 null，绝不抛。 */
    function parseCardText(text) {
      if (typeof text !== "string" || text.length === 0) return null;
      try {
        var v = JSON.parse(text);
        if (v && typeof v === "object" && (v.card || v.digest)) return v;
        return null;
      } catch (e) {
        return null;
      }
    }

    /** 把工具结果解析成 { digest, card }。 */
    function parseResult(block) {
      return parseCardText(resultText(block));
    }

    /* ── 数据源一：磁盘（经宿主 HTTP 路由）────────────────────────────
     *
     * ★ 为什么现在是首选源
     * ------------------------------------------------------------------
     * 原来页签只读**对话里那份工具结果**，而那份字节对两个机制都脆弱：
     *   · DSH 溢出策略：内联超过 maxInlineBytes 就截成「头+尾+Omitted 提示」
     *     ⇒ 字节残缺 ⇒ JSON.parse 失败 ⇒ 页签显示原文而不是地图（实测踩过）
     *   · 工具结果裁剪/压缩：结果被压掉后页签会显示「本会话还没有刷新过」
     *     —— 与"真的没刷新过"在界面上长得一模一样
     * 而且那份字节**必须**被裁剪（44KB 每轮进上下文代价太大）。
     *
     * 所以宿主半边（profiles/node_modules/opsmap）注册了一条只读路由
     * `/api/opsmap/card`，把磁盘上那份**完整**卡片透传出来。
     * 页签优先读它 ⇒ 不受容量上限、不受压缩、不受裁剪影响。
     *
     * 对话那份仍然保留为**退路**：宿主路由不可用、或地图还没落过盘时用它。
     * 两条路的解析都走 parseCardText，**同一份逻辑** —— 否则会出现
     * 「一边能画、一边画不出」的错位，而那种错最难看懂。
     */
    /** props 里没有 useSession 时的同形替身。
     *  ⚠ 它**不调用任何 hook** —— 这正是它存在的意义：让 OpsmapView 的 hook 数量
     *     在"有/没有 useSession"两种情况下都稳定（props 在本实例生命周期内不变）。 */
    function useNoSessionStub() {
      return { found: false, seq: -1, node: null };
    }

    function useCardFromDisk(sessionId) {
      var st = React.useState({ phase: "loading", text: null, at: null });
      var set = st[1];
      /* ★ 带上 session：卡片按**目标**分文件，路由要按"这个会话绑定了哪个目标"去取。
         不带 session 的话，一个 cordis 会话（绑 system）会读到 war 会话刷出来的
         任务目标那张图 —— 而它的锚点说的是系统宪章。
         那正是我们花力气消除的"锚点说 A、地图报 B"，不能从这条路上再长出来。 */
      var sid = typeof sessionId === "string" && sessionId.length > 0 ? sessionId : "";
      var url = "/api/opsmap/card" + (sid ? "?session=" + encodeURIComponent(sid) : "");
      React.useEffect(function () {
        var alive = true;
        function load() {
          var p;
          try {
            p = fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
          } catch (e) {
            if (alive) set({ phase: "error", text: null, at: null });
            return;
          }
          p.then(function (r) {
            if (r.status === 404) {
              var e1 = new Error("missing");
              e1.missing = true;
              throw e1;
            }
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.text();
          })
            .then(function (t) {
              if (alive) set({ phase: "ok", text: t, at: Date.now() });
            })
            .catch(function (e) {
              /* 404 = 这个目标还没刷新过（可辨认的状态），其余 = 通道有问题。
                 两者在界面上说法不同 —— 别把"还没有数据"说成"出错了"。 */
              if (alive) set({ phase: e && e.missing ? "missing" : "error", text: null, at: null });
            });
        }
        load();
        /* 轮询而不是订阅：这里没有可订阅的事件面，而地图刷新本身是低频动作
           （有心跳时约十分钟一次）。一分钟一次足够新，且不会给宿主添负担。 */
        var id = setInterval(load, 60000);
        return function () {
          alive = false;
          clearInterval(id);
        };
      }, [url]);
      return st[0];
    }

    /* ── 从会话快照里找最后一次 opsmap_refresh 的结果 ──────────────
     * 现在这是**退路**（首选见 useCardFromDisk）。全部字段都做存在性检查：
     * 快照是运行时的活数据，形状不该被这里假设。找不到就返回 null，
     * 由调用方渲染成人话。 */

    function latestRefreshBlock(nodes) {
      if (!Array.isArray(nodes) || nodes.length === 0) return null;
      var best = null;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!n || n.kind !== "tool-result") continue;
        /* call 可能为 null（窗口截断时调用头落在窗外）—— 那种情况下无法确认
         * 是本工具的结果，跳过而不是误认。 */
        if (!n.call || n.call.name !== "opsmap_refresh") continue;
        if (best === null || (n.seq || 0) >= (best.seq || 0)) best = n;
      }
      return best;
    }

    /* ── 小组件 ──────────────────────────────────────────────────── */

    function stat(label, value, warn, key) {
      return h(
        "div",
        { className: "omStat" + (warn ? " omWarn" : ""), key: key || label },
        h("span", { className: "omStatN" }, String(value)),
        h("span", { className: "omStatL" }, label),
      );
    }

    /** 数据坏掉时的兜底：显示原文，而不是空白卡片。
     *  一块什么都不显示的视图比没有视图更糟 —— 用户会以为系统没问题。 */
    function fallback(block, title) {
      var text = resultText(block);
      return h(
        "div",
        { className: "omCard" },
        h("div", { className: "omHead" }, h("span", { className: "omTitle" }, title)),
        text === null
          ? h("div", { className: "omFoot" }, "刷新中……拿到结果后会在这里显示局势摘要。")
          : h("pre", { className: "omRaw" }, text),
      );
    }

    /**
     * 地图正文。卡片与页签共用。
     * `compact` = 页签模式：显示全部派工件、去掉一部分页脚。
     */
    function MapBody(C, compact) {
  /* 卡片年龄（见 omStamp 处的说明） */
  var staleMin = (function () {
    var t = Date.parse(String((C && C.at) || ''));
    if (!isFinite(t)) return 0;
    return Math.max(0, Math.round((Date.now() - t) / 60000));
  })();
  var ageText = staleMin
    ? '（' + (staleMin >= 120 ? Math.floor(staleMin / 60) + ' 小时前' : staleMin + ' 分钟前') + (staleMin >= 20 ? ' ⚠ 已超心跳周期' : '') + '）'
    : '';

      var HL = C.headline || {};
      var D = C.dispatch;
      var SW = C.swarm;
      /* ★ 逐靶标阶段（第 36 轮）：回答指挥员那句「看不出来到底做到哪步了」。
       * 数据由宿主半边算好（见 lib/index.js 的 buildCard），这里只负责画。
       * null = 拿不到（没导入靶标清单），与「一家都没有」必须画得不一样。 */
      var STAGES = C.stages;
      /* ★ 战场态势图（第 3 轮）。数据由宿主半边算好（见 lib/index.js 的 cop）。
       * null = 算不出来，与「一个点都没有」必须画得不一样。 */
      /* ★ 决策块（第 10 轮）：现在最该做什么 + 凭什么。null = 决策层没给，
       * 与「没有可做的事」必须画得不一样。 */
      var DEC = C.decision;
      /* ★ 打法层（第 11 轮）：当前指纹命中哪些面、每面能试什么。null = 一条都没匹配上，
       * 与「没有战术」必须画得不一样。 */
      var TCT = C.tactics;
      var COP = C.cop;
      /* ★ 页签显示全部 22 条，卡片只显示前 8 条。
       *
       * 分界不是「页签地方大」，而是**进不进模型上下文**：
       *   · 卡片是工具结果的一部分，每轮都要发给模型 → 必须小；
       *   · 页签只在浏览器里渲染，一个字节都不进上下文 → 可以全量。
       *
       * 而全量是必须的：22 条里那 3 条 assault（工蜂唯一能执行的类别）排在
       * 第 20-22 位 —— 只看前 8 条**永远看不见主攻方向**。这是实测出来的，
       * 不是推理：第 8 轮量到 top 8 正好把 #20/#21/#22 全砍掉。
       * 宿主半边因此同时出 top 与 all（见 lib/index.js 的 buildCard）。
       * 老结果没有 all 字段时退化为 top，不会白屏。 */
      var SOURCE = (compact && D && Array.isArray(D.all) && D.all.length > 0)
        ? D.all
        : (D && D.top ? D.top : []);
      var TOP = SOURCE.filter(function (e) {
        return e && typeof e === "object";
      });

      var stats = [];
      if (typeof HL.scorable === "number") stats.push(stat("可计分", HL.scorable, false, "scorable"));
      if (typeof HL.triage === "number") stats.push(stat("待研判", HL.triage, false, "triage"));
      if (typeof HL.blockers === "number") stats.push(stat("阻断项", HL.blockers, HL.blockers > 0, "blockers"));
      if (typeof HL.decisions === "number") stats.push(stat("派工项", HL.decisions, false, "decisions"));
      /* ★ 待你审批 N 件（2026-11-05）
       *
       * 「有人正等你拍板」是唯一一件**只有指挥官能做、不做就卡住**的事。
       * 引擎一直读着 board.approvals，但只当报备合规的比对素材 ——
       * 于是 status=pending 的审批在地图上没有任何位置（读到了却不显示）。
       *
       * 只在 > 0 时画：0 是噪音。这一条与"每个输出先证明自己配得上注意力"同源 ——
       * 需要人介入的事要高亮，不需要人介入的事不该占一格。
       * AP === null（缺 board 数据）也不画 —— 不知道不等于没有。 */
      var AP = C.approvalsPending;
      if (AP && typeof AP.count === "number" && AP.count > 0) {
        stats.push(stat("待批", AP.count, true, "approvalsPending"));
      }

      return h(
        "div",
        { className: "omCard" },

        /* ★ 卡片有多旧（2026-10-23 加）
         *
         *   原来只显示一个绝对时间戳，读者得自己做减法。实测卡片可能已 100 分钟没更新
         *   —— 而读的人无法一眼看出来，会把旧图当当前图看。
         *   心跳是 10 分钟一轮，所以超过 20 分钟就该亮出来。
         *   时间戳**本身留着**（绝对时间对核对有用），只是补上一个"多久之前"。 */
        (function () { return null })(),
        h(
          "div",
          { className: "omHead" },
          h("span", { className: "omTitle" }, "作战地图"),
          h(
            "span",
            { className: "omStamp" + (staleMin >= 20 ? " omStale" : "") },
            String(C.engine || "") + " · " + String(C.at || "").replace("T", " ").slice(0, 19) + ageText,
          ),
        ),

        /* ★ 按哪个目标算的（2026-10-22 新增）。
         *
         *   地图现在跟随**调用方会话绑定的目标**跑判决链，锚点那边也按绑定选目标 ——
         *   两边同源了，但**人看不出来**：页签只显示数字，不显示这些数字是哪份宪章下算出来的。
         *   哪天出现「锚点说 A、地图报 B」，没有这一行就无从对账。
         *
         *   `source` 也要显示：`session-binding` = 按会话绑定算的（正常），
         *   `default` = 没取到绑定、退回了默认目标。两者可信度不同，不能说成一回事。 */
        C.goal
          ? h(
              "div",
              { className: "omGoal" },
              h("span", { className: "omGoalK" }, "目标"),
              h("span", { className: "omGoalV" }, String(C.goal.label || C.goal.id || "?")),
              h("span", { className: "omGoalSrc" },
                (C.goal.source === "session-binding" ? "按会话绑定 · " : "默认 · ") +
                "判据取自 " + String(C.goal.charterJson || "?")),
            )
          : null,

        /* ★ 这张图是从**哪块板面**算的（2026-10-23 加）
         *
         *   由来：实测存在两个板面根（war 预设读 ~/.war、hive 预设读 ~/.hive），
         *   两者写同一批卡片 ⇒ 页签手里的这份可能来自**另一块板面**。
         *   板上 32/36 与 13/36 的差别不是「战况变了」，是「看的不是同一张板子」。
         *
         *   指挥官（模型）不受影响 —— 它调工具时用的是本预设的配置。
         *   受影响的是**人**：他看的是最后被写进去的那一份。
         *   所以这一行是给人的，必须画出来，不能只在卡片数据里躺着。 */
        C.boardRoot
          ? h(
              "div",
              { className: "omGoal" },
              h("span", { className: "omGoalK" }, "板面"),
              h("span", { className: "omGoalSrc" }, String(C.boardRoot)),
              /* 板面**有多旧**（2026-10-23 加）
               *
               *   与"读的是哪块"是两件事：一块新板子可以很旧，一块老板子也可以刚被写过。
               *   实测有一块板面 **6.9 天**没动过 —— 读它的人看到的"战况"全是六天前的，
               *   而光看板面根看不出来。超过 24 小时就把警示画在脸上。
               *   ⚠ digest 里早有这一行（模型看得到）；这里是补给人看的 ——
               *     之前又犯了一次「模型看得到、人看不到」的不对称。 */
              (function () {
                if (!C.boardNewest) return null;
                const t0 = Date.parse(String(C.boardNewest));
                if (!isFinite(t0)) return null;
                /* ⚠ 变量名不能叫 h —— 它是本文件里 React.createElement 的别名 ✗
                   （第一版就叫 h，于是 h("span", ...) 在调一个数字。测试当场抓到。） */
                const hrs = (Date.now() - t0) / 3600000;
                if (hrs < 1) return h("span", { className: "omGoalSrc" }, "（刚写过）");
                const txt = hrs >= 48 ? Math.floor(hrs / 24) + " 天前" : Math.floor(hrs) + " 小时前";
                return h("span", { className: "omGoalSrc" + (hrs >= 24 ? " omStale" : "") },
                  "· 最新写入 " + txt + (hrs >= 24 ? " ⚠ 这块板面不新了" : ""));
              })(),
            )
          : null,

        /* ★★ 战况一览（2026-10-23 加）—— 放在最前面，因为它是"一眼"那一块
         *
         *   指挥官的原话：「我是一眼看不出来的……根本不知道局势如何，更别提指挥了」。
         *   查之后发现：地图算过的东西不少，但页签只画细节、**不画局势** ✗；
         *   而卡片里最该被一眼看到的那条（"最近成果 25.9 小时前"）**哪都没显示** ✗。
         *
         *   这一块**只报数**，不推断、不评价：
         *     · 最近成果什么时候（超过 6 小时黄、超过 24 小时红）
         *     · 在打的分队 / 待派命令
         *     · 立项进度（closed / open / tested）
         *     · 打得最多的几个靶标（成果数 + verified 数）
         *
         *   ⚠ 缺字段就不画那一行 —— **不编 0**（"0 条成果"与"读不到"是两回事）。
         *   ⚠ 这里**不做作战阶段推断**：板面上没有那个字段，靠散文猜会误报（实测过）。 */
        (function () {
          var B = C.brief;
          if (!B || B.ok !== true) {
            if (B && B.ok === false) {
              return h("div", { className: "omBrief" },
                h("span", { className: "omStale" }, "战况一览读不到：" + String(B.error || "未知原因")));
            }
            return null;
          }
          var rows = [];
          /* ① 最近成果 —— 局势里最要紧的一条 */
          var sh = typeof B.staleHours === "number" ? B.staleHours : null;
          if (sh !== null) {
            var tone = sh >= 24 ? " omStale" : sh >= 6 ? "" : "";
            rows.push(h("div", { className: "omBriefTop" + tone },
              h("span", { className: "omBriefK" }, "最近成果"),
              h("b", null, sh >= 48 ? Math.floor(sh / 24) + " 天前" : sh >= 1 ? Math.floor(sh) + " 小时前" : Math.floor(sh * 60) + " 分钟前"),
              sh >= 24 ? h("span", { className: "omStale" }, "　⚠ 一天多没有新成果了") : null));
          }
          /* ② 在打的分队 / 待派命令 */
          var live = [];
          if (typeof B.fighting === "number") live.push("在打的靶标 " + B.fighting);
          if (typeof B.liveTeams === "number") live.push("在线分队 " + B.liveTeams);
          if (typeof B.readyCommands === "number") live.push("待派命令 " + B.readyCommands);
          if (typeof B.unassignedCommands === "number") live.push("挂不上靶标 " + B.unassignedCommands);
          if (live.length) rows.push(h("div", { className: "omBriefLine" }, live.join(" · ")));
          /* ③ 立项进度 */
          var O = B.objectives || null;
          if (O && typeof O === "object") {
            var parts = [];
            if (typeof O.closed === "number") parts.push("已关闭 " + O.closed);
            if (typeof O.open === "number") parts.push("未结 " + O.open);
            if (typeof O.tested === "number") parts.push("已测 " + O.tested);
            if (parts.length) rows.push(h("div", { className: "omBriefLine" }, "立项：" + parts.join(" · ")));
          }
          /* ④ 打得最多的几个靶标 */
          var P = Array.isArray(B.perTarget) ? B.perTarget.slice(0, 6) : [];
          if (P.length) {
            rows.push(h("div", { className: "omBriefLine" }, "战果最多的靶标："));
            rows.push(h("div", { className: "omBriefList" },
              P.map(function (x, i) {
                return h("span", { className: "omBriefChip" + (x.v > 0 ? " omBriefHit" : "") }, i + 1 + ". " +
                  String(x.a || "?") + " · " + x.f + " 条" + (x.v ? "（verified " + x.v + "）" : ""));
              })));
          }
          return rows.length ? h("div", { className: "omBrief" }, rows) : null;
        })(),

        /* ★ 目标判据的当前状态 —— 页签里**唯一随目标变化**的一块。
         *
         *   为什么它该排在前面：系统宪章的目的第一条是
         *   「战场可见：指挥官随时能读到『离达成还差什么』」。
         *   地图把判据算出来了（payload.criteriaStatus），但此前卡片把它整个丢掉 ——
         *   于是换了目标页签只换个名字，看不出这个目标达成得怎么样。
         *
         *   实测依据：两个目标（任务 / 系统）的 headline、派工层、蜂群视野、靶标覆盖
         *   **数字完全相同**（全部来自板面），差异只在这块。
         *
         *   `status` 的取值由引擎给（ok / gap / na 之类），界面**不翻译也不改判** ——
         *   只上色。语义由引擎负责，界面负责让它可见。 */
        (function () {
          var CS = C.criteria;
          if (!Array.isArray(CS) || CS.length === 0) return null;
          var done = CS.filter(function (x) { return x && x.status === "ok"; }).length;
          var bar = CS.filter(function (x) { return x && (x.status === "gap" || x.status === "fail"); }).length;
          return h(
            "div",
            { className: "omSec" },
            h(
              "div",
              { className: "omSecH" },
              "目标判据 " + done + "/" + CS.length + " 达成" + (bar > 0 ? "　未达 " + bar : ""),
            ),
            h(
              "div",
              { className: "omCrit" },
              CS.map(function (c) {
                var st = String((c && c.status) || "na");
                return h(
                  "div",
                  { className: "omRow" + (st === "gap" || st === "fail" ? " omCritBad" : ""), key: String(c && c.id) },
                  h("span", { className: "omRank" }, String((c && c.id) || "?")),
                  h("span", { className: "omBody" }, String((c && c.text) || "(判据无原文)")),
                  h(
                    "span",
                    { className: "omTag" + (st === "ok" ? "" : " omBlock") },
                    (c && c.value !== null && c.value !== undefined ? String(c.value) + " · " : "") + st,
                  ),
                );
              }),
            ),
          );
        })(),

        /* ★★ 决策块（第 10 轮）—— 第一屏第一块，顺序就是重点。
         *
         * 指挥员最初要的不是「一张待办清单」，是「接下来攻击面该怎么做」。
         * 而那张清单之前把**理由**丢了：schwerpunkt 里逐条写好的 why / action
         * 从来没进过卡片（slim 只挑字段），于是界面上只剩结论、没有依据。
         *
         * 这块放在最前面，是为了「看第一眼就知道该干什么、凭什么」；
         * 下面的计数、蜂群落差、阶段分布、态势图全部退成背景。
         * 数字没删 —— 它们是判断依据，只是不再是第一屏的主角。 */
        DEC && DEC.now
          ? h(
              "div",
              { className: "omDecision" + (DEC.now.blocking ? " omDecisionHot" : "") },
              h(
                "div",
                { className: "omDecH" },
                h("span", { className: "omDecK" }, "现在最该做"),
                h("span", { className: "omTag" + (DEC.now.blocking ? " omBlock" : "") },
                  DEC.now.short || DEC.now.kindName || ""),
                DEC.now.blocking ? h("span", { className: "omTag omBlock" }, "阻塞后续") : null,
                DEC.now.executor ? h("span", { className: "omTag" }, "执行：" + DEC.now.executor) : null,
              ),
              h("div", { className: "omDecT" }, "#" + DEC.now.rank + "　" + DEC.now.title),
              DEC.now.why ? h("div", { className: "omDecWhy" }, DEC.now.why) : null,
              DEC.now.action ? h("div", { className: "omDecAct" }, "→ " + DEC.now.action) : null,
              /* 一行说清「这活到底卡在哪」：主攻 0 / 文书满格 = 现在缺的不是打，是文书。
                 ★ 这三个数不是装饰 —— assault 是工蜂唯一能自己执行的类别。 */
              h(
                "div",
                { className: "omDecCounts" },
                (DEC.counts.assault > 0
                  ? "主攻级 " + DEC.counts.assault
                  : "主攻级 0（现在没有能让工蜂直接上的动作）") +
                  "　·　文书级 " + DEC.counts.paper +
                  "　·　阻塞 " + DEC.counts.blocking +
                  "　·　需人裁定 " + DEC.counts.needsHuman +
                  "　·　工蜂可自办 " + DEC.counts.beeReady,
              ),
            )
          : null,

        stats.length > 0 ? h("div", { className: "omStats" }, stats) : null,

        /* ★ 打法层（第 11 轮）—— 接手决策块下方，回答「这类面上通常可以试什么」。
         *
         * 数据不是这里算的：引擎的 matchTactics（opsmap-engine.js:2213）按 doctrine 的
         * detect 规则（host / title / server / 端口）匹配资产，结果挂在 situation.chains[].tactics。
         * 这里只**搬运与排序**，一行都不自己拼 —— 战术与资产的对应关系必须由 doctrine 决定，
         * 代码里出现靶标知识就成了「伪造情报」。
         *
         * 只画前 3 条：卡片体量有限，而指挥员要的是「眼下这几个面能试什么」，
         * 不是一本兵法目录。全量 33 条子战术（含 how / roe / discipline）在 doctrine.tacticsMeta。
         * null = 一条都没匹配上（不是「没有战术」，是「当前指纹还认不出产品」）——
         * 这两种要画得不一样，否则会让人以为军法层是空的。 */
        TCT && TCT.top && TCT.top.length > 0
          ? h(
              "div",
              { className: "omSec" },
              h(
                "div",
                { className: "omSecH" },
                "打法可试 · 按当前命中面（" + TCT.kinds + " 类命中 " + TCT.assets + " 个资产）",
              ),
              h(
                "div",
                { className: "omTactics" },
                TCT.top.map(function (t) {
                  return h(
                    "div",
                    { className: "omTactic", key: "tc" + t.id },
                    h("span", { className: "omTag" }, "×" + t.n),
                    h("span", { className: "omTacticName" }, t.name),
                    t.steps ? h("span", { className: "omTacticMeta" }, t.steps + " 步") : null,
                    t.addrs && t.addrs.length
                      ? h("span", { className: "omTacticAddr" }, "命中：" + t.addrs.join(" / "))
                      : null,
                  );
                }),
              ),
              h(
                "div",
                { className: "omFoot" },
                "只在当前指纹认得出的面上给建议；全量打法与纪律（roe）在「作战地图」页签的军法层",
              ),
            )
          : null,

        /* 蜂群视野落差 —— 这张地图最重要的一个数字。
         * 它回答「地图给蜂群看了，可他们真的看得见吗」。 */
        SW
          ? h(
              "div",
              { className: "omBanner " + (SW.gap > 0 ? "omBad" : "omInfo") },
              h("span", null, SW.gap > 0 ? "⚠" : "✓"),
              h(
                "span",
                null,
                "蜂群视野：地图建议 " + SW.mapTotal + " 条，蜂群此刻看得见 " +
                  SW.visibleCount + " 条（落差 " + SW.gap + "）",
              ),
            )
          : null,

        /* ★ 战况总览：逐靶标阶段（第 36 轮补）
         *
         * 缺口（指挥员原话）：「我另一个会话立的作战地图我也看不出来到底做到哪步了啊」。
         * 下面那行「靶标覆盖 19/19 真正零覆盖 0」只回答**登记全不全**，
         * 不回答**每家打到哪一步**。而那个信息引擎早就算好了（unitStatus()），
         * 只是 buildCard 从来没传出来、界面从来没画过。
         *
         * 分工照 top/all 的成例：同一份字节，两个槽位各画各的粒度 ——
         *   · 卡片（进模型上下文）只出阶段分布一行 chips；
         *   · 页签（只在浏览器，不进上下文）出逐靶标明细，并把可计分的挑出来。
         * 阶段按「离分数由远到近」排（rank 升序），同 rank 内家数多的在前
         * —— 最大的一堆通常就是瓶颈。 */
        STAGES && STAGES.length > 0
          ? h(
              "div",
              { className: "omSec" },
              h("div", { className: "omSecH" }, "战况总览 · 按「离分数由远到近」"),
              h(
                "div",
                { className: "omStages" },
                STAGES.map(function (s) {
                  return h(
                    "span",
                    {
                      className: "omStage" + (s.rank >= 4 ? " omStageHot" : ""),
                      key: "st" + s.label,
                      title: (s.units || []).map(function (x) { return x.t; }).join("\n"),
                    },
                    s.label + " " + s.n,
                  );
                }),
              ),
              compact
                ? h(
                    "div",
                    { className: "omStageList" },
                    STAGES.map(function (s) {
                      return h(
                        "div",
                        { className: "omStageGrp", key: "sg" + s.label },
                        h("div", { className: "omStageH" }, s.label + "（" + s.n + " 家）"),
                        (s.units || []).map(function (u, i) {
                          return h(
                            "div",
                            { className: "omUnit", key: "su" + s.label + i },
                            h("span", { className: "omUnitName", title: u.t }, u.t),
                            h("span", { className: "omTag" }, u.a || "（无入口）"),
                            h("span", { className: "omTag" }, "意图 " + u.o),
                            u.s > 0 ? h("span", { className: "omTag omStageHot" }, "可计分 " + u.s) : null,
                          );
                        }),
                      );
                    }),
                  )
                : null,
            )
          : null,

        /* ★ 战场态势图（第 3 轮）—— 指挥员要的「像国战游戏那样看清战场」。
         *
         * 三件事一眼可见：
         *   哪些点在哪     → 每个点一块牌子，带编号与入口地址
         *   哪个点正在战斗  → 「⚔ 在打 N」标签 + 红框
         *   哪些队伍正在过去 → 「➤ 待发 N」（已下令未落地）与「⏳ 弃 N」（去过又停下）
         *
         * 分工照 stages 的成例：卡片（进模型上下文）只出一行汇总；页签出整张网格。
         * 没有经纬度 —— 这是拓扑布点，不是地理图；这一点写在标题里，免得读者误会。 */
        COP && COP.counts
          ? h(
              "div",
              { className: "omSec" },
              h(
                "div",
                { className: "omSecH" },
                "战场态势 · " + COP.counts.total + " 个点（拓扑布点，非地理图）",
              ),
              h(
                "div",
                { className: "omFoot" },
                "交战中 " + COP.counts.fighting +
                  "　有弃兵 " + COP.counts.stalled +
                  "　有空位 " + COP.counts.pending +
                  "　有命令 " + COP.counts.withCommands +
                  "（可建卡 " + COP.counts.readyCommands +
                  (COP.counts.humanCommands ? " / 需人 " + COP.counts.humanCommands : "") + "）" +
                  "　在打的队伍 " + COP.counts.liveTeams +
                  "　弃过的队伍 " + COP.counts.staleTeams +
                  (COP.counts.unassignedCommands
                    ? "　全局级任务 " + COP.counts.unassignedCommands +
                      "（需人 " + COP.counts.unassignedHuman + "）"
                    : ""),
              ),
              /* ★「指挥部 / 全局任务」——不属于任何点的活。
                  第一版把它们丢了，于是界面上像"没有待办的活"，其实有 8 条。
                  第 9 轮又发现还有一类：有 assetId 但那张资产不属于任何靶标单元
                  （清单外资产 / corpus 语料），此前也隐形。
                  两类必须**分开标**：「清单外」是纪律信号（有东西不在管辖内），
                  「流程」是内务（该报备没报备）。合成一句话会让人误判轻重。 */
              COP.unassigned && COP.unassigned.length > 0 && compact
                ? h(
                    "div",
                    { className: "omFoot", style: { marginTop: "4px" } },
                    "指挥部 / 全局任务（不挂在任何点上）：" +
                      COP.unassigned.map(function (e) {
                        var tag = e.why === "asset-not-in-any-unit" ? "〔清单外〕" : "〔流程〕";
                        return " #" + e.rank + tag + (e.human ? "需人 " : "") + e.title;
                      }).join("　·　"),
                  )
                : null,
              compact
                ? h(
                    "div",
                    { className: "omCop" },
                    COP.nodes.map(function (n) {
                      var hot = n.live > 0;
                      var scored = n.scorable > 0;
                      return h(
                        "div",
                        {
                          className: "omNode" + (hot ? " omHot" : "") + (scored ? " omScored" : ""),
                          key: "cop" + n.no,
                          title: (n.holders && n.holders.length ? "在打：" + n.holders.join(" ") + "\n" : "") +
                            (n.stale && n.stale.length ? "弃过：" + n.stale.join(" ") : ""),
                        },
                        h(
                          "div",
                          { className: "omNodeH" },
                          h("span", { className: "omNodeNo" }, "#" + n.no),
                          h("span", { className: "omNodeName" }, n.name),
                        ),
                        h("div", { className: "omNodeAddr" }, (n.addrs && n.addrs.length ? n.addrs.join(" ") : "（无入口）")),
                        h(
                          "div",
                          { className: "omNodeMeta" },
                          h("span", { className: "omTag" + (n.rank >= 4 ? " omStageHot" : "") }, n.stage),
                          n.live > 0 ? h("span", { className: "omTag omBlock" }, "⚔ 在打 " + n.live) : null,
                          n.expired > 0 ? h("span", { className: "omTag" }, "⏳ 弃 " + n.expired) : null,
                          n.open > 0 ? h("span", { className: "omTag" }, "○ 空位 " + n.open) : null,
                          n.cmd > 0 ? h("span", { className: "omTag" }, "➤ 待发 " + n.cmd) : null,
                          scored ? h("span", { className: "omTag omStageHot" }, "★ 可计分 " + n.scorable) : null,
                        ),
                      );
                    }),
                  )
                : null,
            )
          : null,

        /* 派工层：谁该干什么 */
        D
          ? h(
              "div",
              { className: "omSec" },
              h(
                "div",
                { className: "omSecH" },
                "派工层 · 共 " + D.total + " 条（可直接建卡 " + D.executable +
                  " / 需两步 " + D.twoStep + " / 需人 " + D.needsHuman + "）" +
                  /* ★ 裁剪必须**看得见**。
                   *
                   * 宿主半边为了不越过 DSH 的 50000 字节溢出阈值，会在载荷过大时
                   * 按字节裁剪 `all`（见 lib/index.js 的 fitInlinePayload）。
                   * 不越过阈值是硬要求：一旦越线，DSH 会把内联内容截成「头+尾」，
                   * 这份 JSON 就成了残缺的、parse 不出来的东西 —— 页签反而**完全打不开**。
                   * 所以"少画几条"是换取"页签能打开"的必要代价。
                   *
                   * 但代价必须说出来。静默裁剪会让页签看起来"就这么多条"，
                   * 而"视图与告示同源、不撒谎"正是这套设计的第一条纪律。 */
                  (compact && typeof D.allOmitted === "number" && D.allOmitted > 0
                    ? "　⚠ 其中 " + D.allOmitted + " 条因内联字节预算被裁（不裁就会越过 DSH 的 50000 字节溢出阈值，整份 JSON 被截断、页签反而完全打不开）"
                    : ""),
              ),
              /* D.top 兜底：过滤掉非对象元素，再兜空数组。
               * 这是被测试抓出来的真 bug（见 artifacts/_tools/_card_render_test.mjs）：
               * 只要 top 里混进一个 null，读 e.rank 就抛异常，整行炸掉。
               * 渲染半张卡永远好过整行消失 —— 而这种失败是静默的。 */
              TOP.map(function (e) {
                return h(
                  "div",
                  { className: "omRow", key: "d" + e.rank },
                  h("span", { className: "omRank" }, "#" + e.rank),
                  h(
                    "span",
                    { className: "omTag" + (e.blocking ? " omBlock" : "") },
                    e.short || e.kindName || e.kind,
                  ),
                  h("span", { className: "omBody" }, e.title),
                  h("span", { className: "omVerb", title: e.verb || "" }, e.verb || ""),
                  h("span", { className: "omTag" }, e.executor || ""),
                );
              }),
              TOP.length < D.total
                ? h(
                    "div",
                    { className: "omFoot" },
                    "（卡片只带前 " + TOP.length + " 条，共 " + D.total +
                      " 条 —— 完整 " + D.total + " 条在对话旁的「作战地图」页签里，那一边不进模型上下文）",
                  )
                : null,
            )
          : null,

        /* 战法库（地图把相关战法送到眼前 —— 这是"可进化"的落点） */
        (function () {
          const kb = C.kb;
          if (!kb) return null;
          const rows = (kb.cards || []).map(function (x) {
            return h("div", { className: "omKbCard", key: String(x.id) },
              h("div", { className: "omKbId" }, "[" + String(x.type || "?") + "] " + String(x.id || "?")),
              h("div", { className: "omKbWhy" }, "为什么命中：" + ((x.matchedBy || []).join(" · ") || "(未记)")),
              h("div", { className: "omFoot" }, String(x.brief || x.title || "").slice(0, 120)));
          });
          return h("div", null,
            h("div", { className: "omStageH" },
              "战法库 · 与主攻方向相关 " + rows.length + " 张（库内 " + kb.total + "）" +
              (kb.error ? "（读不到：" + kb.error + "）" : "")),
            rows.length
              ? h("div", { className: "omKb" }, rows)
              : h("div", { className: "omKbNote" },
                  "词面未命中。库内构成：" + String(kb.shape || "(未知)") +
                  "　—— 要按技法检索用 personal-kb 技能。"));
        })(),

        /* 靶标覆盖 */
        C.targets
          ? h(
              "div",
              { className: "omFoot" },
              "靶标覆盖 " + C.targets.covered + "/" + C.targets.units +
                "　真正零覆盖 " + C.targets.realGap + "　清单外 " + C.targets.orphan,
            )
          : null,

        /* 主攻方向（摘要没带这一项时整段不渲染） */
        C.schwerpunkt
          ? h(
              "div",
              { className: "omFoot" },
              "主攻方向 " + C.schwerpunkt.total + " 条　纸上 " + C.schwerpunkt.paper +
                "　主攻 " + C.schwerpunkt.assault,
            )
          : null,

        compact
          ? null
          : h(
              "div",
              { className: "omFoot" },
              "⚠ 地图只读，不写板面。派工层里的 board 调用参数要由 lead 用 board_* 工具执行；" +
                "尤其 register-gap / open-front 必须先 board_asset_add 建资产卡，否则意图卡无处可挂。",
            ),
      );
    }

    /* ── 槽位一：对话流里的调用行 ────────────────────────────────── */

    function OpsmapRow(props) {
      var block = props && props.block;
      var parsed = parseResult(block);
      if (!parsed || !parsed.card) return fallback(block, "作战地图");
      return MapBody(parsed.card, false);
    }

    /* ── 槽位二：对话视图旁边的「作战地图」页签 ──────────────────── */

    function OpsmapView(props) {
      /* ══ ★★ 所有 hook 必须**无条件、固定顺序**调用 ══════════════════════════
       *
       *   这里是本页签「点了没反应」的真凶（2026-10-22 定位）。
       *
       *   原来的写法是：
       *     var disk = useCardFromDisk(...)          ← hook ①
       *     if (disk 拿到了) return ...              ← early return
       *     if (!useSession) return ...              ← early return
       *     var picked = useSession(...)             ← hook ②（在分支之后！）
       *
       *   于是两次渲染的 hook 数量不同：
       *     第 1 帧（磁盘还没取到）→ 走到底 → 调 2 个 hook
       *     第 2 帧（磁盘取到且解析成功）→ early return → 只调 1 个 hook
       *   React 的规则是「每次渲染的 hook 数量与顺序必须一致」，少一个就抛
       *     Rendered fewer hooks than expected
       *   ⇒ **整个视图崩掉** ⇒ 点页签什么都不出来。
       *
       *   ⚠ 为什么测试没抓到：我的假 React 只是把 useState/useEffect 记下来，
       *     **不检查顺序与数量** —— 它太宽容了，于是放过了这一类致命错误。
       *     已把 test-client-render.mjs 的假 React 改成**强制检查 hook 数量**，
       *     同类的错以后会在测试里就红。
       *
       *   正确形态：**两个 hook 都放在最顶上，无条件调用**；
       *   之后再做"用哪个数据源"的判断 —— 判断不是 hook，放哪儿都行。 */
      var disk = useCardFromDisk(props && props.sessionId);
      var useSession = props && props.useSession;
      /* ⚠ 即使 props 里没有 useSession 也必须**照常调用一次**，
         否则「有/没有」两种情况的 hook 数量不同（而且那会在首帧就炸）。
         没有真 hook 时用一个不调用任何 hook 的同形替身 —— 它是稳定的，
         因为 props.useSession 在组件实例的整个生命周期里不会变。 */
      var picker = typeof useSession === "function" ? useSession : useNoSessionStub;
      var picked = picker(function (snapshot) {
        var node = latestRefreshBlock(snapshot && snapshot.nodes);
        /* 返回稳定标识：seq 变化才重渲染。seq 为 0 时退回节点数。 */
        return node === null
          ? { found: false, seq: -1, node: null }
          : { found: true, seq: node.seq || 0, node: node };
      });

      /* ① 首选：磁盘那份完整卡片（经宿主只读路由，按本会话绑定的目标取）。 */
      var fromDisk = disk.phase === "ok" ? parseCardText(disk.text) : null;
      if (fromDisk && fromDisk.card) {
        return h(
          "div",
          { className: "omTab" },
          h(
            "div",
            { className: "omSrcNote" },
            "数据源：磁盘（完整卡片，不受对话容量与压缩影响）",
          ),
          MapBody(fromDisk.card, true),
        );
      }

      /* ② 退路：对话里最新一次 opsmap_refresh 的结果。
       *    useSession 由槽位主人作为标准 prop 发下来。它不在就别装死 ——
       *    明说自己缺什么，比渲染一个空白页签有用。 */
      if (typeof useSession !== "function") {
        return h(
          "div",
          { className: "omTab" },
          h(
            "div",
            { className: "omEmpty" },
            h("b", null, "作战地图页签拿不到会话快照"),
            "这个槽位应该作为标准 prop 发下 useSession，但没有拿到。",
            h("span", { className: "omCode" }, "props.useSession 缺失"),
          ),
        );
      }

      var parsed = picked && picked.found ? parseResult(picked.node) : null;

      if (parsed && parsed.card) {
        return h(
          "div",
          { className: "omTab" },
          h(
            "div",
            { className: "omSrcNote" },
            "数据源：对话（磁盘那份不可用：" + disk.phase + "）",
          ),
          MapBody(parsed.card, true),
        );
      }

      /* 有结果，但解析不出 card —— 说「没刷新过」是误导（用户明明刷新过）。
       * 照 card 的 fallback 那条纪律：显示原文，绝不空白。 */
      if (picked && picked.found) {
        return h(
          "div",
          { className: "omTab" },
          h(
            "div",
            { className: "omEmpty" },
            h("b", null, "拿到了 opsmap_refresh 的结果，但不是预期的 JSON"),
            "页签照实显示原文，而不是假装没有数据。对话里那张卡片读的是同一份字节。",
            h("pre", { className: "omRaw" }, resultText(picked.node) || "(结果里没有文本内容)"),
          ),
        );
      }

      /* ③ 两个源都没有。区分「磁盘通道坏了」与「确实没刷新过」——
       *    这两件事在界面上必须长得不一样，否则人会去查错方向。 */
      if (disk.phase === "error") {
        return h(
          "div",
          { className: "omTab" },
          h(
            "div",
            { className: "omEmpty" },
            h("b", null, "作战地图页签读不到数据"),
            "磁盘通道（/api/opsmap/card）请求失败，而本会话里也没有 opsmap_refresh 的结果。",
            h("span", { className: "omCode" }, "宿主路由不可用 —— 先确认 opsmap 宿主半边是否挂上"),
          ),
        );
      }

      /* 确实没刷新过 —— 这不是错误，是新会话的正常状态。给出可执行的下一步。
       * ⚠ 区分 `missing`（磁盘上没有**当前目标**那份）与 `loading`：
       *   前者是"地图还没为这个目标跑过"，后者是"还在取"。混成一句会让人去查错方向。 */
      return h(
        "div",
        { className: "omTab" },
        h(
          "div",
          { className: "omEmpty" },
          h("b", null, disk.phase === "missing" ? "作战地图还没为当前目标刷新过" : "正在读取作战地图…"),
          disk.phase === "missing"
            ? "磁盘上没有本会话所绑定目标的那份卡片。在对话里让 agent 调一次 "
            : "正在从磁盘读取完整卡片；若宿主路由不可用会退回读对话里的那份。",
          disk.phase === "missing" ? h("span", { className: "omCode" }, "opsmap_refresh") : null,
          disk.phase === "missing" ? "，或等地图心跳跑一轮（若已开启），最新局势就会出现在这里。" : null,
          disk.phase === "missing"
            ? h("span", { className: "omCode" }, "（页签不进模型上下文；数据落在磁盘，不受压缩影响）")
            : null,
        ),
      );
    }

    /* ── 插件 ────────────────────────────────────────────────────── */

    var inject = ["slots"];

    function apply(ctx) {
      /* ★ 自报装置：告诉宿主"这个客户端模块真的跑起来了"。
       *
       *   为什么需要：页签「点了没反应」时，宿主侧完全看不见客户端模块的死活 ——
       *   槽位里没注册、控制台又不在手边。这一个 fire-and-forget 的信号
       *   把「模块跑没跑」变成宿主侧可读的事实（宿主写在
       *   ~/.dsh/opsmap-client-mounted.txt）。
       *
       *   ⚠ 用 catch 全吞、失败绝不抛出：自报装置不能反过来把客户端搞坏。
       *     宿主那一半要重启才生效，在那之前这里是 404，同样被吞掉。 */
      try {
        var _sid = "";
        fetch("/api/opsmap/mounted?session=" + encodeURIComponent(_sid) +
              "&src=" + encodeURIComponent(REACT_SOURCES.join("/")) +
              "&mode=" + encodeURIComponent(String((typeof window !== "undefined" && window.__ModuleLoader__ && window.__ModuleLoader__.mode) || "?"))
        ).catch(function () {});
      } catch (e) { /* 自报失败不影响任何东西 */ }

      /* 槽位一：把 opsmap_refresh 的调用行渲染成卡片。
       * tool.call.toolview 的 keyDomain 是开放的，未认领的 key 会退回通用工具行，
       * 所以认领自己这个 key 是纯增量的，不动任何出厂 UI。 */
      ctx.slots.inject("tool.call.toolview", function () {
        return ctx.slots.register(
          { name: "tool.call.toolview", key: "opsmap_refresh" },
          OpsmapRow,
        );
      });

      /* 槽位二：对话视图旁边的页签。
       * conversation.view 是 list 槽位、replaceRisk 为 none ——
       * 用一个自己的 id 就只是「在旁边多一格」，不会顶掉 chat / trajectory。
       * order 取 20：排在 chat(0) 与 trajectory(10) 之后。 */
      ctx.slots.inject("conversation.view", function () {
        return ctx.slots.register(
          { name: "conversation.view", id: "opsmap", order: 20, label: "作战地图" },
          OpsmapView,
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
