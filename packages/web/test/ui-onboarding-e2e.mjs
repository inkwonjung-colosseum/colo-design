/**
 * Browser-level check of the first run, fully
 * offline.
 *
 * The daemon boots with no project at all, against a local fixture repo, so
 * the full-window start wizard holds the stage and the test drives the exact
 * sequence a 사용자 would: connect a token, pick a repo, and start. The
 * machine gates (Claude Code, git) are the ones this machine already passes.
 *
 * Prerequisites: `pnpm build` (daemon + web dist)
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createFixtureRepo, freePort } from "../../daemon/test/fixture-repo.mjs";
import { stopDaemon } from "./stop-daemon.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const daemonEntry = join(repoRoot, "packages", "daemon", "dist", "index.js");
const webDist = join(repoRoot, "packages", "web", "dist");
const DIR = join(tmpdir(), "colo-design-onboard-ui-e2e");
const PORT = 5401;

const REPO_PAT = "onboard_ui_pat";

/**
 * The wizard's first gate answers for the machine's Claude CLI. A dev machine
 * has one and made this suite pass by accident; a CI runner has none and the
 * gate renders as a fix button instead of a answered line. The stub answers
 * what the gate asks — `--version`, `auth status` — through the env pin.
 */
function stubClaude(dir) {
  const path = join(dir, "claude");
  const script = [
    "#!/usr/bin/env node",
    'if (process.argv[2] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
    'if (process.argv[2] === "auth" && process.argv[3] === "status") {',
    '  console.log(\'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"planner@example.com"}\');',
    "  process.exit(0);",
    "}",
    "console.log('{\"loggedIn\":false}');",
  ].join("\n");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") {
    throw new Error(`check("${name}") was called without a verdict`);
  }
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

function serveDist() {
  const server = createServer((req, res) => {
    const requested = (req.url ?? "/").split("?")[0];
    let file = join(webDist, requested === "/" ? "index.html" : requested);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(webDist, "index.html");
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
    });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(PORT, "127.0.0.1", () => ok(server)));
}

