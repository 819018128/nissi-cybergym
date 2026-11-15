/**
 * war-xray — the BROWSER half: render xray reports as cards instead of raw text,
 * plus one always-visible button that fetches a fresh report without touching
 * the conversation.
 *
 * HAND-WRITTEN BUNDLE, NO BUILD STEP
 * ----------------------------------
 * `window.__ModuleLoader__.load({ id, factory })` where the factory is CommonJS
 * and returns `{ apply, inject }` — the same contract a host plugin has.
 *
 * THE FACTORY GETS EXACTLY ONE ARGUMENT
 * -------------------------------------
 * `ClientModuleSystem.materialize` (dsh-client-modules/lib/client.js:235) calls
 * `factory(require)` — `exports: registered(makeRequire(edges))` — and NOTHING
 * else. The production bundles (dsh-client-ui-tool/lib/client.js:3-6) therefore
 * create `module`/`exports` themselves. A `factory(require, module, exports)`
 * signature leaves `exports` undefined and dies on the first line that touches
 * it (`Object.defineProperty called on non-object`). Do not restore the
 * three-argument form: the loader will not pass the second or third.
 *
 * WHAT IT REGISTERS
 * -----------------
 *   1. `tool.call.toolview`, keyed by tool name — the three xray_* result cards.
 *      An unclaimed key falls back to the generic tool row, so claiming our three
 *      tools is purely additive.
 *   2. `shell.overlay` — the operator's docking button (see BUTTON below).
 *
 * BUTTON: WHY IT IS A CLIENT→HOST CALL, NOT A CHAT MESSAGE
 * -------------------------------------------------------
 * The requirement was zero tokens: clicking must NOT put a message in the
 * conversation and wait for a model round trip. So the button uses the
 * package-private Client→Host channel that `@deepseek-ai/dsh-client-connection`
 * already provides on both faces:
 *
 *   client  ctx.connection.rpc.call('/war-xray', 'report', { minutes })
 *           → POST `${origin}/war-xray/report` with the standard RPC envelope
 *   host    ctx.connection.rpc.handle('/war-xray', handler, {authority:'loopback'})
 *           → registers that exact prefix route on the host web server
 *
 * Both halves are in lib/index.js / this file and meet at the wire format
 * implemented by `rpcFetchHandler` (host) and `createWebConnectionRpc` (client).
 * Nothing enters the conversation, so nothing enters the history or the context.
 *
 * Degradation is total: no `ctx.connection` (headless / non-web composition) or a
 * failed call renders a disabled button or an inline error, never a crash. A view
 * that can throw would be worse than no view.
 *
 * NO SECOND BUNDLE
 * ----------------
 * `tool.call.toolview` is keyed and `shell.overlay` cells are keyed by `id`, so a
 * second copy of this file registering the same keys at the same priority throws
 * and takes the whole plugin load down with it (2026-10-30, "Failed to load
 * plugins"). There is exactly ONE client bundle: this file.
 */

