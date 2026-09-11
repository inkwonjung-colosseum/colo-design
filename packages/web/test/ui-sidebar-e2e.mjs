/**
 * Browser-level check of the project sidebar and its conversation tree
 * (PLAN D12–D21, D59), fully offline.
 *
 * Two projects are created over the daemon socket (the same WebSocket the
 * browser uses), then the test drives the tree the planner uses: the project
 * rows with their conversations as children, the active mark, a one-click
 * jump into another project's conversation (the workspace switches and the
 * old project's preview port stops answering), a background turn reading
 * 작업 중 → 답이 왔습니다, a fold that survives a reload, and the folded
 * rail's conversation popover.
 *
 * Prerequisites: `pnpm build` (daemon + web dist)
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { createFixtureRepo, freePort } from "../../daemon/test/fixture-repo.mjs";
import { fileURLToPath } from "node:url";

/**
 * A fake `claude` CLI whose real invocation stalls two seconds — long enough
 * for a background turn's 작업 중 mark to be watched before it settles.
 * (Same shape as projects-e2e's, kept local: fixture-repo stays UI-agnostic.)
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
      "sleep 2",
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
const DIR = join(tmpdir(), "cds-design-sidebar-ui-e2e");
const PORT = 5402;

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") {
    throw new Error(`check("${name}") was called without a verdict`);
  }
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };

function serveDist() {
  const server = createServer((req, res) => {
    const path = req.url === "/" ? "/index.html" : (req.url ?? "/").split("?")[0];
    const file = existsSync(join(webDist, path)) ? join(webDist, path) : join(webDist, "index.html");
    res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(PORT, "127.0.0.1", () => ok(server)));
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** Waits until a TCP connect to the port is refused, giving the daemon a
    moment to take the old project's preview down. */
async function portClosed(port) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      await sleep(500);
    } catch {
      return true;
    }
  }
  return false;
}

