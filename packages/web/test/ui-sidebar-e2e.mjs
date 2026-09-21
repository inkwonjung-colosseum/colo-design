/**
 * Browser-level check of the status rail, fully offline.
 *
 * Two projects are created over the daemon socket (the same WebSocket the
 * browser uses), then the test drives the rail the planner uses: the live
 * zone up top (확인 대기 · 작업 중 across projects, the project as a tail
 * chip), each project's finished conversations folded under its own row,
 * the active project open by default, the fold hiding and restoring rows,
 * the active mark, a one-click jump into another project's conversation
 * (the workspace switches while the old project's preview stays warm on
 * its port), a background turn reading 작업 중 → 다시 조용해짐, the
 * per-project tree budget turning overflow into a count row that opens
 * the project-scoped palette, and the folded rail's conversation popover.
 *
 * Prerequisites: `pnpm build` (daemon + web dist)
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFixtureRepo, freePort } from "../../daemon/test/fixture-repo.mjs";
import { stopDaemon } from "./stop-daemon.mjs";

/**
 * A fake `claude` CLI whose real invocation stalls eight seconds — long enough
 * for a background turn's 작업 중 mark to be watched before it settles, and
 * for the thread-state announce (disk scan + coalesced broadcast) to land
 * while the turn is still running. (Same shape as projects-e2e's, kept
 * local: fixture-repo stays UI-agnostic.)
 */
function writeTurnStubClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  --version) echo "1.0.0-stub"; exit 0;;',
      "  auth)",
      '    echo \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"planner@example.com"}\'',
      "    exit 0;;",
      "esac",
      "sleep 8",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const daemonEntry = join(repoRoot, "packages", "daemon", "dist", "index.js");
const webDist = join(repoRoot, "packages", "web", "dist");
const DIR = join(tmpdir(), "colo-design-sidebar-ui-e2e");
const PORT = 5402;

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
  ".woff2": "font/woff2",
};

