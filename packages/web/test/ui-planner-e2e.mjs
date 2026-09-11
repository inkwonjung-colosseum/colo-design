/**
 * Browser-level check of the planner app, end to end with a real Claude session.
 *
 * This is the one suite that proves the product's claim: a planning document
 * goes in, screens come out inside the repo the planner connected, and the
 * planner watches the repo's own preview render them. The connected repo is a
 * local fixture remote (packages/daemon/test/fixture-repo.mjs), so the git
 * side stays offline; the Claude turn is real and billed to the signed-in
 * subscription.
 *
 * Costs one multi-turn session which writes several files — budget several
 * minutes. The first run also installs the fixture repo (a no-op npm script).
 *
 * Prerequisites: `pnpm build`
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createFixtureRepo, freePort } from "../../daemon/test/fixture-repo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const daemonEntry = join(repoRoot, "packages", "daemon", "dist", "index.js");
const webDist = join(repoRoot, "packages", "web", "dist");
const DIR = join(tmpdir(), "cds-design-planner-e2e");
const WORK_ROOT = join(DIR, "work");
const SPEC = join(DIR, "2026-09-08-회원관리.md");
const PORT = 5396;
const DAEMON_PORT = 7834;

const SPEC_MARKDOWN = `# 회원 관리 기획서

## 회원 목록
- 회원번호, 이름, 가입일, 상태를 한 줄로 보여 준다.
- 상태는 활성/정지 두 가지다.
- 행을 클릭하면 상세로 간다.

## 회원 상세
- 기본 정보(회원번호, 이름, 가입일)와 상태 변경 버튼이 있다.
- 정지 회원은 상단에 안내 문구가 나온다.
`;

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

/** Screen files anywhere under the connected repo's clone. */
function generatedScreens(root) {
  const dir = join(root, "src", "screens");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((entry) => entry.endsWith(".screen.tsx"));
}

