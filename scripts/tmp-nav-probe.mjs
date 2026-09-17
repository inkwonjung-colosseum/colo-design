/** Throwaway probe: open settings on the connect screen N times, dump nav. */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(resolve(here, ".."), "packages", "web", "dist");
const PORT = 5399;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
const server = createServer((req, res) => {
  const path = req.url.split("?")[0];
  const file = path === "/" ? join(webDist, "index.html") : join(webDist, path);
  try {
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404);
    res.end("no");
  }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 200)));
page.on("console", (m) => {
  if (m.type() === "error") console.log("CONSOLEERR", m.text().slice(0, 200));
});
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForSelector(".connect__cmd", { timeout: 10000 });
await page.getByRole("button", { name: "설정" }).click();
await page.waitForSelector('[role="dialog"][aria-label="설정"]');
for (let i = 0; i < 6; i += 1) {
  const nav = await page.locator(".settings__navItem").allInnerTexts();
  console.log(`t+${i * 250}ms nav=`, JSON.stringify(nav));
  if (nav.length >= 7) break;
  await page.waitForTimeout(250);
}
const shot = await page
  .locator(".modal__panel--settings")
  .screenshot({ path: "scripts/tmp-nav-probe.png" });
console.log("shot bytes:", shot?.byteLength ?? 0);
await browser.close();
server.close();