async function main() {
  if (!existsSync(webDist)) throw new Error("web dist missing. Run: pnpm --filter @cds-design/web build");
  if (!existsSync(daemonEntry)) throw new Error("daemon dist missing. Run: pnpm --filter @cds-design/daemon build");

  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "claude-config"), { recursive: true });
  // Two repos, two ports: the tree's whole claim is one node per project with
  // each one's conversations beneath it, and only the active project's
  // preview port serving. The turn stub stalls two seconds, so a background
  // turn can be watched mid-flight (작업 중) before it settles.
  const paymentsFixture = await createFixtureRepo({ dir: join(DIR, "fixture-payments"), port: await freePort() });
  const refundsFixture = await createFixtureRepo({ dir: join(DIR, "fixture-refunds"), port: await freePort() });

  const env = {
    ...process.env,
    CDS_DESIGN_PORT: String(await freePort()),
    CDS_DESIGN_PROJECTS_SETTINGS: join(DIR, "projects.json"),
    CDS_DESIGN_PROJECTS_DIR: join(DIR, "projects"),
    CLAUDE_CONFIG_DIR: join(DIR, "claude-config"),
    CDS_DESIGN_CLAUDE_BIN: writeTurnStubClaude(join(DIR, "bin")),
    CDS_DESIGN_CREDENTIAL_STORE: "memory",
  };
  delete env.ANTHROPIC_API_KEY;
  const daemon = spawn(process.execPath, [daemonEntry], { env, stdio: ["ignore", "pipe", "pipe"] });
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
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  // 결함③ (PLAN 0단계): the browser's own confirm must never enter the
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
            ws.addEventListener(
              "message",
              (event) => {
                const reply = JSON.parse(String(event.data));
                if (reply.id !== message.id) return;
                clearTimeout(timer);
                reply.type === "ok" ? ok(reply.data) : fail(new Error(reply.message));
              },
            );
            ws.send(JSON.stringify(message));
          });
        } finally {
          ws.close();
        }
      },
      { url: daemonUrl, message: { ...message, id: `t${Math.random().toString(36).slice(2)}` }, timeoutMs },
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
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
    await page.getByRole("button", { name: "연결" }).click();
    await page.waitForSelector(".onboarding", { timeout: 60000 });
    const start = page.getByRole("button", { name: "시작하기" });
    await start.waitFor({ timeout: 30000 });
    await start.click();
    await page.waitForSelector(".planner__body", { timeout: 60000 });
    // --- a. two projects, over the same socket the browser uses -----------
    await call({ type: "project.create", name: "결제", repoUrl: paymentsFixture.remote });
    await call({ type: "project.create", name: "환불", repoUrl: refundsFixture.remote });
    await waitReady("the 환불 clone");
    check("two projects created over the socket, both cloning", true);

    // --- b. one node per project, the active one marked --------------------
    await page.waitForFunction(
      () => document.querySelectorAll(".node").length === 2,
      undefined,
      { timeout: 30000 },
    );
    check("the tree holds one node per project", (await page.locator(".node").count()) === 2);
    const activeNode = page.locator(".node--active");
    check(
      "the active mark sits on the project just created",
      (await activeNode.count()) === 1 && (await activeNode.innerText()).includes("환불"),
      (await page.locator(".node__name").allInnerTexts()).join(", "),
    );

    // --- b2. a conversation shows up as its project's child row ------------
    const { sessionId: refundsSession } = await call({ type: "session.create" });
    await leaf(refundsSession).waitFor({ timeout: 30000 });
    check(
      "a created session arrives as a child row of its project",
      (await page.locator(".leaf[data-thread-id]").count()) === 1 &&
        (await leaf(refundsSession).innerText()).includes("새 화면"),
      (await leaf(refundsSession).innerText()).split("\n")[0] ?? "",
    );

    // --- c. clicking a row switches the whole workspace --------------------
    const refundsPreview = await call({ type: "repo.status" }, 15000);
    const refundsPort = Number(new URL(refundsPreview.previewUrl).port);
    await page.locator(".node", { hasText: "결제" }).locator(".node__row").click();
    await page.locator(".planner__project", { hasText: "결제" }).waitFor({ timeout: 15000 });
    check("the header switches the moment a row is clicked", true);
    const paymentsStatus = await waitReady("the 결제 clone after the switch");
    const paymentsPort = Number(new URL(paymentsStatus.previewUrl).port);
    await page
      .locator(`.preview__frame[src="http://127.0.0.1:${paymentsPort}"]`)
      .waitFor({ timeout: 30000 });
    check("the preview column serves the new project's fixture port", true, `port ${paymentsPort}`);

    // --- d. one conversation per project, both visible at once -------------
    const { sessionId: paymentsSession } = await call({ type: "session.create" });
    await leaf(paymentsSession).waitFor({ timeout: 30000 });
    // Back to 환불: the tree's point is that 결제's conversation stays visible
    // while nobody is looking at that project.
    await page.locator(".node", { hasText: "환불" }).locator(".node__row").click();
    await page.locator(".planner__project", { hasText: "환불" }).waitFor({ timeout: 15000 });
    await waitReady("the 환불 clone after the second switch");
    await leaf(paymentsSession).waitFor({ timeout: 30000 });
    check(
      "two projects' conversations show in the tree at the same time",
      (await page.locator(".leaf").count()) >= 2,
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
    check(
      "clicking another project's child makes it active and opens it",
      (await leaf(paymentsSession).getAttribute("class"))?.includes("leaf--active") === true,
    );
    check(
      "the jumped-from project's preview port no longer answers",
      await portClosed(refundsPort),
      `port ${refundsPort}`,
    );

    // --- f. a background turn reads 작업 중, then 답이 왔습니다 -------------
    const { sessionId: paymentsSecond } = await call({ type: "session.create" });
    await leaf(paymentsSecond).waitFor({ timeout: 30000 });
    await call({ type: "session.send", sessionId: paymentsSecond, text: "스텁 턴" });
    await leaf(paymentsSecond).locator(".leaf__meta--live").waitFor({ timeout: 30000 });
    check(
      "a turn on a background row reads 작업 중",
      (await leaf(paymentsSecond).innerText()).includes("작업 중"),
    );
    await leaf(paymentsSecond).locator(".leaf__meta", { hasText: "답이 왔습니다" }).waitFor({ timeout: 60000 });
    check(
      "the settled turn reads 답이 왔습니다 with a ring",
      (await leaf(paymentsSecond).locator(".leaf__dot--done").count()) === 1,
    );
    // The row the planner is reading wears no ring (PLAN D2).
    check(
      "the open conversation's row shows no finished ring",
      (await leaf(paymentsSession).locator(".leaf__dot--done").count()) === 0,
    );

    // --- g. a fold survives a reload ---------------------------------------
    await page.locator(".node", { hasText: "환불" }).locator(".node__chev").click();
    const refundsNode = page.locator(".node", { hasText: "환불" });
    await refundsNode.waitFor({ state: "visible", timeout: 5000 });
    check(
      "the chevron folds a project's conversations away",
      (await refundsNode.getAttribute("class"))?.includes("node--folded") === true &&
        (await page.locator(".node--folded").count()) === 1,
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".planner__body").waitFor({ timeout: 30000 });
    await page.locator(".node", { hasText: "환불" }).waitFor({ timeout: 30000 });
    const foldedAfterReload = page.locator(".node", { hasText: "환불" });
    check(
      "the fold survives a reload",
      (await foldedAfterReload.getAttribute("class"))?.includes("node--folded") === true,
    );
    await foldedAfterReload.locator(".node__chev").click();

    // --- h. the row menu renames a project in place ------------------------
    const paymentsRow = page.locator(".node", { hasText: "결제" });
    await paymentsRow.locator(".node__menu-btn").click();
    await paymentsRow.getByRole("menuitem", { name: "이름 바꾸기" }).click();
    await page.getByLabel("프로젝트 이름").fill("결제 시스템");
    await page.keyboard.press("Enter");
    await page.locator(".node", { hasText: "결제 시스템" }).waitFor({ timeout: 15000 });
    check("이름 바꾸기 renames the row in place", true, (await page.locator(".node__name").allInnerTexts()).join(", "));

    // --- i. removing from the list keeps the folders -----------------------
    const workRootsBefore = (await call({ type: "project.list" }, 15000)).projects.length;
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
    await page.locator(".node", { hasText: "결제 시스템" }).waitFor({ state: "detached", timeout: 15000 });
    const afterRemove = await call({ type: "project.list" }, 15000);
    check(
      "the row disappears and the list shrinks by one",
      afterRemove.projects.length === workRootsBefore - 1,
      `${workRootsBefore} → ${afterRemove.projects.length}`,
    );
    check(
      "no dangerous ask fell back to the browser's confirm (결함③)",
      (await page.evaluate(() => window.__nativeConfirmUsed ?? false)) === false,
    );

    // --- j. the folded rail opens a conversation popover -------------------
    await page.setViewportSize({ width: 960, height: 720 });
    await page.locator(".sidebar--collapsed").waitFor({ timeout: 10000 });
    check("a 960px window auto-folds the rail", (await page.locator(".sidebar--collapsed").count()) === 1);
    // The rail's tile keeps the project's accessible name; the badge's words
    // ride along when there is state to say (변경 N · 확인 대기 · 넘김…).
    const refundsTile = page.getByRole("button", { name: /환불 대화/ });
    await refundsTile.waitFor({ timeout: 10000 });
    await refundsTile.click();
    const popover = page.locator(".node__pop");
    await popover.waitFor({ timeout: 10000 });
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
    await page.screenshot({ path: join(here, "ui-sidebar-e2e.png"), fullPage: true });
  } finally {
    await browser.close();
    server.close();
    daemon.kill("SIGTERM");
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
