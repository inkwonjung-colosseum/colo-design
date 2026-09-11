/**
 * Desktop comments suite (PLAN §4·5) — the native preview path, driven end
 * to end against the dev entry with Playwright _electron: the fixture repo's
 * bridge declares its screens through the preview preload, the address bar
 * moves the view, the tool's own overlay pins an element and sends, the
 * daemon records the comment, the popover resolves it, and a foreign origin
 * is refused in place.
 *
 * The main window's page is the planner UI; the VIEW's page is reached
 * through the main process (`globalThis.cdsDesignPlannerPreview`) because a
 * WebContentsView is not a window Playwright can adopt. What runs inside the
 * view is the real compiled preload — the overlay, the bridge door, the stale
 * detection — same as a packaged app.
 *
 * Prerequisites: pnpm build (all four packages) — same as desktop-smoke.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { createFixtureRepo, freePort } from "../../daemon/test/fixture-repo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "..");
const repo = join(desktop, "..", "..");

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") {
    throw new Error(`check("${name}") was called without a verdict`);
  }
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/**
 * The turn must really RUN for the pins to survive and settle — same slow
 * stub ui-comments-e2e used: answer version/auth, sleep on the comment turn.
 */
function slowStubClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  --version) echo "1.0.0-stub"; exit 0;;',
      "  auth)",
      '    echo "{\\"loggedIn\\":true,\\"authMethod\\":\\"claude.ai\\",\\"subscriptionType\\":\\"team\\",\\"email\\":\\"planner@example.com\\"}"',
      "    exit 0;;",
      "esac",
      "while IFS= read -r line; do",
      "  case \"$line\" in",
      "    *화면\\ 수정\\ 요청*) sleep 2; exit 0;;",
      "  esac",
      "done",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

/**
 * One step inside the view's page, through the main-process handle. Two
 * Playwright traps live here: `app.evaluate`'s callback receives the ELECTRON
 * MODULE first and the arg second, and a bare STRING arg means "evaluate
 * this as an expression" — the script rides an object, after the module.
 */
