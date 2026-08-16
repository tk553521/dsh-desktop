// Apply the hot-reload-safe version of @dsh-desktop/win32-pty to the current
// DSH web profile.
//
// The upstream plugin originally monkey-patched ctx.subprocess without a
// Cordis ctx.effect disposer, so hot-disabling it left the runtime patched and
// hot-re-enabling was blocked by the module-level WeakSet. This script syncs
// the fixed plugin source from plugins/win32-pty into the installed package.
//
// Usage:
//   node scripts/apply-win32-pty-hot-reload.mjs
//
// It is idempotent: re-running simply re-copies the same fixed files.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "plugins", "win32-pty");

function dshHome() {
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim()) {
    return process.env.DSH_HOME.trim();
  }
  if (process.env.USERPROFILE) {
    return join(process.env.USERPROFILE, ".dsh");
  }
  return join(process.env.HOME || ".", ".dsh");
}

function targetPackageDir() {
  const home = dshHome();
  return join(home, "profiles", "web", "node_modules", "@dsh-desktop", "win32-pty");
}

export function applyWin32PtyHotReload({ log = console.log } = {}) {
  const target = targetPackageDir();
  if (!existsSync(join(source, "package.json")) || !existsSync(join(source, "lib", "index.js"))) {
    throw new Error("win32-pty plugin source is missing; expected plugins/win32-pty");
  }
  if (!existsSync(target)) {
    log(`[win32-pty] not installed in web profile, skipping: ${target}`);
    return false;
  }

  mkdirSync(join(target, "lib"), { recursive: true });
  cpSync(source, target, { recursive: true });
  log(`[win32-pty] hot-reload-safe plugin copied to ${target}`);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  applyWin32PtyHotReload();
}
