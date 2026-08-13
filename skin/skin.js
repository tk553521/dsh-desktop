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
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  restart:
    '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
};

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

// ---- titlebar -------------------------------------------------------------
function buildTitlebar() {
  if (!document.body) return;
  if (document.getElementById("dsh-titlebar")) return;

  const bar = document.createElement("div");
  bar.id = "dsh-titlebar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "DSH Desktop window controls");

  bar.innerHTML = `
    <div class="dsh-tb-drag" data-tauri-drag-region>
      <span class="dsh-tb-mark">${lucide("orbit", 12, 2.1)}</span>
      <span class="dsh-tb-word">DSH</span>
      <span class="dsh-tb-sep"></span>
      <span class="dsh-tb-title">DeepSeek Harness</span>
      <span class="dsh-tb-dot"></span>
    </div>
    <button class="dsh-tb-btn dsh-tb-plug" title="Plugins" aria-label="Plugins">${lucide("puzzle")}</button>
    <button class="dsh-tb-btn dsh-tb-min" title="Minimize" aria-label="Minimize">${lucide("minus")}</button>
    <button class="dsh-tb-btn dsh-tb-max" title="Maximize" aria-label="Maximize">${lucide("square")}</button>
    <button class="dsh-tb-btn dsh-tb-close" title="Close to tray" aria-label="Close">${lucide("close")}</button>`;

  document.body.appendChild(bar);
  buildPluginPanel();

  const minBtn = bar.querySelector(".dsh-tb-min");
  const maxBtn = bar.querySelector(".dsh-tb-max");
  const closeBtn = bar.querySelector(".dsh-tb-close");
  const drag = bar.querySelector(".dsh-tb-drag");
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
  setInterval(updateTitle, 1500);

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
    drag.addEventListener("dblclick", () => win.toggleMaximize().then(refreshMax).catch(() => {}));
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
      <span class="dsp-headnote">cordis</span>
      <button class="dsh-tb-btn dsp-close" title="Close" aria-label="Close">${lucide("close")}</button>
    </div>
    <div class="dsp-status" id="dsp-status"></div>
    <div class="dsp-install">
      <input id="dsp-input" spellcheck="false" placeholder="package spec — name / file: / git+" />
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

      list.innerHTML = "";
      if (data.bundles.length) {
        const head = document.createElement("div");
        head.className = "dsp-section";
        head.textContent = `layers · ${data.bundles.length}`;
        list.appendChild(head);
        for (const name of data.bundles) {
          const row = document.createElement("div");
          row.className = "dsp-row";
          row.innerHTML = `<span class="dsp-row-name">${name}</span><span class="dsp-row-tag">bundle</span>`;
          list.appendChild(row);
        }
      }
      if (data.dependencies.length) {
        const head = document.createElement("div");
        head.className = "dsp-section";
        head.textContent = `installed packages · ${data.dependencies.length}`;
        list.appendChild(head);
        for (const dep of data.dependencies) {
          const row = document.createElement("div");
          row.className = "dsp-row";
          const label = document.createElement("span");
          label.className = "dsp-row-name";
          label.textContent = `${dep.name} · ${dep.spec}`;
          const btn = document.createElement("button");
          btn.className = "dsh-tb-btn dsp-remove";
          btn.title = "Remove";
          btn.innerHTML = lucide("trash", 12);
          btn.addEventListener("click", () => run("remove", dep.name));
          row.appendChild(label);
          row.appendChild(btn);
          list.appendChild(row);
        }
      }
      if (!data.bundles.length && !data.dependencies.length) {
        const empty = document.createElement("div");
        empty.className = "dsp-empty";
        empty.textContent = "no out-of-tree plugins installed";
        list.appendChild(empty);
      }
    } catch (error) {
      status.textContent = `plugin_list failed: ${error}`;
    }
  };

  const run = async (action, name) => {
    if (!invoke) return;
    logLine(`> ${action} ${name}`, "cmd");
    input.disabled = true;
    try {
      const output = await invoke("plugin_manage", { action, name });
      if (output.trim()) logLine(output.trim(), "out");
      logLine(`${action} ${name} — done`, "ok");
      if (action === "add") {
        logLine("restart the harness to compose the new bundle layer", "warn");
      }
      await refresh();
    } catch (error) {
      logLine(String(error), "err");
    } finally {
      input.disabled = false;
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
      panel.classList.toggle("dsh-hidden");
      if (!panel.classList.contains("dsh-hidden")) refresh();
    });
  }
}

function ensureBody() {
  if (document.body) {
    appendLayers();
    buildTitlebar();
  } else {
    new MutationObserver(() => ensureBody()).observe(document.documentElement, { childList: true });
  }
}

ensureBody();
