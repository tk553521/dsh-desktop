/**
 * DSH Desktop skin runtime — injected at document creation.
 * Expects `FONTS` ({name: base64Woff2}) and `SKIN_CSS` (string) from the build.
 * (function body; see scripts/build-skin.mjs)
 */

// ---- guard: only the harness UI document --------------------------------
if (!/^(http|https):$/.test(location.protocol)) return;
if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost") return;

const reducedMotion =
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---- fonts + css, injected before first paint ---------------------------
(function injectBase() {
  if (document.getElementById("dsh-skin-css")) return;
  const style = document.createElement("style");
  style.id = "dsh-skin-css";
  let fontFaces = "";
  for (const [name, b64] of Object.entries(FONTS || {})) {
    const family = name === "SpaceGrotesk" ? "SpaceGroteskVar" : "InterVar";
    fontFaces +=
      `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${b64}) format("woff2");` +
      `font-weight:100 900;font-style:normal;font-display:swap;}`;
  }
  style.textContent = fontFaces + "\n" + (SKIN_CSS || "");
  (document.head || document.documentElement).appendChild(style);
})();

// ---- lucide glyphs (stroke icons, 24x24 viewBox) -------------------------
const ICONS = {
  minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
  square: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  restore:
    '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  orbit:
    '<circle cx="12" cy="12" r="3"/><circle cx="19" cy="5" r="2"/><path d="M12 2v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="M2 12h2"/><path d="m4.9 19.1 1.4-1.4"/><path d="M12 22v-2"/><path d="m19.1 4.9-1.4 1.4"/><path d="M22 12h-2"/><path d="m19.1 19.1-1.4-1.4"/>',
  puzzle:
    '<path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  restart:
    '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
  file:
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
};

const WHALE_PATH = "M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z";
function whaleIcon(size) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 50 50" fill="none"><path d="' + WHALE_PATH + '" fill="currentColor"/></svg>';
}