function serveDist() {
  const server = createServer((req, res) => {
    const path = req.url === "/" ? "/index.html" : (req.url ?? "/").split("?")[0];
    const file = existsSync(join(webDist, path))
      ? join(webDist, path)
      : join(webDist, "index.html");
    res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(PORT, "127.0.0.1", () => ok(server)));
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** Whether the fixture preview on `port` still answers — a warm server does. */
async function serving(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

async function main() {
  if (!existsSync(webDist))
    throw new Error("web dist missing. Run: pnpm --filter @colo-design/web build");
  if (!existsSync(daemonEntry))
    throw new Error("daemon dist missing. Run: pnpm --filter @colo-design/daemon build");

  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "claude-config"), { recursive: true });
  // Two repos, two ports: the tree's whole claim is one node per project with
  // each one's conversations beneath it, and only the active project's
  // preview port serving. The turn stub stalls two seconds, so a background
  // turn can be watched mid-flight (작업 중) before it settles.
  const paymentsFixture = await createFixtureRepo({
    dir: join(DIR, "fixture-payments"),
    port: await freePort(),
  });
  const refundsFixture = await createFixtureRepo({
    dir: join(DIR, "fixture-refunds"),
    port: await freePort(),
  });

  // The hover card's 폴더 열기 must not raise a real Finder window — the
  // daemon's COLO_DESIGN_OPEN_BIN override points at this stub, which logs
  // the path it was asked to open.
  const openStub = join(DIR, "bin", "open-stub");
  const openedLog = join(DIR, "opened.log");
  mkdirSync(join(DIR, "bin"), { recursive: true });
  writeFileSync(openStub, `#!/bin/sh\necho "$1" >> ${JSON.stringify(openedLog)}\n`);
  chmodSync(openStub, 0o755);

  const env = {
    ...process.env,
    COLO_DESIGN_PORT: String(await freePort()),
    COLO_DESIGN_PROJECTS_SETTINGS: join(DIR, "projects.json"),
    COLO_DESIGN_PROJECTS_DIR: join(DIR, "projects"),
    CLAUDE_CONFIG_DIR: join(DIR, "claude-config"),
    COLO_DESIGN_CLAUDE_BIN: writeTurnStubClaude(join(DIR, "bin")),
    COLO_DESIGN_OPEN_BIN: openStub,
    COLO_DESIGN_CREDENTIAL_STORE: "memory",
    // The page comes from this file's static server, not the daemon — the
    // upgrade's Origin must be named or the daemon 403s it.
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
  // The browser's own confirm must never enter the
  // picture — every dangerous ask is the app's dialog.
  await page.addInitScript(() => {
    window.confirm = () => {
      window.__nativeConfirmUsed = true;
      return true;
    };
  });

  /** A second socket from the page: setup, session wiring, and status polls. */
  const call = (message, timeoutMs = 60000) =>
    page.evaluate(
      async ({ url, message, timeoutMs }) => {
        const ws = new WebSocket(url);
        await new Promise((ok, fail) => {
          ws.addEventListener("open", ok, { once: true });
          ws.addEventListener("error", () => fail(new Error("socket refused")), { once: true });
        });
        try {
          return await new Promise((ok, fail) => {
            const timer = setTimeout(() => fail(new Error(`${message.type} timed out`)), timeoutMs);
            ws.addEventListener("message", (event) => {
              const reply = JSON.parse(String(event.data));
              if (reply.id !== message.id) return;
              clearTimeout(timer);
              reply.type === "ok" ? ok(reply.data) : fail(new Error(reply.message));
            });
            ws.send(JSON.stringify(message));
          });
        } finally {
          ws.close();
        }
      },
      {
        url: daemonUrl,
        message: { ...message, id: `t${Math.random().toString(36).slice(2)}` },
        timeoutMs,
      },
    );

  /** Poll until the active clone reports ready; refuse to pass on error. */
  const waitReady = async (label) => {
    for (let deadline = Date.now() + 90000; Date.now() < deadline; ) {
      const status = await call({ type: "repo.status" }, 15000);
      if (status.phase === "ready") return status;
      if (status.phase === "error") throw new Error(`${label}: ${status.detail ?? status.phase}`);
      await sleep(1000);
    }
    throw new Error(`${label}: never became ready`);
  };

  /** The project node's child row for one conversation id. */
  const leaf = (threadId) => page.locator(`.leaf[data-thread-id="${threadId}"]`);

  try {
    // 첫 실행 투어의 예시 창은 빈 대화마다 선다 — 이 스위트는 투어가
    // 아니라 그 아래의 화면을 본다.
    await page.addInitScript(() => localStorage.setItem("colo-design.tour-step", "done"));
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
    await page.getByRole("button", { name: "연결" }).click();
    // 첫 화면은 마법사가 아니라 2단 시작 흐름이다 — 기계
    // 게이트는 조용히 통과하고, 소켓 호출은 사이드바가 서 있는 이 자리에서
    // 바로 간다.
    await page.waitForSelector(".onboarding--start", { timeout: 60000 });
    // --- a. two projects, over the same socket the browser uses -----------
    await call({
      type: "project.create",
      name: "결제",
      repoUrl: paymentsFixture.remote,
      approveCommands: true,
    });
    await call({
      type: "project.create",
      name: "환불",
      repoUrl: refundsFixture.remote,
      approveCommands: true,
    });
    await waitReady("the 환불 clone");

    // --- b1. the project row's hover card: branch, port, folder ------------
    // The card is interactive — the pointer may cross onto it and its rows
    // open what they name (repo → GitHub, preview → its port, folder → the
    // OS file manager, stubbed above).
    const refundsStatus = await call({ type: "repo.status" }, 15000);
    const refundsRow = page.locator(".node", { hasText: "환불" }).locator(".node__row");
    await refundsRow.hover();
    const card = page.locator(".tip__bubble--shown .pcard");
    await card.waitFor({ timeout: 10000 });
    const cardText = await card.innerText();
    check(
      "the hover card names the branch, the preview port, and the clone folder",
      cardText.includes("main") &&
        cardText.includes(new URL(refundsStatus.previewUrl).port) &&
        cardText.includes("환불"),
      cardText.split("\n").join(" · "),
    );
    // Crossing onto the card must not close it — the rows inside are links.
    await card.hover();
    check("the card survives the pointer crossing onto it", await card.isVisible());
    await card.locator("button.pcard__row").click();
    const expectedRoot = join(DIR, "projects", "환불", "repo");
    let openedPath = "";
    for (let i = 0; i < 50 && !openedPath; i++) {
      await sleep(100);
      if (existsSync(openedLog)) openedPath = readFileSync(openedLog, "utf8").trim();
    }
    check(
      "폴더 열기 asks the OS opener for the clone's folder",
      openedPath === expectedRoot,
      `${openedPath} vs ${expectedRoot}`,
    );
    await page.mouse.move(40, 400);
    await card.waitFor({ state: "hidden", timeout: 10000 });
    check("two projects created over the socket, both cloning", true);

    // --- b. one node per project, the active one marked --------------------
    await page.waitForFunction(() => document.querySelectorAll(".node").length === 2, undefined, {
      timeout: 30000,
    });
    check("the tree holds one node per project", (await page.locator(".node").count()) === 2);
    const activeNode = page.locator(".node--active");
    check(
      "the active mark sits on the project just created",
      (await activeNode.count()) === 1 && (await activeNode.innerText()).includes("환불"),
      (await page.locator(".node__name").allInnerTexts()).join(", "),
    );

    // --- b2. a conversation shows up as its project's child row ------------
    const { sessionId: refundsSession } = await call({
      type: "session.create",
    });
    await leaf(refundsSession).waitFor({ timeout: 30000 });
    // The row count is not asserted: the conventions-prep turn (연결 준비)
    // auto-opens a sibling thread post-ready, and under the stub CLI that
    // leaf is transient — it leaves the tree when the session closes without
    // a transcript. What this step proves is the created session's own row.
    check(
      "a created session arrives as a child row of its project",
      (await leaf(refundsSession).innerText()).includes("새 화면"),
      (await leaf(refundsSession).innerText()).split("\n")[0] ?? "",
    );

    // --- c. clicking a row switches the whole workspace --------------------
    const refundsPreview = await call({ type: "repo.status" }, 15000);
    const refundsPort = Number(new URL(refundsPreview.previewUrl).port);
    await page.locator(".node", { hasText: "결제" }).locator(".node__row").click();
    await page.locator(".planner__project", { hasText: "결제" }).waitFor({ timeout: 15000 });
    // The activation click leaves the pointer resting on the row, where its
    // hover card hangs over the tree rows that just unfolded beneath it —
    // move off before reaching for the child row.
    await page.mouse.move(40, 400);
    check("the header switches the moment a row is clicked", true);
    const paymentsStatus = await waitReady("the 결제 clone after the switch");
    const paymentsPort = Number(new URL(paymentsStatus.previewUrl).port);
    // The preview column lives in the thread view — a project row alone
    // lands on the project's home. Opening the new conversation's row is
    // what brings the column (and its iframe) on screen.
    const { sessionId: paymentsSession } = await call({
      type: "session.create",
    });
    await leaf(paymentsSession).waitFor({ timeout: 30000 });
    await leaf(paymentsSession).click();
    await page
      .locator(`.preview__frame[src="http://127.0.0.1:${paymentsPort}"]`)
      .waitFor({ timeout: 30000 });
    check("the preview column serves the new project's fixture port", true, `port ${paymentsPort}`);

    // --- d. a folded project keeps its history, folded ----------------------
    // Back to 환불: the switch to 결제 opened its tree, so its rows showed.
    // Folding is the tree's own move now — fold 결제 and its finished
    // conversations leave the screen without leaving the project; unfold
    // and two projects' rows stand at once.
    await page.locator(".node", { hasText: "환불" }).locator(".node__row").click();
    await page.locator(".planner__project", { hasText: "환불" }).waitFor({ timeout: 15000 });
    await waitReady("the 환불 clone after the second switch");
    await page.locator(".node", { hasText: "결제" }).locator(".node__caret").click();
    await leaf(paymentsSession).waitFor({ state: "detached", timeout: 15000 });
    check("a folded project keeps its finished rows out of sight", true);
    await page.locator(".node", { hasText: "결제" }).locator(".node__caret").click();
    await leaf(paymentsSession).waitFor({ timeout: 30000 });
    check(
      "two projects' conversations show in the tree at the same time",
      (await page.locator(".leaf[data-thread-id]").count()) >= 2,
      (await page.locator(".leaf__title").allInnerTexts()).join(", "),
    );

    // --- e. a child of another project: one click switches and opens -------
    await leaf(paymentsSession).click();
    await page.locator(".planner__project", { hasText: "결제" }).waitFor({ timeout: 30000 });
    await waitReady("the 결제 clone after the child-row jump");
    await page
      .locator(`.preview__frame[src="http://127.0.0.1:${paymentsPort}"]`)
      .waitFor({ timeout: 30000 });
    await leaf(paymentsSession).waitFor({ timeout: 30000 });
    // The active mark rides the thread-state announce — poll for the class
    // rather than reading it once, the same patience the row's own wait had.
    await page.waitForFunction(
      (id) =>
        document
          .querySelector(`.leaf[data-thread-id="${id}"]`)
          ?.getAttribute("class")
          ?.includes("leaf--active") === true,
      paymentsSession,
      { timeout: 30000 },
    );
    check("clicking another project's child makes it active and opens it", true);
    // The project the planner left keeps its server: a return is a repaint of
    // the page the desktop kept, so the port must still answer.
    check(
      "the jumped-from project's preview stays warm on its port",
      await serving(refundsPort),
      `port ${refundsPort}`,
    );

    // --- f. a background turn reads 작업 중, then settles back to quiet -----
    const { sessionId: paymentsSecond } = await call({
      type: "session.create",
    });
    await leaf(paymentsSecond).waitFor({ timeout: 30000 });
    await call({
      type: "session.send",
      sessionId: paymentsSecond,
      text: "스텁 턴",
    });
    await leaf(paymentsSecond).locator(".leaf__dot--live").waitFor({ timeout: 30000 });
    await page.locator(".gsec", { hasText: "작업 중" }).waitFor({ timeout: 10000 });
    check(
      "a turn on a background row sits in the 작업 중 group, chip on the row",
      (await leaf(paymentsSecond).locator(".leaf__dot--live").count()) === 1 &&
        (await leaf(paymentsSecond).locator(".leaf__proj").innerText()) === "결제",
    );
    // A settled conversation is the steady state, so the row returns to
    // recency words and the ring carries the answer-arrived mark alone.
    await leaf(paymentsSecond).locator(".leaf__dot--done").waitFor({ timeout: 60000 });
    const settled = await leaf(paymentsSecond).innerText();
    check(
      "the settled turn reads quiet — recency words, ring on the dot",
      !settled.includes("작업 중") &&
        /방금|(\d+분 전)/.test(settled) &&
        (await leaf(paymentsSecond).locator(".leaf__dot--done").count()) === 1,
      settled.split("\n").join(" · "),
    );
    // The row the planner is reading wears no ring.
    check(
      "the open conversation's row shows no finished ring",
      (await leaf(paymentsSession).locator(".leaf__dot--done").count()) === 0,
    );

    // --- f2. the head's title renames on a single click --------------------
    await page.locator(".thread__title").click();
    const titleInput = page.getByLabel("대화 이름");
    await titleInput.waitFor({ timeout: 5000 });
    await titleInput.fill("회원 화면 작업");
    await page.keyboard.press("Enter");
    await page.locator(".thread__title", { hasText: "회원 화면 작업" }).waitFor({ timeout: 5000 });
    // --- g. the two zones stand again after a reload ------------------------
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".planner__main").waitFor({ timeout: 30000 });
    await leaf(paymentsSecond).waitFor({ timeout: 30000 });
    await page.locator(".node", { hasText: "환불" }).waitFor({ timeout: 30000 });
    check(
      "the folds and the project rows survive a reload",
      (await page.locator(".leaf[data-thread-id]").count()) >= 2,
      (await page.locator(".leaf__title").allInnerTexts()).join(", "),
    );

    // --- h. the row menu renames a project in place ------------------------
    // ··· 는 hover 까지 visibility:hidden — pointer 를 행에 먼저 세운다.
    const paymentsRow = page.locator(".node", { hasText: "결제" });
    await paymentsRow.locator(".node__rowwrap").hover();
    await paymentsRow.locator(".node__menu-btn").click();
    await paymentsRow.getByRole("menuitem", { name: "이름 바꾸기" }).click();
    await page.getByLabel("프로젝트 이름").fill("결제 시스템");
    await page.keyboard.press("Enter");
    await page.locator(".node", { hasText: "결제 시스템" }).waitFor({ timeout: 15000 });
    check(
      "이름 바꾸기 renames the row in place",
      true,
      (await page.locator(".node__name").allInnerTexts()).join(", "),
    );

    // --- h1. 지켜 줄 것: the project's own rules, in the project's own place.
    //     The box lives on the project row, not in 설정 —
    //     and what it saves is what the next conversation is told.
    const guarded = page.locator(".node", { hasText: "결제 시스템" });
    await guarded.locator(".node__rowwrap").hover();
    await guarded.locator(".node__menu-btn").click();
    await guarded.getByRole("menuitem", { name: "지켜 줄 것" }).click();
    await page.locator('[role="dialog"][aria-label="지켜 줄 것"]').waitFor({ timeout: 10000 });
    await page.getByRole("textbox", { name: "지켜 줄 것" }).fill("버튼은 CDS 컴포넌트만 씁니다.");
    await page
      .locator('[role="dialog"][aria-label="지켜 줄 것"]')
      .getByRole("button", { name: "저장" })
      .click();
    await page
      .locator('[role="dialog"][aria-label="지켜 줄 것"]')
      .waitFor({ state: "detached", timeout: 15000 });
    const guardedProject = await call({ type: "project.list" });
    check(
      "지켜 줄 것 is saved on the project the row names",
      guardedProject.projects.find((project) => project.name === "결제 시스템")?.instructions ===
        "버튼은 CDS 컴포넌트만 씁니다.",
      JSON.stringify(guardedProject.projects.map((project) => project.instructions)),
    );
    // 다시 열면 적어 둔 것이 그대로 있어야 한다 — 상자가 자기 값을 잊으면
    // 사용자는 매번 처음부터 쓴다.
    await guarded.locator(".node__rowwrap").hover();
    await guarded.locator(".node__menu-btn").click();
    await guarded.getByRole("menuitem", { name: "지켜 줄 것" }).click();
    check(
      "reopening the box shows what was written",
      (await page.getByRole("textbox", { name: "지켜 줄 것" }).inputValue()) ===
        "버튼은 CDS 컴포넌트만 씁니다.",
    );
    await page.getByRole("button", { name: "취소" }).click();

    // --- h2. overflow past a project's tree budget becomes a count row -----
    // A project's tree holds five finished conversations; the rest must not
    // read as gone — the count row names them and opens the palette scoped
    // to that project (its history is its own scope now). The
    // conventions-prep thread may still be around — it is a conversation
    // too, so the number absorbs it. What this step proves is the
    // per-project cap plus a count row into the project's scope.
    for (let extra = 0; extra < 4; extra += 1) await call({ type: "session.create" });
    const paymentsNode = page.locator(".node", { hasText: "결제 시스템" });
    const moreRow = paymentsNode.locator(".leaf--more");
    await moreRow.waitFor({ timeout: 30000 });
    check(
      "a sixth finished conversation turns into a count row, not silence",
      (await paymentsNode.locator(".leaf[data-thread-id]").count()) === 5 &&
        /이전 대화 \d+개 더 보기/.test(await moreRow.innerText()),
      await moreRow.innerText(),
    );
    await moreRow.click();
    await page.locator(".palette__panel").waitFor({ timeout: 10000 });
    check(
      "the count row opens the palette scoped to the project",
      (await page.locator(".palette__search").getAttribute("placeholder")) ===
        "이 프로젝트의 대화 찾기",
      (await page.locator(".palette__search").getAttribute("placeholder")) ?? "",
    );
    await page.keyboard.press("Escape");
    await page.locator(".palette__panel").waitFor({ state: "detached", timeout: 10000 });
    check("the palette answers Escape like every menu", true);
    // The expanded rail's own portrait — the rail screenshot at the end of
    // this file is the folded one, so this one is the grouped view's.
    await page.screenshot({ path: join(here, "ui-sidebar-groups.png"), fullPage: true });

    // --- i. removing from the list keeps the folders -----------------------
    const workRootsBefore = (await call({ type: "project.list" }, 15000)).projects.length;
    await paymentsRow.locator(".node__rowwrap").hover();
    await paymentsRow.locator(".node__menu-btn").click();
    await paymentsRow.getByRole("menuitem", { name: "프로젝트 지우기" }).click();
    const removeDialog = page.locator('[role="dialog"][aria-label="프로젝트 지우기"]');
    await removeDialog.waitFor({ timeout: 15000 });
    check(
      "the removal dialog offers both scopes",
      (await removeDialog.getByRole("button", { name: "목록에서만 지우기" }).count()) === 1 &&
        (await removeDialog.getByRole("button", { name: "폴더까지 지우기" }).count()) === 1,
    );
    await removeDialog.getByRole("button", { name: "목록에서만 지우기" }).click();
    await page
      .locator(".node", { hasText: "결제 시스템" })
      .waitFor({ state: "detached", timeout: 15000 });
    const afterRemove = await call({ type: "project.list" }, 15000);
    check(
      "the row disappears and the list shrinks by one",
      afterRemove.projects.length === workRootsBefore - 1,
      `${workRootsBefore} → ${afterRemove.projects.length}`,
    );
    check(
      "no dangerous ask fell back to the browser's confirm",
      (await page.evaluate(() => window.__nativeConfirmUsed ?? false)) === false,
    );

    // --- j. the folded rail opens a conversation popover -------------------
    await page.setViewportSize({ width: 960, height: 720 });
    await page.locator(".sidebar--collapsed").waitFor({ timeout: 10000 });
    check(
      "a 960px window auto-folds the rail",
      (await page.locator(".sidebar--collapsed").count()) === 1,
    );
    // The rail's tile keeps the project's accessible name; the badge's words
    // ride along when there is state to say (변경 N · 확인 대기 · 넘김…).
    const refundsTile = page.getByRole("button", { name: /환불 대화/ });
    await refundsTile.waitFor({ timeout: 10000 });
    await refundsTile.click();
    const popover = page.locator(".node__pop");
    await popover.waitFor({ timeout: 10000 });
    // poprise(0.18s 스프링) 의 overshoot 은 정착 전 경계를 순간적으로 벗어
    // 한다 — 재는 것은 멈춘 자리다. 병렬 레인의 부하가 애니메이션을 늘린다.
    await popover.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    check(
      "the rail's icon click opens the conversation popover",
      (await popover.getByRole("menuitem", { name: "새 화면" }).count()) >= 1 &&
        (await popover.getByRole("menuitem", { name: "＋ 새 대화" }).count()) === 1,
      `${(await popover.innerText()).split("\n").slice(0, 3).join(" · ")}`,
    );
    const geom = await popover.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        verdict:
          r.left >= 44 &&
          r.right <= window.innerWidth &&
          r.top >= 0 &&
          r.bottom <= window.innerHeight &&
          r.width > 100,
        detail:
          `l:${Math.round(r.left)} r:${Math.round(r.right)} t:${Math.round(r.top)} ` +
          `b:${Math.round(r.bottom)} w:${Math.round(r.width)} ih:${window.innerHeight}`,
      };
    });
    check("the popover opens beside the rail, whole inside the window", geom.verdict, geom.detail);
    // Picking a conversation from the popover opens it.
    await popover.getByRole("menuitem").first().click();
    await popover.waitFor({ state: "detached", timeout: 10000 });
    check("a popover row click closes the popover", true);

    check("no uncaught console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
    await page.screenshot({
      path: join(here, "ui-sidebar-e2e.png"),
      fullPage: true,
    });
  } finally {
    await browser.close();
    server.close();
    await stopDaemon(daemon);
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  rmSync(DIR, { recursive: true, force: true });
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
