/** Throwaway: screenshot the provider-room harness in both themes. */
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 300)));
page.on("console", (m) => {
  if (m.type() === "error") console.log("CONSOLEERR", m.text().slice(0, 300));
});
for (const theme of ["light", "dark"]) {
  await page.goto("http://127.0.0.1:29173/provider-harness.html");
  await page.evaluate((t) => {
    localStorage.setItem(
      "colo-design.settings",
      JSON.stringify({ theme: t, chat: { provider: "claude", model: "opus", effort: "high" } }),
    );
  }, theme);
  await page.reload();
  await page.waitForSelector(".providerlist__item", { timeout: 10000 });
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(400);
  await page.locator(".modal__panel--settings").screenshot({
    path: `scripts/tmp-provider-${theme}.png`,
  });
  // hovered + focused states on the second card
  await page.locator(".providerlist__item").nth(1).hover();
  await page.waitForTimeout(150);
  await page.locator(".modal__panel--settings").screenshot({
    path: `scripts/tmp-provider-${theme}-hover.png`,
  });
  console.log(theme, "shot done");
}
await browser.close();