window.__ModuleLoader__.load({
  id: "war-xray",
  factory: function (require) {
    /* The loader passes only `require` — see the note at the top. */
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var h = React.createElement;
    var useState = React.useState;

    /* ── styles ───────────────────────────────────────────────────────
     * Everything is expressed through the page's own `--dsw-alias-*` tokens:
     * the card must read as part of the app in both light and dark themes, and
     * a hardcoded hex would be wrong in exactly one of them. `color-mix` is used
     * only for translucent tints of an existing token (Chrome 111+), never to
     * invent a colour the theme does not have.
     */
    var css = [
      /* card shell */
      ".xrayCard{display:flex;flex-direction:column;gap:10px;padding:11px 13px;border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-markdown-code-block)}",
      ".xrayHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}",
      ".xrayTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
      ".xraySub{font-size:11px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}",

      /* ① conclusion bar — the first thing a reader needs is "is this bad?" */
      ".xrayVerdict{display:flex;align-items:flex-start;gap:7px;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:1.5}",
      ".xrayVerdict .xrayVdot{flex:0 0 7px;width:7px;height:7px;border-radius:50%;margin-top:5px;background:currentColor}",
      ".xrayVerdict .xrayVtxt{flex:1;color:var(--dsw-alias-label-secondary)}",
      ".xrayVerdict .xrayVlv{font-weight:700;flex:0 0 auto}",
      ".xrayVerdict.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 9%, transparent)}",
      ".xrayVerdict.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)}",
      ".xrayVerdict.bad{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)}",
      ".xrayVerdict.na{color:var(--dsw-alias-label-caption)}",

      /* ② primary vs secondary numbers */
      ".xrayHero{display:flex;align-items:flex-end;gap:22px;flex-wrap:wrap}",
      ".xrayHeroCell{display:flex;flex-direction:column;gap:2px}",
      ".xrayHeroN{font-size:27px;font-weight:700;line-height:1;letter-spacing:-.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}",
      ".xrayHeroN.dur{font-size:22px}",
      ".xrayHeroN.alert{color:var(--dsw-alias-state-error-primary)}",
      ".xrayHeroL{font-size:10px;letter-spacing:.04em;color:var(--dsw-alias-label-caption)}",
      ".xrayMinor{display:flex;gap:4px 14px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-caption)}",
      ".xrayMinor b{font-weight:600;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",

      /* ③ sections */
      ".xraySec{display:flex;flex-direction:column;gap:5px}",
      ".xraySecH{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-caption)}",
      ".xraySecMax{font-size:10px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--dsw-alias-label-dimmed)}",
      ".xrayScale{display:flex;justify-content:space-between;font-size:9px;color:var(--dsw-alias-label-dimmed);margin-top:-2px;padding:0 34px 0 42%}",

      /* bars with a light grid + numeric ticks */
      ".xrayBar{display:flex;align-items:center;gap:7px;font-size:12px;line-height:1.45}",
      ".xrayBarName{flex:0 0 40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}",
      ".xrayBarTrack{flex:1;height:9px;border-radius:5px;background:var(--dsw-alias-bg-base);overflow:hidden;background-image:repeating-linear-gradient(90deg,var(--dsw-alias-border-l1) 0 1px,transparent 1px 25%);background-size:100% 100%}",
      ".xrayBarFill{height:100%;border-radius:5px;background:var(--dsw-alias-label-tertiary)}",
      ".xrayBarFill.max{background:var(--dsw-alias-brand-primary)}",
      ".xrayBarN{flex:0 0 34px;text-align:right;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-caption)}",
      ".xrayBar.maxrow .xrayBarName{color:var(--dsw-alias-label-primary);font-weight:600}",
      ".xrayBar.maxrow .xrayBarN{color:var(--dsw-alias-brand-primary);font-weight:700}",

      /* rows / tags */
      ".xrayRow{display:flex;align-items:baseline;gap:6px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}",
      ".xrayMono{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
      ".xrayTag{display:inline-block;flex:0 0 auto;font-size:10px;padding:1px 6px;border-radius:5px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}",
      ".xrayTag.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}",
      ".xrayTag.bad{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
      /* ④ 堵点着色：在等模型 / 在等工具 必须一眼分得开 —— 两者的优化动作相反 */
      ".xrayTag.model{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)}",
      ".xrayTag.toolw{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent)}",
      ".xrayTag.other{color:var(--dsw-alias-label-tertiary)}",
      ".xrayWhy{font-size:10px;color:var(--dsw-alias-label-dimmed)}",

      /* findings */
      ".xrayFind{display:flex;flex-direction:column;gap:1px;padding:6px 9px;border-radius:7px;border-left:2px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}",
      ".xrayFind.bad{border-left-color:var(--dsw-alias-state-error-primary)}",
      ".xrayFind.warn{border-left-color:var(--dsw-alias-state-warn-primary)}",
      ".xrayFindS{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
      ".xrayFindM{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
      ".xrayFindA{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-caption)}",
      ".xrayFindA b{color:var(--dsw-alias-state-business-primary);font-weight:600}",

      /* empty state — never a blank box */
      ".xrayEmpty{display:flex;flex-direction:column;gap:3px;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-caption)}",
      ".xrayEmpty b{color:var(--dsw-alias-label-secondary);font-weight:600}",
      ".xrayRaw{white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0}",

      /* ── ⑤ the dock: one always-visible button in shell.overlay ───────── */
      /* 位置：右下角、抬到输入卡片之上。
       * 为什么不是 bottom:20px —— 实测那里正好压在输入框的右上角（模型选择器
       * 附近），点它就是在点输入区。抬到输入卡片上沿以上既不挡输入，也不挡
       * 右下角的发送按钮，而且任何会话里都在视野内。 */
      ".xrayDock{position:fixed;right:22px;bottom:158px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;font-family:var(--dsw-font-family,inherit)}",
      ".xrayDock>*{pointer-events:auto}",
      ".xrayBtn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:15px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;cursor:pointer;box-shadow:var(--dsw-alias-shadow-lv2);transition:background .12s,border-color .12s,color .12s}",
      ".xrayBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}",
      ".xrayBtn:disabled{cursor:not-allowed;opacity:.55}",
      ".xrayBtnDot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-dimmed);flex:0 0 auto}",
      ".xrayBtnDot.ok{background:var(--dsw-alias-state-success-primary)}",
      ".xrayBtnDot.warn{background:var(--dsw-alias-state-warn-primary)}",
      ".xrayBtnDot.bad{background:var(--dsw-alias-state-error-primary)}",
      ".xrayBtnDot.loading{background:var(--dsw-alias-brand-primary);animation:xrayPulse 1s ease-in-out infinite}",
      "@keyframes xrayPulse{0%,100%{opacity:1}50%{opacity:.25}}",
      ".xrayPanel{width:min(580px,calc(100vw - 40px));max-height:min(72vh,660px);overflow:auto;padding:10px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-alias-shadow-lv3)}",
      ".xrayPanelBar{display:flex;align-items:center;gap:8px;padding:0 2px 8px}",
      ".xrayPanelBar .xrayGrow{flex:1}",
      ".xrayMini{height:24px;padding:0 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}",
      ".xrayMini:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".xrayMini:disabled{opacity:.5;cursor:not-allowed}",
      ".xrayErr{padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent);font-size:11.5px;line-height:1.55;color:var(--dsw-alias-state-error-primary);word-break:break-word}"
    ].join("");

    var tagId = "war-xray/xray.css";
    if (
      typeof document !== "undefined" &&
      document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null
    ) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "war-xray";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    /* ── result access ────────────────────────────────────────────── */

    function resultText(block) {
      if (!block || block.kind !== "tool-result") return null;
      var content = block.content;
      if (!Array.isArray(content)) return null;
      var out = [];
      for (var i = 0; i < content.length; i++) {
        var part = content[i];
        if (part && typeof part.text === "string") out.push(part.text);
      }
      return out.length ? out.join("\n") : null;
    }

    /* ── parsers (all fail soft, all line-oriented) ────────────────────
     * The host writes these blocks in a fixed, line-parseable shape:
     *   ── 判定 ──
     *   等级: ok（正常）
     *   结论: …
     *   发现1: <signal> ｜ <meaning> ｜ 建议 <action>
     * If the format ever changes, lib/index.js must change with it — the two
     * halves are one contract.
     */

    function splitLines(text) {
      return String(text === null || text === undefined ? "" : text).split("\n");
    }

    function grab(text, re) {
      var m = re.exec(text);
      return m ? m[1] : null;
    }

    /** Parse the "事件 N 条 ｜ 跨度 …" header line. */
    function parseHeader(text) {
      var r = { events: null, span: null, steps: null, reqs: null, tools: null, subs: null, errs: null, line: null };
      var lines = splitLines(text);
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf("事件") === 0 && lines[i].indexOf("跨度") > 0) {
          r.line = lines[i];
          break;
        }
      }
      if (!r.line) return r;
      r.events = grab(r.line, /事件\s+(\d+)\s*条/);
      r.span = grab(r.line, /跨度\s+([\d.]+[a-z]+)/);
      r.steps = grab(r.line, /步\s+(\d+)/);
      r.reqs = grab(r.line, /模型请求\s+(\d+)/);
      r.tools = grab(r.line, /工具调用\s+(\d+)/);
      r.subs = grab(r.line, /分队\s+(\d+)/);
      r.errs = grab(r.line, /错误\s+(\d+)/);
      return r;
    }

    /** Parse the ── 判定 ── block: level, one-line verdict, findings. */
    function parseVerdict(text) {
      var out = { level: null, label: null, verdict: null, findings: [] };
      var lines = splitLines(text);
      var inside = false;
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        if (!inside) {
          if (ln.indexOf("── 判定") >= 0) inside = true;
          continue;
        }
        if (ln.trim().indexOf("──") === 0) break; /* next section */
        var ml = /^等级:\s*(ok|warn|bad)\s*(?:（(.+?)）)?/.exec(ln);
        if (ml) { out.level = ml[1]; out.label = ml[2] || null; continue; }
        var mv = /^结论:\s*(.*)$/.exec(ln);
        if (mv) { out.verdict = mv[1].trim(); continue; }
        var mf = /^发现\d+:\s*(.*)$/.exec(ln);
        if (mf) {
          var parts = mf[1].split(" ｜ ");
          out.findings.push({
            signal: (parts[0] || "").trim(),
            meaning: (parts[1] || "").trim(),
            action: (parts[2] || "").trim().replace(/^建议\s*/, "")
          });
        }
      }
      return out;
    }

    /** Parse the two timing lines (old 口径 kept, new 口径 added by the host). */
    function parseTimings(text) {
      var out = { avgStep: null, avgReq: null, modelWait: null, modelWaitSeg: null, toolSpan: null, toolSpanSeg: null, other: null };
      var lines = splitLines(text);
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        if (ln.indexOf("平均每步耗时") === 0) {
          out.avgStep = grab(ln, /平均每步耗时\s+(\S+)/);
          out.avgReq = grab(ln, /平均每请求\s+(\S+)/);
          continue;
        }
        if (ln.indexOf("平均等模型") === 0) {
          out.modelWait = grab(ln, /平均等模型\s+(\S+?)(?:（|｜|\s|$)/);
          out.modelWaitSeg = grab(ln, /（(\d+)\s*段）/);
          out.toolSpan = grab(ln, /工具执行总时长\s+(\S+?)(?:（|｜|\s|$)/);
          out.toolSpanSeg = grab(ln, /工具执行总时长\s+\S+?（(\d+)\s*段）/);
          out.other = grab(ln, /其余\s+(\S+)/);
        }
      }
      return out;
    }

    /** Parse "── 工具调用 TOP ──" into [{name,count}]. */
    function parseToolTop(text) {
      var out = [];
      var lines = splitLines(text);
      var inside = false;
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        if (ln.indexOf("── 工具调用") >= 0) { inside = true; continue; }
        if (inside) {
          if (ln.indexOf("──") >= 0 && ln.indexOf("── 工具调用") < 0) break;
          var m = /^\s*(\d+)×\s+(\S+)/.exec(ln);
          if (m) out.push({ count: parseInt(m[1], 10), name: m[2] });
        }
      }
      return out;
    }

    /**
     * Classify a gap by what it was waiting on — the whole point of the colour.
     *
     * The host already decided this (lib/index.js `classifyGap`) and appends the
     * answer to the gap line as a trailing marker ("· 在等工具"). Reading that
     * marker is the ONLY way the two halves can agree: the browser sees just one
     * line of text and cannot re-derive the attribution from the event kinds
     * alone (which end of the gap is decisive). The token fallback below only
     * covers text written by an older host half that predates the marker.
     */
    function gapClass(kind) {
      var k = String(kind || "");
      if (k.indexOf("在等工具") >= 0) return "toolw";
      if (k.indexOf("在等模型") >= 0) return "model";
      if (k.indexOf("tool") === 0) return "toolw";
      if (k.indexOf("pre-step") === 0 || k.indexOf("request") === 0) return "model";
      return "other";
    }

    function gapWhy(kind) {
      var c = gapClass(kind);
      if (c === "model") return "在等模型";
      if (c === "toolw") return "在等工具";
      return "在等其它阶段";
    }

    /**
     * Parse the gaps block into [{gap,kind,cls}].
     *
     * Two shapes exist, one per report:
     *   xray_report   "  6m40s     之后紧跟 tool / pwsh"
     *   xray_hotspots "    6m40s → tool/pwsh"        (the "最长的 5 次空档" list)
     *
     * WHY NOT A DURATION REGEX（缺陷修复，2026-10-30）
     * ----------------------------------------------
     * The previous version matched the duration with `([\d.]+[a-z]+)`, which
     * only covers a SINGLE unit: it parsed "41m" and rejected "3m38s" — and
     * every real gap in the report is of the compound form. So the 堵点 section
     * of the card was silently empty on real data while the parser looked
     * correct in isolation. Splitting on the literal separator instead of
     * pattern-matching the number removes the whole class of bug: any duration
     * `dur()` can produce is accepted, and only the separator has to be known.
     */
    function parseGaps(text) {
      var out = [];
      var lines = splitLines(text);
      var inside = false;
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        if (ln.indexOf("── 堵点") >= 0) { inside = true; continue; }
        if (inside) {
          if (ln.indexOf("──") === 0) break;
          var gap = null;
          var kind = null;
          var at = ln.indexOf("之后紧跟");
          if (at > 0) {
            gap = ln.slice(0, at).trim();
            kind = ln.slice(at + 4).trim();
          } else {
            var arrow = ln.indexOf("→");
            if (arrow > 0) {
              gap = ln.slice(0, arrow).trim();
              kind = ln.slice(arrow + 1).trim();
            }
          }
          if (!gap || !kind) continue;
          if (!/[0-9]/.test(gap)) continue;
          /* The host appends its own conclusion after "·" ("tool / pwsh · 在等工具").
           * Split it off so the row can show it as the label instead of printing it
           * twice; text from an older host has no marker and falls back to gapClass. */
          var marker = "";
          var bold = kind.lastIndexOf("·");
          if (bold > 0) {
            marker = kind.slice(bold + 1).trim();
            kind = kind.slice(0, bold).trim();
          }
          /* "最长的 5 次空档" 的行是缩进过的；排行榜的 "4 次  tool/pwsh" 没有
           * 箭头也没有"之后紧跟"，不会误入这里。 */
          out.push({ gap: gap, kind: kind, wait: marker, cls: gapClass(marker || kind) });
        }
      }
      return out;
    }

    /** Parse the idle-loop block into [{tool,times}]. */
    function parseLoops(text) {
      var out = [];
      var lines = splitLines(text);
      var inside = false;
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        if (ln.indexOf("── 疑似空转") >= 0) { inside = true; continue; }
        if (inside) {
          if (ln.indexOf("──") === 0) break;
          var m = /^\s*(\S+)\s+×(\d+)/.exec(ln);
          if (m) out.push({ tool: m[1], times: parseInt(m[2], 10) });
        }
      }
      return out;
    }

    /* ── small pieces ─────────────────────────────────────────────── */

    function Num(v) {
      var n = parseInt(v, 10);
      return isFinite(n) ? n : 0;
    }

    function Section(title, maxText, children) {
      return h(
        "div",
        { className: "xraySec" },
        h(
          "div",
          { className: "xraySecH" },
          h("span", null, title),
          maxText ? h("span", { className: "xraySecMax" }, maxText) : null
        ),
        children
      );
    }

    /** One bar row. The largest value in the set is highlighted (`.max`). */
    function Bar(item, idx, max) {
      var isMax = idx === 0 && item.count > 0;
      var pct = max > 0 ? Math.max(2, Math.round((item.count / max) * 100)) : 2;
      return h(
        "div",
        { className: "xrayBar" + (isMax ? " maxrow" : ""), key: "b" + idx },
        h("div", { className: "xrayBarName", title: item.name }, item.name),
        h(
          "div",
          { className: "xrayBarTrack" },
          h("div", {
            className: "xrayBarFill" + (isMax ? " max" : ""),
            style: { width: pct + "%" }
          })
        ),
        h("div", { className: "xrayBarN" }, String(item.count))
      );
    }

    /** Numeric scale under a bar set: 0 at the left edge, the max at the right. */
    function Scale(max) {
      return h(
        "div",
        { className: "xrayScale", key: "scale" },
        h("span", null, "0"),
        h("span", null, String(max))
      );
    }

    function Raw(text) {
      return h("pre", { className: "xrayRaw" }, text);
    }

    function EmptyState(title, hint) {
      return h(
        "div",
        { className: "xrayCard" },
        h(
          "div",
          { className: "xrayEmpty" },
          h("b", null, title),
          h("span", null, hint)
        )
      );
    }

    /* ── the report card (shared by the tool view and the dock panel) ── */

    function renderReportCard(text) {
      var head = parseHeader(text);
      var verdict = parseVerdict(text);
      var timings = parseTimings(text);
      var tools = parseToolTop(text);
      var gaps = parseGaps(text);
      var loops = parseLoops(text);
      var maxTool = tools.length ? tools[0].count : 0;
      var errN = Num(head.errs);
      var parsedOk = head.line !== null || verdict.level !== null || tools.length || gaps.length || loops.length;

      /* Nothing recognisable: show it verbatim rather than pretending. */
      if (!parsedOk) {
        if (/^XRAY (ERROR|:)/.test(text)) {
          return h(
            "div",
            { className: "xrayCard" },
            h("div", { className: "xrayErr" }, text)
          );
        }
        return h("div", { className: "xrayCard" }, Raw(text));
      }

      var children = [
        h(
          "div",
          { className: "xrayHead", key: "head" },
          h("span", { className: "xrayTitle" }, "XRAY · 本次运行"),
          h("span", { className: "xraySub" }, head.span ? "跨度 " + head.span : "")
        )
      ];

      /* ① conclusion bar */
      if (verdict.level) {
        children.push(
          h(
            "div",
            { className: "xrayVerdict " + verdict.level, key: "verdict" },
            h("span", { className: "xrayVdot" }),
            h("span", { className: "xrayVlv" }, verdict.label || (verdict.level === "bad" ? "异常" : verdict.level === "warn" ? "注意" : "正常")),
            h("span", { className: "xrayVtxt" }, verdict.verdict || "")
          )
        );
      } else {
        children.push(
          h(
            "div",
            { className: "xrayVerdict na", key: "verdict" },
            h("span", { className: "xrayVdot" }),
            h("span", { className: "xrayVtxt" }, "这份报告没有判定块（可能是旧版宿主半区写的），只能看到原始数字。")
          )
        );
      }

      /* ② primary numbers big, secondary numbers small and grey */
      children.push(
        h(
          "div",
          { className: "xrayHero", key: "hero" },
          h(
            "div",
            { className: "xrayHeroCell" },
            h("div", { className: "xrayHeroN" }, head.events === null ? "-" : head.events),
            h("div", { className: "xrayHeroL" }, "事件")
          ),
          h(
            "div",
            { className: "xrayHeroCell" },
            h("div", { className: "xrayHeroN dur" }, head.span || "-"),
            h("div", { className: "xrayHeroL" }, "跨度")
          )
        )
      );
      children.push(
        h(
          "div",
          { className: "xrayMinor", key: "minor" },
          h("span", null, "步 ", h("b", null, head.steps === null ? "-" : head.steps)),
          h("span", null, "模型请求 ", h("b", null, head.reqs === null ? "-" : head.reqs)),
          h("span", null, "工具调用 ", h("b", null, head.tools === null ? "-" : head.tools)),
          h("span", null, "分队 ", h("b", null, head.subs === null ? "-" : head.subs)),
          h(
            "span",
            null,
            "错误 ",
            h("b", { style: errN > 0 ? { color: "var(--dsw-alias-state-error-primary)" } : null }, head.errs === null ? "-" : head.errs)
          )
        )
      );

      /* ②b the corrected timing split — model wait vs tool execution */
      if (timings.modelWait !== null || timings.toolSpan !== null) {
        children.push(
          h(
            "div",
            { className: "xrayMinor", key: "timing" },
            h("span", null, "平均等模型 ", h("b", null, timings.modelWait || "-"), timings.modelWaitSeg ? "（" + timings.modelWaitSeg + " 段）" : ""),
            h("span", null, "工具执行总时长 ", h("b", null, timings.toolSpan || "-"), timings.toolSpanSeg ? "（" + timings.toolSpanSeg + " 段）" : ""),
            timings.avgStep ? h("span", { className: "xrayWhy" }, "旧口径 平均每步 " + timings.avgStep + "（含工具时间，仅供对比）") : null
          )
        );
      }

      /* findings */
      if (verdict.findings.length) {
        children.push(
          Section(
            "发现",
            null,
            verdict.findings.slice(0, 5).map(function (f, i) {
              return h(
                "div",
                { className: "xrayFind " + (verdict.level === "bad" ? "bad" : "warn"), key: "f" + i },
                h("div", { className: "xrayFindS" }, f.signal),
                f.meaning ? h("div", { className: "xrayFindM" }, f.meaning) : null,
                f.action ? h("div", { className: "xrayFindA" }, h("b", null, "建议 "), f.action) : null
              );
            })
          )
        );
      }

      /* ③ bars with numeric scale; the largest is highlighted */
      if (tools.length) {
        children.push(
          Section(
            "工具调用 TOP",
            "最大值 " + maxTool,
            tools.slice(0, 8).map(function (t, i) {
              return Bar(t, i, maxTool);
            }).concat([Scale(maxTool)])
          )
        );
      }

      /* ④ gaps, coloured by what they were waiting on */
      if (gaps.length) {
        children.push(
          Section(
            "堵点（最大空档）",
            null,
            gaps.slice(0, 6).map(function (g, i) {
              return h(
                "div",
                { className: "xrayRow", key: "g" + i },
                h("span", { className: "xrayTag " + g.cls }, g.gap),
                h("span", { className: "xrayWhy" }, g.wait || gapWhy(g.kind)),
                h("span", { className: "xrayMono" }, g.kind)
              );
            })
          )
        );
      } else {
        children.push(Section("堵点", null, h("div", { className: "xrayEmpty" }, h("span", null, "无超过阈值的间隔 —— 这一项是干净的。"))));
      }

      if (loops.length) {
        children.push(
          Section(
            "疑似空转（同工具同参数 ≥3 次）",
            null,
            loops.slice(0, 6).map(function (l, i) {
              return h(
                "div",
                { className: "xrayRow", key: "l" + i },
                h("span", { className: "xrayTag bad" }, "×" + l.times),
                h("span", { className: "xrayMono" }, l.tool)
              );
            })
          )
        );
      }

      return h("div", { className: "xrayCard" }, children);
    }

    /* ── xray_report view ─────────────────────────────────────────── */

    function ReportRow(props) {
      var text = resultText(props.block);
      if (text == null) {
        return EmptyState("XRAY 正在采集…", "这一步还没有结果；等工具返回后这里会变成一张完整报告。");
      }
      try {
        return renderReportCard(text);
      } catch (e) {
        return h("div", { className: "xrayCard" }, Raw(text));
      }
    }

    /* ── xray_hotspots view ───────────────────────────────────────── */

    function HotspotsRow(props) {
      var text = resultText(props.block);
      if (text == null) {
        return EmptyState("XRAY 跨次热区扫描中…", "正在读 _xray 下的全部观测文件。");
      }
      try {
        var tools = parseToolTop(text);
        var gaps = parseGaps(text);
        var maxTool = tools.length ? tools[0].count : 0;
        var head = null;
        var lines = splitLines(text);
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].indexOf("文件") === 0 && lines[i].indexOf("事件") > 0) { head = lines[i]; break; }
        }
        var children = [
          h(
            "div",
            { className: "xrayHead", key: "head" },
            h("span", { className: "xrayTitle" }, "XRAY · 跨次热区"),
            h("span", { className: "xraySub" }, head || "")
          )
        ];
        if (tools.length) {
          children.push(
            Section(
              "工具调用总排行",
              "最大值 " + maxTool,
              tools.slice(0, 10).map(function (t, i) { return Bar(t, i, maxTool); }).concat([Scale(maxTool)])
            )
          );
        }
        if (gaps.length) {
          children.push(
            Section(
              "堵点排行",
              null,
              gaps.slice(0, 8).map(function (g, i) {
                return h(
                  "div",
                  { className: "xrayRow", key: "g" + i },
                  h("span", { className: "xrayTag " + g.cls }, g.gap),
                  h("span", { className: "xrayWhy" }, g.wait || gapWhy(g.kind)),
                  h("span", { className: "xrayMono" }, g.kind)
                );
              })
            )
          );
        }
        var parsedOk = tools.length || gaps.length || head;
        if (!parsedOk) children.push(Raw(text));
        return h("div", { className: "xrayCard" }, children);
      } catch (e) {
        return h("div", { className: "xrayCard" }, Raw(text));
      }
    }

    /* ── xray_structure view ──────────────────────────────────────── */

    function StructureRow(props) {
      var text = resultText(props.block);
      if (text == null) {
        return EmptyState("XRAY 正在解析结构…", "读 agent.cordis.yml 并分层归类。");
      }
      try {
        var lines = splitLines(text);
        var layers = [];   /* {name, count, items:[]} */
        var gaps = [];     /* 缺口自查行 */
        var cur = null;
        for (var i = 0; i < lines.length; i++) {
          var ln = lines[i];
          var mh = /^┌─\s+(\S+)\s+\[(\d+)\]/.exec(ln);
          if (mh) { cur = { name: mh[1], count: parseInt(mh[2], 10), items: [] }; layers.push(cur); continue; }
          if (ln.indexOf("└─") === 0) { cur = null; continue; }
          if (cur && ln.indexOf("│") === 0) {
            var it = ln.replace(/^│\s*/, "").split("←")[0].trim();
            if (it) cur.items.push(it);
            continue;
          }
          var mg = /^\s{2}(\S.*?)[:：]\s*(✓|✗.*)$/.exec(ln);
          if (mg) gaps.push({ name: mg[1], ok: mg[2].indexOf("✓") === 0, note: mg[2] });
        }

        var total = layers.reduce(function (a, x) { return a + x.count; }, 0);
        var maxLayer = layers.reduce(function (a, x) { return Math.max(a, x.count); }, 0);
        var children = [
          h("div", { className: "xrayHead", key: "head" },
            h("span", { className: "xrayTitle" }, "XRAY · 结构图"),
            h("span", { className: "xraySub" }, total + " 个组件 · " + layers.length + " 层"))
        ];

        children.push(
          h(
            "div",
            { className: "xrayHero", key: "hero" },
            h("div", { className: "xrayHeroCell" },
              h("div", { className: "xrayHeroN" }, String(total)),
              h("div", { className: "xrayHeroL" }, "组件")),
            h("div", { className: "xrayHeroCell" },
              h("div", { className: "xrayHeroN dur" }, String(layers.length)),
              h("div", { className: "xrayHeroL" }, "分层"))
          )
        );

        if (layers.length) {
          children.push(
            Section(
              "分层",
              "最大值 " + maxLayer,
              layers.map(function (L, i) { return Bar({ name: L.name, count: L.count }, i, maxLayer); })
                .concat([Scale(maxLayer)])
            )
          );
        }

        if (gaps.length) {
          children.push(
            Section(
              "缺口自查",
              null,
              gaps.map(function (g, i) {
                return h(
                  "div",
                  { className: "xrayRow", key: "g" + i },
                  h("span", { className: "xrayTag " + (g.ok ? "ok" : "bad") }, g.ok ? "✓" : "✗"),
                  h("span", null, g.name)
                );
              })
            )
          );
        }

        if (!layers.length && !gaps.length) children.push(Raw(text));
        return h("div", { className: "xrayCard" }, children);
      } catch (e) {
        return h("div", { className: "xrayCard" }, Raw(text));
      }
    }

    /* ── the dock: one button + one panel, no conversation involved ────
     *
     * State lives entirely in this component: nothing is written to the
     * session, the inbox or the store. Clicking runs one Client→Host call and
     * paints the answer in the panel — the model never sees it, so it costs
     * zero tokens and adds zero history.
     */

    var connHandle = null;   /* set once ctx.connection arrives */
    var connState = "pending"; /* pending | ready | absent */

    function rpcCall(endpoint, payload) {
      if (!connHandle || typeof connHandle.rpc !== "object" || !connHandle.rpc) {
        return Promise.reject(new Error("ctx.connection.rpc 不可用"));
      }
      return connHandle.rpc.call("/war-xray", endpoint, payload || {});
    }

    function XrayDock() {
      var openS = useState(false);
      var loadingS = useState(false);
      var textS = useState(null);
      var errS = useState(null);
      var atS = useState(0);
      var levelS = useState(null);

      var open = openS[0], setOpen = openS[1];
      var loading = loadingS[0], setLoading = loadingS[1];
      var text = textS[0], setText = textS[1];
      var err = errS[0], setErr = errS[1];
      var at = atS[0], setAt = atS[1];
      var level = levelS[0], setLevel = levelS[1];

      function run() {
        if (loading) return;
        setLoading(true);
        setErr(null);
        var p;
        try {
          p = rpcCall("report", { minutes: 120 });
        } catch (e) {
          p = Promise.reject(e);
        }
        p.then(function (res) {
          if (res && res.ok === true && res.value && typeof res.value.text === "string") {
            setText(res.value.text);
            setAt(Date.now());
            try {
              var v = parseVerdict(res.value.text);
              setLevel(v.level);
            } catch (e2) {
              setLevel(null);
            }
            return;
          }
          if (res && res.ok === false) {
            var msg = res.error && res.error.message ? res.error.message : "宿主返回了错误但没有给出原因";
            setErr("宿主侧报告失败：" + msg);
            return;
          }
          setErr("宿主返回了无法识别的结果（不是 RpcResult 的形状）。");
        }).catch(function (e) {
          var m = e && e.message ? e.message : String(e);
          setErr(
            "通道调用失败：" + m +
            "\n如果宿主半区刚改过，这条通道要等预设重挂（重启 dsh web）后才会注册 —— " +
            "在那之前按钮拿不到数据，但页面和对话都不受影响。"
          );
        }).then(function () {
          setLoading(false);
        });
      }

      function toggle() {
        var next = !open;
        setOpen(next);
        if (next && text === null && !loading) run();
      }

      var dotCls = "xrayBtnDot" + (loading ? " loading" : level ? " " + level : "");
      var btnLabel = loading ? "采集中…" : "XRAY 体检";
      var disabled = loading || (connState === "absent");

      var kids = [];

      if (open) {
        var body;
        if (err) {
          body = h("div", { className: "xrayErr" }, err);
        } else if (text === null) {
          body = h(
            "div",
            { className: "xrayEmpty" },
            h("b", null, loading ? "正在采集…" : "还没有数据，随便说一句话就会开始采集。"),
            h("span", null, "也可以点「重新采集」立刻取一次本实例的观测。")
          );
        } else {
          try {
            body = renderReportCard(text);
          } catch (e3) {
            body = Raw(text);
          }
        }

        kids.push(
          h(
            "div",
            { className: "xrayPanel", key: "panel" },
            h(
              "div",
              { className: "xrayPanelBar" },
              h("span", { className: "xrayTitle" }, "XRAY 体检"),
              at ? h("span", { className: "xraySub" }, clockOf(at)) : null,
              h("span", { className: "xrayGrow" }),
              h("button", { className: "xrayMini", onClick: run, disabled: loading }, loading ? "采集中…" : "重新采集"),
              h("button", { className: "xrayMini", onClick: function () { setOpen(false); } }, "收起")
            ),
            body
          )
        );
      }

      kids.push(
        h(
          "button",
          {
            className: "xrayBtn",
            key: "btn",
            onClick: toggle,
            disabled: disabled,
            title:
              connState === "absent"
                ? "宿主通道不可用：本页面没有拿到 ctx.connection（非 web 部署），按钮无法取数。"
                : "点一下取一份 XRAY 报告（只在浏览器与宿主之间往返，不发消息、不消耗 token）"
          },
          h("span", { className: dotCls }),
          btnLabel
        )
      );

      return h("div", { className: "xrayDock" }, kids);
    }

    function clockOf(ms) {
      try {
        var d = new Date(ms);
        var p = function (n) { return (n < 10 ? "0" : "") + n; };
        return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
      } catch (e) {
        return "";
      }
    }

    /* ── plugin ───────────────────────────────────────────────────── */

    var inject = ["slots"];

    function apply(ctx) {
      var views = [
        ["xray_report", ReportRow],
        ["xray_hotspots", HotspotsRow],
        ["xray_structure", StructureRow]
      ];
      ctx.slots.inject("tool.call.toolview", function () {
        return views.map(function (pair) {
          return ctx.slots.register(
            { name: "tool.call.toolview", key: pair[0] },
            pair[1]
          );
        });
      });

      /* The always-visible button. `shell.overlay` is the frame-wide additive
       * layer: a fresh `id` sits beside the shipped entries instead of replacing
       * them, and the layer is click-through until an entry opts in (see
       * `.xrayDock>*{pointer-events:auto}`). */
      try {
        ctx.slots.inject("shell.overlay", function () {
          return ctx.slots.register({ name: "shell.overlay", id: "war-xray-dock" }, XrayDock);
        });
      } catch (e) { /* 该槽位在当前组合里不存在：卡片照旧，只是没有按钮 */ }

      /* Package-private Client→Host channel. `connection` is provided by
       * @deepseek-ai/dsh-client-connection, which is part of the web shell; the
       * delayed injection keeps this plugin loading even when it is absent. */
      try {
        ctx.inject(["connection"], function (sub) {
          try {
            connHandle = sub.connection;
            connState = connHandle && connHandle.rpc ? "ready" : "absent";
          } catch (e) {
            connState = "absent";
          }
        });
      } catch (e) {
        connState = "absent";
      }
    }

    exports.apply = apply;
    exports.inject = inject;

    /* Test seam, and nothing else. The host half writes a line-parseable report
     * format; this half parses it. Asserting that the two halves still agree is
     * a contract test that needs the parser and the renderer from OUTSIDE — and
     * the module loader gives no handle on a plugin's exports from the page. So
     * the pure pieces are exposed under a name nothing in the app calls. They
     * are pure functions of a string; exposing them costs no state and no
     * behaviour. */
    exports.__test = {
      parseHeader: parseHeader,
      parseVerdict: parseVerdict,
      parseTimings: parseTimings,
      parseToolTop: parseToolTop,
      parseGaps: parseGaps,
      parseLoops: parseLoops,
      renderReportCard: renderReportCard
    };

    return module.exports;
  }
});