function lucide(name, size = 14, strokeWidth = 1.9) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`
  );
}

// ---- ambient layers (aurora canvas, vignette, grain) ---------------------
function appendLayers() {
  const body = document.body;
  if (!body) return;

  if (!document.getElementById("dsh-aurora-canvas")) {
    const canvas = document.createElement("canvas");
    canvas.id = "dsh-aurora-canvas";
    body.insertBefore(canvas, body.firstChild);
    startAurora(canvas);
  }
  if (!document.getElementById("dsh-aurora-vignette")) {
    const vignette = document.createElement("div");
    vignette.id = "dsh-aurora-vignette";
    body.insertBefore(vignette, body.firstChild);
  }
  if (!document.getElementById("dsh-grain")) {
    const grain = document.createElement("div");
    grain.id = "dsh-grain";
    body.appendChild(grain);
  }
}

function startAurora(canvas) {
  const vert = `
    attribute vec2 a;
    void main(){ gl_Position = vec4(a, 0.0, 1.0); }`;

  const frag = `
    precision highp float;
    uniform vec2 u_res;
    uniform float u_time;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
    float noise(vec2 p){
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
        mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm(vec2 p){
      float v = 0.0, a = 0.5;
      mat2 r = mat2(0.8, 0.6, -0.6, 0.8);
      for (int i = 0; i < 5; i++) { v += a * noise(p); p = r * p * 2.03; a *= 0.5; }
      return v;
    }
    void main(){
      vec2 uv = (gl_FragCoord.xy * 2.0 - u_res) / min(u_res.x, u_res.y);
      float t = u_time * 0.055;
      vec2 q = vec2(fbm(uv * 1.35 + t), fbm(uv * 1.35 - t * 0.7));
      vec2 r = vec2(fbm(uv * 1.15 + q * 1.7 + t * 0.4), fbm(uv * 1.15 + q * 1.7 - t * 0.3));
      float f = fbm(uv * 1.55 + r * 2.1);
      vec3 violet = vec3(0.55, 0.35, 1.0);
      vec3 cyan   = vec3(0.12, 0.60, 0.98);
      vec3 magenta= vec3(0.95, 0.22, 0.70);
      vec3 col = mix(violet, cyan, smoothstep(0.18, 0.82, f));
      col = mix(col, magenta, smoothstep(0.42, 0.92, fbm(uv * 1.15 + r * 1.35)));
      col *= 0.19 + 0.14 * pow(f, 2.0);
      float vig = smoothstep(1.55, 0.2, length(uv));
      col *= 0.55 + 0.45 * vig;
      gl_FragColor = vec4(col, 1.0);
    }`;

  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
  if (!gl) return;

  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vert));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const uRes = gl.getUniformLocation(prog, "u_res");
  const uTime = gl.getUniformLocation(prog, "u_time");

  const QUALITY = 0.34;
  const resize = () => {
    const w = Math.max(2, Math.floor(innerWidth * QUALITY));
    const h = Math.max(2, Math.floor(innerHeight * QUALITY));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
  };

  let running = true;
  let start = performance.now();
  const frame = (now) => {
    if (!running) return;
    resize();
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, (now - start) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!reducedMotion) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  addEventListener("resize", resize);
  document.addEventListener("visibilitychange", () => {
    running = !document.hidden;
    if (running && !reducedMotion) requestAnimationFrame(frame);
  });
}

// ---- window drag strip ------------------------------------------------------
// The frameless window's whole top strip behaves like a native titlebar, not
// just the floating pill: Tauri's core drag script walks data-tauri-drag-region
// attributes — "deep" makes every non-interactive pixel of the region drag the
// window, and double-click there toggles maximize, while buttons/links/inputs
// inside the region stay fully clickable. The page header (center column) and
// the sidebar brand row are the two containers that make up the top strip.
// Re-applied on an interval because SPA routing swaps those elements.
function wireDragStrip() {
  const mark = (el) => {
    if (el && el instanceof HTMLElement && !el.hasAttribute("data-tauri-drag-region")) {
      el.setAttribute("data-tauri-drag-region", "deep");
    }
  };
  const center = document.querySelector('[class*="_centerCol"]');
  mark(center && center.querySelector("header"));
  const sidebar = document.querySelector('[class*="_sidebarCol"]');
  mark(sidebar && sidebar.querySelector('[class*="_logoRow" i]'));
}

// ---- welcome-notice (内测声明) rescue ---------------------------------------
// When the harness's settings RPC fails (shared harness restarting, boot race,
// connection drop), the 内测声明 dialog shows "暂时无法保存确认状态" and traps
// the whole app: the client's OnboardingModal ignores dismiss (no close button,
// Escape/backdrop are no-ops) and marks the app root `inert`, so the user is
// frozen with no way out. Rescue: keep pressing the client's own 继续 button
// (it knows the current acknowledgement version), and if the harness stays
// unreachable, remove the dialog for the rest of the session so it can never
// block the app again.
(function wireWelcomeRescue() {
  const ERROR_ZH = "暂时无法保存确认状态";
  const ERROR_EN = "could not be saved";
  const MAX_ATTEMPTS = 10;
  let active = null; // { dialog, timer, attempts }

  function dismiss() {
    if (!active) return;
    clearInterval(active.timer);
    window.__dshWelcomeDismissed = true;
    active.dialog.remove();
    active = null;
  }

  function clickContinue() {
    if (!active) return;
    if (!active.dialog.isConnected) {
      // the client unmounted it (acknowledged or re-rendered away) — stop
      clearInterval(active.timer);
      active = null;
      return;
    }
    const button = [...active.dialog.querySelectorAll("button")].find((b) => {
      const label = (b.textContent || "").trim();
      return label === "继续" || label === "Continue";
    });
    if (button && !button.disabled) {
      active.attempts += 1;
      button.click();
      if (active.attempts >= MAX_ATTEMPTS) dismiss();
    }
  }

  function scan() {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => {
      const text = d.innerText || "";
      return (
        (text.includes("内测声明") || text.includes("Internal Testing Notice")) &&
        (text.includes(ERROR_ZH) || text.includes(ERROR_EN))
      );
    });
    if (!dialog) return;
    if (window.__dshWelcomeDismissed) {
      // user already dismissed this session — never trap them again
      dialog.remove();
      return;
    }
    if (active && active.dialog.isConnected) return; // already handling one
    if (active) {
      clearInterval(active.timer);
      active = null;
    }
    active = { dialog, timer: setInterval(clickContinue, 1200), attempts: 0 };
    clickContinue();
  }

  setInterval(scan, 800);
})();

// ---- titlebar -------------------------------------------------------------
function buildTitlebar() {
  if (!document.body) return;
  if (document.getElementById("dsh-titlebar")) return;

  const bar = document.createElement("div");
  bar.id = "dsh-titlebar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "DSH Desktop window controls");
  // Whole pill is a drag region (deep: clicks on the mark/word/title/dot drag
  // the window too). Buttons inside remain clickable — the core drag handler
  // skips clickable elements that don't carry the attribute themselves.
  bar.setAttribute("data-tauri-drag-region", "deep");

  bar.innerHTML = `
    <div class="dsh-tb-drag">
      <span class="dsh-tb-mark">${whaleIcon(13)}</span>
      <span class="dsh-tb-word">DSH</span>
      <span class="dsh-tb-sep"></span>
      <span class="dsh-tb-title">DeepSeek Harness</span>
      <span class="dsh-tb-dot"></span>
    </div>
    <button class="dsh-tb-btn dsh-tb-mcp" title="MCP 管理" aria-label="MCP servers">${lucide("plug", 13, 1.8)}<span class="dsh-tb-mcp-badge" id="dsh-tb-mcp-badge"></span></button>
    <button class="dsh-tb-btn dsh-tb-plug" title="Plugins" aria-label="Plugins">${lucide("puzzle")}</button>
    <button class="dsh-tb-btn dsh-tb-min" title="Minimize" aria-label="Minimize">${lucide("minus")}</button>
    <button class="dsh-tb-btn dsh-tb-max" title="Maximize" aria-label="Maximize">${lucide("square")}</button>
    <button class="dsh-tb-btn dsh-tb-close" title="Close to tray" aria-label="Close">${lucide("close")}</button>`;

  document.body.appendChild(bar);
  buildPluginPanel();
  buildMcpPanel();

  const minBtn = bar.querySelector(".dsh-tb-min");
  const maxBtn = bar.querySelector(".dsh-tb-max");
  const closeBtn = bar.querySelector(".dsh-tb-close");
  const title = bar.querySelector(".dsh-tb-title");

  const updateTitle = () => {
    const text = (document.title || "").trim();
    if (text) title.textContent = text;
  };
  updateTitle();
  new MutationObserver(updateTitle).observe(document.querySelector("title") || document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  wireDragStrip();
  setInterval(() => {
    updateTitle();
    wireDragStrip();
  }, 1500);

  let win = null;
  const wire = () => {
    try {
      const tauri = window.__TAURI__;
      if (tauri && tauri.window && tauri.window.getCurrentWindow) {
        win = tauri.window.getCurrentWindow();
      }
    } catch (_) {}
    if (!win) return false;

    minBtn.addEventListener("click", () => win.minimize().catch(() => {}));
    closeBtn.addEventListener("click", () => win.close().catch(() => {}));

    const refreshMax = () => {
      win.isMaximized()
        .then((maxed) => {
          maxBtn.innerHTML = lucide(maxed ? "restore" : "square");
          maxBtn.title = maxed ? "Restore" : "Maximize";
        })
        .catch(() => {});
    };
    maxBtn.addEventListener("click", () => win.toggleMaximize().then(refreshMax).catch(() => {}));
    // Double-click maximize is handled natively by the core (drag.js) for
    // `data-tauri-drag-region` elements — do NOT add a JS dblclick handler
    // here: it would toggle a second time and cancel the core's toggle out.
    addEventListener("resize", refreshMax);
    refreshMax();
    return true;
  };

  if (!wire()) {
    // IPC unavailable — degrade gracefully.
    let attempts = 0;
    const poll = setInterval(() => {
      attempts += 1;
      if (wire()) clearInterval(poll);
      else if (attempts > 30) {
        clearInterval(poll);
        minBtn.remove();
        maxBtn.remove();
        closeBtn.addEventListener("click", () => {
          try {
            window.close();
          } catch (_) {}
        });
      }
    }, 100);
  }
}

// ---- plugin management panel (Cordis / pnpm through the exe) --------------
function buildPluginPanel() {
  if (document.getElementById("dsh-plugin-panel")) return;
  const invoke =
    window.__TAURI__ && window.__TAURI__.core
      ? (cmd, args) => window.__TAURI__.core.invoke(cmd, args)
      : null;

  const panel = document.createElement("div");
  panel.id = "dsh-plugin-panel";
  panel.className = "dsh-hidden";
  panel.innerHTML = `
    <div class="dsp-head">
      <span class="dsp-title">${lucide("puzzle", 13)} <b>Plugins</b></span>
      <span class="dsp-headnote">cordis · hot-swap</span>
      <button class="dsh-tb-btn dsp-close" title="Close" aria-label="Close">${lucide("close")}</button>
    </div>
    <div class="dsp-status" id="dsp-status"></div>
    <div class="dsp-install">
      <input id="dsp-input" spellcheck="false" placeholder="GitHub repo URL — https://github.com/owner/repo" />
      <button class="dsh-tb-btn dsp-add" title="Install" aria-label="Install">${lucide("plus")}</button>
    </div>
    <div class="dsp-list" id="dsp-list"></div>
    <div class="dsp-foot">
      <span class="dsp-loghead">output</span>
      <button class="dsh-tb-btn dsp-restart" title="Restart the harness" aria-label="Restart harness">${lucide("restart")}</button>
    </div>
    <pre class="dsp-log" id="dsp-log">plugin panel ready</pre>`;
  document.body.appendChild(panel);

  const status = panel.querySelector("#dsp-status");
  const list = panel.querySelector("#dsp-list");
  const log = panel.querySelector("#dsp-log");
  const input = panel.querySelector("#dsp-input");

  const logLine = (text, kind) => {
    const line = document.createElement("div");
    line.className = `dsp-line dsp-${kind || "info"}`;
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  };

  const readClientGraph = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(`/?dsh-desktop-graph=${Date.now()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const text = await response.text();
      const marker = "window.__DSH_BOOT__ = ";
      const start = text.indexOf(marker);
      if (start < 0) return null;
      let payload = text.slice(start + marker.length);
      const end = payload.indexOf("</script>");
      if (end < 0) return null;
      payload = payload.slice(0, end).trim().replace(/;+\s*$/, "");
      const data = JSON.parse(payload);
      return (data.entries || []).map((entry) => entry.id);
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // The host patch layer hot-swaps server plugins immediately, but a page
  // that is already open keeps the old `window.__DSH_BOOT__` client graph.
  // Wait until a fresh GET / reflects the change, then reload only the page
  // (the harness process and all sessions stay alive).
  const waitForClientGraph = async (name, enabled, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    let announced = false;
    while (Date.now() < deadline) {
      const ids = await readClientGraph();
      if (ids) {
        const present = ids.includes(name);
        if (present === enabled) {
          logLine(`client graph ${enabled ? "contains" : "dropped"} ${name}`, "ok");
          return true;
        }
      }
      if (!announced) {
        logLine(`waiting for the cordis host graph to ${enabled ? "add" : "drop"} ${name}…`, "warn");
        announced = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    logLine(`timed out waiting for ${name} in the client graph`, "err");
    return false;
  };

  const reloadClient = (names, enabled) =>
    Promise.all(names.map((name) => waitForClientGraph(name, enabled))).then((results) => {
      if (results.every(Boolean)) {
        logLine("client graph updated — reloading the page", "ok");
        setTimeout(() => window.location.reload(), 250);
      }
      return results.every(Boolean);
    });

  const refresh = async () => {
    if (!invoke) {
      status.textContent = "tauri ipc unavailable";
      return;
    }
    try {
      const data = await invoke("plugin_list");
      status.innerHTML = "";
      const dot = document.createElement("span");
      dot.className = "dsp-dot" + (data.pnpm ? "" : " dsp-dot-off");
      status.appendChild(dot);
      status.appendChild(document.createTextNode(` profile ${data.profile}`));
      const pnpmNote = document.createElement("span");
      pnpmNote.className = "dsp-pnpm";
      pnpmNote.textContent = data.pnpm ? "pnpm bundled" : "pnpm missing";
      status.appendChild(pnpmNote);

      const addBtn = panel.querySelector(".dsp-add");
      if (addBtn) addBtn.disabled = !data.pnpm;

      list.innerHTML = "";
      if (data.bundles.length) {
        const head = document.createElement("div");
        head.className = "dsp-section";
        head.textContent = `bundle layers · ${data.bundles.length}`;
        list.appendChild(head);
        for (const name of data.bundles) {
          const row = document.createElement("div");
          row.className = "dsp-row";
          const label = document.createElement("span");
          label.className = "dsp-row-name";
          label.textContent = name;
          const tag = document.createElement("span");
          tag.className = "dsp-row-tag";
          tag.textContent = "bundle";
          row.appendChild(label);
          row.appendChild(tag);
          list.appendChild(row);
        }
      }
      if (data.dependencies.length) {
        const head = document.createElement("div");
        head.className = "dsp-section";
        head.textContent = `installed plugins · ${data.dependencies.length}`;
        list.appendChild(head);
        for (const dep of data.dependencies) {
          const row = document.createElement("div");
          row.className = "dsp-row";
          const label = document.createElement("span");
          label.className = "dsp-row-name";
          label.textContent = `${dep.name} · ${typeof dep.spec === "string" ? dep.spec : JSON.stringify(dep.spec)}`;
          label.title = label.textContent;
          const actions = document.createElement("span");
          actions.className = "dsp-actions";
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "dsp-toggle" + (dep.enabled ? " dsp-toggle-on" : "");
          toggle.setAttribute("role", "switch");
          toggle.setAttribute("aria-checked", dep.enabled ? "true" : "false");
          toggle.title = dep.enabled ? "Disable — unload immediately" : "Enable — load immediately";
          toggle.innerHTML = `<span class="dsp-toggle-knob"></span>`;
          toggle.addEventListener("click", () => setEnabled(dep.name, !dep.enabled));
          if (!data.pnpm) toggle.disabled = true;
          const remove = document.createElement("button");
          remove.className = "dsh-tb-btn dsp-remove";
          remove.title = "Remove";
          remove.innerHTML = lucide("trash", 12);
          remove.addEventListener("click", () => run("remove", dep.name));
          if (!data.pnpm) remove.disabled = true;
          actions.appendChild(toggle);
          actions.appendChild(remove);
          row.appendChild(label);
          row.appendChild(actions);
          list.appendChild(row);
        }
      } else {
        const empty = document.createElement("div");
        empty.className = "dsp-empty";
        empty.textContent = data.pnpm
          ? "no out-of-tree plugins installed — paste a GitHub repo URL above"
          : "pnpm is missing, so plugin install is unavailable";
        list.appendChild(empty);
      }
    } catch (error) {
      status.textContent = `plugin_list failed: ${error}`;
    }
  };

  let pluginBusy = false;

  const setEnabled = async (name, enabled) => {
    if (!invoke || pluginBusy) return;
    pluginBusy = true;
    logLine(`> ${enabled ? "enable" : "disable"} ${name}`, "cmd");
    try {
      const result = await invoke("plugin_set_enabled", { name, enabled });
      const message = (result && result.message) || String(result || "");
      if (message.trim()) logLine(message.trim(), "out");
      logLine(`${name} ${enabled ? "enabled" : "disabled"} — hot-applied by cordis HMR`, "ok");
      if (result && result.reload) {
        const ready = await reloadClient([name], enabled);
        if (!ready) await refresh();
      } else {
        await refresh();
      }
    } catch (error) {
      logLine(String(error), "err");
    } finally {
      pluginBusy = false;
    }
  };

  const run = async (action, name) => {
    if (!invoke || pluginBusy) return;
    pluginBusy = true;
    logLine(`> ${action} ${name}`, "cmd");
    input.disabled = true;
    const addBtn = panel.querySelector(".dsp-add");
    if (addBtn) addBtn.disabled = true;
    try {
      const result = await invoke("plugin_manage", { action, name });
      const output = (result && result.output) || String(result || "");
      if (output.trim()) logLine(output.trim(), "out");
      logLine(`${action} ${name} — done`, "ok");
      if (action === "add") {
        logLine("hot-loaded through cordis HMR — no restart needed", "warn");
        input.value = "";
      }
      if (result && result.reload && Array.isArray(result.clients) && result.clients.length) {
        const ready = await reloadClient(result.clients, action === "add");
        if (!ready) await refresh();
      } else {
        await refresh();
      }
    } catch (error) {
      logLine(String(error), "err");
      await refresh();
    } finally {
      pluginBusy = false;
      input.disabled = false;
      if (addBtn) addBtn.disabled = false;
    }
  };

  panel.querySelector(".dsp-close").addEventListener("click", () => {
    panel.classList.add("dsh-hidden");
  });
  panel.querySelector(".dsp-add").addEventListener("click", () => {
    const name = input.value.trim();
    if (name) run("add", name);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const name = input.value.trim();
      if (name) run("add", name);
    }
  });
  panel.querySelector(".dsp-restart").addEventListener("click", async () => {
    if (!invoke) return;
    logLine("restarting harness", "cmd");
    try {
      await invoke("retry_boot");
    } catch (error) {
      logLine(String(error), "err");
    }
  });
  refresh();

  const plugBtn = document.querySelector("#dsh-titlebar .dsh-tb-plug");
  if (plugBtn) {
    plugBtn.addEventListener("click", () => {
      // Only one floating panel at a time: opening Plugins closes MCP.
      closeMcpPanel();
      const opening = panel.classList.contains("dsh-hidden");
      panel.classList.toggle("dsh-hidden", !opening);
      plugBtn.classList.toggle("active", opening);
      if (opening) refresh();
    });
  }
}

// ---- MCP management：标题栏 Plugins 左侧按钮 + 右上角玻璃面板 --------------
// The desktop shell scans the Claude-Code-style `.mcp.json` registries it can
// reach (global `~/.mcp.json`, DSH home and every known workspace) and merges
// them into a management panel (`mcp_list`), with per-server enable/disable
// toggles (`mcp_set_enabled`). A floating titlebar button sits right before
// the Plugins button and opens a top-right glass panel styled exactly like the
// plugin manager.
function mcpInvokeAvailable() {
  return !!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);
}

function closeMcpPanel() {
  const panel = document.getElementById("dsh-mcp-bar");
  if (panel) panel.classList.add("dsh-hidden");
  const btn = document.querySelector("#dsh-titlebar .dsh-tb-mcp");
  if (btn) {
    btn.classList.remove("active");
    btn.setAttribute("aria-expanded", "false");
  }
}

function closePluginPanel() {
  const panel = document.getElementById("dsh-plugin-panel");
  if (panel) panel.classList.add("dsh-hidden");
  const btn = document.querySelector("#dsh-titlebar .dsh-tb-plug");
  if (btn) btn.classList.remove("active");
}

function buildMcpPanel() {
  if (document.getElementById("dsh-mcp-bar")) return;
  if (!document.body) {
    setTimeout(buildMcpPanel, 50);
    return;
  }
  const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);

  const panel = document.createElement("div");
  panel.id = "dsh-mcp-bar";
  panel.className = "dsh-hidden";

  panel.innerHTML = `
    <div class="dsh-mcp-head">
      <span class="dsh-mcp-title">${lucide("plug", 13, 1.8)} <b>MCP 管理</b></span>
      <span class="dsh-mcp-count" id="dsh-mcp-count"></span>
      <span class="dsh-mcp-summary" id="dsh-mcp-summary"></span>
      <button type="button" class="dsh-tb-btn dsh-mcp-refresh" title="Rescan MCP configurations" aria-label="Rescan MCP configurations">${lucide("refresh", 13, 1.8)}</button>
      <button type="button" class="dsh-tb-btn dsh-mcp-close" title="Close MCP management" aria-label="Close MCP management">${lucide("close", 13, 1.8)}</button>
    </div>
    <div class="dsh-mcp-body" id="dsh-mcp-body"></div>`;

  document.body.appendChild(panel);

  const body = panel.querySelector("#dsh-mcp-body");
  const count = panel.querySelector("#dsh-mcp-count");
  const summary = panel.querySelector("#dsh-mcp-summary");
  const mcpBtn = document.querySelector("#dsh-titlebar .dsh-tb-mcp");
  const badge = document.getElementById("dsh-tb-mcp-badge");

  const setOpen = (open) => {
    panel.classList.toggle("dsh-hidden", !open);
    if (mcpBtn) {
      mcpBtn.classList.toggle("active", open);
      mcpBtn.setAttribute("aria-expanded", open ? "true" : "false");
    }
    if (open) refresh();
  };

  if (mcpBtn) {
    mcpBtn.addEventListener("click", () => {
      const opening = panel.classList.contains("dsh-hidden");
      // Only one floating panel at a time: opening MCP closes Plugins.
      closePluginPanel();
      setOpen(opening);
    });
  }
  panel.querySelector(".dsh-mcp-close").addEventListener("click", () => setOpen(false));
  panel.querySelector(".dsh-mcp-refresh").addEventListener("click", refresh);

  // Esc or clicking anywhere outside closes the panel.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });
  document.addEventListener("click", (e) => {
    if (panel.classList.contains("dsh-hidden")) return;
    if (e.target instanceof Element &&
        (e.target.closest("#dsh-mcp-bar") || e.target.closest("#dsh-titlebar .dsh-tb-mcp"))) return;
    setOpen(false);
  });

  function setBusy(busy) {
    const refreshBtn = panel.querySelector(".dsh-mcp-refresh");
    if (refreshBtn) refreshBtn.disabled = busy;
  }

  function makeRow(server) {
    const row = document.createElement("div");
    row.className = "dsh-mcp-row";
    row.title = server.config;

    const label = document.createElement("span");
    label.className = "dsh-mcp-name";
    label.textContent = server.name || "?";
    label.title = server.config;

    const meta = document.createElement("span");
    meta.className = "dsh-mcp-meta";
    const cmdParts = [server.command || "", ...(server.args || []).slice(0, 3)];
    meta.textContent = cmdParts.join(" ").trim() || (server.env_keys && server.env_keys.length ? "env: " + server.env_keys.join(", ") : "remote / http");
    meta.title = meta.textContent;

    const scope = document.createElement("span");
    scope.className = "dsh-mcp-scope";
    const scopeText =
      server.source === "global" ? "global"
      : server.source === "dsh" ? "dsh-home"
      : server.workspace || "workspace";
    scope.textContent = scopeText;
    scope.title = server.config;
    scope.classList.add("dsh-mcp-scope-" + (server.source === "global" ? "global" : server.source === "dsh" ? "dsh" : "ws"));

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "dsh-mcp-switch" + (server.enabled ? " dsh-mcp-switch-on" : "");
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", server.enabled ? "true" : "false");
    toggle.title = server.enabled ? "Disable this MCP server" : "Enable this MCP server";
    toggle.innerHTML = `<span class="dsh-mcp-switch-knob"></span>`;

    const config = server.config;
    const serverName = server.name;
    const serverEnabled = server.enabled;
    toggle.addEventListener("click", async () => {
      toggle.disabled = true;
      try {
        await invoke("mcp_set_enabled", { config, name: serverName, enabled: !serverEnabled });
        await refresh();
      } catch (error) {
        summary.textContent = String((error && error.message) || error || "toggle failed");
        timeoutShowSummary();
        toggle.disabled = false;
      }
    });

    const details = document.createElement("span");
    details.className = "dsh-mcp-details";
    const parts = [];
    if (server.env_keys && server.env_keys.length) parts.push("env: " + server.env_keys.join(", "));
    details.textContent = parts.length ? parts.join(" · ") : server.config;

    row.appendChild(label);
    row.appendChild(meta);
    row.appendChild(scope);
    row.appendChild(details);
    row.appendChild(toggle);
    return row;
  }

  let summaryTimer = null;
  function timeoutShowSummary() {
    if (summaryTimer) clearTimeout(summaryTimer);
    summaryTimer = setTimeout(() => refresh(), 2600);
  }

  function render(data) {
    const servers = (data && Array.isArray(data.servers)) ? data.servers : [];
    const enabled = servers.filter((s) => s.enabled).length;
    const total = servers.length;
    count.textContent = String(total);
    summary.textContent = enabled + "/" + total + " on";
    if (badge) badge.textContent = String(total);
    if (badge) badge.title = total + " MCP servers";

    body.innerHTML = "";
    if (!total) {
      const empty = document.createElement("div");
      empty.className = "dsh-mcp-empty";
      empty.textContent =
        data && data.files && data.files.length
          ? "No MCP servers configured in the scanned .mcp.json files."
          : "No .mcp.json registries found — scanned global, DSH home and workspaces.";
      body.appendChild(empty);
      return;
    }

    const sections = [
      { key: "global", label: "Global" },
      { key: "dsh", label: "DSH home" },
      { key: "workspace", label: "Workspaces" },
    ];
    let anyRow = false;
    for (const section of sections) {
      const group = servers.filter((s) => s.source === section.key);
      if (!group.length) continue;
      anyRow = true;
      const head = document.createElement("div");
      head.className = "dsh-mcp-section";
      const on = group.filter((s) => s.enabled).length;
      head.textContent = section.label + " · " + on + "/" + group.length;
      body.appendChild(head);
      for (const server of group) body.appendChild(makeRow(server));
    }
    if (!anyRow) {
      const empty = document.createElement("div");
      empty.className = "dsh-mcp-empty";
      empty.textContent = "No MCP servers found — none of the scanned .mcp.json files define mcpServers.";
      body.appendChild(empty);
    }
  }

  async function refresh() {
    if (!mcpInvokeAvailable()) {
      count.textContent = "—";
      summary.textContent = "ipc unavailable";
      return;
    }
    setBusy(true);
    try {
      render(await invoke("mcp_list"));
    } catch (error) {
      summary.textContent = String((error && error.message) || error || "mcp_list failed");
      count.textContent = "!";
    } finally {
      setBusy(false);
    }
  }

  // Prime the badge count even before the user opens the panel.
  refresh();
}

