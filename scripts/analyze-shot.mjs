// Pixel-level analysis of a screenshot for design verification (no vision model).
// Usage: node scripts/analyze-shot.mjs <file.png>
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const sharp = require(join(root, "src-tauri", "resources", "runtime", "node_modules", "sharp"));

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/analyze-shot.mjs <file.png>");
  process.exit(1);
}

const { data, info } = await sharp(file)
  .resize(960, null) // analysis resolution
  .raw()
  .toBuffer({ resolveWithObject: true });

const { width, height, channels } = info;
let sumR = 0, sumG = 0, sumB = 0, n = 0;
let dark = 0, bright = 0;
let aurora = 0; // saturated violet/cyan/magenta
let text = 0;   // near-white pixels
const rows = 8, cols = 8;
const cells = Array.from({ length: rows * cols }, () => ({ r: 0, g: 0, b: 0, n: 0 }));

for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * channels;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    sumR += r; sumG += g; sumB += b; n++;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (lum < 32) dark++;
    if (lum > 200) bright++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn > 28 && mx > 45) {
      let hue = 0;
      if (mx === r) hue = ((g - b) / (mx - mn) + 6) % 6;
      else if (mx === g) hue = (b - r) / (mx - mn) + 2;
      else hue = (r - g) / (mx - mn) + 4;
      hue *= 60;
      if ((hue >= 190 && hue <= 300) || (hue >= 320 && hue <= 350)) aurora++;
    }
    if (r > 150 && g > 150 && b > 160) text++;
    const ci = Math.min(rows - 1, Math.floor((y / height) * rows)) * cols + Math.min(cols - 1, Math.floor((x / width) * cols));
    cells[ci].r += r; cells[ci].g += g; cells[ci].b += b; cells[ci].n++;
  }
}

const avg = [sumR / n, sumG / n, sumB / n].map((v) => v.toFixed(1));
console.log(JSON.stringify({
  file,
  size: `${width}x${height}`,
  avgRgb: avg,
  darkPct: ((dark / n) * 100).toFixed(1),
  brightPct: ((bright / n) * 100).toFixed(1),
  textPct: ((text / n) * 100).toFixed(1),
  auroraPct: ((aurora / n) * 100).toFixed(1),
  grid: cells.map((c) => c.n ? `${Math.round(c.r / c.n)},${Math.round(c.g / c.n)},${Math.round(c.b / c.n)}` : "-"),
}, null, 2));
