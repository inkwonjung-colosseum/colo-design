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
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const DIR = join(tmpdir(), "cds-design-publish-ui");
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
  return stdout.split("\n").map((line) => line.trim()).find((name) => name.startsWith("cds-design/")) ?? null;
}

/**
 * A claude that answers the gates, then fails EVERY turn on the stream-json
 * wire (PLAN D35): the offline stand-in for a turn that ends wrong, so the
 * browser can prove the silence is gone.
 */
function writeErrorStubClaude(dir) {
  const path = writeStubClaude(dir);
  // The gates read --version and `auth status`; the SDK's stream-json run
  // falls through the stub's case and used to exit silently. Now it answers
  // with a failed result (PLAN D35), so the browser can prove the silence is
  // gone. Single-quoted sh echoes: the JSON carries no single quotes.
  const script = readFileSync(path, "utf8").replace(
    "esac\nexit 0",
    [
      "esac",
      `echo '{"type":"system","subtype":"init","session_id":"stub","tools":[],"mcp_servers":[],"model":"stub","permissionMode":"default","slash_commands":[],"agents":[]}'`,
      `echo '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["의도된 스텁 실패"],"result":"의도된 스텁 실패","session_id":"stub","total_cost_usd":0,"duration_ms":10,"num_turns":1}'`,
      "exit 0",
    ].join("\n"),
  );
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

/**
 * The stepper owns the cycle's primary button (PLAN D44): one at every
 * moment, its label the stage table's — 검토·수정 offers 저장, a saved
 * branch offers 개발자에게 넘기기.
 */
async function viaActionBar(page, label) {
  await page.locator(".stepper").getByRole("button", { name: label, exact: true }).click();
}

/**
 * The always-there route (PLAN D44): 더 보기 ▾ carries every cycle action.
 * An empty cycle's primary button is 새 대화, so "there is nothing to save"
 * is proven through the menu rather than the stepper.
 */
async function viaMoreMenu(page, label) {
  await page.locator(".screenpanel__bar").getByRole("button", { name: "더 보기" }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}
async function main() {
  if (!existsSync(webDist)) throw new Error("web dist missing. Run: pnpm --filter @cds-design/web build");
  if (!existsSync(daemonEntry)) throw new Error("daemon dist missing. Run: pnpm --filter @cds-design/daemon build");

  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "claude-config"), { recursive: true });
  const previewPort = await freePort();
  const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port: previewPort });
  const remoteBefore = await remoteHead(fixture.remote);

  const env = {
    ...process.env,
    CDS_DESIGN_PORT: String(await freePort()),
    CDS_DESIGN_REPO_DIR: WORK_ROOT,
    CDS_DESIGN_REPO_URL: fixture.remote,
    CDS_DESIGN_REPO_SETTINGS: join(DIR, "settings.json"),
    // The registry is what decides which repo the daemon means, so it lives
    // in the throwaway directory too — left on its default this suite would
    // write the developer's own ~/cds-design.
    CDS_DESIGN_PROJECTS_SETTINGS: join(DIR, "projects.json"),
    CDS_DESIGN_PROJECTS_DIR: join(DIR, "projects"),
    CLAUDE_CONFIG_DIR: join(DIR, "claude-config"),
    CDS_DESIGN_CLAUDE_BIN: writeErrorStubClaude(join(DIR, "bin")),
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

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
    await page.getByRole("button", { name: "연결" }).click();
    try {
      await page.waitForSelector(".planner__body", { timeout: 60000 });
    } catch {
      console.error("CONNECT DUMP:", (await page.locator("body").innerText()).slice(0, 800).replace(/\n+/g, " | "));
      throw new Error("planner body never appeared");
    }
    await page.waitForSelector(".screenpanel__bar", { timeout: 60000 });
    await page.waitForSelector(".preview", { timeout: 600000 });
    check("the planner connects and the workspace shows the repo preview", true);

    // --- the panel --------------------------------------------------------
    await viaMoreMenu(page, "저장");
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

    // The stepper's number is event-driven (PLAN D8): a turn finishing or a
    // save recounts it, and these raw writes are neither — so one 레포 최신화
    // is what moves the primary button from 새 대화 to 저장.
    await page.locator(".screenpanel__bar").getByRole("button", { name: "최신화" }).click();
    await page.locator(".stepper").getByRole("button", { name: "저장", exact: true }).waitFor({ timeout: 20000 });
    await viaActionBar(page, "저장");
    // PLAN D51: the summary is the first thing; the raw files live behind
    await page.getByText("자세히 보기 (파일 2개)").waitFor({ timeout: 10000 });
    check(
      "the summary is on top and the raw diff waits behind a fold",
      (await page.getByText("자세히 보기 (파일 2개)").isVisible()) === true &&
        (await page.locator(".diff__file").first().isVisible()) === false,
    );
    await page.getByText("자세히 보기 (파일 2개)").click();
    await page.locator(".diff__file").first().waitFor({ state: "visible", timeout: 10000 });
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

    // --- a failed turn is a card, not a silence (PLAN D35) ----------------
    // The tree offers two ways to start one (the row's ＋ and, for a project
    // with no conversations, its own row); this drives the row's ＋.
    await page.locator(".node__add").first().click();
    const field = page.getByPlaceholder("만들고 싶은 화면을 말해 주세요");
    await field.fill("화면을 만들어 줘");
    await field.press("Enter");
    await page.waitForSelector(".turnfail", { timeout: 30000 });
    check(
      "a failed turn is a card that says what happened",
      (await page.locator(".turnfail").innerText()).includes("답을 마치지 못했습니다"),
    );
    const retry = page.locator(".turnfail").getByRole("button", { name: "다시 보내기" });
    check("the card offers the same words back", (await retry.count()) === 1);
    await retry.click();
    // A failed turn closes the CLI run; resuming may continue the same thread
    // or open a fresh one on the same words. What must hold either way: the
    // words went out again (the field emptied) and a failed-turn card stands.
    await page.waitForFunction(
      () => {
        const area = document.querySelector(".composer textarea");
        return area instanceof HTMLTextAreaElement && area.value === "";
      },
      undefined,
      { timeout: 30000 },
    );
    await page.waitForSelector(".turnfail", { timeout: 30000 });
    check("retrying sends the same words again", true);

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
