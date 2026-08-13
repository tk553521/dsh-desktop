/**
 * @dsh-desktop/demo-plugin — server half.
 * A minimal Cordis plugin: logs on load and serves a /demo route through the
 * harness webserver, proving an out-of-tree plugin runs inside the exe.
 */

const name = "@dsh-desktop/demo-plugin";
const inject = ["webServer"];

export function apply(ctx, config) {
  ctx.logger.info("[demo-plugin] loaded through the DSH Desktop exe");

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: "/demo",
        handler: async (req, res) => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405);
            res.end();
            return;
          }
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(`demo-plugin ok — served by ${name} inside the desktop app`);
        },
      }),
    "demo-plugin: /demo route",
  );
}

export { inject, name };