// ---- file drop → stage attachments → insert paths into the composer ---------
// The desktop shell (via Tauri) intercepts OS file drops and emits
// `tauri://drag-drop` with the real filesystem paths. We copy them into
// ~/.dsh/attachments/ (Rust command `stage_attachments`) and drop the staged
// absolute paths into the message composer so the agent can read them with
// its `read` tool.
function findComposerCard() {
  return document.querySelector("[data-composer-card]");
}

function findComposerTextarea() {
  const card = findComposerCard();
  return card ? card.querySelector("textarea") : null;
}

function setNativeValue(el, value) {
  const proto =
    el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

// ---- drop overlay：只蒙住输入框（composer card）---------------------------
function buildDropOverlay() {
  if (document.getElementById("dsh-drop-overlay")) return;
  const overlay = document.createElement("div");
  overlay.id = "dsh-drop-overlay";
  overlay.className = "dsh-hidden";
  overlay.innerHTML = `
    <div class="dsh-drop-box">
      <span class="dsh-drop-icon">${lucide("folder", 20, 1.4)}</span>
      <span class="dsh-drop-title">Drop to attach</span>
    </div>`;
  document.body.appendChild(overlay);
}

function positionDropOverlay() {
  const card = findComposerCard();
  const el = document.getElementById("dsh-drop-overlay");
  if (!card || !el) return;
  const r = card.getBoundingClientRect();
  el.style.left = r.left + "px";
  el.style.top = r.top + "px";
  el.style.width = r.width + "px";
  el.style.height = r.height + "px";
}

function showDropOverlay() {
  buildDropOverlay();
  const el = document.getElementById("dsh-drop-overlay");
  if (el) {
    positionDropOverlay();
    el.classList.remove("dsh-hidden");
  }
}

function hideDropOverlay() {
  const el = document.getElementById("dsh-drop-overlay");
  if (el) el.classList.add("dsh-hidden");
}

// ---- 附件栏：作为控件显示在输入框（composer card）上方 --------------------
let attachments = []; // [{ path, name, kind }]

function buildAttachRail() {
  if (document.getElementById("dsh-attach-rail")) return;
  const rail = document.createElement("div");
  rail.id = "dsh-attach-rail";
  rail.className = "dsh-hidden";
  document.body.appendChild(rail);
}

function positionAttachRail() {
  const card = findComposerCard();
  const rail = document.getElementById("dsh-attach-rail");
  if (!card || !rail) return;
  const r = card.getBoundingClientRect();
  rail.style.left = r.left + "px";
  rail.style.width = r.width + "px";
  const gap = 8;
  rail.style.top = Math.max(8, r.top - rail.offsetHeight - gap) + "px";
}

function makeAttachmentChip(att) {
  const chip = document.createElement("div");
  chip.className = "dsh-attach-chip";
  chip.dataset.path = att.path;
  chip.dataset.kind = att.kind || "file";
  chip.title = att.path;
  const icon =
    att.kind === "directory" ? lucide("folder", 13, 1.7) : lucide("file", 13, 1.7);
  chip.innerHTML =
    `<span class="dsh-attach-ico">${icon}</span>` +
    `<span class="dsh-attach-name">${escapeHtml(att.name)}</span>` +
    `<button type="button" class="dsh-attach-x" title="Remove" aria-label="Remove">${lucide("close", 10)}</button>`;
  chip.querySelector(".dsh-attach-x").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    attachments = attachments.filter((a) => a.path !== att.path);
    renderAttachRail();
  });
  return chip;
}

