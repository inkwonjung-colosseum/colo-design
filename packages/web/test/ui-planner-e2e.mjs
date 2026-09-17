/**
 * Browser-level check of the planner app, end to end with a real Claude session.
 *
 * This is the one suite that proves the product's claim: requirements typed
 * into the composer go in, screens come out inside the repo the planner
 * connected, and the planner watches the repo's own preview render them. The
 * connected repo is a local fixture remote (packages/daemon/test/fixture-repo.mjs),
 * so the git side stays offline; the Claude turn is real and billed to the
 * signed-in subscription.
 *
 * Costs one multi-turn session which writes several files — budget several
 * minutes. The first run also installs the fixture repo (a no-op npm script).
 *
 * Prerequisites: `pnpm build`
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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
const DIR = join(tmpdir(), "colo-design-planner-e2e");
const WORK_ROOT = join(DIR, "work");
const PORT = 5396;
const DAEMON_PORT = 7834;

const REQUIREMENTS = `회원 관리 화면을 만들어줘. 되물을 것이 있으면 한 번에 물어보고, 없으면 바로 만들어.

회원 목록
- 회원번호, 이름, 가입일, 상태를 한 줄로 보여 준다.
- 상태는 활성/정지 두 가지다.
- 행을 클릭하면 상세로 간다.

회원 상세
- 기본 정보(회원번호, 이름, 가입일)와 상태 변경 버튼이 있다.
- 정지 회원은 상단에 안내 문구가 나온다.`;

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

/** Screen files anywhere under the connected repo's clone. */
function generatedScreens(root) {
  const dir = join(root, "src", "screens");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((entry) => entry.endsWith(".screen.tsx"));
}

