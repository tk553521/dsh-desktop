// Generate logo.svg (a black DeepSeek whale on a white rounded tile) from the
// official DeepSeek whale path shipped in the bundled frontend's favicon.
// Re-run after `prepare-runtime` if the favicon ever changes.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const favicon = join(
  root,
  "src-tauri",
  "resources",
  "runtime",
  "node_modules",
  "@deepseek-ai",
  "dsh-web-frontend",
  "dist",
  "favicon.svg",
);

const source = readFileSync(favicon, "utf8");
const match = source.match(/\sd="([^"]+)"/);
if (!match) throw new Error("whale path not found in favicon.svg");
const d = match[1];

// The whale occupies the 0..50 box in the favicon; center it on the tile.
const logo = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="32" y="32" width="960" height="960" rx="224" fill="#ffffff"/>
  <g transform="translate(512 512) scale(14) translate(-25 -25)">
    <path d="${d}" fill="#000000"/>
  </g>
</svg>
`;

writeFileSync(join(root, "logo.svg"), logo);
console.log("logo.svg written (black whale on white tile)");
