// Fetch variable woff2 fonts (latin) from Google Fonts for embedding into the skin.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "skin", "fonts");
mkdirSync(outDir, { recursive: true });

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const families = [
  { name: "SpaceGrotesk", css: "Space+Grotesk:wght@300..700" },
  { name: "Inter", css: "Inter:opsz,wght@14..32,100..900" },
];

for (const { name, css } of families) {
  const target = join(outDir, `${name}.woff2`);
  if (existsSync(target)) {
    console.log(`[skip] ${name} already present`);
    continue;
  }
  const cssUrl = `https://fonts.googleapis.com/css2?family=${css}&display=swap`;
  const res = await fetch(cssUrl, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`css fetch failed ${res.status} for ${name}`);
  const text = await res.text();
  // Grab the LAST latin (non-italic) woff2 block — variable font, full range.
  const blocks = [...text.matchAll(/\/\* ([a-z-]+) \*\/\s*@font-face\s*\{[^}]*?src:\s*url\((https:[^)]+\.woff2)\)[^}]*\}/g)];
  let url = null;
  for (const [, subset, candidate] of blocks) {
    if (subset === "latin") url = candidate;
  }
  if (!url) {
    console.error(`no latin woff2 for ${name}; blocks:`, blocks.map((b) => b[1]));
    process.exit(1);
  }
  const font = await fetch(url, { headers: { "User-Agent": UA } });
  if (!font.ok) throw new Error(`font fetch failed ${font.status}`);
  writeFileSync(target, Buffer.from(await font.arrayBuffer()));
  console.log(`[ok] ${name} <- ${url} (${(font.headers.get("content-length") ?? "?")} bytes)`);
}
console.log("fonts done");
