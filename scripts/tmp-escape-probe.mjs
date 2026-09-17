/**
 * Throwaway probe: reproduce ui-settings-e2e 7c and report why Escape
 * does not close the settings dialog.
 */
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const webDist = join(repoRoot, "packages", "web", "dist");
const PORT = 5398;
const APP = `http://127.0.0.1:${PORT}/`;

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
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("no");
  }
});

import { readFileSync } from "node:fs";

await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(APP);
await page.waitForSelector(".connect__cmd", { timeout: 10000 });
await page.getByRole("button", { name: "설정" }).click();
await page.waitForSelector('[role="dialog"][aria-label="설정"]');

const focusableCount = await page.evaluate(() => {
  const panel = document.querySelector('[role="dialog"][aria-label="설정"]');
  return panel
    ? panel.querySelectorAll(
        "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ).length
    : 0;
});
await page.getByRole("tab", { name: "동작" }).click();
await page
  .getByRole("radiogroup", { name: "보내기 키" })
  .getByRole("radio", { name: "Enter", exact: true })
  .focus();
let steps = 0;
for (; steps < focusableCount + 2; steps += 1) {
  await page.keyboard.press("Tab");
  const inside = await page.evaluate(
    () =>
      document
        .querySelector('[role="dialog"][aria-label="설정"]')
        ?.contains(document.activeElement) === true,
  );
  if (!inside) break;
}
const before = await page.evaluate(() => ({
  active: document.activeElement?.className ?? String(document.activeElement),
  tag: document.activeElement?.tagName,
  overlays: [...document.querySelectorAll(".modal, .palette, .onboarding")].map((el) =>
    `${el.tagName}.${el.className}`.slice(0, 80),
  ),
  text: (document.activeElement?.textContent ?? "").slice(0, 40),
}));
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
const after = await page.evaluate(() => ({
  dialogCount: document.querySelectorAll('[role="dialog"][aria-label="설정"]').length,
  active: document.activeElement?.className ?? String(document.activeElement),
}));
console.log(JSON.stringify({ focusableCount, walked: steps, before, after }, null, 2));
await browser.close();
server.close();
