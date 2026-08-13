// Evaluate a JS file in the live WebView2 via CDP and print exceptions/results.
// Usage: node scripts/cdp-eval.mjs <file.js> [urlMatch]
import { readFileSync } from "node:fs";

const file = process.argv[2];
const match = process.argv[3] || "";
const code = readFileSync(file, "utf8");

const targets = await (await fetch("http://127.0.0.1:9333/json")).json();
const target = targets.find((t) => t.type === "page" && t.url.includes(match)) || targets.find((t) => t.type === "page");
if (!target) {
  console.error("no page target");
  process.exit(1);
}
console.log("target:", target.url);

const ws = new WebSocket(target.webSocketDebuggerUrl);
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("cdp timeout")), 30000);
  ws.onopen = () => {
    ws.send(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: code, returnByValue: true, awaitPromise: true, timeout: 20000 },
    }));
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id === 1) {
      clearTimeout(timer);
      resolve(msg);
    }
  };
  ws.onerror = (e) => reject(new Error("ws error"));
});
ws.close();

if (result.result?.exceptionDetails) {
  console.error("EXCEPTION:", JSON.stringify(result.result.exceptionDetails, null, 2));
  process.exit(1);
}
console.log("RESULT:", JSON.stringify(result.result?.result ?? null, null, 2));
