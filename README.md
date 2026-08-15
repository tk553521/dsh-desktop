# DSH Desktop

DeepSeek Harness（DSH）的 **Tauri 桌面版** —— 把完整的浏览器代理体验打包成一个原生 Windows 应用。一个 exe，浏览器代理能做的它都能做：会话、工具、目标（goal）、子代理（subagent）、工作流（workflow）、设置，外加一套「Aurora Engine」视觉系统和桌面窗口壳（系统托盘、窗口控制）。

> **免责声明**：本项目是**个人使用**的第三方封装，**与 DeepSeek 官方无关**，未获得 DeepSeek 官方授权、背书或支持。「DeepSeek」及相关标识归其权利方所有。本项目仅是对 `@deepseek-ai/dsh` 运行时的本地打包与界面封装。

## 图标

- **应用图标（exe / 快捷方式）**：DeepSeek 鲸鱼娘图标，来自 [fornarwhal/deepseek-whale-girl-icon](https://github.com/fornarwhal/deepseek-whale-girl-icon)，许可证 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)（署名—非商业性使用—相同方式共享）。
- **界面标记（标题栏 / 启动画面）**：黑色鲸鱼，轮廓取自 DeepSeek 官方 favicon。

## 许可证

本项目采用 [MIT License](./LICENSE) 开源许可。

## 架构

```
dist/index.html           启动画面（WebGL 极光、动态文字）
src-tauri/                Tauri 外壳
  src/lib.rs              启动流程：spawn/复用 `dsh web`、托盘、窗口
  scripts/init.js         生成的皮肤注入 bundle（见下文）
  resources/runtime/      内置运行时（清单入库，产物生成，见下文）：
    package.json          提交的依赖清单（@deepseek-ai/dsh@0.1.0-rc.6）
    package-lock.json     提交的锁定文件（确定性 npm ci 的依据）
    node.exe              由 scripts/prepare-runtime.mjs 复制构建机 node
    node_modules/         由 `npm ci` 生成（不入库）
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
- **插件管理器** —— 悬浮标题栏的拼图按钮打开玻璃面板：输入 GitHub 仓库地址（或任意 pnpm 可识别的包 spec）即可安装，已安装插件带开关，通过 Cordis HMR 热插拔，无需重启 Harness。安装仍走 CLI 所用的 `dsh plugin --profile web` pnpm 协议，因此 registry 源、`file:`/`link:` 路径以及 git 源都可以用。
  （带浏览器半的插件在热切换后会自动等待 host graph 更新并刷新 WebView；Harness 进程和会话不重启。）

`plugins/demo-plugin/` 是一个可运行示例（server 半区带 `/demo` 路由 + browser 半区带一个徽标）；在面板里用 `file:<repo>/plugins/demo-plugin` 即可安装。

已知限制：`dsh plugin` 需要 pnpm；exe 内置了它（见 `resources/tools/pnpm/`）。git 托管插件的构建脚本默认被 pnpm 的供应链策略拦截；桌面面板会读取 pnpm 报出的 build key 并自动用 `--allow-build` 重试放行。

## 构建

干净机器上只需两步（`npm run tauri` 会自动触发 `pretauri` 准备内置运行时，无需任何手动复制）：

```powershell
npm install
npm run tauri build            # release + NSIS 安装包（target/release/bundle）
```

`npm run tauri build` 时，`pretauri`（`scripts/prepare-runtime.mjs`）会自动：

1. 把提交的 `skin/fonts/*.woff2` 同步到 `dist/fonts/`（启动画面字体）；
2. 复制构建机当前 `node.exe` 到 `src-tauri/resources/runtime/node.exe`；
3. 用提交的 `package-lock.json` 执行 `npm ci`，生成 `node_modules`（原生插件均为 N-API/预编译，与 Node 版本解耦，无需本地编译器）；
4. 从 npm registry 拉取独立版 `pnpm.exe`（插件面板用，离线时跳过并仅影响插件安装）。

首次构建需从零下载约 255 MB 依赖并编译 Tauri（耗时数分钟）；之后增量构建会自动跳过已就绪的运行时。原生字体（`skin/fonts`）与图标集均已入库，`scripts/fetch-fonts.mjs`、`npx tauri icon` 只在**改动**皮肤字体/图标后才需要重跑。

debug 构建会把 WebView2 暴露在 `http://127.0.0.1:9333/json` 供 CDP 调试：
`pwsh scripts/cdp.ps1 -Eval "document.title"`。

## 运行时布局说明

- `resources/runtime/package.json` + `package-lock.json` 是**提交的清单**，`node_modules` 由 `npm ci` 按锁定文件确定性生成（integrity 校验），等价于逐字节复刻一份已知可用的 `@deepseek-ai/dsh@0.1.0-rc.6` 安装。
- 内置 `node.exe` 即构建机 node：它既用来跑 `npm ci`，也随应用打包，因此原生插件（sharp、node-pty、ripgrep 等，均为 N-API/预编译/独立 exe）ABI 必然匹配。若想固定版本，可自行把某个 node.exe 放到 `resources/runtime/`（脚本发现已存在则跳过复制）。
- `node_modules/`、`node.exe`、`tools/` 为生成产物（见 `.gitignore`）。
