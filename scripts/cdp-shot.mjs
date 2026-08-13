// Poll CDP for a matching page and screenshot it the moment it appears.
// Usage: node scripts/cdp-shot.mjs <out.png> <urlMatch>
import { writeFileSync } from "node:fs";

const out = process.argv[2];
const match = process.argv[3] || "";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const cdpShot = (target) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => reject(new Error("timeout")), 15000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "png" } }));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id === 1) {
        clearTimeout(timer);
        resolve(msg.result?.data || null);
      }
    };
    ws.onerror = () => reject(new Error("ws error"));
  });

let captured = null;
const deadline = Date.now() + 25000;
while (Date.now() < deadline && !captured) {
  try {
    const targets = await (await fetch("http://127.0.0.1:9333/json")).json();
    const target = targets.find((t) => t.type === "page" && t.url.includes(match));
    if (target) {
      const data = await cdpShot(target);
      if (data) {
        writeFileSync(out, Buffer.from(data, "base64"));
        captured = target.url;
      }
    }
  } catch (_) {}
  if (!captured) await delay(90);
}
console.log(captured ? `captured ${captured} -> ${out}` : "no target matched in time");
