/**
 * Browser-level check of the publish review, without spending a model turn.
 *
 * The connected repo is a local fixture remote; the "work to publish" is
 * written straight into the clone (what Claude's Write tool would have left
 * there), and the test drives the panel the planner uses: changed-file list
 * with expandable hunks, a commit message, 승인, then the published result —
 * and verifies the commit actually reached the bare remote.
 *
 * Prerequisites: `pnpm build`
 */
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { createFixtureRepo, freePort, writeStubClaude } from "../../daemon/test/fixture-repo.mjs";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const daemonEntry = join(repoRoot, "packages", "daemon", "dist", "index.js");
const webDist = join(repoRoot, "packages", "web", "dist");
const DIR = join(tmpdir(), "drafthouse-publish-ui");
const WORK_ROOT = join(DIR, "work");
const PORT = 5398;

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") {
    throw new Error(`check("${name}") was called without a verdict`);
  }
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

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

async function remoteHead(remote, ref = "main") {
  const { stdout } = await run("git", ["--git-dir", remote, "rev-parse", ref]);
  return stdout.trim();
}

/** The branch a save created, as the bare remote sees it. */
async function cycleBranch(remote) {
  const { stdout } = await run("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return stdout.split("\n").map((line) => line.trim()).find((name) => name.startsWith("drafthouse/")) ?? null;
}


/**
 * Every cycle action lives in 더 보기 whatever the stepper is suggesting
 * (PLAN D8) — the rail is advice, not a gate. This suite has no 기획서 open,
 * so the stepper has no primary to press and the menu is the only way in.
 */
async function viaMenu(page, label) {
  await page.getByRole("button", { name: "더 보기" }).click();
  await page.getByRole("menuitem", { name: label }).click();
}

async function main() {
  if (!existsSync(webDist)) throw new Error("web dist missing. Run: pnpm --filter @drafthouse/web build");
  if (!existsSync(daemonEntry)) throw new Error("daemon dist missing. Run: pnpm --filter @drafthouse/daemon build");

  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "claude-config"), { recursive: true });
  const previewPort = await freePort();
  const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port: previewPort });
  const remoteBefore = await remoteHead(fixture.remote);

  const env = {
    ...process.env,
    DRAFTHOUSE_PORT: String(await freePort()),
    DRAFTHOUSE_REPO_DIR: WORK_ROOT,
    DRAFTHOUSE_REPO_URL: fixture.remote,
    DRAFTHOUSE_REPO_SETTINGS: join(DIR, "settings.json"),
    // The registry is what decides which repo and mirror the daemon means, so
    // it lives in the throwaway directory too — left on its default this suite
    // would write (and migrate) the developer's own ~/drafthouse.
    DRAFTHOUSE_PROJECTS_SETTINGS: join(DIR, "projects.json"),
    DRAFTHOUSE_PROJECTS_DIR: join(DIR, "projects"),
    CLAUDE_CONFIG_DIR: join(DIR, "claude-config"),
    DRAFTHOUSE_CLAUDE_BIN: writeStubClaude(join(DIR, "bin")),
    DRAFTHOUSE_CONFLUENCE_SITE: "https://example.atlassian.net",
    DRAFTHOUSE_CONFLUENCE_EMAIL: "dev@example.com",
    DRAFTHOUSE_CONFLUENCE_TOKEN: "publish-ui-token",
    DRAFTHOUSE_CONFLUENCE_FIXTURE: join(
      repoRoot,
      "packages",
      "daemon",
      "test",
      "fixtures",
      "confluence",
      "golden",
    ),
    DRAFTHOUSE_CREDENTIAL_STORE: "memory",
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

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
    await page.getByRole("button", { name: "연결" }).click();
    await page.waitForSelector(".planner__body", { timeout: 60000 });
    await page.getByRole("tab", { name: "화면" }).click();
    await page.waitForSelector(".preview", { timeout: 600000 });
    check("the planner connects and the 화면 segment shows the repo preview", true);

    // --- the panel --------------------------------------------------------
    await viaMenu(page, "저장");
    await page.waitForSelector('[role="dialog"][aria-label="저장 검토"]', { timeout: 5000 });
    check("the empty panel says there is nothing to save", (await page.locator(".diff__files").count()) === 0);
    await page.keyboard.press("Escape");
    check("escape closes the review", (await page.locator('[role="dialog"][aria-label="저장 검토"]').count()) === 0);

    // --- work appears, the review shows it --------------------------------
    mkdirSync(join(WORK_ROOT, "src", "screens", "member"), { recursive: true });
    writeFileSync(
      join(WORK_ROOT, "src", "screens", "member", "MemberList.screen.tsx"),
      'export default function MemberListScreen() { return null; }\n',
    );
    const indexHtml = readFileSync(join(WORK_ROOT, "index.html"), "utf8");
    writeFileSync(join(WORK_ROOT, "index.html"), `${indexHtml}<p>회원 관리 목록 추가</p>\n`);

    await viaMenu(page, "저장");
    await page.waitForSelector(".diff__file", { timeout: 10000 });
    const rows = page.locator(".diff__file");
    check(
      "every changed file is listed with its status",
      (await rows.count()) === 2,
      (await page.locator(".diff__path").allInnerTexts()).join(", "),
    );
    check(
      "a new screen reads 추가, an edit reads 수정",
      (await page.locator(".diff__badge").allInnerTexts()).sort().join(",") === "수정,추가",
    );

    // Single-hunk files are expanded by default; the added file's hunk is
    // on screen without a click.
    const hunk = await page
      .locator(".diff__file", { hasText: "MemberList.screen.tsx" })
      .locator(".diff__hunk")
      .innerText();
    check(
      "the hunk shows the added content",
      hunk.includes("+export default function MemberListScreen"),
      hunk.split("\n")[0] ?? "",
    );

    // --- save, and watch it land on its own branch ------------------------
    await page.getByLabel("저장 메모").fill("회원 관리 화면 추가");
    await page.locator('[role="dialog"][aria-label="저장 검토"]').getByRole("button", { name: "저장", exact: true }).click();
    await page.waitForSelector(".notice--info", { timeout: 120000 });

    await page.waitForFunction(() => document.querySelectorAll(".diff__file").length === 0, undefined, { timeout: 10000 });
    check("the panel reloads to an empty diff", true);

    const branch = await cycleBranch(fixture.remote);
    check("the save created its own branch on the remote", branch !== null, `${branch}`);
    check(
      "the developer's base branch did not move",
      (await remoteHead(fixture.remote)) === remoteBefore,
      remoteBefore.slice(0, 10),
    );
    const { stdout: subject } = await run("git", ["--git-dir", fixture.remote, "log", "-1", "--pretty=%s", branch]);
    check("the planner's message is the commit subject", subject.trim() === "회원 관리 화면 추가", subject.trim());

    await page.getByRole("button", { name: "닫기", exact: true }).click();
    check("closing the review returns to the planner", (await page.locator('[role="dialog"]').count()) === 0);

    check("no uncaught console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
    await page.screenshot({ path: join(here, "ui-publish-e2e.png"), fullPage: true });
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
  console.error(`\nPUBLISH UI E2E ERROR: ${error.message}`);
  process.exit(2);
});
