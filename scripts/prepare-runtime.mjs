// Prepare the bundled DSH runtime before a tauri build so a clean
// `git clone` + `npm install` + `npm run tauri build` needs no manual steps:
//
//   src-tauri/resources/runtime/node.exe        <- the Node that also runs `npm ci`
//                                                    (guarantees native-module ABI match)
//   src-tauri/resources/runtime/node_modules/   <- `npm ci` from the committed
//                                                    package.json + package-lock.json
//   src-tauri/resources/tools/pnpm/pnpm.exe     <- standalone pnpm for the plugin panel
//   dist/fonts/*.woff2                          <- synced from the committed skin/fonts
//
// Idempotent: everything is skipped unless the manifests changed or a required
// file is missing. Network is only needed the first time (or after a version bump).
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(root, "src-tauri", "resources", "runtime");
const manifestFile = join(runtimeDir, "package.json");
const lockFile = join(runtimeDir, "package-lock.json");
const nodeExe = join(runtimeDir, "node.exe");
const binJs = join(
  runtimeDir,
  "node_modules",
  "@deepseek-ai",
  "dsh",
  "lib",
  "bin.js",
);
const stampFile = join(runtimeDir, ".prepared");
const toolsDir = join(root, "src-tauri", "resources", "tools", "pnpm");
const pnpmExe = join(toolsDir, "pnpm.exe");
const distFontsDir = join(root, "dist", "fonts");
const skinFontsDir = join(root, "skin", "fonts");

// Standalone pnpm: a Node SEA exe (`@pnpm/win-x64`) whose embedded entry
// loads the esbuild bundle from `dist/pnpm.mjs` next to the exe at runtime —
// so the tool directory must ship the exe AND the `pnpm` package's `dist/`.
const PNPM_VERSION = "11.21.0";

function fail(msg) {
  console.error(`[prepare-runtime] ERROR: ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.error) fail(`failed to spawn ${cmd}: ${res.error.message}`);
  return res.status ?? 0;
}

// npm-cli.js lives next to the node that is running this script (the same
// install that `npm run` uses), so `npm ci` and the bundled node.exe share
// the exact same runtime/ABI.
function npmCli() {
  const candidate = join(
    dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  return existsSync(candidate) ? candidate : null;
}

function syncDistFonts() {
  mkdirSync(distFontsDir, { recursive: true });
  for (const name of readdirSync(skinFontsDir)) {
    if (!name.endsWith(".woff2")) continue;
    const src = join(skinFontsDir, name);
    const dst = join(distFontsDir, name);
    if (!existsSync(dst)) {
      copyFileSync(src, dst);
      console.log(`[prepare-runtime] dist/fonts/${name} <- skin/fonts`);
    }
  }
}

function ensureNode() {
  if (existsSync(nodeExe)) return;
  if (process.platform !== "win32") {
    fail(
      "this app is Windows-only (NSIS bundle + win-x64 runtime); build it on Windows",
    );
  }
  copyFileSync(process.execPath, nodeExe);
  console.log(`[prepare-runtime] node.exe <- ${process.execPath} (${process.version})`);
}

function manifestFingerprint() {
  const hash = createHash("sha1");
  hash.update(readFileSync(manifestFile));
  hash.update(readFileSync(lockFile));
  return hash.digest("hex");
}

function runtimeUpToDate() {
  if (!existsSync(nodeExe) || !existsSync(binJs) || !existsSync(stampFile)) {
    return false;
  }
  let stamp = "";
  try {
    stamp = readFileSync(stampFile, "utf8").trim();
  } catch {
    return false;
  }
  return stamp === manifestFingerprint();
}

function installRuntime() {
  if (runtimeUpToDate()) {
    console.log(`[prepare-runtime] runtime already prepared (${binJs})`);
    return;
  }

  mkdirSync(runtimeDir, { recursive: true });
  if (!existsSync(manifestFile) || !existsSync(lockFile)) {
    fail("runtime manifest missing (package.json / package-lock.json)");
  }

  ensureNode();

  // `npm ci` is deterministic: it installs exactly the graph pinned in the
  // committed package-lock.json (integrity-verified), ignoring semver ranges.
  const cli = npmCli();
  const args = ["ci", "--no-audit", "--no-fund", "--loglevel=error"];
  console.log(`[prepare-runtime] npm ci (cwd: ${runtimeDir})`);
  let status;
  if (cli) {
    status = run(process.execPath, [cli, ...args], { cwd: runtimeDir });
  } else {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    status = run(npmCmd, args, { cwd: runtimeDir });
  }
  if (status !== 0) {
    fail("npm ci failed; see output above");
  }
  if (!existsSync(binJs)) {
    fail(`runtime incomplete after npm ci (missing ${binJs})`);
  }
  writeFileSync(stampFile, manifestFingerprint());
  console.log(`[prepare-runtime] runtime ready (${binJs})`);
}

function ensurePnpm() {
  const distDir = join(toolsDir, "dist");
  if (existsSync(pnpmExe) && existsSync(join(distDir, "pnpm.mjs"))) {
    console.log("[prepare-runtime] pnpm.exe + dist/ already present");
    return;
  }
  console.log(`[prepare-runtime] fetching standalone pnpm ${PNPM_VERSION} ...`);
  const cli = npmCli();
  if (!cli) {
    console.warn(
      "[prepare-runtime] WARN: npm-cli.js not found next to node; skipping pnpm (plugin panel will show pnpm unavailable)",
    );
    return;
  }
  const tmp = join(root, ".tmp-pnpm");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  // One install invocation: sequential `npm install --prefix` calls prune each
  // other's packages (nothing is saved to a manifest), so both specs must go
  // into a single command.
  const status = run(
    process.execPath,
    [
      cli,
      "install",
      `@pnpm/win-x64@${PNPM_VERSION}`,
      `pnpm@${PNPM_VERSION}`,
      "--prefix",
      tmp,
      "--no-save",
      "--no-package-lock",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ],
    { cwd: tmp },
  );
  // The SEA exe resolves `dist/pnpm.mjs` relative to itself, so the bundle
  // must sit next to the exe. `pnpm@<version>` carries that dist/ payload
  // (pnpm.mjs, worker.js, node-gyp, templates, ...) in its package.
  const exeSrc = join(tmp, "node_modules", "@pnpm", "win-x64", "pnpm.exe");
  const distSrc = join(tmp, "node_modules", "pnpm", "dist");
  if (status === 0 && existsSync(exeSrc) && existsSync(distSrc)) {
    mkdirSync(toolsDir, { recursive: true });
    copyFileSync(exeSrc, pnpmExe);
    rmSync(distDir, { recursive: true, force: true });
    cpSync(distSrc, distDir, { recursive: true });
    console.log(`[prepare-runtime] pnpm.exe + dist/ (v${PNPM_VERSION}) installed`);
  } else {
    console.warn(
      "[prepare-runtime] WARN: could not fetch pnpm — plugin install will be unavailable, but the build continues",
    );
  }
  rmSync(tmp, { recursive: true, force: true });
}

syncDistFonts();
ensureNode();
installRuntime();
ensurePnpm();
console.log("[prepare-runtime] done");
