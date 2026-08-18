/**
 * @dsh-desktop/session-stats — browser half.
 *
 * Registers a full-width telemetry card in the conversation composer dock.
 * The card is session-scoped (it automatically follows the currently selected
 * session), reads the durable whole-log projections (`sessionStats`,
 * `sessionToolDetail`, `tokenUsage`) and ticks live running wall-time between
 * event frames.
 */
window.__ModuleLoader__.load({
  id: "@dsh-desktop/session-stats",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

    var NS = "dshDesktopSessionStats";
    var zh = {
      "title": "会话统计",
      "status.live": "实时",
      "status.idle": "已就绪",
      "metric.thinking": "模型思考时间",
      "metric.tool": "工具调用时间",
      "metric.ttft": "平均首字延迟",
      "metric.turns": "轮次 / 步数",
      "metric.tokens": "输入 / 输出",
      "ratio.title": "思考与工具时间占比",
      "ds.balance": "DeepSeek 余额",
      "ds.sessionUsage": "本次会话用量",
      "ds.perTurn": "每轮用量",
      "ds.peak": "峰时",
      "ds.valley": "谷时",
      "ds.peakHint": "00:30 – 08:30 为谷时",
      "ds.refresh": "刷新余额",
      "ds.loading": "查询中…",
      "ds.notConfigured": "未配置 DEEPSEEK_API_KEY",
      "ds.fetchFailed": "余额查询失败",
      "ds.input": "输入",
      "ds.output": "输出",
      "ds.cache": "缓存",
      "ratio.thinking": "思考",
      "ratio.tool": "工具",
      "longest.title": "耗时最久的工具调用",
      "longest.duration": "耗时",
      "longest.call": "调用",
      "longest.result": "返回值",
      "longest.expand": "展开全部",
      "longest.collapse": "收起",
      "longest.error": "出错",
      "running.title": "进行中的工具调用",
      "empty": "该会话还没有可统计的活动",
      "tool.calls": "{count} 次调用",
    };
    var en = {
      "title": "Session telemetry",
      "status.live": "LIVE",
      "status.idle": "READY",
      "metric.thinking": "Model thinking",
      "metric.tool": "Tool calls",
      "metric.ttft": "Avg first token",
      "metric.turns": "Turns / steps",
      "metric.tokens": "Input / output",
      "ratio.title": "Thinking vs tool time",
      "ds.balance": "DeepSeek balance",
      "ds.sessionUsage": "Session usage",
      "ds.perTurn": "Per-turn usage",
      "ds.peak": "Peak",
      "ds.valley": "Off-peak",
      "ds.peakHint": "00:30 – 08:30 is off-peak",
      "ds.refresh": "Refresh balance",
      "ds.loading": "Fetching…",
      "ds.notConfigured": "DEEPSEEK_API_KEY not set",
      "ds.fetchFailed": "Balance fetch failed",
      "ds.input": "In",
      "ds.output": "Out",
      "ds.cache": "Cache",
      "ratio.thinking": "Thinking",
      "ratio.tool": "Tools",
      "longest.title": "Longest tool call",
      "longest.duration": "Duration",
      "longest.call": "Call",
      "longest.result": "Return value",
      "longest.expand": "Expand",
      "longest.collapse": "Collapse",
      "longest.error": "Error",
      "running.title": "Running tools",
      "empty": "No measurable activity in this session yet",
      "tool.calls": "{count} calls",
    };

    var CSS = `
      #dsh-session-stats-panel {
        --dssp-violet: #a99bff;
        --dssp-cyan: #55c8f8;
        --dssp-green: #35d9a3;
        --dssp-pink: #ff7ac8;
        --dssp-track: rgba(255, 255, 255, 0.07);
        width: 100%;
        max-width: var(--dsh-chat-content-width, 780px);
        box-sizing: border-box;
        margin: 2px auto 0;
        padding: 12px 14px 13px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.08));
        border-radius: 15px;
        background:
          linear-gradient(180deg, var(--dsw-alias-bg-layer-2, rgba(17,20,32,.62)), var(--dsw-alias-bg-layer-1, rgba(10,12,20,.52)));
        box-shadow:
          0 14px 44px rgba(0,0,0,.22),
          inset 0 1px 0 rgba(255,255,255,.055);
        backdrop-filter: blur(18px) saturate(145%);
        -webkit-backdrop-filter: blur(18px) saturate(145%);
        font-family: var(--dsh-font, "Segoe UI", system-ui, sans-serif);
        user-select: none;
        transition: border-color .2s ease, box-shadow .2s ease;
      }
      body:not([data-ds-dark-theme]) #dsh-session-stats-panel {
        --dssp-violet: #6b57e8;
        --dssp-cyan: #0d92dc;
        --dssp-green: #0b9b6c;
        --dssp-pink: #d13b93;
        --dssp-track: rgba(15, 17, 25, 0.08);
        border-color: rgba(15,17,25,.09);
        box-shadow:
          0 12px 34px rgba(15,17,25,.10),
          inset 0 1px 0 rgba(255,255,255,.65);
      }
      #dsh-session-stats-panel * { box-sizing: border-box; }
      #dsh-session-stats-panel .dssp-head {
        display: flex; align-items: center; justify-content: space-between;
        gap: 10px; margin-bottom: 10px;
        cursor: pointer; user-select: none;
      }
      #dsh-session-stats-panel .dssp-head-actions {
        display: inline-flex; align-items: center; gap: 8px;
      }
      #dsh-session-stats-panel .dssp-chevron {
        display: grid; place-items: center; flex: none;
        color: var(--dsw-alias-label-tertiary, rgb(124,131,166));
        transition: transform .28s cubic-bezier(.22,1,.36,1);
      }
      #dsh-session-stats-panel .dssp-chevron.open { transform: rotate(180deg); }
      #dsh-session-stats-panel .dssp-summary {
        display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px;
        margin-top: 2px; padding: 8px 10px;
        border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.06));
        border-radius: 11px; background: var(--dsw-alias-bg-layer-1, rgba(12,14,23,.4));
        color: var(--dsw-alias-label-secondary, rgb(165,170,198));
        font-size: 10.5px; line-height: 1.6; font-variant-numeric: tabular-nums;
      }
      #dsh-session-stats-panel .dssp-summary span { display: inline-flex; align-items: center; gap: 5px; }
      #dsh-session-stats-panel .dssp-summary i { width: 6px; height: 6px; border-radius: 50%; flex: none; }
      #dsh-session-stats-panel .dssp-summary .sum-think i { background: var(--dssp-violet); }
      #dsh-session-stats-panel .dssp-summary .sum-tool i { background: var(--dssp-cyan); }
      #dsh-session-stats-panel .dssp-summary .sum-dim { color: var(--dsw-alias-label-tertiary, rgb(124,131,166)); }
      #dsh-session-stats-panel .dssp-title {
        display: inline-flex; align-items: center; gap: 7px;
        color: var(--dsw-alias-label-primary, rgb(241,240,250));
        font-size: 11px; font-weight: 650; letter-spacing: .16em; text-transform: uppercase;
      }
      #dsh-session-stats-panel .dssp-title svg { color: var(--dssp-violet); flex: none; }
      #dsh-session-stats-panel .dssp-session {
        max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-weight: 500; letter-spacing: 0; text-transform: none;
        color: var(--dsw-alias-label-secondary, rgb(165,170,198));
      }
      #dsh-session-stats-panel .dssp-status {
        display: inline-flex; align-items: center; gap: 6px;
        color: var(--dsw-alias-label-tertiary, rgb(124,131,166));
        font-size: 10px; font-weight: 600; letter-spacing: .14em;
      }
      #dsh-session-stats-panel .dssp-dot {
        width: 6px; height: 6px; border-radius: 50%; flex: none;
        background: var(--dssp-green); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dssp-green) 18%, transparent);
      }
      #dsh-session-stats-panel .dssp-dot.live {
        background: var(--dssp-cyan); animation: dssp-pulse 1.4s ease-out infinite;
      }
      @keyframes dssp-pulse {
        0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--dssp-cyan) 48%, transparent); }
        70% { box-shadow: 0 0 0 6px transparent; }
        100% { box-shadow: 0 0 0 0 transparent; }
      }
      #dsh-session-stats-panel .dssp-grid {
        display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px;
      }
      #dsh-session-stats-panel .dssp-metric {
        min-width: 0; padding: 9px 10px 8px;
        border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.06));
        border-radius: 11px;
        background: var(--dsw-alias-bg-layer-1, rgba(12,14,23,.4));
      }
      #dsh-session-stats-panel .dssp-metric-label {
        color: var(--dsw-alias-label-tertiary, rgb(124,131,166));
        font-size: 10px; line-height: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      #dsh-session-stats-panel .dssp-value {
        margin-top: 2px; color: var(--dsw-alias-label-primary, rgb(241,240,250));
        font-family: var(--dsh-font-mono, "Cascadia Code", Consolas, monospace);
        font-size: 14px; font-weight: 650; line-height: 20px; font-variant-numeric: tabular-nums;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      #dsh-session-stats-panel .dssp-value.think { color: var(--dssp-violet); }
      #dsh-session-stats-panel .dssp-value.tool { color: var(--dssp-cyan); }
      #dsh-session-stats-panel .dssp-sub {
        margin-top: 1px; color: var(--dsw-alias-label-tertiary, rgb(124,131,166));
        font-size: 9.5px; line-height: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        font-variant-numeric: tabular-nums;
      }
      #dsh-session-stats-panel .dssp-ratio {
        margin-top: 10px; padding: 9px 10px 8px;
        border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.06));
        border-radius: 11px; background: var(--dsw-alias-bg-layer-1, rgba(12,14,23,.4));
      }
      #dsh-session-stats-panel .dssp-ratio-label {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        color: var(--dsw-alias-label-tertiary, rgb(124,131,166));
        font-size: 10px; letter-spacing: .02em; margin-bottom: 7px;
      }
      #dsh-session-stats-panel .dssp-legend { display: flex; align-items: center; gap: 12px; font-size: 10px; }
      #dsh-session-stats-panel .dssp-legend span { display: inline-flex; align-items: center; gap: 5px; }
      #dsh-session-stats-panel .dssp-legend i { width: 7px; height: 7px; border-radius: 50%; flex: none; }
      #dsh-session-stats-panel .dssp-legend .think i { background: var(--dssp-violet); }
      #dsh-session-stats-panel .dssp-legend .tool i { background: var(--dssp-cyan); }
      #dsh-session-stats-panel .dssp-track {
        display: flex; height: 7px; border-radius: 999px; overflow: hidden; background: var(--dssp-track);
      }
      #dsh-session-stats-panel .dssp-fill {
        height: 100%; width: 0; transition: width .45s cubic-bezier(.22,1,.36,1);
      }
      #dsh-session-stats-panel .dssp-fill.think {
        background: linear-gradient(90deg, var(--dssp-violet), var(--dssp-pink));
        border-radius: 999px 0 0 999px;
      }
      #dsh-session-stats-panel .dssp-fill.tool {
        background: linear-gradient(90deg, var(--dssp-cyan), var(--dssp-green));
        border-radius: 0 999px 999px 0;
      }
      #dsh-session-stats-panel .dssp-longest {
        margin-top: 9px; border-top: 1px solid var(--dsw-alias-separator-primary, rgba(255,255,255,.07));
        padding-top: 9px;
      }
      #dsh-session-stats-panel .dssp-longest-head {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        color: var(--dsw-alias-label-secondary, rgb(165,170,198));
        font-size: 10.5px; font-weight: 620; margin-bottom: 6px;
      }
      #dsh-session-stats-panel .dssp-longest-head b {
        color: var(--dssp-cyan); font-family: var(--dsh-font-mono, Consolas, monospace);
        font-weight: 650; font-variant-numeric: tabular-nums; white-space: nowrap;
      }
      #dsh-session-stats-panel .dssp-code {
        position: relative; margin: 0 0 6px; padding: 7px 9px;
        border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.06));
        border-radius: 9px; background: var(--dsw-alias-bg-base, rgba(5,6,11,.4));
        color: var(--dsw-alias-label-secondary, rgb(165,170,198));
        font-family: var(--dsh-font-mono, "Cascadia Code", Consolas, monospace);
        font-size: 10.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word;
        overflow: auto; max-height: 92px; user-select: text;
      }
      #dsh-session-stats-panel .dssp-code.expanded { max-height: 320px; }
      #dsh-session-stats-panel .dssp-code-kicker {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        color: var(--dsw-alias-label-tertiary, rgb(124,131,166));
        font-size: 9.5px; font-weight: 620; letter-spacing: .1em; text-transform: uppercase; margin: 7px 0 3px;
      }
      #dsh-session-stats-panel .dssp-toggle {
        border: 0; background: transparent; padding: 0; cursor: pointer;
        color: var(--dssp-cyan); font: inherit; font-size: 9.5px; letter-spacing: .04em;
      }
      #dsh-session-stats-panel .dssp-toggle:hover { color: var(--dssp-violet); }
      #dsh-session-stats-panel .dssp-running {
        margin-top: 8px; display: flex; flex-wrap: wrap; gap: 5px;
      }
      #dsh-session-stats-panel .dssp-running-chip {
        max-width: 100%; display: inline-flex; align-items: center; gap: 6px;
        padding: 4px 8px; border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--dssp-cyan) 30%, transparent);
        background: color-mix(in srgb, var(--dssp-cyan) 9%, transparent);
        color: var(--dsw-alias-label-secondary, rgb(165,170,198));
        font-family: var(--dsh-font-mono, Consolas, monospace); font-size: 10px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      #dsh-session-stats-panel .dssp-running-chip i {
        width: 5px; height: 5px; border-radius: 50%; background: var(--dssp-cyan); flex: none;
        animation: dssp-pulse 1.4s ease-out infinite;
      }
      #dsh-session-stats-panel .dssp-deepseek {
        margin-top: 9px; border-top: 1px solid var(--dsw-alias-separator-primary, rgba(255,255,255,.07));
        padding-top: 9px;
      }
      #dsh-session-stats-panel .dssp-ds-head {
        display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px 10px;
        margin-bottom: 7px;
      }
      #dsh-session-stats-panel .dssp-ds-title {
        display: inline-flex; align-items: center; gap: 6px;
        color: var(--dsw-alias-label-secondary, rgb(165,170,198));
        font-size: 10.5px; font-weight: 620;
      }
      #dsh-session-stats-panel .dssp-ds-title svg { color: var(--dssp-violet); }
      #dsh-session-stats-panel .dssp-peak {
        display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px;
        font-size: 9.5px; font-weight: 620; letter-spacing: .04em;
        border: 1px solid color-mix(in srgb, var(--dssp-pink) 38%, transparent);
        background: color-mix(in srgb, var(--dssp-pink) 10%, transparent);
        color: color-mix(in srgb, var(--dssp-pink) 85%, #fff);
      }
      #dsh-session-stats-panel .dssp-peak.valley {
        border-color: color-mix(in srgb, var(--dssp-green) 40%, transparent);
        background: color-mix(in srgb, var(--dssp-green) 10%, transparent);
        color: color-mix(in srgb, var(--dssp-green) 80%, #fff);
      }
      #dsh-session-stats-panel .dssp-balance {
        display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px;
        padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.06));
        border-radius: 10px; background: var(--dsw-alias-bg-layer-1, rgba(12,14,23,.4));
        font-variant-numeric: tabular-nums;
      }
      #dsh-session-stats-panel .dssp-balance-amount {
        font-family: var(--dsh-font-mono, "Cascadia Code", Consolas, monospace);
        font-size: 15px; font-weight: 700; color: var(--dssp-green);
      }
      #dsh-session-stats-panel .dssp-balance-meta {
        color: var(--dsw-alias-label-tertiary, rgb(124,131,166)); font-size: 9.5px;
      }
      #dsh-session-stats-panel .dssp-balance-state {
        color: var(--dsw-alias-label-secondary, rgb(165,170,198)); font-size: 10.5px;
        display: inline-flex; align-items: center; gap: 6px;
      }
      #dsh-session-stats-panel .dssp-refresh {
        border: 0; background: transparent; padding: 0; cursor: pointer;
        color: var(--dsw-alias-label-tertiary, rgb(124,131,166));
        display: inline-flex; align-items: center; gap: 4px; font: inherit; font-size: 9.5px; letter-spacing: .04em;
      }
      #dsh-session-stats-panel .dssp-refresh:hover { color: var(--dssp-cyan); }
      #dsh-session-stats-panel .dssp-refresh.spinning svg { animation: dssp-pulse 1s linear infinite; }
      #dsh-session-stats-panel .dssp-usage-row {
        display: flex; flex-wrap: wrap; gap: 6px 14px; padding: 7px 10px; margin-bottom: 7px;
        border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.06));
        border-radius: 10px; background: var(--dsw-alias-bg-layer-1, rgba(12,14,23,.4));
        color: var(--dsw-alias-label-secondary, rgb(165,170,198)); font-size: 10px;
        font-variant-numeric: tabular-nums;
      }
      #dsh-session-stats-panel .dssp-usage-row span { display: inline-flex; align-items: center; gap: 4px; }
      #dsh-session-stats-panel .dssp-usage-row i { width: 6px; height: 6px; border-radius: 50%; flex: none; }
      #dsh-session-stats-panel .dssp-turn-list {
        display: flex; flex-direction: column; gap: 3px; max-height: 120px; overflow: auto;
        padding-right: 3px;
      }
      #dsh-session-stats-panel .dssp-turn {
        display: flex; align-items: center; gap: 8px;
        padding: 5px 8px; border-radius: 8px;
        background: var(--dsw-alias-bg-base, rgba(5,6,11,.35));
        color: var(--dsw-alias-label-secondary, rgb(165,170,198));
        font-family: var(--dsh-font-mono, Consolas, monospace); font-size: 9.5px;
        font-variant-numeric: tabular-nums;
      }
      #dsh-session-stats-panel .dssp-turn b { color: var(--dsw-alias-label-primary, rgb(241,240,250)); font-weight: 650; }
      #dsh-session-stats-panel .dssp-turn .spacer { flex: 1; }
      #dsh-session-stats-panel .dssp-turn .total { color: var(--dssp-cyan); }
      #dsh-session-stats-panel .dssp-turn-empty { color: var(--dsw-alias-label-tertiary, rgb(124,131,166)); font-size: 10px; padding: 2px 0; }
      #dsh-session-stats-panel .dssp-empty {
        color: var(--dsw-alias-label-tertiary, rgb(124,131,166));
        font-size: 10.5px; text-align: center; padding: 8px 0 2px;
      }
      @media (max-width: 920px) {
        #dsh-session-stats-panel .dssp-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
    `;

    function injectCss() {
      if (document.getElementById("dsh-session-stats-css")) return;
      var style = document.createElement("style");
      style.id = "dsh-session-stats-css";
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    function num(value, fallback) {
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
    }

    function formatMs(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return "0s";
      if (ms < 1000) return Math.round(ms) + "ms";
      var seconds = ms / 1000;
      if (seconds < 60) return (Math.round(seconds * 10) / 10).toFixed(1).replace(/\.0$/, "") + "s";
      var whole = Math.round(seconds);
      var minutes = Math.floor(whole / 60);
      var rest = whole % 60;
      if (minutes < 60) return minutes + "m " + String(rest).padStart(2, "0") + "s";
      var hours = Math.floor(minutes / 60);
      return hours + "h " + String(minutes % 60).padStart(2, "0") + "m";
    }

    function formatTokens(value) {
      if (!Number.isFinite(value) || value < 0) return "0";
      if (value < 1000) return String(Math.round(value));
      if (value < 1000000) {
        var scaled = value / 1000;
        return (scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10) + "K";
      }
      var millions = value / 1000000;
      return (millions >= 100 ? Math.round(millions) : Math.round(millions * 10) / 10) + "M";
    }

    function throughput(tokens, ms) {
      if (!Number.isFinite(tokens) || !Number.isFinite(ms) || tokens <= 0 || ms <= 0) return null;
      return tokens / (ms / 1000);
    }

    function peakPeriod(ms) {
      var date = ms === undefined ? new Date() : new Date(ms);
      var minutes = date.getHours() * 60 + date.getMinutes();
      return minutes >= 30 && minutes < 510
        ? { kind: "valley", key: "ds.valley" }
        : { kind: "peak", key: "ds.peak" };
    }

    function formatBalanceTotal(value) {
      var n = Number(value);
      return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : String(value ?? "—");
    }

    function textOfContent(content) {
      if (Array.isArray(content)) {
        var parts = content
          .map(function (block) {
            if (block && typeof block === "object" && typeof block.text === "string") return block.text;
            if (typeof block === "string") return block;
            if (block && block.type === "tool-result") return textOfContent(block.content);
            return block === null || block === undefined ? "" : JSON.stringify(block);
          })
          .filter(function (part) {
            return part !== "";
          });
        return parts.join("\n").trim() || JSON.stringify(content);
      }
      if (typeof content === "string") return content;
      if (content && typeof content === "object" && typeof content.text === "string") return content.text;
      return content === null || content === undefined ? "" : JSON.stringify(content);
    }

    function fallbackStats(nodes) {
      var turns = {};
      var steps = 0;
      var llmMs = 0;
      var toolMs = 0;
      var ttftMs = 0;
      var ttftSteps = 0;
      var decodeMs = 0;
      var decodeTokens = 0;
      var toolCalls = 0;
      var toolResults = 0;
      var longest = null;
      for (var i = 0; i < nodes.length; i += 1) {
        var node = nodes[i];
        if (!node) continue;
        if (node.kind === "tool-result") {
          toolResults += 1;
          if (node.callTime !== null && node.callTime !== undefined) {
            var duration = Math.max(0, node.time - node.callTime);
            toolMs += duration;
            if (longest === null || duration > longest.durationMs) {
              longest = {
                callId: node.callId || "",
                name: node.call ? node.call.name : "tool",
                arguments: node.call ? node.call.argsRaw || "" : "",
                argumentsTruncated: false,
                durationMs: duration,
                startedAt: node.callTime,
                completedAt: node.time,
                turn: node.turn || 0,
                step: node.step || 0,
                returnValue: textOfContent(node.content),
                returnValueTruncated: false,
                isError: node.isError === true,
              };
            }
          }
          continue;
        }
        if (node.kind !== "assistant") continue;
        turns[node.turn] = true;
        steps += 1;
        if (node.timing && node.timing.stepStartTime !== null && node.timing.stepStartTime !== undefined) {
          llmMs += Math.max(0, node.timing.completedTime - node.timing.stepStartTime);
        }
        if (node.timing && node.timing.stepStartTime !== null && node.timing.firstTokenTime !== null) {
          ttftMs += Math.max(0, node.timing.firstTokenTime - node.timing.stepStartTime);
          ttftSteps += 1;
        }
        if (
          node.timing &&
          node.timing.firstTokenTime !== null &&
          node.usage &&
          typeof node.usage.outputTokens === "number"
        ) {
          decodeMs += Math.max(0, node.timing.completedTime - node.timing.firstTokenTime);
          decodeTokens += node.usage.outputTokens;
        }
      }
      return {
        turns: Object.keys(turns).length,
        steps: steps,
        llmMs: llmMs,
        toolMs: toolMs,
        ttftMs: ttftMs,
        ttftSteps: ttftSteps,
        decodeMs: decodeMs,
        decodeTokens: decodeTokens,
        toolCalls: toolCalls,
        toolResults: toolResults,
        longest: longest,
      };
    }

    function liveRunningCalls(runningCalls) {
      return (runningCalls || []).map(function (call) {
        return {
          callId: call.callId,
          name: call.name || "tool",
          arguments: call.argsRaw || "",
          argumentsTruncated: false,
          startedAt: typeof call.time === "number" ? call.time : Date.now(),
          turn: call.turn || 0,
          step: call.step || 0,
        };
      });
    }

    function SessionStatsPanel(props) {
      var useSession = props.useSession;
      var useProjection = props.useProjection;
      var t = props.t || function (key) { return en[key] || key; };

      var session = useSession(function (s) { return s; });
      var nodes = session.nodes || [];
      var running = session.running === true;
      var sessionRunningCalls = session.runningCalls || [];
      var projectedStats = useProjection("sessionStats");
      var toolDetail = useProjection("sessionToolDetail");
      var usage = useProjection("tokenUsage");
      var title = useProjection("title");
      var turnUsage = useProjection("sessionTurnUsage");

      var balanceState = React.useState(null);
      var balance = balanceState[0];
      var setBalance = balanceState[1];
      var balanceErrorState = React.useState(null);
      var balanceError = balanceErrorState[0];
      var setBalanceError = balanceErrorState[1];
      var balanceLoadingState = React.useState(false);
      var balanceLoading = balanceLoadingState[0];
      var setBalanceLoading = balanceLoadingState[1];

      var fetchBalance = function () {
        if (balanceLoading) return;
        setBalanceLoading(true);
        setBalanceError(null);
        fetch("/dsh-desktop/deepseek-balance", { cache: "no-store" })
          .then(function (response) {
            return response.json().catch(function () { return null; });
          })
          .then(function (payload) {
            if (payload && payload.ok === true && payload.balance) {
              setBalance(payload.balance);
            } else {
              setBalance(null);
              setBalanceError(payload ? (payload.error || "fetch-failed") : "fetch-failed");
            }
          })
          .catch(function (error) {
            setBalance(null);
            setBalanceError(String(error && error.message || "fetch-failed"));
          })
          .finally(function () {
            setBalanceLoading(false);
          });
      };

      React.useEffect(function () {
        fetchBalance();
        var timer = setInterval(fetchBalance, 30000);
        return function () { clearInterval(timer); };
      }, []);

      var fallback = React.useMemo(function () { return fallbackStats(nodes); }, [nodes]);
      var liveCalls = React.useMemo(function () {
        var projected = toolDetail && Array.isArray(toolDetail.runningCalls) ? toolDetail.runningCalls.slice() : [];
        var seen = {};
        for (var i = 0; i < projected.length; i += 1) seen[projected[i].callId] = true;
        var fallbackCalls = liveRunningCalls(sessionRunningCalls);
        for (var j = 0; j < fallbackCalls.length; j += 1) {
          if (seen[fallbackCalls[j].callId] !== true) projected.push(fallbackCalls[j]);
        }
        return projected;
      }, [toolDetail, sessionRunningCalls]);
      var openStep = toolDetail && toolDetail.openStep ? toolDetail.openStep : null;
      var hasLive = running || liveCalls.length > 0 || openStep !== null;

      var nowRef = React.useState(function () { return Date.now(); });
      var now = nowRef[0];
      var setNow = nowRef[1];
      var peak = peakPeriod(now);
      React.useEffect(function () {
        if (!hasLive) return undefined;
        var timer = setInterval(function () { setNow(Date.now()); }, 1000);
        return function () { clearInterval(timer); };
      }, [hasLive]);

      var completedLlmMs = num(projectedStats && projectedStats.llmMs, fallback.llmMs);
      var completedToolMs = num(projectedStats && projectedStats.toolMs, fallback.toolMs);
      var liveLlmMs = openStep === null ? 0 : Math.max(0, now - openStep.startedAt);
      var liveToolMs = liveCalls.reduce(function (sum, call) {
        return sum + Math.max(0, now - call.startedAt);
      }, 0);
      var llmMs = completedLlmMs + liveLlmMs;
      var toolMs = completedToolMs + liveToolMs;
      var denominator = llmMs + toolMs;
      var thinkingPercent = denominator <= 0 ? 0 : Math.round(llmMs / denominator * 1000) / 10;
      var toolPercent = denominator <= 0 ? 0 : Math.max(0, 100 - thinkingPercent);

      var steps = num(projectedStats && projectedStats.steps, fallback.steps);
      var turns = num(projectedStats && projectedStats.turns, fallback.turns);
      var ttftSteps = num(projectedStats && projectedStats.ttftSteps, fallback.ttftSteps);
      var ttftMs = num(projectedStats && projectedStats.ttftMs, fallback.ttftMs);
      var decodeMs = num(projectedStats && projectedStats.decodeMs, fallback.decodeMs);
      var decodeTokens = num(projectedStats && projectedStats.decodeTokens, fallback.decodeTokens);
      var tokenInput = usage
        ? num(usage.uncachedInputTokens, 0) + num(usage.cacheReadTokens, 0) + num(usage.cacheWriteTokens, 0)
        : null;
      var tokenOutput = usage ? num(usage.outputTokens, 0) : null;
      var tokenCache = usage ? num(usage.cacheReadTokens, 0) + num(usage.cacheWriteTokens, 0) : null;
      var tokenSpeed = throughput(decodeTokens, decodeMs);

      var projectedLongest = toolDetail && toolDetail.longestToolCall ? toolDetail.longestToolCall : null;
      var longest = projectedLongest || fallback.longest;
      var totalToolCalls = num(toolDetail && toolDetail.toolCalls, fallback.toolResults);
      var turnList = turnUsage && Array.isArray(turnUsage.turns) ? turnUsage.turns : [];
      var recentTurns = turnList.slice(-6);

      var argsExpanded = React.useState(false);
      var resultExpanded = React.useState(false);
      var showArgs = argsExpanded[0];
      var setShowArgs = argsExpanded[1];
      var showResult = resultExpanded[0];
      var setShowResult = resultExpanded[1];

      var expandedState = React.useState(false);
      var expanded = expandedState[0];
      var setExpanded = expandedState[1];
      var toggleExpanded = function () { setExpanded(function (v) { return !v; }); };
      var onHeaderKeyDown = function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleExpanded();
        }
      };

      var empty = steps === 0 && totalToolCalls === 0 && liveCalls.length === 0 && liveLlmMs === 0;
      var longestArgs = longest ? longest.arguments || "" : "";
      var longestReturn = longest ? longest.returnValue || "" : "";
      var showArgsToggle = longestArgs.length > 260 || longest && longest.argumentsTruncated;
      var showResultToggle = longestReturn.length > 300 || longest && longest.returnValueTruncated;

      return React.createElement(
        "section",
        { id: "dsh-session-stats-panel", "aria-label": t("title") },
        React.createElement(
          "header",
          {
            className: "dssp-head",
            role: "button",
            tabIndex: 0,
            "aria-expanded": expanded,
            onClick: toggleExpanded,
            onKeyDown: onHeaderKeyDown,
          },
          React.createElement(
            "span",
            { className: "dssp-title" },
            React.createElement("span", {
              dangerouslySetInnerHTML: {
                __html:
                  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3"/><path d="m5.6 5.6 2.1 2.1"/><path d="M3 12h3"/><path d="m5.6 18.4 2.1-2.1"/><path d="M12 21v-3"/><path d="m16.3 16.3 2.1 2.1"/><path d="M21 12h-3"/><path d="m16.3 7.7 2.1-2.1"/><path d="M12 8.5 14 11h-4Z"/></svg>',
              },
            }),
            t("title"),
            title ? React.createElement("span", { className: "dssp-session", title: String(title) }, "· " + title) : null,
          ),
          React.createElement(
            "span",
            { className: "dssp-head-actions" },
            React.createElement(
              "span",
              { className: "dssp-status" },
              React.createElement("i", { className: "dssp-dot" + (hasLive ? " live" : "") }),
              t(hasLive ? "status.live" : "status.idle"),
            ),
            React.createElement(
              "span",
              { className: "dssp-chevron" + (expanded ? " open" : "") },
              React.createElement("span", {
                dangerouslySetInnerHTML: {
                  __html:
                    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
                },
              }),
            ),
          ),
        ),
        !expanded
          ? React.createElement(
              "div",
              { className: "dssp-summary" },
              React.createElement("span", { className: "sum-think" }, React.createElement("i", null), t("ratio.thinking"), " ", formatMs(llmMs)),
              React.createElement("span", { className: "sum-tool" }, React.createElement("i", null), t("ratio.tool"), " ", formatMs(toolMs)),
              React.createElement("span", { className: "sum-dim" }, turns + " / " + steps, " · ", t("tool.calls", { count: totalToolCalls })),
            )
          : empty
            ? React.createElement("div", { className: "dssp-empty" }, t("empty"))
            : React.createElement(
                React.Fragment,
                null,
              React.createElement(
                "div",
                { className: "dssp-grid" },
                React.createElement(
                  "div",
                  { className: "dssp-metric" },
                  React.createElement("div", { className: "dssp-metric-label" }, t("metric.thinking")),
                  React.createElement("div", { className: "dssp-value think" }, formatMs(llmMs)),
                  React.createElement("div", { className: "dssp-sub" }, liveLlmMs > 0 ? "live +" + formatMs(liveLlmMs) : formatMs(completedLlmMs) + " done"),
                ),
                React.createElement(
                  "div",
                  { className: "dssp-metric" },
                  React.createElement("div", { className: "dssp-metric-label" }, t("metric.tool")),
                  React.createElement("div", { className: "dssp-value tool" }, formatMs(toolMs)),
                  React.createElement(
                    "div",
                    { className: "dssp-sub" },
                    t("tool.calls", { count: totalToolCalls }),
                  ),
                ),
                React.createElement(
                  "div",
                  { className: "dssp-metric" },
                  React.createElement("div", { className: "dssp-metric-label" }, t("metric.turns")),
                  React.createElement("div", { className: "dssp-value" }, turns + " / " + steps),
                  React.createElement("div", { className: "dssp-sub" }, ttftSteps > 0 ? t("metric.ttft") + " " + formatMs(ttftMs / ttftSteps) : "—"),
                ),
                React.createElement(
                  "div",
                  { className: "dssp-metric" },
                  React.createElement("div", { className: "dssp-metric-label" }, t("metric.tokens")),
                  React.createElement("div", { className: "dssp-value" }, (tokenInput === null ? "—" : formatTokens(tokenInput)) + " / " + (tokenOutput === null ? "—" : formatTokens(tokenOutput))),
                  React.createElement("div", { className: "dssp-sub" }, tokenSpeed === null ? "—" : tokenSpeed.toFixed(1) + " tok/s"),
                ),
              ),
              React.createElement(
                "div",
                { className: "dssp-ratio" },
                React.createElement(
                  "div",
                  { className: "dssp-ratio-label" },
                  React.createElement("span", null, t("ratio.title")),
                  React.createElement(
                    "span",
                    { className: "dssp-legend" },
                    React.createElement("span", { className: "think" }, React.createElement("i", null), t("ratio.thinking"), " ", thinkingPercent.toFixed(1) + "%"),
                    React.createElement("span", { className: "tool" }, React.createElement("i", null), t("ratio.tool"), " ", toolPercent.toFixed(1) + "%"),
                  ),
                ),
                React.createElement(
                  "div",
                  { className: "dssp-track" },
                  React.createElement("div", { className: "dssp-fill think", style: { width: thinkingPercent + "%" } }),
                  React.createElement("div", { className: "dssp-fill tool", style: { width: toolPercent + "%" } }),
                ),
              ),
              longest
                ? React.createElement(
                    "div",
                    { className: "dssp-longest" },
                    React.createElement(
                      "div",
                      { className: "dssp-longest-head" },
                      React.createElement("span", null, t("longest.title") + " · " + longest.name),
                      React.createElement("b", null, t("longest.duration") + " " + formatMs(longest.durationMs)),
                    ),
                    React.createElement("div", { className: "dssp-code-kicker" }, React.createElement("span", null, t("longest.call")), showArgsToggle ? React.createElement("button", { type: "button", className: "dssp-toggle", onClick: function () { setShowArgs(function (v) { return !v; }); } }, showArgs ? t("longest.collapse") : t("longest.expand")) : null),
                    React.createElement("pre", { className: "dssp-code" + (showArgs ? " expanded" : "") }, longestArgs || "—"),
                    React.createElement("div", { className: "dssp-code-kicker" }, React.createElement("span", null, t("longest.result") + (longest.isError ? " · " + t("longest.error") : "")), showResultToggle ? React.createElement("button", { type: "button", className: "dssp-toggle", onClick: function () { setShowResult(function (v) { return !v; }); } }, showResult ? t("longest.collapse") : t("longest.expand")) : null),
                    React.createElement("pre", { className: "dssp-code" + (showResult ? " expanded" : "") }, longestReturn || "—"),
                  )
                : null,
              liveCalls.length > 0
                ? React.createElement(
                    "div",
                    { className: "dssp-running" },
                    liveCalls.map(function (call) {
                      return React.createElement(
                        "span",
                        { className: "dssp-running-chip", key: call.callId, title: call.arguments },
                        React.createElement("i", null),
                        call.name + " · " + formatMs(Math.max(0, now - call.startedAt)),
                      );
                    }),
                  )
                : null,
              React.createElement(
                "div",
                { className: "dssp-deepseek" },
                React.createElement(
                  "div",
                  { className: "dssp-ds-head" },
                  React.createElement(
                    "span",
                    { className: "dssp-ds-title" },
                    React.createElement("span", {
                      dangerouslySetInnerHTML: {
                        __html:
                          '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12V8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v4"/><path d="M2 20h20"/><path d="M4 12h4v3a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-3h4a1 1 0 0 1 1 1v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a1 1 0 0 1 1-1Z"/></svg>',
                      },
                    }),
                    t("ds.balance"),
                  ),
                  React.createElement("span", { className: "dssp-peak " + peak.kind, title: t("ds.peakHint") }, t(peak.key)),
                  React.createElement(
                    "button",
                    { type: "button", className: "dssp-refresh" + (balanceLoading ? " spinning" : ""), onClick: fetchBalance },
                    t(balanceLoading ? "ds.loading" : "ds.refresh"),
                  ),
                ),
                React.createElement(
                  "div",
                  { className: "dssp-balance" },
                  balance
                    ? React.createElement(
                        React.Fragment,
                        null,
                        React.createElement("span", { className: "dssp-balance-amount" }, balance.currency + " " + formatBalanceTotal(balance.total)),
                        React.createElement("span", { className: "dssp-balance-meta" }, "TOP-UP " + formatBalanceTotal(balance.toppedUp) + " · GRANT " + formatBalanceTotal(balance.granted)),
                      )
                    : balanceLoading
                      ? React.createElement("span", { className: "dssp-balance-state" }, t("ds.loading"))
                      : React.createElement("span", { className: "dssp-balance-state" }, t(balanceError === "missing-credential" ? "ds.notConfigured" : "ds.fetchFailed")),
                ),
                React.createElement("div", { className: "dssp-code-kicker" }, React.createElement("span", null, t("ds.sessionUsage")), null),
                React.createElement(
                  "div",
                  { className: "dssp-usage-row" },
                  React.createElement("span", null, t("ds.input"), " ", formatTokens(tokenInput === null ? 0 : tokenInput)),
                  React.createElement("span", null, t("ds.output"), " ", formatTokens(tokenOutput === null ? 0 : tokenOutput)),
                  React.createElement("span", null, t("ds.cache"), " ", formatTokens(tokenCache === null ? 0 : tokenCache)),
                  React.createElement("span", null, "∑ ", turns, " / ", steps),
                ),
                React.createElement("div", { className: "dssp-code-kicker" }, React.createElement("span", null, t("ds.perTurn")), null),
                recentTurns.length > 0
                  ? React.createElement(
                      "div",
                      { className: "dssp-turn-list" },
                      recentTurns.map(function (entry) {
                        return React.createElement(
                          "div",
                          { className: "dssp-turn", key: String(entry.turn) },
                          React.createElement("b", null, "#" + entry.turn),
                          React.createElement("span", null, t("ds.input"), " ", formatTokens(entry.inputTokens)),
                          React.createElement("span", null, t("ds.output"), " ", formatTokens(entry.outputTokens)),
                          React.createElement("span", null, t("ds.cache"), " ", formatTokens(entry.cacheReadTokens + entry.cacheWriteTokens)),
                          React.createElement("span", { className: "spacer" }),
                          React.createElement("span", { className: "total" }, formatTokens(entry.totalTokens)),
                        );
                      }),
                    )
                  : React.createElement("div", { className: "dssp-turn-empty" }, "—"),
              ),
            ),
      );
    }

    function apply(ctx) {
      injectCss();
      ctx.effect(function () {
        ctx.locale.register(NS, { zh: zh, en: en });
      }, "dsh-desktop-session-stats: dictionaries");
      var t = ctx.locale.bind(NS);
      ctx.slots.inject("conversation.composer.dock", function () {
        return ctx.slots.register(
          {
            name: "conversation.composer.dock",
            id: "dsh-desktop-session-stats",
            order: 100,
            locale: NS,
          },
          function (props) {
            return React.createElement(SessionStatsPanel, { useSession: props.useSession, useProjection: props.useProjection, t: t });
          },
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    exports.name = "dsh-desktop-session-stats";
    return module.exports;
  },
});