function renderAttachRail() {
  buildAttachRail();
  const rail = document.getElementById("dsh-attach-rail");
  rail.innerHTML = "";
  for (const att of attachments) rail.appendChild(makeAttachmentChip(att));
  if (attachments.length) {
    rail.classList.remove("dsh-hidden");
    positionAttachRail();
  } else {
    rail.classList.add("dsh-hidden");
  }
}

function addAttachments(staged) {
  for (const s of staged) {
    if (!attachments.some((a) => a.path === s.path)) {
      attachments.push({ path: s.path, name: s.name, kind: s.kind });
    }
  }
  renderAttachRail();
}

// ---- 发送前把附件路径注入草稿，让 agent 的 read 工具能读到 -----------------
// composer 是受控 textarea（value=draft）；用原生 setter 改 value + 派发 input
// 事件，React 的 onChange 会 setDraft，随后 Enter/发送按钮的 submit 就带上路径。
function injectAttachmentsIntoDraft() {
  if (!attachments.length) return;
  const ta = findComposerTextarea();
  if (!ta) return;
  const paths = attachments.map((a) => a.path).join("\n");
  const sep = ta.value && !ta.value.endsWith("\n") ? "\n" : "";
  setNativeValue(ta, ta.value + sep + paths);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  attachments = [];
  renderAttachRail();
}