async function main() {
  if (!existsSync(webDist))
    throw new Error("web dist missing. Run: pnpm --filter @colo-design/web build");
  if (!existsSync(daemonEntry))
    throw new Error("daemon dist missing. Run: pnpm --filter @colo-design/daemon build");

  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const previewPort = await freePort();
  const fixture = await createFixtureRepo({
    dir: join(DIR, "fixture"),
    port: previewPort,
  });

  const env = {
    ...process.env,
    COLO_DESIGN_PORT: String(DAEMON_PORT),
    COLO_DESIGN_REPO_DIR: WORK_ROOT,
    COLO_DESIGN_REPO_URL: fixture.remote,
    COLO_DESIGN_REPO_SETTINGS: join(DIR, "settings.json"),
    // Same isolation as every other suite: the registry belongs to this run.
    COLO_DESIGN_PROJECTS_SETTINGS: join(DIR, "projects.json"),
    COLO_DESIGN_PROJECTS_DIR: join(DIR, "projects"),
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

  // 작업 과정 보기를 켜 둔 채로 연다. 이 스위치의 기본은 꺼짐이고(설정 ·
  // tape-visibility), 꺼져 있으면 도구 호출 묶음은 그룹으로 묶이기 전에
  // 걸러져 접힌 활동 줄 자체가 테이프에 없다 — 5단계가 읽는 것이 바로 그
  // 줄이다. 기본값 쪽의 계약(꺼져 있으면 보이지 않는다)은 오프라인
  // ui-settings-e2e 가 지키므로, 여기서는 켠 사용자의 테이프를 본다.
  await page.addInitScript(() => {
    const key = "colo-design.settings";
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(key) ?? "{}") ?? {};
    } catch {
      stored = {};
    }
    stored.chat = { ...(stored.chat ?? {}), showTools: true };
    localStorage.setItem(key, JSON.stringify(stored));
  });

  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
  await page.getByRole("button", { name: "연결" }).click();

  // --- 1. connecting lands on the home inbox; a conversation opens the workspace ---
  //     홈 인박스가 기본 뷰다(P1) — 대화 화면은 새 대화 leaf 가 연다.
  await page.waitForSelector(".planner__work", { timeout: 60000 });
  await page.locator(".leaf--start").first().click();
  await page.waitForSelector(".planner__body", { timeout: 60000 });
  check("connecting opens the workspace through a new conversation", true);
  // --- 2. the connected repo bootstraps itself ----------------------------
  const progress = page.locator(".progress__head h2");
  if (await progress.count()) {
    check("bootstrap reports what it is doing", true, await progress.first().innerText());
  }
  await page.waitForSelector(".preview", { timeout: 300000 });
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

  // --- 3. the ask itself, typed into the composer --------------------------
  const VISIBLE = ".planner__body:not([hidden]) ";
  const area = page.locator(`${VISIBLE}.composer textarea`);
  // `fill` rather than keystrokes: the requirements carry newlines, and Enter
  // in this field is 보내기.
  await area.fill(REQUIREMENTS);
  await page.getByRole("button", { name: "보내기" }).click();

  // --- 4. the ask lands in the transcript as the planner's own turn -------
  await page.waitForSelector(".bubble--user", { timeout: 30000 });
  const echoed = await page.locator(".bubble--user").first().innerText();
  check(
    "the typed requirements come back as the planner's own turn",
    echoed.includes("회원 목록"),
    echoed.slice(0, 40),
  );

  // --- 5. Claude works, and the planner sees a folded activity line -------
  await page.waitForSelector(".activity", { timeout: 240000 });
  const activity = await page.locator(".activity__text").first().innerText();
  // The first snapshot can be command-only ("검사 1회 실행") before file work
  // lands in the fold, so any folded Korean counter counts — not just 개.
  check(
    "tool work folds into one Korean activity line",
    /(개|회 실행|곳 확인|가지)/.test(activity),
    activity,
  );

  // --- 6. answering questions, then screens on disk ----------------------
  // Claude asks about what the ask leaves open and then waits — nothing
  // times out on its own. A suite that only polled for files would sit here
  // until its own timeout, so answering is part of the path being tested.
  let answered = 0;
  let approved = 0;
  const screensReady = () => generatedScreens(WORK_ROOT).length > 0;
  for (const deadline = Date.now() + 420000; Date.now() < deadline; ) {
    if (await screensReady()) break;
    if (await page.locator(".card--question").count()) {
      const questions = page.locator(".card--question .question");
      for (let i = 0; i < (await questions.count()); i += 1) {
        await questions.nth(i).locator(".option").first().click();
      }
      await page.getByRole("button", { name: "답변 보내기" }).click();
      answered += 1;
      await page.waitForSelector(".card--question", {
        state: "detached",
        timeout: 30000,
      });
    } else if (await page.locator(".card--permission").count()) {
      // 라벨이 결과를 말한다(cards.tsx perm__opt 접미사) — 의도된 계약 변경.
      await page.getByRole("button", { name: "허용 · 이번 한 번만" }).click();
      approved += 1;
    }
    await page.waitForTimeout(5000);
  }
  check(
    "question or permission cards are exercised at least once",
    answered + approved > 0,
    `answered=${answered} approved=${approved}`,
  );
  const written = generatedScreens(WORK_ROOT);
  check(
    "Claude wrote screen files inside the connected repo",
    written.length >= 1,
    written.join(", "),
  );

  // --- 7. the turn settles, and the preview is still the repo's ----------
  await page.waitForSelector(".toolbar__stop", {
    state: "detached",
    timeout: 120000,
  });
  const settled = generatedScreens(WORK_ROOT);
  check("the turn ends with every planned screen written", settled.length >= 2, settled.join(", "));
  check(
    "the repo's preview still serves after the turn",
    (await page.locator(".preview__frame").getAttribute("src")) ===
      `http://127.0.0.1:${previewPort}`,
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
  // The head's title is the one rename affordance a click reaches (the ···
  // menu and F2 open the same input); the words come back in the field.
  await page.locator(".thread__title").click();
  await page.getByLabel("대화 이름").fill("회원 관리 화면");
  await page.keyboard.press("Enter");
  check(
    "clicking the thread title renames it in place",
    (await page.locator(".thread__title").innerText()).includes("회원 관리 화면"),
  );

  // The ring only appears once a settled turn has reported usage, which is
  // exactly where step 7 left the session. It rides the send row now, beside
  // the button it is a reason to press or not — the plan chip that used to
  // carry this reading keeps the account's budgets alone.
  const ring = page.locator(`${VISIBLE}.ring`);
  check("the chat shows how long the conversation has grown", await ring.isVisible());
  // Hovering it is the whole disclosure — and the whole disclosure is the
  // percent. 토큰 수와 세션 비용은 화면을 떠났다:
  // 구독 하나가 이 제품의 약속이므로 숫자로 재는 자리를 두지 않는다.
  await ring.hover();
  // The tip is a CSS disclosure that fades in (0.12s) — reading before the
  // visibility transition has flipped computes an empty innerText.
  const tip = page.locator(`${VISIBLE}.ctx__tip`);
  await tip.waitFor({ state: "visible", timeout: 2000 });
  const reading = await tip.innerText();
  check(
    "hovering the ring names the context window and how full it is",
    reading.includes("컨텍스트 윈도우") && /\d+% 사용됨/.test(reading),
    reading.replace(/\n/g, " · "),
  );
  check(
    "the reading keeps token counts and cost off the screen",
    !reading.includes("토큰") && !reading.includes("$"),
    reading.replace(/\n/g, " · "),
  );

  // Duplicate assistant text was a real regression: the streamed deltas and
  // the aggregated message have to describe the same block.
  const paragraphs = await page.locator(".planner__chat .md p").allInnerTexts();
  const repeated = paragraphs.filter(
    (text, index) => text.trim() && paragraphs[index + 1]?.trim() === text.trim(),
  );
  check(
    "assistant text is not rendered twice",
    repeated.length === 0,
    repeated[0]?.slice(0, 50) ?? "",
  );

  check("no uncaught console errors", errors.length === 0, errors.slice(0, 2).join(" | "));

  await page.screenshot({
    path: join(here, "ui-planner-e2e.png"),
    fullPage: true,
  });
  console.log(`\nscreenshot: ${join(here, "ui-planner-e2e.png")}`);
  console.log(`fixture workspace kept at: ${WORK_ROOT}`);

  await browser.close();
  server.close();
  await stopDaemon(daemon);

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nPLANNER E2E ERROR: ${error.message}`);
  process.exit(2);
});
