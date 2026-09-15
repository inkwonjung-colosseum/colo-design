/**
 * Smoke check against an already running daemon and web dev server.
 *
 * Confirms the connect handoff, the connected repo's phase, and the session
 * list, without spending a model turn. It starts nothing.
 *
 * Usage: node scripts/smoke-live.mjs "$(grep -o 'ws://[^ ]*' /tmp/hub-daemon.log)"
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const url = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto("http://127.0.0.1:5273/");
await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(url);
await page.getByRole("button", { name: "연결" }).click();
await page.waitForSelector(".planner", { timeout: 15000 });
await page.waitForTimeout(2500);

// Either the repo is still syncing or it is ready; both are a healthy answer,
// and which one it is says more than a pass/fail would.
const progress = await page
  .locator(".progress__head h2")
  .first()
  .innerText()
  .catch(() => null);
const sessions = await page.locator(".leaf__title").allInnerTexts();

const warnings = await page.locator(".planner__warnings .notice__text").allInnerTexts();
console.log("header:", await page.locator(".planner__header .hint").innerText());
console.log("repo:", progress ?? "ready (preview shown)");
console.log("sessions listed:", sessions.length, JSON.stringify(sessions.slice(0, 5)));
console.log("daemon warnings:", warnings.length ? warnings : "none");
console.log("page errors:", errors.length ? errors.slice(0, 3) : "none");
await page.screenshot({ path: join(tmpdir(), "hub-live.png"), fullPage: true });
await browser.close();
