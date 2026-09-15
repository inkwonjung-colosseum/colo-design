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
import { execFile, spawn } from "node:child_process";
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
import { promisify } from "node:util";
import { chromium } from "playwright";
import { createFixtureRepo, freePort } from "../../daemon/test/fixture-repo.mjs";
import { stopDaemon } from "./stop-daemon.mjs";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const daemonEntry = join(repoRoot, "packages", "daemon", "dist", "index.js");
const webDist = join(repoRoot, "packages", "web", "dist");
const DIR = join(tmpdir(), "colo-design-publish-ui");
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

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
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

async function remoteHead(remote, ref = "main") {
  const { stdout } = await run("git", ["--git-dir", remote, "rev-parse", ref]);
  return stdout.trim();
}

/** The branch a save created, as the bare remote sees it. */
async function cycleBranch(remote) {
  const { stdout } = await run("git", [
    "--git-dir",
    remote,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  return (
    stdout
      .split("\n")
      .map((line) => line.trim())
      .find((name) => name.startsWith("colo-design/")) ?? null
  );
}

/**
 * A claude that answers the gates, then fails EVERY turn on the stream-json
 * wire (PLAN D35): the offline stand-in for a turn that ends wrong, so the
 * browser can prove the silence is gone.
 */
function writeErrorStubClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  const promptsLog = join(dir, "prompts.log");
  // The gates read --version and `auth status`; the SDK's stream-json run
  // fails every turn (PLAN D35) so the browser can prove the silence is
  // gone. Every stdin line is appended to prompts.log synchronously — the
  // wire-level record a resend assertion can count.
  const script = [
    "#!/usr/bin/env node",
    "const fs = require('fs');",
    "const args = process.argv.slice(2);",
    'if (args[0] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
    'if (args[0] === "auth") {',
    '  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "team", email: "planner@example.com" }));',
    "  process.exit(0);",
    "}",
    `const LOG = ${JSON.stringify(promptsLog)};`,
    'const INIT = { type: "system", subtype: "init", session_id: "stub", tools: [], mcp_servers: [], model: "stub", permissionMode: "default", slash_commands: [], agents: [] };',
    'const FAIL = { type: "result", subtype: "error_during_execution", is_error: true, errors: ["의도된 스텁 실패"], result: "의도된 스텁 실패", session_id: "stub", total_cost_usd: 0, duration_ms: 10, num_turns: 1 };',
    'let buf = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => {',
    "  buf += chunk;",
    "  let idx;",
    '  while ((idx = buf.indexOf("\\n")) !== -1) {',
    "    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);",
    '    fs.appendFileSync(LOG, line + "\\n");',
    "    let o = null; try { o = JSON.parse(line); } catch { continue; }",
    '    if (o.type === "user") {',
    '      process.stdout.write(JSON.stringify(INIT) + "\\n");',
    '      process.stdout.write(JSON.stringify(FAIL) + "\\n");',
    "    }",
    "  }",
    "});",
    "",
  ].join("\n");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

/**
 * The action set lives in the top bar (PLAN D82): 저장 · 개발자에게 넘기기 ·
 * 상태 확인 are always drawn and locked by condition — the label is the
 * button's, the reason is its title.
 */
async function viaActionBar(page, label) {
  await page.locator(".screenpanel__bar").getByRole("button", { name: label, exact: true }).click();
}
async function main() {
  if (!existsSync(webDist))
    throw new Error("web dist missing. Run: pnpm --filter @colo-design/web build");
  if (!existsSync(daemonEntry))
    throw new Error("daemon dist missing. Run: pnpm --filter @colo-design/daemon build");

  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "claude-config"), { recursive: true });
  const previewPort = await freePort();
  const fixture = await createFixtureRepo({
    dir: join(DIR, "fixture"),
    port: previewPort,
  });
  const remoteBefore = await remoteHead(fixture.remote);

  const env = {
    ...process.env,
    COLO_DESIGN_PORT: String(await freePort()),
    COLO_DESIGN_REPO_DIR: WORK_ROOT,
    COLO_DESIGN_REPO_URL: fixture.remote,
    COLO_DESIGN_REPO_SETTINGS: join(DIR, "settings.json"),
    // The registry is what decides which repo the daemon means, so it lives
    // in the throwaway directory too — left on its default this suite would
    // write the developer's own ~/colo-design.
    COLO_DESIGN_PROJECTS_SETTINGS: join(DIR, "projects.json"),
    COLO_DESIGN_PROJECTS_DIR: join(DIR, "projects"),
    CLAUDE_CONFIG_DIR: join(DIR, "claude-config"),
    COLO_DESIGN_CLAUDE_BIN: writeErrorStubClaude(join(DIR, "bin")),
    COLO_DESIGN_CREDENTIAL_STORE: "memory",
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
    await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
    await page.getByRole("button", { name: "연결" }).click();
    try {
      await page.waitForSelector(".planner__body", { timeout: 60000 });
    } catch {
      console.error(
        "CONNECT DUMP:",
        (await page.locator("body").innerText()).slice(0, 800).replace(/\n+/g, " | "),
      );
      throw new Error("planner body never appeared");
    }
    await page.waitForSelector(".screenpanel__bar", { timeout: 60000 });
    await page.waitForSelector(".preview", { timeout: 600000 });
    check("the planner connects and the workspace shows the repo preview", true);

    // --- the empty cycle --------------------------------------------------
    // "저장할 것이 없다"는 잠긴 버튼의 title 로 증명한다 (PLAN D82) — 잠긴
    // 저장은 패널을 열 수도 없다.
    const emptySave = page
      .locator(".screenpanel__bar")
      .getByRole("button", { name: "저장", exact: true });
    await emptySave.waitFor({ timeout: 20000 });
    check(
      "an empty cycle locks 저장 with its reason in the title",
      (await emptySave.isDisabled()) === true &&
        (await emptySave.getAttribute("title")) === "저장할 변경이 없습니다",
      (await emptySave.getAttribute("title")) ?? "(no title)",
    );
    check(
      "and 넘기기 is locked with 먼저 저장해 주세요",
      (await page
        .locator(".screenpanel__bar")
        .getByRole("button", { name: "개발자에게 넘기기" })
        .getAttribute("title")) === "먼저 저장해 주세요",
    );

    // --- work appears, the review shows it --------------------------------
    mkdirSync(join(WORK_ROOT, "src", "screens", "member"), { recursive: true });
    writeFileSync(
      join(WORK_ROOT, "src", "screens", "member", "MemberList.screen.tsx"),
      "export default function MemberListScreen() { return null; }\n",
    );
    const indexHtml = readFileSync(join(WORK_ROOT, "index.html"), "utf8");
    writeFileSync(join(WORK_ROOT, "index.html"), `${indexHtml}<p>회원 관리 목록 추가</p>\n`);

    // The change count is event-driven (PLAN D8): a turn finishing or a save
    // recounts it, and these raw writes are neither — so one 레포 최신화 is
    // what unlocks 저장 in the top bar.
    await page
      .locator(".screenpanel__bar")
      .getByRole("button", { name: "최신 변경 받아오기" })
      .click();
    await page.waitForFunction(
      () => {
        const buttons = [...document.querySelectorAll(".screenpanel__bar button")];
        const save = buttons.find((b) => b.textContent?.trim() === "저장");
        return save ? !save.disabled : false;
      },
      undefined,
      { timeout: 20000 },
    );
    await viaActionBar(page, "저장");
    // PLAN D51 + 비개발자 저장: the summary is the first thing; the raw
    // files stay folded at every size — the review reads as sentences, and
    // the code is one deliberate click away.
    await page.getByText("자세히 보기 (파일 2개)").waitFor({ timeout: 10000 });
    check(
      "the summary is on top and the raw file list stays folded",
      (await page.getByText("자세히 보기 (파일 2개)").isVisible()) === true &&
        (await page.locator(".diff__file").first().isVisible()) === false,
    );
    await page.getByText("자세히 보기 (파일 2개)").click();
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

    // Even a single-hunk file keeps its code folded until the row is pressed.
    const addedRow = page.locator(".diff__file", { hasText: "MemberList.screen.tsx" });
    check(
      "the hunk stays folded until the row is pressed",
      (await addedRow.locator(".diff__hunk").isVisible()) === false,
    );
    await addedRow.locator(".diff__filerow").click();
    const hunk = await addedRow.locator(".diff__hunk").innerText();
    check(
      "the hunk shows the added content",
      hunk.includes("+export default function MemberListScreen"),
      hunk.split("\n")[0] ?? "",
    );

    // --- save, and watch it land on its own branch ------------------------
    await page.getByLabel("저장 메모").fill("회원 관리 화면 추가");
    await page
      .locator('[role="dialog"][aria-label="저장 검토"]')
      .getByRole("button", { name: "저장", exact: true })
      .click();
    await page.waitForSelector(".notice--info", { timeout: 120000 });
    check(
      "the settled line shows the memo the save carried",
      (await page.getByTestId("committed-memo").innerText()).includes("회원 관리 화면 추가"),
    );

    await page.waitForFunction(
      () => document.querySelectorAll(".diff__file").length === 0,
      undefined,
      { timeout: 10000 },
    );
    check("the panel reloads to an empty diff", true);

    const branch = await cycleBranch(fixture.remote);
    check("the save created its own branch on the remote", branch !== null, `${branch}`);
    check(
      "the developer's base branch did not move",
      (await remoteHead(fixture.remote)) === remoteBefore,
      remoteBefore.slice(0, 10),
    );
    const { stdout: subject } = await run("git", [
      "--git-dir",
      fixture.remote,
      "log",
      "-1",
      "--pretty=%s",
      branch,
    ]);
    check(
      "the planner's message is the commit subject",
      subject.trim() === "회원 관리 화면 추가",
      subject.trim(),
    );

    await page.getByRole("button", { name: "닫기", exact: true }).click();
    check(
      "closing the review returns to the planner",
      (await page.locator('[role="dialog"]').count()) === 0,
    );

    // --- 넘기기: the draft turn fails on this stub, so the dialog must open
    // on the browser's own proposal — never on an empty form (비개발자 넘기기).
    await viaActionBar(page, "개발자에게 넘기기");
    const handoffDialog = page.locator('[role="dialog"][aria-label="개발자에게 넘기기"]');
    await handoffDialog.waitFor({ timeout: 10000 });
    await page.waitForFunction(
      () => !document.body.innerText.includes("개발자가 읽을 제목과 내용을 만드는 중"),
      undefined,
      { timeout: 20000 },
    );
    const proposedTitle = await page.getByLabel("넘길 제목").inputValue();
    check(
      "a draft that cannot land leaves the browser's proposal in the fields",
      proposedTitle.length > 0 &&
        !(await handoffDialog.innerText()).includes("Claude가 채웠습니다"),
      proposedTitle,
    );
    await handoffDialog.getByRole("button", { name: "취소", exact: true }).click();
    check("the handoff closes", (await handoffDialog.count()) === 0);

    // --- D92: ⌘/ 시트 -------------------------------------------------------
    await page.keyboard.press("Meta+/");
    const sheet = page.locator('[role="dialog"][aria-label="단축키"]');
    await sheet.waitFor({ timeout: 5000 });
    const sheetText = await sheet.innerText();
    check(
      "D92 the ⌘/ sheet lists the pin and the reload rows",
      sheetText.includes("⌥+클릭") && sheetText.includes("⌘R"),
      sheetText.split("\n").slice(0, 3).join(" / "),
    );
    await sheet.getByRole("button", { name: "단축키 닫기" }).click();
    check("D92 the sheet closes", (await sheet.count()) === 0);

    // --- a failed turn is a card, not a silence (PLAN D35) ----------------
    // The tree offers two ways to start one (the row's ＋ and, for a project
    // with no conversations, its own row); this drives the row's ＋.
    await page.locator(".node__add").first().click();
    const field = page.getByPlaceholder(
      "메시지를 보내 보세요 — @로 파일을, /로 명령을 불러올 수 있어요",
    );
    await field.fill("화면을 만들어 줘");
    await field.press("Enter");
    await page.waitForSelector(".turnfail", { timeout: 30000 });
    check(
      "a failed turn is a card that says what happened",
      (await page.locator(".turnfail").last().innerText()).includes("답을 마치지 못했습니다"),
    );
    // The retry is the LAST card's own button (커미티 F-B3): with the
    // dead-query resume in place every retried send honestly fails again,
    // so older failed cards stay on the tape WITHOUT their own buttons —
    // only the newest failure offers 다시 보내기, with the newest words.
    const retry = page.locator(".turnfail").last().getByRole("button", { name: "다시 보내기" });
    await retry.waitFor({ state: "attached", timeout: 15000 }).catch(() => {});
    check("the card offers the same words back", (await retry.count()) === 1);
    const cardsBefore = await page.locator(".turnfail").count();
    await retry.click();
    // A failed turn closes the CLI run; resending may continue the same thread
    // or open a fresh one. The wire-level proof either way: the stub CLI saw
    // the same words again, and a new failed card stands.
    await page.waitForFunction(
      (n) => document.querySelectorAll(".turnfail").length > n,
      cardsBefore,
      { timeout: 30000 },
    );
    const sends =
      readFileSync(join(DIR, "bin", "prompts.log"), "utf8").split("화면을 만들어 줘").length - 1;
    check("retrying sends the same words again", sends === 2, `${sends} send(s) on the wire`);
    check("no uncaught console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
    await page.screenshot({
      path: join(here, "ui-publish-e2e.png"),
      fullPage: true,
    });
  } finally {
    await browser.close();
    server.close();
    // The daemon's own shutdown settles writers (sessions, preview, git
    // children) before exiting — removing the tmpdir against a live one
    // races ENOTEMPTY on .git under load.
    await stopDaemon(daemon);
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
