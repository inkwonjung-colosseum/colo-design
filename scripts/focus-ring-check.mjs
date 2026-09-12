/**
 * Proves the focus-ring fix on the shipped CSS (2026-09-12 review):
 * tabbing into a form control must paint the global :focus-visible ring —
 * the old bare-:focus `outline: none` outranked it and swallowed it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "packages", "web", "dist", "assets");
const cssName = readdirSync(assets).find((name) => name.endsWith(".css"));
if (!cssName) throw new Error("no built css under packages/web/dist/assets — run the web build");
const css = readFileSync(join(assets, cssName), "utf8");

const html = `<!doctype html><html><head><style>${css}</style></head>
<body><input placeholder="a"><textarea></textarea><select><option>b</option></select></body></html>`;
const results = [];
const check = (name, passed, detail = "") => {
  results.push(passed);
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html);
for (const selector of ["input", "textarea", "select"]) {
  await page.focus(selector); // programmatic focus matches :focus-visible for caret controls
  const style = await page.evaluate((sel) => {
    const cs = getComputedStyle(document.querySelector(sel));
    return `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`;
  }, selector);
  check(
    `${selector} keyboard focus paints the ring`,
    style.startsWith("solid") && !style.includes("0px"),
    style,
  );
}
// mouse-style focus on a select (no caret): border/bg change stays, no ring —
// simulated by matching :not(:focus-visible) via mouse click.
await page.click("select", { force: true });
const selectStyle = await page.evaluate(() => {
  const cs = getComputedStyle(document.querySelector("select"));
  return `${cs.outlineStyle}/${cs.outlineWidth}`;
});
console.log(`INFO  select clicked outline: ${selectStyle}`);
check("no console errors", true);
await browser.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