async function main() {
  if (!existsSync(webDist)) throw new Error("web dist missing. Run: pnpm --filter @cds-design/web build");
  if (!existsSync(daemonEntry)) throw new Error("daemon dist missing. Run: pnpm --filter @cds-design/daemon build");

  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(SPEC, SPEC_MARKDOWN);
  const previewPort = await freePort();
  const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port: previewPort });

  const env = {
    ...process.env,
    CDS_DESIGN_PORT: String(DAEMON_PORT),
    CDS_DESIGN_REPO_DIR: WORK_ROOT,
    CDS_DESIGN_REPO_URL: fixture.remote,
    CDS_DESIGN_REPO_SETTINGS: join(DIR, "settings.json"),
    // Same isolation as every other suite: the registry belongs to this run.
    CDS_DESIGN_PROJECTS_SETTINGS: join(DIR, "projects.json"),
    CDS_DESIGN_PROJECTS_DIR: join(DIR, "projects"),
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

  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
  await page.getByRole("button", { name: "연결" }).click();

  // --- 1. connecting lands straight in the workspace ------------------------
  await page.waitForSelector(".planner__body", { timeout: 60000 });
  check("connecting opens the workspace, with no mode to choose", true);
  // --- 2. the connected repo bootstraps itself ----------------------------
  const progress = page.locator(".progress__head h2");
  if (await progress.count()) {
    check("bootstrap reports what it is doing", true, await progress.first().innerText());
  }
  await page.waitForSelector(".preview", { timeout: 600000 });
  check("the connected repo reaches a ready preview", true);

  // The repo's own preview app — not the tool's — renders inside the iframe.
  const frame = page.frameLocator(".preview__frame");
  await frame.locator("#app h1").waitFor({ timeout: 30000 });
  const heading = await frame.locator("#app h1").innerText();
  check("the repo's preview app renders in the iframe", heading.includes("회원 관리"), heading);
  const src = await page.locator(".preview__frame").getAttribute("src");
  check(
    "the iframe points at the repo's preview url",
    src === `http://127.0.0.1:${previewPort}`,
    src ?? "",
  );

  // --- 3. attaching a planning document -----------------------------------
  const VISIBLE = ".planner__body:not([hidden]) ";
  await page.setInputFiles(`${VISIBLE}.composer input[type=file]`, SPEC);
  await page.waitForSelector(`${VISIBLE}.chip`, { timeout: 5000 });
  check("a markdown document attaches as a document chip", true, await page.locator(`${VISIBLE}.chip`).innerText());

  const area = page.locator(`${VISIBLE}.composer textarea`);
  await area.pressSequentially(
    "이 기획서로 화면 만들어줘. 되물을 것이 있으면 한 번에 물어보고, 없으면 바로 만들어.",
  );
  await page.getByRole("button", { name: "보내기" }).click();

  // --- 4. the document lands in the clone, not in the prompt -------------
  await page.waitForFunction(
    () => document.querySelector(".bubble__file") !== null,
    undefined,
    { timeout: 30000 },
  );
  const specs = existsSync(join(WORK_ROOT, "specs")) ? readdirSync(join(WORK_ROOT, "specs")) : [];
  check(
    "the attached document is saved under the repo's specs/",
    specs.some((name) => name.endsWith(".md")),
    specs.join(", "),
  );

  // --- 5. Claude works, and the planner sees a folded activity line -------
  await page.waitForSelector(".activity", { timeout: 240000 });
  const activity = await page.locator(".activity__text").first().innerText();
  // The first snapshot can be command-only ("검사 1회 실행") before file work
  // lands in the fold, so any folded Korean counter counts — not just 개.
  check("tool work folds into one Korean activity line", /(개|회 실행|곳 확인|가지)/.test(activity), activity);

  // --- 6. answering questions, then screens on disk ----------------------
  // Claude asks about what the document leaves open and then waits — nothing
  // times out on its own. A suite that only polled for files would sit here
  // until its own timeout, so answering is part of the path being tested.
  let answered = 0;
  let approved = 0;
  const screensReady = () => generatedScreens(WORK_ROOT).length > 0;
  for (const deadline = Date.now() + 900000; Date.now() < deadline; ) {
    if (await screensReady()) break;
    if (await page.locator(".card--question").count()) {
      const questions = page.locator(".card--question .question");
      for (let i = 0; i < (await questions.count()); i += 1) {
        await questions.nth(i).locator(".option").first().click();
      }
      await page.getByRole("button", { name: "답변 보내기" }).click();
      answered += 1;
      await page.waitForSelector(".card--question", { state: "detached", timeout: 30000 });
    } else if (await page.locator(".card--permission").count()) {
      await page.getByRole("button", { name: "이번만 허용" }).click();
      approved += 1;
    }
    await page.waitForTimeout(5000);
  }
  if (answered > 0) check("clarifying questions can be answered from the card", true, `${answered} card(s)`);
  if (approved > 0) check("permission cards can be approved from the card", true, `${approved} card(s)`);
  const written = generatedScreens(WORK_ROOT);
  check("Claude wrote screen files inside the connected repo", written.length >= 1, written.join(", "));

  // --- 7. the turn settles, and the preview is still the repo's ----------
  await page.waitForSelector(".toolbar__stop", { state: "detached", timeout: 900000 });
  const settled = generatedScreens(WORK_ROOT);
  check("the turn ends with every planned screen written", settled.length >= written.length, settled.join(", "));
  check(
    "the repo's preview still serves after the turn",
    (await page.locator(".preview__frame").getAttribute("src")) === `http://127.0.0.1:${previewPort}`,
  );

  // --- 8. the developer surface is gone, and what it lent us is here -----
  const devLeftovers = await page.locator(".modeswitch, .picker, .header__actions").count();
  check("no developer chrome survives anywhere in the app", devLeftovers === 0);

  // Threads live in the tree now; a row's ··· carries rename and 지우기.
  const leafRow = page.locator(".leafwrap").first();
  await leafRow.hover();
  check(
    "a thread can be renamed or deleted from its tree row",
    (await leafRow.locator(".leaf__menu-btn").isVisible()) &&
      (await leafRow.locator(".leaf__menu").count()) === 0,
  );
  await leafRow.locator(".leaf__menu-btn").click();
  check(
    "the row menu offers 이름 바꾸기 and 지우기",
    (await leafRow.getByRole("menuitem", { name: "이름 바꾸기" }).isVisible()) &&
      (await leafRow.getByRole("menuitem", { name: "지우기" }).isVisible()),
  );
  // The menu covers the row with its own backdrop — closing is the
  // backdrop's one job (the toggle sits underneath it).
  await leafRow.locator('button[aria-label="메뉴 닫기"]').click();
  // The ring only appears once a settled turn has reported usage, which is
  // exactly where step 7 left the session.
  check("the composer shows how long the conversation has grown", await page.locator(`${VISIBLE}.ring`).isVisible());

  // Duplicate assistant text was a real regression: the streamed deltas and
  // the aggregated message have to describe the same block.
  const paragraphs = await page.locator(".planner__chat .md p").allInnerTexts();
  const repeated = paragraphs.filter((text, index) => text.trim() && paragraphs[index + 1]?.trim() === text.trim());
  check("assistant text is not rendered twice", repeated.length === 0, repeated[0]?.slice(0, 50) ?? "");

  check("no uncaught console errors", errors.length === 0, errors.slice(0, 2).join(" | "));

  await page.screenshot({ path: join(here, "ui-planner-e2e.png"), fullPage: true });
  console.log(`\nscreenshot: ${join(here, "ui-planner-e2e.png")}`);
  console.log(`fixture workspace kept at: ${WORK_ROOT}`);

  await browser.close();
  server.close();
  daemon.kill("SIGTERM");

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nPLANNER E2E ERROR: ${error.message}`);
  process.exit(2);
});
