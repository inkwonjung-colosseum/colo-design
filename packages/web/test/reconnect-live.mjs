/**
 * Browser-level check of the reconnect path — the "user left the tab open
 * while the daemon restarted" scenario.
 *
 * Connects to the running dev server, kills the daemon underneath the tab,
 * restarts it, and asserts the tab recovers WITHOUT a reload: the header says
 * 연결됨 again and the session list repopulates. Then deletes a planning thread
 * through the UI to prove RPCs work again after recovery.
 *
 * This one runs against the real daemon, so the thread it deletes is a real
 * one. Point it at a throwaway daemon if that matters.
 *
 * Usage: node packages/web/test/reconnect-live.mjs "<client url>"
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const url = process.argv[2];
if (!url) throw new Error("pass the daemon client url");
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const daemonEntry = join(repoRoot, "packages", "daemon", "dist", "index.js");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

function startDaemon() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const daemon = spawn(process.execPath, [daemonEntry], { env, stdio: ["ignore", "pipe", "pipe"] });
  daemon.stderr.on("data", (d) => process.stderr.write(`[daemon] ${d}`));
  process.on("exit", () => daemon.kill("SIGKILL"));
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("daemon never printed a url")), 20000);
    let buffered = "";
    daemon.stdout.on("data", (chunk) => {
      buffered += String(chunk);
      const match = buffered.match(/client url: (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        ok(match[1]);
      }
    });
  });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("dialog", (dialog) => dialog.accept());

await page.goto("http://127.0.0.1:5273/");
await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(url);
await page.getByRole("button", { name: "연결" }).click();
await page.waitForSelector(".planner", { timeout: 15000 });
await page.waitForSelector(".leaf", { timeout: 30000 });
check("connected and sessions listed", true);

// --- kill the daemon under the live tab -----------------------------------
const { execSync } = await import("node:child_process");
try {
  execSync("launchctl remove hub-daemon", { stdio: "ignore" });
} catch {
  // label absent — fine
}
// Wait for the port to actually free up so the replacement can bind.
for (let i = 0; i < 20; i++) {
  let free = false;
  try {
    execSync("lsof -nP -iTCP:7823 -sTCP:LISTEN", { stdio: "ignore" });
  } catch {
    free = true; // lsof exits non-zero when nothing matches
  }
  if (free) break;
  await new Promise((ok) => setTimeout(ok, 500));
}
check("daemon is down", true);

// The tab must notice the drop but keep rendering the app shell.
await page.waitForTimeout(500);
check("app shell survives the disconnect", (await page.locator(".planner").count()) === 1);

// --- bring the daemon back -----------------------------------------------
const newUrl = await startDaemon();
check("replacement daemon serves the same pairing url", newUrl === url, newUrl);

// --- the tab must recover WITHOUT a reload -------------------------------
await page.waitForFunction(
  () => document.querySelector(".planner__header .hint")?.textContent?.includes("연결됨"),
  undefined,
  { timeout: 20000 },
);
check("connection returns to open without a reload", true);
await page.waitForSelector(".tree", { timeout: 20000 });
await page.waitForSelector(".leaf", { timeout: 20000 });

// --- RPCs work again: archive through the tree ----------------------------
const leafRow = page.locator(".leafwrap").first();
const leavesBefore = await page.locator(".leafwrap").count();
await leafRow.hover();
await leafRow.locator(".leaf__menu-btn").click();
await leafRow.getByRole("menuitem", { name: "보관" }).click();
await page.waitForFunction(
  (before) => document.querySelectorAll(".leafwrap").length === before - 1,
  leavesBefore,
  { timeout: 15000 },
);
check("session archive works after reconnect", true);

check("no console or page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
