// Crop a screenshot region and report color statistics.
// Usage: node scripts/crop-analyze.mjs <file> <left> <top> <width> <height>
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const sharp = require(join(root, "src-tauri", "resources", "runtime", "node_modules", "sharp"));

const [file, left, top, width, height] = process.argv.slice(2);
const { data, info } = await sharp(file)
  .extract({ left: +left, top: +top, width: +width, height: +height })
  .raw()
  .toBuffer({ resolveWithObject: true });

let sumR = 0, sumG = 0, sumB = 0, n = 0;
let minL = 255, maxL = 0;
let sat = 0;
const hist = {};
for (let i = 0; i < data.length; i += info.channels) {
  const r = data[i], g = data[i + 1], b = data[i + 2];
  sumR += r; sumG += g; sumB += b; n++;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum < minL) minL = lum;
  if (lum > maxL) maxL = lum;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  sat += mx - mn;
  const key = `${r >> 4},${g >> 4},${b >> 4}`;
  hist[key] = (hist[key] || 0) + 1;
}
const topColors = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 6)
  .map(([k, c]) => `rgb(${k.split(",").map((v) => (v << 4)).join(",")}) x${c}`);

console.log(JSON.stringify({
  region: `${left},${top} ${width}x${height}`,
  avg: [sumR / n, sumG / n, sumB / n].map((v) => v.toFixed(1)),
  lumRange: `${minL.toFixed(0)}..${maxL.toFixed(0)}`,
  meanSat: (sat / n).toFixed(1),
  distinctColors: Object.keys(hist).length,
  topColors,
}, null, 2));
