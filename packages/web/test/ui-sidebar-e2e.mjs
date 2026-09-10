/**
 * Browser-level check of the project sidebar (PLAN D12–D21), fully offline.
 *
 * Two projects are created over the daemon socket (the same WebSocket the
 * browser uses), then the test drives the rail the planner uses: the rows
 * and the active mark, switching projects from a row, the one-preview rule
 * (the old project's port stops answering), the row menu's 이름 바꾸기 and
 * 프로젝트 지우기, and the narrow-window auto fold.
 *
 * Prerequisites: `pnpm build` (daemon + web dist)
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createFixtureRepo, freePort, writeStubClaude } from "../../daemon/test/fixture-repo.mjs";

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
    const requested = (req.url ?? "/").split("?")[0];
    let file = join(webDist, requested === "/" ? "index.html" : requested);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(webDist, "index.html");
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
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
  // Two repos, two ports: the sidebar's whole claim is one row per project,
  // and only the active project's preview port serving.
  const paymentsFixture = await createFixtureRepo({ dir: join(DIR, "fixture-payments"), port: await freePort() });
  const refundsFixture = await createFixtureRepo({ dir: join(DIR, "fixture-refunds"), port: await freePort() });

  const env = {
    ...process.env,
    CDS_DESIGN_PORT: String(await freePort()),
    // Per-project clones live under the registry; no legacy repo overrides,
    // which would pin every message to one clone (see projects-e2e).
    CDS_DESIGN_PROJECTS_SETTINGS: join(DIR, "projects.json"),
    CDS_DESIGN_PROJECTS_DIR: join(DIR, "projects"),
    CLAUDE_CONFIG_DIR: join(DIR, "claude-config"),
    CDS_DESIGN_CLAUDE_BIN: writeStubClaude(join(DIR, "bin")),
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

  /** A second socket from the page: setup and repo.status polling. */
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
    for (const deadline = Date.now() + 90000; Date.now() < deadline; ) {
      const status = await call({ type: "repo.status" }, 15000);
      if (status.phase === "ready") return status;
      if (status.phase === "error") throw new Error(`${label}: ${status.detail ?? status.phase}`);
      await sleep(1000);
    }
    throw new Error(`${label}: never became ready`);
  };

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
    await page.getByRole("button", { name: "연결" }).click();
    // A fresh machine opens the wizard first; the github gate is only a
    // warn, so 시작하기 clears it without a token and the workspace (empty
    // until the projects below land) takes over.
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

    // --- b. one row per project, the active one marked --------------------
    await page.waitForFunction(
      () => document.querySelectorAll(".sidebar__row").length === 2,
      undefined,
      { timeout: 30000 },
    );
    check("the sidebar holds one row per project", (await page.locator(".sidebar__row").count()) === 2);
    const activeRow = page.locator(".sidebar__row--active");
    check(
      "the active mark sits on the project just created",
      (await activeRow.count()) === 1 && (await activeRow.innerText()).includes("환불"),
      (await page.locator(".sidebar__name").allInnerTexts()).join(", "),
    );

    // --- c. clicking a row switches the whole workspace -------------------
    const refundsPreview = await call({ type: "repo.status" }, 15000);
    const refundsPort = Number(new URL(refundsPreview.previewUrl).port);
    await page
      .locator(".sidebar__row", { hasText: "결제" })
      .locator(".sidebar__main")
      .click();
    await page
      .locator(".planner__project", { hasText: "결제" })
      .waitFor({ timeout: 15000 });
    check("the header switches the moment a row is clicked", true);
    const paymentsStatus = await waitReady("the 결제 clone after the switch");
    const paymentsPort = Number(new URL(paymentsStatus.previewUrl).port);
    await page
      .locator(`.preview__frame[src="http://127.0.0.1:${paymentsPort}"]`)
      .waitFor({ timeout: 30000 });
    check("the preview column serves the new project's fixture port", true, `port ${paymentsPort}`);

    // --- d. only the active project runs a preview ------------------------
    check(
      "the other project's preview port no longer accepts connections",
      await portClosed(refundsPort),
      `port ${refundsPort}`,
    );

    // --- e. the row menu renames a project in place -----------------------
    const paymentsRow = page.locator(".sidebar__row", { hasText: "결제" });
    await paymentsRow.locator(".sidebar__menu-btn").click();
    await paymentsRow.getByRole("menuitem", { name: "이름 바꾸기" }).click();
    await page.getByLabel("프로젝트 이름").fill("결제 시스템");
    await page.keyboard.press("Enter");
    await page
      .locator(".sidebar__row", { hasText: "결제 시스템" })
      .waitFor({ timeout: 15000 });
    check("이름 바꾸기 renames the row in place", true, (await page.locator(".sidebar__name").allInnerTexts()).join(", "));

    // --- f. removing from the list keeps the folders ----------------------
    const workRootsBefore = (await call({ type: "project.list" }, 15000)).projects.length;
    await paymentsRow.locator(".sidebar__menu-btn").click();
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
      .locator(".sidebar__row", { hasText: "결제 시스템" })
      .waitFor({ state: "detached", timeout: 15000 });
    const afterRemove = await call({ type: "project.list" }, 15000);
    check(
      "the row disappears and the list shrinks by one",
      afterRemove.projects.length === workRootsBefore - 1,
      `${workRootsBefore} → ${afterRemove.projects.length}`,
    );

    // --- g. a narrow window folds the rail --------------------------------
    await page.setViewportSize({ width: 960, height: 720 });
    await page.locator(".sidebar--collapsed").waitFor({ timeout: 10000 });
    check("a 960px window auto-folds the rail", (await page.locator(".sidebar--collapsed").count()) === 1);

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
