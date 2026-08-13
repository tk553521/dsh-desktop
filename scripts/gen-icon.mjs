// Rasterize logo.svg -> app-icon.png (1024) using the sharp bundled in the runtime tree.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const sharp = require(join(root, "src-tauri", "resources", "runtime", "node_modules", "sharp"));

const svg = readFileSync(join(root, "logo.svg"));
await sharp(svg, { density: 300 })
  .resize(1024, 1024)
  .png({ compressionLevel: 9 })
  .toFile(join(root, "app-icon.png"));
console.log("app-icon.png written");