async function main() {
  if (!existsSync(webDist))
    throw new Error("web dist missing. Run: pnpm --filter @colo-design/web build");
  if (!existsSync(daemonEntry))
    throw new Error("daemon dist missing. Run: pnpm --filter @colo-design/daemon build");

  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const fixture = await createFixtureRepo({
    dir: join(DIR, "fixture"),
    port: await freePort(),
  });
  const fixture2 = await createFixtureRepo({
    dir: join(DIR, "fixture2"),
    port: await freePort(),
  });

  const env = {
    ...process.env,
    COLO_DESIGN_PORT: String(await freePort()),
    COLO_DESIGN_REPO_DIR: join(DIR, "work"),
    COLO_DESIGN_REPO_SETTINGS: join(DIR, "repo.json"),
    // The registry decides what "the repo" means, so it has to live in the
    // throwaway directory too: a previous run's projects.json would otherwise
    // hand this daemon a deleted fixture remote.
    COLO_DESIGN_PROJECTS_SETTINGS: join(DIR, "projects.json"),
    COLO_DESIGN_PROJECTS_DIR: join(DIR, "projects"),
    // Deliberately NO repo url: the wizard must block, then unblock through
    // its own project form.
    COLO_DESIGN_CREDENTIAL_STORE: "memory",
    // The github gate and the picker's list answer from the recorded pairs,
    // never from api.github.com.
    COLO_DESIGN_GITHUB_FIXTURE: join(repoRoot, "packages", "daemon", "test", "fixtures", "github"),
    // The wizard's Claude gate reads this stub — see stubClaude above.
    COLO_DESIGN_CLAUDE_BIN: stubClaude(join(DIR, "claude-bin")),
    // The page comes from this file's static server, not the daemon — the
    // upgrade's Origin must be named or the daemon 403s it (server.ts
    // allowedUpgradeOrigin).
    COLO_DESIGN_DEV_SERVER: `http://127.0.0.1:${PORT}`,
  };
  delete env.ANTHROPIC_API_KEY;
  const daemon = spawn(process.execPath, [daemonEntry], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stderr.on("data", (d) => process.stderr.write(`[daemon] ${d}`));
  process.on("exit", () => daemon.kill("SIGKILL"));
  const daemonUrl = await new Promise((ok, fail) => {
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

  const server = await serveDist();
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1680, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    // --- 1. the first run is the full-window start wizard -----------------
    //     기계 게이트는 조용히 확인된다 — 실패만 기계 마법사를 세운다.
    //     여기서는 전부 통과하므로 시작 마법사의 토큰 단계가 첫 화면이다.
    //     토큰 전에는 레포·준비 단계가 접힌 한 줄이다.
    await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
    await page.getByRole("button", { name: "연결" }).click();

    await page.waitForSelector(".onboarding--start .ghtoken", { timeout: 20000 });
    check(
      "the first run opens the start wizard's token step, not the machine wizard",
      (await page.locator(".onboarding--start").count()) === 1 &&
        (await page.locator(".onboarding--start .onboarding__step").count()) === 3 &&
        (await page.locator(".onboarding--start .onboarding__step--line").count()) === 2,
    );

    // --- 2. the token passes: its card folds to a line, the repo card opens
    await page.getByLabel("GitHub 개인 액세스 토큰").fill(REPO_PAT);
    await page.locator(".ghtoken").getByRole("button", { name: "연결" }).click();
    await page.waitForSelector(".onboarding--start .repopicker", { timeout: 20000 });
    const tokenLine = page.locator(".onboarding--start .onboarding__step--line", {
      hasText: "토큰 연결",
    });
    check(
      "the token step folds into a line and the repo step opens",
      (await page.locator(".onboarding--start .ghtoken").count()) === 0 &&
        (await tokenLine.count()) === 1 &&
        (await tokenLine.getByRole("button", { name: "토큰 바꾸기" }).count()) === 1,
    );

    // --- 2b. 토큰 바꾸기 re-opens the form; a pass folds the line back -----
    await tokenLine.getByRole("button", { name: "토큰 바꾸기" }).click();
    await page.waitForSelector(".onboarding--start .ghtoken", { timeout: 15000 });
    await page.getByLabel("GitHub 개인 액세스 토큰").fill(REPO_PAT);
    await page.locator(".ghtoken").getByRole("button", { name: "연결" }).click();
    await page.waitForSelector(".onboarding--start .ghtoken", {
      state: "detached",
      timeout: 20000,
    });

    // --- 3. the repo step is the picker itself -----------------------------
    check(
      "the start wizard asks for a repo instead of an address",
      (await page.locator(".onboarding--start .repopicker").count()) === 1,
    );
    await page
      .waitForFunction(
        () => document.querySelectorAll(".repopicker__row").length === 2,
        undefined,
        { timeout: 15000 },
      )
      .catch(() => undefined);
    check(
      "the picker lists only the repos the token can push to — read-only and archived dropped",
      (await page.locator(".repopicker__row").count()) === 2,
      (await page.locator(".repopicker__name").allInnerTexts()).join(", "),
    );

    const search = page.getByLabel("레포 이름으로 찾기");
    await search.fill("pay");
    await page.locator(".repopicker__row", { hasText: "payments-web" }).click();
    await page
      .waitForFunction(
        () =>
          document
            .querySelector(".repopicker__confirm")
            ?.textContent?.includes("화면 제작 준비가 된 레포"),
        undefined,
        { timeout: 15000 },
      )
      .catch(() => undefined);
    check(
      "picking a repo judges it before any clone, and pre-fills the name",
      (await page.getByLabel("프로젝트 이름").inputValue()) === "payments-web",
      (await page.locator(".repopicker__confirm .onboarding__detail").innerText()).slice(0, 60),
    );
    await page.screenshot({ path: join(here, "ui-onboarding-picker.png") });

    // --- 4. the manual url is the fallback for what the list cannot see ---
    await page.getByRole("button", { name: "목록에 없나요? 주소로 추가" }).click();
    await page.getByLabel("연결 레포 주소").fill(fixture.remote);
    // The one explicit yes: the repo's install · preview commands may run here.
    await page.getByTestId("approve-commands-manual").check();
    await page.getByRole("button", { name: "추가", exact: true }).click();

    // The picker gives way to the workspace frame as soon as the registry
    // answers; the home inbox is the landing view (P1 홈 인박스), and the
    // clone that follows draws itself in the preview column once a
    // conversation opens.
    await page.waitForSelector(".planner__work", { timeout: 90000 });
    // 홈이 기본값이므로 대화 화면은 새 대화 leaf 가 연다 — 상시 표시다.
    await page.locator(".leaf--start").first().click();
    await page.waitForSelector(".planner__body:not(.planner__empty)", {
      timeout: 90000,
    });
    check(
      "the header names the project the planner just made",
      (await page.locator(".planner__project").innerText()).includes("remote"),
    );
    check(
      "the tree lists the project and marks it active",
      (await page.locator(".node").count()) === 1 &&
        (await page.locator(".node--active").innerText()).includes("remote"),
    );

    // --- 5. a second project comes from the same picker, in a dialog ------
    await page.locator(".sidebar__new").click();
    await page.waitForSelector('[role="dialog"][aria-label="프로젝트 추가"]', {
      timeout: 15000,
    });
    check(
      "+ 새 프로젝트 opens the same picker as a dialog",
      (await page.locator('[role="dialog"][aria-label="프로젝트 추가"] .repopicker').count()) === 1,
    );
    await page.keyboard.press("Escape");
    check(
      "escape closes the dialog",
      (await page.locator('[role="dialog"][aria-label="프로젝트 추가"]').count()) === 0,
    );

    // --- 6. the wizard still exists — behind 설정, for the machine gates --
    //     첫 화면이 2단으로 바뀐 뒤에도 마법사는 기계 게이트의 자리로 남는다
    //     (설정 → 처음 설정 다시 보기).
    await page.locator(".sidebar__gear").click();
    await page.getByRole("button", { name: "처음 설정 다시 보기" }).click();
    await page.waitForSelector(".onboarding", { timeout: 15000 });
    await page
      .waitForFunction(
        () => document.querySelectorAll(".onboarding__step").length === 4,
        undefined,
        { timeout: 15000 },
      )
      .catch(() => undefined);
    const stepTitles = await page.locator(".onboarding__stephead h2").allInnerTexts();
    check(
      "the four machine gates are listed in order, GitHub last",
      // 제목은 쓸모가 먼저다 — 도구 이름은 부제
      // (.onboarding__tool)로 내려갔다. 의도된 계약 변경.
      JSON.stringify(stepTitles) ===
        JSON.stringify([
          "화면을 만드는 Claude",
          "작업을 보관할 준비",
          "앱 실행 준비",
          "개발자에게 넘길 준비",
        ]),
      stepTitles.join(" · "),
    );
    const githubLine = await page
      .locator(".onboarding__step--line", { hasText: "GitHub" })
      .innerText();
    check(
      "the github line passes, naming the login the token acts as",
      githubLine.includes("GitHub @jik-dev 로 연결됨"),
      githubLine.replace(/\n+/g, " · "),
    );
    await page.getByRole("button", { name: "시작하기", exact: true }).click();
    await page.waitForSelector(".onboarding", { state: "detached", timeout: 15000 });

    // The dialog is not just for show: the same manual-address path that
    // made the first project makes the second one inside it.
    await page.locator(".sidebar__new").click();
    await page.waitForSelector('[role="dialog"][aria-label="프로젝트 추가"]', {
      timeout: 15000,
    });
    await page.getByRole("button", { name: "목록에 없나요? 주소로 추가" }).click();
    await page.getByLabel("연결 레포 주소").fill(fixture2.remote);
    await page
      .locator('[role="dialog"][aria-label="프로젝트 추가"]')
      .getByTestId("approve-commands-manual")
      .check();
    await page
      .locator('[role="dialog"][aria-label="프로젝트 추가"]')
      .getByRole("button", { name: "추가", exact: true })
      .click();
    await page.waitForSelector('[role="dialog"][aria-label="프로젝트 추가"]', {
      state: "detached",
      timeout: 90000,
    });
    check("만들기 closes the dialog", (await page.locator('[role="dialog"]').count()) === 0);
    check(
      "the tree now holds both projects, the new one active",
      (await page.locator(".node").count()) === 2 &&
        (await page.locator(".node--active").count()) === 1,
      (await page.locator(".node__name").allInnerTexts()).join(", "),
    );

    // A brand new project starts with no threads: the tree row where the eye
    // lands IS the way to begin, next to the row's own ＋.
    const tree = page.locator(".tree");
    await tree.waitFor({ timeout: 15000 });
    const startButtons = await tree.getByRole("button", { name: "새 대화" }).count();
    const startRows = await tree.locator(".leaf--start").count();
    check(
      "an empty project offers the way to start, in the tree",
      // Both fixture projects are brand new, so both carry the row.
      startRows === 2 && startButtons >= 2,
      `${startRows} start row(s) · ${startButtons} start button(s)`,
    );

    check(
      "the secrets never reached the browser",
      !JSON.stringify(await page.evaluate(() => localStorage)).includes(REPO_PAT),
    );
    await page.screenshot({ path: join(here, "ui-onboarding-done.png") });
  } finally {
    await browser.close();
    server.close();
    await stopDaemon(daemon);
    rmSync(DIR, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0 || errors.length > 0) {
    if (errors.length > 0) console.error(`Console errors: ${errors.join(" | ")}`);
    console.error(`Failed: ${failed.map((r) => r.name).join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  rmSync(DIR, { recursive: true, force: true });
  process.exit(1);
});
