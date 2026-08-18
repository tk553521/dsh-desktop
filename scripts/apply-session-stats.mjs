// Materialize the bundled @dsh-desktop/session-stats plugin into the runtime
// dependency tree and register it in the web-app bundle patch. This runs
// after `npm ci` (and on already-prepared runtimes) so the feature is always
// present even though runtime/node_modules itself is a generated artifact.
//
// The plugin is copied to:
//   runtime/node_modules/@dsh-desktop/session-stats
// and:
//   1. added as a dependency of @deepseek-ai/dsh-web-app, which makes the
//      harness profile-boot closure link it into ~/.dsh/profiles/node_modules;
//   2. inserted into dsh-web-app/cordis.patch.yml as one loader row (the same
//      package serves the host projection half and the browser panel half).
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "plugins", "session-stats");
const runtimeDir = join(root, "src-tauri", "resources", "runtime");
const target = join(runtimeDir, "node_modules", "@dsh-desktop", "session-stats");
const webAppDir = join(runtimeDir, "node_modules", "@deepseek-ai", "dsh-web-app");
const webAppPackage = join(webAppDir, "package.json");
const webAppPatch = join(webAppDir, "cordis.patch.yml");

const ROW_ID = "dsh-desktop-session-stats";
const PATCH_ROW = `    # Desktop telemetry panel: whole-log tool detail projection + the live
    # per-session statistics card in the composer dock.
    - id: ${ROW_ID}
      name: '@dsh-desktop/session-stats'
      inject: [sessionProjections, webServer]`;

export function applySessionStats({ log = console.log } = {}) {
  if (!existsSync(source) || !existsSync(webAppPackage) || !existsSync(webAppPatch)) {
    throw new Error(
      "session-stats plugin or dsh-web-app runtime is missing; run npm ci in src-tauri/resources/runtime first",
    );
  }

  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  log("[session-stats] plugin copied into runtime node_modules");

  const pkg = JSON.parse(readFileSync(webAppPackage, "utf8"));
  if (!pkg.dependencies || typeof pkg.dependencies !== "object") pkg.dependencies = {};
  if (pkg.dependencies["@dsh-desktop/session-stats"] !== "0.1.0") {
    pkg.dependencies["@dsh-desktop/session-stats"] = "0.1.0";
    writeFileSync(webAppPackage, JSON.stringify(pkg, null, 2) + "\n");
    log("[session-stats] dsh-web-app dependency added");
  }

  const patch = readFileSync(webAppPatch, "utf8");
  if (!patch.includes(`id: ${ROW_ID}`)) {
    const anchor = "    - id: session-stats\n      name: '@deepseek-ai/dsh-session-stats'\n";
    if (!patch.includes(anchor)) {
      throw new Error(`session-stats anchor row not found in ${webAppPatch}`);
    }
    const next = patch.replace(anchor, `${anchor}\n${PATCH_ROW}`);
    writeFileSync(webAppPatch, next);
    log("[session-stats] loader row inserted into dsh-web-app bundle patch");
  } else {
    const expectedInject = "      inject: [sessionProjections, webServer]";
    const fullRow = "    - id: " + ROW_ID + "\n      name: '@dsh-desktop/session-stats'\n" + expectedInject;
    if (!patch.includes(fullRow)) {
      const previousRow = "    - id: " + ROW_ID + "\n      name: '@dsh-desktop/session-stats'\n      inject: [sessionProjections]";
      if (!patch.includes(previousRow)) {
        throw new Error(`existing ${ROW_ID} row has an unexpected form in ${webAppPatch}`);
      }
      writeFileSync(webAppPatch, patch.replace(previousRow, fullRow));
      log("[session-stats] loader row inject updated (webServer)");
    } else {
      log("[session-stats] loader row already present");
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applySessionStats();
}
