// A tiny site with known contents, used to prove each chaos rule in isolation.
// Served on two hostnames (127.0.0.1 and localhost) so one of them can play
// the role of a "third party".
import http from "node:http";
import type { AddressInfo } from "node:net";

export const API_CALLS = 10;
export const BIG_CSS_BYTES = 300_000;

export interface Fixture {
  /** First-party origin the tests load. */
  url: string;
  /** Same server, different site — plays the third party. */
  thirdPartyOrigin: string;
  close: () => Promise<void>;
}

export async function startFixture(): Promise<Fixture> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const send = (type: string, body: string | Buffer, status = 200) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };

    if (u.pathname === "/") {
      const tp = `http://localhost:${(server.address() as AddressInfo).port}`;
      return send(
        "text/html",
        `<!doctype html><html><head><title>Breakit fixture</title>
<link rel="stylesheet" href="/big.css">
<style>body{font:16px system-ui;margin:32px}img{margin:4px}</style></head><body>
<h1>Fixture</h1><div id="status">waiting</div>
<div>${Array.from({ length: 6 }, (_, i) => `<img src="/img/${i}.svg" width="80" height="80">`).join("")}
<img src="${tp}/img/tp.svg" width="80" height="80"></div>
${Array.from({ length: 4 }, (_, i) => `<script src="/js/${i}.js"></script>`).join("\n")}
<script src="${tp}/js/tp.js"></script>
<script>
addEventListener("load", async () => {
  let ok = 0, bad = 0;
  await Promise.all(Array.from({length:${API_CALLS}}, (_, i) =>
    fetch("/api/items/" + i).then(async r => { await r.text(); r.ok ? ok++ : bad++; }).catch(() => bad++)));
  document.getElementById("status").textContent = "api ok " + ok + " / failed " + bad;
});
</script></body></html>`,
      );
    }
    if (u.pathname === "/big.css") {
      // 300 KB of comment: a stylesheet blocks load, so its transfer time is
      // what a bandwidth cap should visibly stretch.
      return send("text/css", `/*${"x".repeat(BIG_CSS_BYTES - 4)}*/`);
    }
    if (u.pathname.startsWith("/img/")) {
      const hue = (u.pathname.length * 47) % 360;
      return send(
        "image/svg+xml",
        `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="hsl(${hue} 60% 60%)"/></svg>`,
      );
    }
    if (u.pathname.startsWith("/js/")) {
      return send("text/javascript", `window.__n=(window.__n||0)+1;`);
    }
    if (u.pathname.startsWith("/api/")) {
      res.setHeader("access-control-allow-origin", "*");
      return send("application/json", JSON.stringify({ ok: true, path: u.pathname }));
    }
    send("text/plain", "not found", 404);
  });

  // No host: listen dual-stack so `localhost` works whether it resolves to ::1 or 127.0.0.1.
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    thirdPartyOrigin: `http://localhost:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
