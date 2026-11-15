/**
 * hive-board-ui — the BROWSER half: renders the board as cards instead of JSON.
 *
 * HAND-WRITTEN BUNDLE, NO BUILD STEP
 * ----------------------------------
 * Shipped client bundles look like build output, but the shape is simple enough
 * to write directly: `window.__ModuleLoader__.load({ id, factory })`, where the
 * factory is CommonJS and returns `{ apply, inject }` — the same contract a host
 * plugin has. `pnpm run build` generates this shape; it is not a runtime
 * requirement. Writing it by hand keeps this package dependency-free, which
 * matters because a build chain would be one more thing to install on an
 * engagement host.
 *
 * WHAT IT REGISTERS, AND WHY THAT IS SAFE
 * ---------------------------------------
 * Into `tool.call.toolview`, keyed by tool name. The slot's own contract says an
 * unclaimed key falls back to the generic tool row, so claiming `board_snapshot`
 * is purely additive: it changes how OUR tool's calls render and touches nothing
 * shipped.
 *
 * NO HOST SERVICE, NO RPC
 * -----------------------
 * The board's state already reaches the browser, because every `board_snapshot`
 * call travels through the conversation as a tool result and the runtime keeps
 * the frozen result node. So this view is a pure function of data the turn
 * already holds. That is why there is no request here, no cache, and no way for
 * the view to disagree with what the model was told — the two read the same
 * bytes.
 *
 * Everything degrades: if the result is not the JSON shape expected, or the call
 * is still running, the component renders the plain text rather than an empty
 * card. A view that silently shows nothing is worse than no view.
 */