const inView = async (app, script) => {
  const outcome = await app.evaluate(async (_electronModule, { script: expression }) => {
    const contents = globalThis.cdsDesignPlannerPreview?.webContents();
    if (!contents) return { error: "the preview view is gone" };
    try {
      return { value: await contents.executeJavaScript(expression) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, { script });
  if (outcome && typeof outcome === "object" && "error" in outcome) {
    throw new Error(`in-view script failed: ${String(outcome.error)}`);
  }
  return outcome.value;
};

const viewUrl = (app) =>
  app.evaluate(() => globalThis.cdsDesignPlannerPreview?.webContents()?.getURL() ?? null);

async function main() {
  run("pnpm", ["--filter", "@cds-design/protocol", "build"], repo);
  run("pnpm", ["--filter", "@cds-design/daemon", "build"], repo);
  run("pnpm", ["--filter", "@cds-design/web", "build"], repo);
  run("pnpm", ["--filter", "@cds-design/desktop", "build"], repo);
  const webDist = join(desktop, "web-dist");
  rmSync(webDist, { recursive: true, force: true });
  mkdirSync(webDist, { recursive: true });
  cpSync(join(repo, "packages", "web", "dist"), webDist, { recursive: true });

  const dir = join(tmpdir(), `cds-design-desktop-comments-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const fixture = await createFixtureRepo({ dir: join(dir, "fixture"), port: await freePort() });
  // The daemon's active project points here — a clone of the fixture remote,
  // the same shape ui-publish-e2e boots.
  const workRoot = join(dir, "work");
  run("git", ["clone", "--quiet", fixture.remote, workRoot]);

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const app = await electron.launch({
    executablePath: join(desktop, "node_modules", ".bin", "electron"),
    args: [desktop],
    env: {
      ...env,
      CDS_DESIGN_PORT: String(await freePort()),
      CDS_DESIGN_REPO_DIR: workRoot,
      CDS_DESIGN_REPO_URL: fixture.remote,
      CDS_DESIGN_REPO_SETTINGS: join(dir, "settings.json"),
      CDS_DESIGN_PROJECTS_SETTINGS: join(dir, "projects.json"),
      CDS_DESIGN_PROJECTS_DIR: join(dir, "projects"),
      CLAUDE_CONFIG_DIR: join(dir, "claude-config"),
      CDS_DESIGN_CLAUDE_BIN: slowStubClaude(join(dir, "bin")),
      CDS_DESIGN_CREDENTIAL_STORE: "memory",
    },
  });

  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1720, height: 1000 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const consoleLog = [];
    page.on("console", (m) => {
      consoleLog.push(`${m.type()}: ${m.text()}`);
      if (m.type() === "error") errors.push(m.text());
    });

    await page.waitForSelector(".planner__body", { timeout: 60000 });
    await page.waitForSelector(".screenpanel__bar", { timeout: 60000 });
    check("the planner workspace renders with the fixture project", true);

    // --- the bridge speaks through the preload (D68) -----------------------
    const picker = page.getByRole("combobox", { name: "화면" });
    await picker.waitFor({ timeout: 60000 });
    const offered = await picker.locator("option").allTextContents();
    check("the fixture bridge's screens reach the picker", offered.includes("회원 목록"), offered.join(" · "));

    // The native pane mounted — the handle exists and points at the preview.
    const url0 = await viewUrl(app);
    check(
      "the view is mounted on the fixture preview origin",
      typeof url0 === "string" && url0.startsWith(`http://127.0.0.1:${fixture.port}`),
      url0 ?? "(none)",
    );

    // --- picking a screen routes through the bridge, no reload (D66) -------
    await picker.selectOption({ label: "회원 목록" });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="preview-address"]')?.value === "/member/MemberList",
      { timeout: 30000 },
    );
    check("the address bar shows the screen's route", true);

    // A state chip moves the view and the bar follows.
    await page.getByRole("group", { name: "상태" }).getByRole("button", { name: "비어 있음" }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="preview-address"]')?.value ===
        "/member/MemberList?state=empty",
      { timeout: 30000 },
    );
    const emptyState = await inView(
      app,
      `(function () {
        const wrapper = document.querySelector('[data-screen]');
        let visible = 0;
        for (const row of document.querySelectorAll('[data-screen] tbody tr')) {
          if (row.style.display !== 'none') visible += 1;
        }
        return 'rows:' + visible + ' state:' + (wrapper ? wrapper.getAttribute('data-state') : 'none');
      })()`,
    );
    check(
      "the empty state really changes the screen",
      emptyState === "rows:0 state:empty",
      String(emptyState),
    );

    // --- the tool's overlay pins and sends (D67) ---------------------------
    await page.getByRole("button", { name: /💬 코멘트/ }).click();
    const overlayThere = await inView(
      app,
      `Boolean(document.querySelector("[data-cds-design-overlay]"))`,
    );
    check("comment mode injects the tool's overlay into the view", overlayThere === true);

    await inView(
      app,
      `(() => { document.querySelector('[data-screen] tbody td').click(); return true; })()`,
    );
    const pinned = await inView(
      app,
      `(() => {
        const input = document.querySelector('textarea[aria-label="핀 1 코멘트"]');
        if (!input) return false;
        input.value = "이름 열을 가입일 역순으로 정렬해 주세요.";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const save = [...document.querySelectorAll("button")].find((b) => b.textContent === "저장");
        save.click();
        return true;
      })()`,
    );
    check("clicking an element pins it with an inline editor", pinned === true);

    await inView(
      app,
      `(() => {
        const send = [...document.querySelectorAll("button")].find((b) =>
          (b.textContent || "").includes("수정 요청 1건 보내기"));
        if (!send) return false;
        send.click();
        return true;
      })()`,
    );

    // --- the tool side: pins summary, card, record, resolve (D57) ----------
    await page.locator('[data-testid="pins-summary"]').waitFor({ timeout: 15000 });
    const summary = await page.locator('[data-testid="pins-summary"]').innerText();
    check(
      "the pins summary names the screen",
      summary.includes("수정 요청 1건") && summary.includes("member/MemberList"),
      summary.split("\n")[0],
    );
    const card = page.locator(".machine--comments");
    await card.waitFor({ timeout: 30000 });
    const cardText = await card.innerText();
    check(
      "the transcript shows the 수정 요청 card",
      cardText.includes("수정 요청 1건") && cardText.includes("이름 열을 가입일 역순으로"),
      cardText.split("\n")[0],
    );
    await page.locator('[data-testid="pins-summary"]').waitFor({ state: "detached", timeout: 30000 });
    check("pins clear once the turn settles", true);

    // --- the popover: one unresolved row, and the resolve toggle (D57) -----
    await page.locator(".screenpanel__bar").getByRole("button", { name: "더 보기" }).click();
    await page.getByRole("menuitem", { name: "코멘트 목록" }).click();
    const dialog = page.locator('[role="dialog"][aria-label="코멘트 기록"]');
    await dialog.waitFor({ timeout: 5000 });
    const covered = await app.evaluate(() => {
      const view = globalThis.cdsDesignPlannerPreview;
      return view ? view.webContents() !== null : false;
    });
    check("the modal opens over a live view", covered === true);
    const popoverText = await dialog.innerText();
    check(
      "the recorded comment is one unresolved row",
      popoverText.includes("member/MemberList") && popoverText.includes("이름 열을 가입일 역순으로"),
      popoverText.split("\n").slice(0, 2).join(" / "),
    );
    await dialog.getByRole("button", { name: "해결", exact: true }).click();
    try {
      await dialog.getByText("미해결로").waitFor({ timeout: 8000 });
    } catch {
      const store = [];
      const walkStores = (folder) => {
        for (const entry of readdirSync(folder, { withFileTypes: true })) {
          const path = join(folder, entry.name);
          if (entry.isDirectory()) walkStores(path);
          else if (entry.name === "comments.json") store.push(readFileSync(path, "utf8"));
        }
      };
      try {
        walkStores(join(dir, "projects"));
      } catch {
        // no store at all — that is itself the answer
      }
      const dump = (await dialog.innerText().catch(() => "(gone)")).replace(/\n/g, " | ").slice(0, 300);
      console.log(`RESOLVE DUMP ${dump}\nSTORE ${store.join(" ;; ").slice(0, 500)}`);
      const wsProbe = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const ws = new WebSocket(
              window.location.href.replace(/^http/, "ws").replace(/\/(\?|$)/, "$1"),
            );
            const inbox = [];
            const done = () => resolve(inbox.join(" ;; ").slice(0, 400));
            const timer = setTimeout(done, 4000);
            ws.addEventListener("open", () => {
              ws.send(JSON.stringify({ type: "comments.list", id: "probe-list" }));
            });
            ws.addEventListener("message", (event) => {
              inbox.push(String(event.data).slice(0, 200));
              if (String(event.data).includes("probe-list")) {
                ws.send(JSON.stringify({ type: "comments.resolve", id: "probe-resolve", resolved: false }));
                clearTimeout(timer);
                setTimeout(done, 1500);
              }
            });
            ws.addEventListener("error", () => resolve("ws error"));
          }),
      );
      console.log(`WS PROBE ${String(wsProbe)}`);
      throw new Error("the resolve toggle never flipped");
    }
    const badgeAfterResolve = await page.getByRole("button", { name: /💬 코멘트/ }).innerText();
    check("the resolve toggle clears the badge", !/\d/.test(badgeAfterResolve), badgeAfterResolve);
    await dialog.getByRole("button", { name: "코멘트 기록 닫기" }).click();

    // --- the address bar's line (D66) --------------------------------------
    const foreign = page.locator('[data-testid="preview-address"]');
    await foreign.fill("https://example.com");
    await foreign.press("Enter");
    await page.waitForSelector(".frame__addrerror", { timeout: 5000 });
    const refused = await page.locator(".frame__addrerror").innerText();
    const urlAfter = await viewUrl(app);
    check(
      "another origin is refused in place",
      refused.includes("미리보기 서버 안의 주소만") &&
        typeof urlAfter === "string" &&
        urlAfter.includes("state=empty"),
      `${refused} · ${urlAfter ?? ""}`,
    );

    // 새로 고침 keeps where the view is — the old pane snapped home.
    await page.getByRole("button", { name: "미리보기 새로 고침" }).click();
    await page.waitForTimeout(800);
    const urlReloaded = await viewUrl(app);
    check(
      "reload stays on the current url",
      typeof urlReloaded === "string" && urlReloaded.includes("state=empty"),
      urlReloaded ?? "",
    );

    check("no uncaught renderer errors", errors.length === 0, errors.slice(0, 2).join(" | "));
    await page.screenshot({ path: join(here, "desktop-comments.png"), fullPage: true });
  } finally {
    await app.close().catch(() => undefined);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
