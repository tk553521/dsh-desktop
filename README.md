# DSH Desktop

DeepSeek Harness（DSH）的 **Tauri 桌面版** —— 把完整的浏览器代理体验打包成一个原生 Windows 应用。一个 exe，浏览器代理能做的它都能做：会话、工具、目标（goal）、子代理（subagent）、工作流（workflow）、设置，外加一套「Aurora Engine」视觉系统和桌面窗口壳（系统托盘、窗口控制）。

> **免责声明**：本项目是**个人使用**的第三方封装，**与 DeepSeek 官方无关**，未获得 DeepSeek 官方授权、背书或支持。「DeepSeek」及相关标识归其权利方所有。本项目仅是对 `@deepseek-ai/dsh` 运行时的本地打包与界面封装。

## 许可证

本项目采用 [MIT License](./LICENSE) 开源许可。

## 架构

```
dist/index.html           启动画面（WebGL 极光、动态文字）
src-tauri/                Tauri 外壳
  src/lib.rs              启动流程：spawn/复用 `dsh web`、托盘、窗口
  scripts/init.js         生成的皮肤注入 bundle（见下文）
  resources/runtime/      内置运行时（生成产物，不入库）：
    node.exe              固定版本 Node.js v25.2.1（与原生插件 ABI 匹配）
    node_modules/         固定版本 @deepseek-ai/dsh 依赖树（即 Harness 本体）
  icons/                  应用图标集
skin/
  skin.css                完整的 --dsw-* token 重映射 + 字体 + 窗口样式
  skin.js                 极光画布、噪点、标题栏、IPC 接线
  fonts/                  Space Grotesk / Inter 可变字体 woff2
scripts/
  build-skin.mjs          把皮肤 + 字体打包成 src-tauri/scripts/init.js
  fetch-fonts.mjs         下载可变字体
  gen-icon.mjs            logo.svg -> app-icon.png（通过内置 sharp）
  cdp.ps1                 WebView2 CDP 调试探针（debug 构建暴露 :9333）
  analyze-shot.mjs        像素级截图分析
```

## 启动流程

1. 启动窗口立即打开，并实时流式展示后端各启动阶段。
2. 后台线程探测 `127.0.0.1:3080`（随后 43210–43212）：若已有存活的 `dsh web` 则直接复用；否则由内置 `node.exe` 启动 `node_modules/@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port <n>`。
3. 遵循 `DSH_HOME` 环境变量（默认 `%USERPROFILE%\.dsh`），因此会话、凭据和设置与命令行 CLI 共享。Harness 每次启动时会自动用 junction 把 `%DSH_HOME%/profiles/node_modules` 修复指向内置依赖树。
4. 服务器应答后，主窗口打开 Harness 界面，并在文档创建阶段注入皮肤。关闭窗口隐藏到托盘，代理继续运行；从托盘退出会终止整个进程树。

## 皮肤

Harness 界面通过 `--dsw-static-*` / `--dsw-alias-*` CSS 变量做了完整的 token 化；`skin.css` 把整套 token 重映射为「黑曜石 + 极光」配色（半透明表面叠加 WebGL 极光画布、噪点、胶片暗角），用内嵌可变字体覆盖排版，并加了一个悬浮玻璃窗口控制胶囊，图标全部使用 Lucide 线性图标（无任何 emoji）。

## 插件架构（Cordis）

这个 exe 运行的是真正的「一切皆插件」依赖树 —— 它本身就是 web profile：约 100 个内置 host + client 插件从内置运行时启动。桌面应用内支持完整的插件结构：

- **补丁层（Patch layers）** —— `%DSH_HOME%/profiles/web/cordis.patch.yml` 和 `%DSH_HOME%/cordis.patch.yml` 会被监听并像 CLI 一样热重载。
- **Bundle 层** —— 声明了 `dsh.bundle.patch` 的包会加入 `dsh.profile.bundles`，其补丁在启动时合成。
- **客户端插件** —— 声明了 `dsh.client`（platform 为 "web"）以及 `exports["./client"]` 入口的包，会在 `/plugins/<pkg>/client.js` 提供并自动注入 `window.__DSH_BOOT__`。
- **插件管理器** —— 悬浮标题栏的拼图按钮打开玻璃面板：通过内置 `pnpm`（v11，standalone）安装/卸载、列出各层和已安装包、重启 Harness 以合成新 bundle。它对接的正是 CLI 所用的 `dsh plugin --profile web` pnpm 协议，因此 registry 源、`file:`/`link:` 路径以及 git 源都可以用。

`plugins/demo-plugin/` 是一个可运行示例（server 半区带 `/demo` 路由 + browser 半区带一个徽标）；在面板里用 `file:<repo>/plugins/demo-plugin` 即可安装。

已知限制：`dsh plugin` 需要 pnpm；exe 内置了它（见 `resources/tools/pnpm/`）。git 托管插件的构建脚本默认被 pnpm 的供应链策略拦截，需在 profile 的 `pnpm-workspace.yaml` 中通过 `allowBuilds` 放行。

## 构建

```powershell
npm install
node scripts/fetch-fonts.mjs     # 首次执行一次；下载 woff2 字体
node scripts/build-skin.mjs      # 重新生成 src-tauri/scripts/init.js
npx tauri icon app-icon.png      # 首次执行一次；生成图标集（需要 app-icon.png）
npx tauri build                  # release + NSIS 安装包（target/release/bundle）
```

首次构建需要从零编译 Tauri（耗时数分钟）。debug 构建会把 WebView2 暴露在 `http://127.0.0.1:9333/json` 供 CDP 调试：
`pwsh scripts/cdp.ps1 -Eval "document.title"`。

## 运行时布局说明

- 内置 `node_modules` 是正在运行的 `@deepseek-ai/dsh@0.1.0-rc.6` 安装的逐字节拷贝，因此原生插件（sharp、node-pty、ripgrep）与内置 Node ABI 完全匹配。
- `resources/runtime/` 是生成产物（见 `.gitignore`）；用 robocopy 复制 Harness 依赖树加上匹配的 `node.exe` 即可补齐。