function wireSendInjection() {
  if (window.__dsh_send_injection_wired) return;
  window.__dsh_send_injection_wired = true;

  // Enter 发送：捕获阶段注入，React 的 onKeyDown 随后 submit 时已含路径。
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      if (!attachments.length) return;
      const ta = findComposerTextarea();
      if (!ta || document.activeElement !== ta) return;
      injectAttachmentsIntoDraft();
    },
    true,
  );

  // 发送按钮：捕获阶段注入，React 的 onClick 随后 submit 时已含路径。
  document.addEventListener(
    "click",
    (e) => {
      if (!attachments.length) return;
      const btn =
        e.target instanceof Element
          ? e.target.closest("[data-composer-card] button")
          : null;
      if (!btn) return;
      const label = btn.getAttribute("aria-label") || "";
      if (!/send|发送/i.test(label) || /stop|停止/i.test(label)) return;
      injectAttachmentsIntoDraft();
    },
    true,
  );
}

function wireFileDrop() {
  if (window.__dsh_file_drop_wired) return;
  const tauri = window.__TAURI__;
  const invoke = tauri && tauri.core ? (cmd, args) => tauri.core.invoke(cmd, args) : null;
  const listen = tauri && tauri.event ? tauri.event.listen : null;
  if (!invoke || !listen) {
    // IPC not ready yet — retry briefly (withGlobalTauri injects before page
    // scripts normally, but be defensive like the titlebar wiring).
    const attempt = (window.__dsh_drop_retry = (window.__dsh_drop_retry || 0) + 1);
    if (attempt <= 30) setTimeout(wireFileDrop, 100);
    return;
  }
  window.__dsh_file_drop_wired = true;

  let depth = 0;
  let busy = false;

  const onEnter = () => {
    depth += 1;
    showDropOverlay();
  };
  const onOver = () => {
    if (depth > 0) showDropOverlay();
  };
  const onLeave = () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) hideDropOverlay();
  };
  const onDrop = (event) => {
    depth = 0;
    hideDropOverlay();
    const paths =
      event && event.payload && Array.isArray(event.payload.paths)
        ? event.payload.paths.filter((p) => typeof p === "string" && p)
        : [];
    if (!paths.length || busy) return;
    busy = true;
    invoke("stage_attachments", { paths })
      .then((staged) => {
        if (Array.isArray(staged) && staged.length) {
          addAttachments(staged);
        }
      })
      .catch((error) => console.error("[dsh-drop] stage_attachments failed:", error))
      .finally(() => {
        busy = false;
      });
  };

  listen("tauri://drag-enter", onEnter).catch((e) => console.error("[dsh-drop] enter:", e));
  listen("tauri://drag-over", onOver).catch((e) => console.error("[dsh-drop] over:", e));
  listen("tauri://drag-leave", onLeave).catch((e) => console.error("[dsh-drop] leave:", e));
  listen("tauri://drag-drop", onDrop).catch((e) => console.error("[dsh-drop] drop:", e));
}

function ensureBody() {
  if (document.body) {
    appendLayers();
    buildTitlebar();
    wireFileDrop();
    wireSendInjection();
    // 窗口/布局变化时，附件栏与蒙版重新对齐输入框
    addEventListener("resize", () => {
      if (attachments.length) positionAttachRail();
      positionDropOverlay();
    });
  } else {
    new MutationObserver(() => ensureBody()).observe(document.documentElement, { childList: true });
  }
}

ensureBody();