window.__ModuleLoader__.load({
  id: "hive-board-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var h = React.createElement;

    /* ── styles (inlined, injected once) ─────────────────────────── */

    var css = [
      ".hiveCard{display:flex;flex-direction:column;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-markdown-code-block)}",
      ".hiveHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}",
      ".hiveTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
      ".hiveRoot{font-size:11px;color:var(--dsw-alias-label-caption);font-family:ui-monospace,Consolas,monospace;word-break:break-all}",
      ".hiveStats{display:flex;gap:6px;flex-wrap:wrap}",
      ".hiveStat{display:flex;flex-direction:column;gap:1px;padding:5px 9px;border-radius:7px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);min-width:58px}",
      ".hiveStatN{font-size:15px;font-weight:600;line-height:1.1;color:var(--dsw-alias-label-secondary)}",
      ".hiveStatL{font-size:10px;color:var(--dsw-alias-label-caption)}",
      ".hiveStat.hiveWarn .hiveStatN{color:var(--dsw-alias-state-error-primary)}",
      ".hiveBanner{display:flex;gap:8px;align-items:flex-start;padding:7px 10px;border-radius:7px;font-size:12px;line-height:1.5}",
      ".hiveBanner.hiveBlocked{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-secondary)}",
      ".hiveBanner.hiveInfo{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary)}",
      ".hiveBanner.hiveOk{background:color-mix(in srgb, var(--dsw-alias-state-success-primary, #1a7f37) 10%, transparent);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}",
      ".hiveSec{display:flex;flex-direction:column;gap:4px}",
      ".hiveSecH{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-caption)}",
      ".hiveRow{display:flex;align-items:baseline;gap:7px;font-size:12px;line-height:1.5;min-width:0}",
      ".hiveMono{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);flex:none}",
      ".hiveBody{color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".hiveTag{flex:none;font-size:10px;padding:1px 5px;border-radius:4px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-caption)}",
      ".hiveTag.weaponized{color:var(--dsw-alias-state-error-primary)}",
      ".hiveTag.verified{color:var(--dsw-alias-state-success-primary, #1a7f37)}",
      ".hiveEmpty{font-size:11px;color:var(--dsw-alias-label-caption)}",
      ".hiveRaw{white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0}"
    ].join("");

    var tagId = "hive-board-ui/board.css";
    if (
      typeof document !== "undefined" &&
      document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null
    ) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "hive-board-ui";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    /* ── result access ───────────────────────────────────────────── */

    /**
     * The settled tool result as text, or null while the call is still running.
     * `block` is the frozen running-or-settled node the slot owner passes.
     */
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

    /** Parse the tool result as JSON, returning null rather than throwing. */
    function parseResult(block) {
      var text = resultText(block);
      if (text === null) return null;
      try {
        return JSON.parse(text);
      } catch (e) {
        return null;
      }
    }

    function stat(label, value, warn) {
      return h(
        "div",
        { className: "hiveStat" + (warn ? " hiveWarn" : ""), key: label },
        h("span", { className: "hiveStatN" }, String(value)),
        h("span", { className: "hiveStatL" }, label),
      );
    }

    function section(title, rows, renderRow, emptyLabel) {
      return h(
        "div",
        { className: "hiveSec" },
        h("div", { className: "hiveSecH" }, title + " · " + rows.length),
        rows.length === 0
          ? h("div", { className: "hiveEmpty" }, emptyLabel)
          : rows.map(renderRow),
      );
    }

    function fallback(text, note) {
      return h(
        "div",
        { className: "hiveCard" },
        h("div", { className: "hiveHead" }, h("span", { className: "hiveTitle" }, note)),
        h("pre", { className: "hiveRaw" }, text === null ? "(running…)" : text),
      );
    }

    /* ── board_snapshot ──────────────────────────────────────────── */

    function BoardSnapshotRow(props) {
      var block = props.block;
      var data = parseResult(block);
      if (!data || !data.counts) return fallback(resultText(block), "Board snapshot");

      var c = data.counts;
      var blocked = data.your_unregistered_results || [];
      var live = data.live_claims || [];
      var expired = data.expired_claims || [];
      var open = data.open_objectives || [];
      var untested = data.untested_assets || [];
      var released = data.released_not_delivered || [];

      return h(
        "div",
        { className: "hiveCard" },
        h(
          "div",
          { className: "hiveHead" },
          h("span", { className: "hiveTitle" }, "蜂群画板"),
          h("span", { className: "hiveRoot" }, data.root || ""),
        ),
        data.write_blocked
          ? h(
              "div",
              { className: "hiveBanner hiveBlocked" },
              h("span", null, "⛔"),
              h(
                "span",
                null,
                "你的写操作被阻断：" + blocked.length + " 个已确认成果尚未登记（" +
                  blocked.join(", ") + "）。先 board_result_entry 登记，其他写操作才会放行。",
              ),
            )
          : h(
              "div",
              { className: "hiveBanner hiveOk" },
              h("span", null, "✓"),
              h("span", null, "写操作正常（无待登记成果）"),
            ),
        h(
          "div",
          { className: "hiveStats" },
          stat("资产", c.assets),
          stat("意图", c.objectives),
          stat("成果", c.findings),
          stat("已登记成果", c.results_registered, c.verified > (c.results_registered || 0)),
          stat("情报块", c.intel_blocks),
          stat("待批审批", c.approvals_pending, c.approvals_pending > 0),
        ),
        section("活跃认领", live, function (o) {
          return h(
            "div",
            { className: "hiveRow", key: o.id },
            h("span", { className: "hiveMono" }, o.id),
            h("span", { className: "hiveBody" }, o.holder),
            h("span", { className: "hiveTag" }, "心跳 " + String(o.heartbeat_at).slice(11, 19)),
          );
        }, "无活跃认领"),
        section("待测资产", untested, function (a) {
          return h(
            "div",
            { className: "hiveRow", key: a.id },
            h("span", { className: "hiveMono" }, a.id),
            h("span", { className: "hiveBody" }, a.address + (a.port ? ":" + a.port : "")),
            h("span", { className: "hiveTag" }, "未建意图"),
          );
        }, "无未测资产"),
        section("开放意图", open, function (o) {
          return h(
            "div",
            { className: "hiveRow", key: o.id },
            h("span", { className: "hiveMono" }, o.id),
            h("span", { className: "hiveBody" }, o.title),
          );
        }, "无开放意图"),
        expired.length > 0
          ? section("过期认领（持有者已失效，可重新认领）", expired, function (o) {
              return h(
                "div",
                { className: "hiveRow", key: o.id },
                h("span", { className: "hiveMono" }, o.id),
                h("span", { className: "hiveBody" }, "原持有 " + o.last_holder),
                h("span", { className: "hiveTag" }, "心跳停于 " + String(o.heartbeat_at).slice(11, 19)),
              );
            }, "")
          : null,
        released.length > 0
          ? section("空手收口（测过但无成果）", released, function (o) {
              return h(
                "div",
                { className: "hiveRow", key: o.id },
                h("span", { className: "hiveMono" }, o.id),
                h("span", { className: "hiveBody" }, "由 " + o.released_by + " 释放"),
              );
            }, "")
          : null,
      );
    }

    /* ── egress_status ───────────────────────────────────────────── */

    function EgressStatusRow(props) {
      var data = parseResult(props.block);
      if (!data || !data.view) return fallback(resultText(props.block), "Egress status");
      var state = data.view.state;
      var cls = state === "enabled" ? "hiveOk" : state === "down" ? "hiveBlocked" : "hiveInfo";
      var icon = state === "enabled" ? "✓" : state === "down" ? "⛔" : "○";
      return h(
        "div",
        { className: "hiveCard" },
        h("div", { className: "hiveHead" }, h("span", { className: "hiveTitle" }, "出口控制")),
        h("div", { className: "hiveBanner " + cls }, h("span", null, icon), h("span", null, data.view.message)),
        h(
          "div",
          { className: "hiveStats" },
          stat("状态", state),
          stat("探活", data.healthy ? "通" : "未通", !data.healthy && data.enabled),
          data.profile ? stat("出口", data.profile.url) : stat("出口", "未配置"),
        ),
        data.checked_at ? h("div", { className: "hiveEmpty" }, "最后探活 " + data.checked_at) : null,
      );
    }

    /* ── vdb_search ──────────────────────────────────────────────── */

    function VdbSearchRow(props) {
      var data = parseResult(props.block);
      if (!data || !Array.isArray(data.entries)) return fallback(resultText(props.block), "VDB search");
      var entries = data.entries;
      return h(
        "div",
        { className: "hiveCard" },
        h(
          "div",
          { className: "hiveHead" },
          h("span", { className: "hiveTitle" }, "漏洞知识库"),
          h("span", { className: "hiveTag" }, data.count + " 条命中"),
        ),
        data.note ? h("div", { className: "hiveBanner hiveInfo" }, h("span", null, "ℹ"), h("span", null, data.note)) : null,
        entries.length === 0
          ? h("div", { className: "hiveEmpty" }, "无条目。空库不等于产品干净——用 vdb_build 现场调研。")
          : entries.map(function (e) {
              return h(
                "div",
                { className: "hiveRow", key: e.id },
                h("span", { className: "hiveTag " + e.status }, e.status),
                h("span", { className: "hiveBody" }, e.title),
                h("span", { className: "hiveTag" }, e.vuln_type || "—"),
                h("span", { className: "hiveTag" }, e.severity || "—"),
                h("span", { className: "hiveMono" }, e.fingerprint || ""),
              );
            }),
      );
    }

    /* ── plugin ──────────────────────────────────────────────────── */

    var inject = ["slots"];

    function apply(ctx) {
      var views = [
        ["board_snapshot", BoardSnapshotRow],
        ["egress_status", EgressStatusRow],
        ["vdb_search", VdbSearchRow],
      ];
      ctx.slots.inject("tool.call.toolview", function () {
        return views.map(function (pair) {
          return ctx.slots.register(
            { name: "tool.call.toolview", key: pair[0] },
            pair[1],
          );
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
