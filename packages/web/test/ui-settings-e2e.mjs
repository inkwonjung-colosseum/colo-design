/**
 * Settings panel check. Free: no daemon, no model turn.
 *
 * The panel is reachable from the connect screen on purpose — the theme is a
 * browser preference and should not need a daemon to change — so the whole
 * thing can be driven against the built app served from disk.
 *
 * Prerequisite: `pnpm --filter @drafthouse/web build`
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const webDist = join(repoRoot, "packages", "web", "dist");
const PORT = 5397;
const APP = `http://127.0.0.1:${PORT}/`;

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") throw new Error(`check("${name}") was called without a verdict`);
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

function serveDist() {
  const server = createServer((req, res) => {
    const requested = (req.url ?? "/").split("?")[0];
    let file = join(webDist, requested === "/" ? "index.html" : requested);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(webDist, "index.html");
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(PORT, "127.0.0.1", () => ok(server)));
}

const theme = (page) => page.evaluate(() => document.documentElement.dataset.theme);
const stored = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("drafthouse.settings") ?? "null"));

async function main() {
  if (!existsSync(webDist)) throw new Error("web dist missing. Run: pnpm --filter @drafthouse/web build");

  const server = await serveDist();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const failures = [];
  page.on("pageerror", (e) => failures.push(e.message));
  page.on("console", (m) => m.type() === "error" && failures.push(m.text()));

  try {
    // 1. an unconfigured client opens on paper, whatever the OS says (PLAN
    //    D13). The default is a decision about the work — reading a document
    //    beside a rendered screen — not about what the OS happens to prefer.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(APP);
    await page.waitForSelector(".connect__cmd", { timeout: 10000 });
    check("no stored settings means the light palette stands", (await theme(page)) === "light");
    await page.emulateMedia({ colorScheme: "light" });
    check("nothing is written to storage until something is changed", (await stored(page)) === null);

    // 2. settings open from the connect screen, before any daemon exists.
    await page.getByRole("button", { name: "설정" }).click();
    await page.waitForSelector('[role="dialog"][aria-label="설정"]', { timeout: 5000 });
    await page.screenshot({ path: join(here, "ui-settings-dark.png") });
    const groups = await page.locator(".settings__groupTitle").allInnerTexts();
    check(
      "the panel offers only what a planner sets",
      ["화면", "대화", "동작", "연결 레포", "문제 해결"].every((g) => groups.includes(g)) &&
        groups.length === 5,
      groups.join(", "),
    );
    // No daemon yet, so the repo fields wait for one instead of pretending.
    check(
      "repo url and PAT inputs wait for a daemon",
      (await page.getByLabel("연결 레포 주소").isDisabled()) === true &&
        (await page.getByLabel("연결 레포 개인 액세스 토큰").isDisabled()) === true,
    );

    // 3. theme applies live and persists.
    await page.getByLabel("테마").selectOption("dark");
    await page
      .waitForFunction(() => document.documentElement.dataset.theme === "dark", undefined, {
        timeout: 3000,
      })
      .catch(() => undefined);
    check("the console palette is still one choice away", (await theme(page)) === "dark");
    await page.screenshot({ path: join(here, "ui-settings-dark.png") });
    await page.getByLabel("테마").selectOption("light");
    // A frame, not a reload: the attribute lands from React's commit.
    await page
      .waitForFunction(() => document.documentElement.dataset.theme === "light", undefined, {
        timeout: 3000,
      })
      .catch(() => undefined);
    check("choosing light repaints without a reload", (await theme(page)) === "light");
    // Surfaces cross-fade for 120ms; let them settle so the shot is the real thing.
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(here, "ui-settings-light.png") });
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check("light theme actually swaps the surface colour", bodyBg === "rgb(255, 255, 255)", bodyBg);
    check("the choice is stored", (await stored(page))?.theme === "light");

    // 4. "system" follows the OS, in both directions, without a reload.
    await page.getByLabel("테마").selectOption("system");
    check("system resolves to the OS light mode", (await theme(page)) === "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark", undefined, {
      timeout: 3000,
    });
    check("switching the OS to dark moves the app with it", (await theme(page)) === "dark");
    await page.emulateMedia({ colorScheme: "light" });

    // 5. behaviour choices survive a reload.
    await page.getByLabel("보내기 키").selectOption("modEnter");
    await page.getByLabel("기획을 삭제하기 전에 확인").uncheck();
    const before = await stored(page);
    check(
      "behaviour choices are stored together",
      before?.sendKey === "modEnter" && before?.confirmBeforeDelete === false,
      JSON.stringify(before),
    );

    await page.reload();
    await page.waitForSelector(".connect__cmd", { timeout: 10000 });
    check("theme is applied on load, not after a click", (await theme(page)) === "light");
    await page.getByRole("button", { name: "설정" }).click();
    await page.waitForSelector('[role="dialog"][aria-label="설정"]', { timeout: 5000 });
    check(
      "the panel reopens on the stored values",
      (await page.getByLabel("보내기 키").inputValue()) === "modEnter",
    );

    // 6. the 대화 group: the three chips that used to live in the composer
    //    (PLAN D10). They persist like any other preference — except one.
    await page.getByLabel("생각 시간").selectOption("high");
    await page.getByLabel("확인 방식").selectOption("acceptEdits");
    const chat = (await stored(page))?.chat;
    check(
      "conversation choices are stored with the rest",
      chat?.effort === "high" && chat?.permissionMode === "acceptEdits",
      JSON.stringify(chat),
    );

    await page.reload();
    await page.waitForSelector(".connect__cmd", { timeout: 10000 });
    await page.getByRole("button", { name: "설정" }).click();
    await page.waitForSelector('[role="dialog"][aria-label="설정"]', { timeout: 5000 });
    check(
      "they come back on the values that were chosen",
      (await page.getByLabel("생각 시간").inputValue()) === "high" &&
        (await page.getByLabel("확인 방식").inputValue()) === "acceptEdits",
    );

    // 전부 맡기기 is the one choice that is deliberately not restored: it lets
    // Claude act without asking, and a stored blob is not a decision anybody
    // made this morning.
    await page.getByLabel("확인 방식").selectOption("bypassPermissions");
    check(
      "전부 맡기기 says what it costs, right where it is chosen",
      (await page.locator(".notice--warn").innerText()).includes("확인 카드 없이"),
    );
    check(
      "and it is written down like everything else",
      (await stored(page))?.chat?.permissionMode === "bypassPermissions",
    );
    await page.reload();
    await page.waitForSelector(".connect__cmd", { timeout: 10000 });
    await page.getByRole("button", { name: "설정" }).click();
    await page.waitForSelector('[role="dialog"][aria-label="설정"]', { timeout: 5000 });
    check(
      "but a reload lands back on 물어보고 진행",
      (await page.getByLabel("확인 방식").inputValue()) === "default",
    );

    // 7. the diagnostics are reachable and no longer the first thing in view.
    check(
      "connection details sit behind a fold",
      (await page.locator(".settings__fold").count()) === 1 &&
        (await page.getByLabel("데몬 접속 주소").isVisible()) === false,
    );
    await page.locator(".settings__fold > summary").click();
    check(
      "opening the fold reveals them",
      (await page.getByLabel("데몬 접속 주소").isVisible()) === true,
    );

    // 8. a stored blob that is not a legal Settings must not brick the app.
    await page.evaluate(() =>
      localStorage.setItem(
        "drafthouse.settings",
        JSON.stringify({ theme: "neon", sendKey: 7, confirmBeforeDelete: "yes" }),
      ),
    );
    await page.reload();
    await page.waitForSelector(".connect__cmd", { timeout: 10000 });
    check("nonsense in storage falls back to the defaults", (await theme(page)) === "light");
    await page.getByRole("button", { name: "설정" }).click();
    check(
      "a non-string send key falls back too",
      (await page.getByLabel("보내기 키").inputValue()) === "enter",
    );

    // 9. Escape closes without touching anything.
    await page.keyboard.press("Escape");
    check(
      "escape closes the panel",
      (await page.locator('[role="dialog"][aria-label="설정"]').count()) === 0,
    );

    check("no page errors while driving the panel", failures.length === 0, failures.join(" | "));
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAILED: ${f.name}`);
    process.exit(1);
  }
}

await main();
