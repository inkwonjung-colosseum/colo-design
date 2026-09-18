/**
 * Browser-level check of the publish review, without spending a model turn.
 *
 * The connected repo is a local fixture remote; the "work to publish" is
 * written straight into the clone (what Claude's Write tool would have left
 * there), and the test drives the surface the planner uses: the top bar's
 * 저장 button (one click, no review body), then the published result — and
 * verifies the commit actually reached the bare remote. 넘기기
 * is an in-chat card, not a dialog.
 *
 * Prerequisites: `pnpm build`
 */
import { execFile, execSync, spawn } from "node:child_process";
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
 * wire: the offline stand-in for a turn that ends wrong, so the
 * browser can prove the silence is gone.
 */
function writeErrorStubClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  const promptsLog = join(dir, "prompts.log");
  // The gates read --version and `auth status`; the SDK's stream-json run
  // fails every turn so the browser can prove the silence is
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
    // The SDK opens the stream with control requests (initialize, mode
    // writes, interrupts) and waits for each answer before a user line can
    // ride the queue — an unanswered one closes the query and the send is
    // refused before it ever reaches the tape. Answer every one.
    '    if (o.type === "control_request") {',
    "      process.stdout.write(JSON.stringify({",
    '        type: "control_response",',
    '        response: { subtype: "success", request_id: o.request_id },',
    '      }) + "\\n");',
    "      continue;",
    "    }",
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
 * The action set lives in the top bar: 저장 · 개발자에게 넘기기 ·
 * 상태 확인 are always drawn and locked by condition — the label is the
 * button's, the reason is its tip.
 */
async function viaActionBar(page, label) {
  await page.locator(".screenpanel__bar").getByRole("button", { name: label, exact: true }).click();
}

/**
 * 잠긴 이유를 읽는다. The reason left the `title` attribute for Tip's own
 * bubble (Tip.tsx): the button points at it with `aria-describedby`, and the
 * bubble is a `role="tooltip"` in the body. `title` stays as the fallback for
 * the controls that still wear one.
 */
async function lockReason(page, label) {
  return await page
    .locator(".screenpanel__bar")
    .getByRole("button", { name: label, exact: true })
    .evaluate((element) => {
      const id = (element.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .pop();
      const tip = id ? document.getElementById(id) : null;
      return tip?.textContent?.trim() || element.getAttribute("title") || "";
    });
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

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
    await page.getByRole("button", { name: "연결" }).click();
    try {
      await page.waitForSelector(".planner__work", { timeout: 60000 });
      // 홈이 기본값이므로 대화 화면은 새 대화 leaf 가 연다 — 상시 표시다.
      await page.locator(".leaf--start").first().click();
      await page.waitForSelector(".planner__body:not(.planner__empty)", { timeout: 60000 });
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
    // "저장할 것이 없다"는 잠긴 버튼의 title 로 증명한다 — 잠긴
    // 저장은 패널을 열 수도 없다.
    const emptySave = page
      .locator(".screenpanel__bar")
      .getByRole("button", { name: "저장", exact: true });
    await emptySave.waitFor({ timeout: 20000 });
    const emptySaveReason = await lockReason(page, "저장");
    check(
      "an empty cycle locks 저장 with its reason on the button",
      (await emptySave.isDisabled()) === true && emptySaveReason === "저장할 변경이 없습니다",
      emptySaveReason || "(no reason)",
    );
    check(
      "and 넘기기 is locked with 먼저 저장해 주세요",
      (await lockReason(page, "개발자에게 넘기기")) === "먼저 저장해 주세요",
      (await lockReason(page, "개발자에게 넘기기")) || "(no reason)",
    );

    // --- work appears, the review shows it --------------------------------
    // 저장의 완료 카드는 대화 테이프에 쓰인다 — 대화가 없으면 갈 곳이 없다.
    // 한 마디를 보내 세션을 세운다. 스텁의 send 는 거절로 끝나지만 세션은
    // send 를 시도한 순간(createSession) 생긴다 — 컴포저의 placeholder 가
    // 활성 대화의 것으로 바뀌는 순간이 그 신호다. 파일 쓰기는 이 뒤에 둔다:
    // 세션 탄생의 자동 pull 이 stash 를 쥐는 창에 쓰기가 끼어들면 검토의
    // diff 가 빈 트리를 읽는다 (실측 결함).
    const seedField = page.locator(".composer textarea");
    await seedField.fill("화면을 만들어 줘");
    await seedField.press("Enter");
    await page.waitForFunction(
      () =>
        document
          .querySelector(".composer textarea")
          ?.getAttribute("placeholder")
          ?.includes("메시지를 보내 보세요") === true,
      undefined,
      { timeout: 30000 },
    );
    mkdirSync(join(WORK_ROOT, "src", "screens", "member"), { recursive: true });
    writeFileSync(
      join(WORK_ROOT, "src", "screens", "member", "MemberList.screen.tsx"),
      "export default function MemberListScreen() { return null; }\n",
    );
    const indexHtml = readFileSync(join(WORK_ROOT, "index.html"), "utf8");
    writeFileSync(join(WORK_ROOT, "index.html"), `${indexHtml}<p>회원 관리 목록 추가</p>\n`);
    // 삭제도 저장에 실려 간다 — 아래 워크트리 세 검사(status)가 이 삭제를
    // 기다린다. CLAUDE.md 는 이 스텁 CLI 가 읽지 않으므로 이 뒤의 어느
    // 단계도 이 삭제에 걸리지 않는다.
    rmSync(join(WORK_ROOT, "CLAUDE.md"), { force: true });

    // The change count is event-driven: a turn finishing or a save
    // recounts it, and these raw writes are neither — so one 레포 최신화 is
    // what unlocks 저장 in the top bar. The session's own birth pull can
    // still hold the refresh lock (phase "pulling"), which makes the click
    // a no-op — wait for the button to be pressable first.
    const refreshButton = page.locator(".screenpanel__bar .screenpanel__refresh");
    await page.waitForFunction(
      () => {
        const buttons = [...document.querySelectorAll(".screenpanel__bar button")];
        const refresh = buttons.find((b) => b.textContent?.includes("최신 변경 받아오기"));
        return refresh?.getAttribute("aria-disabled") !== "true";
      },
      undefined,
      { timeout: 30000 },
    );
    await refreshButton.click();
    // The label flips to 받아 오는 중… a render after the click — a poll that
    // samples in between reads the pre-pull state and opens 저장 inside the
    // stash window (실측 결함). Wait for the pull to be observed running
    // first; an instant pull may flip past it, so this wait is soft.
    await page
      .waitForFunction(
        () => {
          const buttons = [...document.querySelectorAll(".screenpanel__bar button")];
          const refresh = buttons.find(
            (b) =>
              b.textContent?.includes("받아 오는 중") || b.getAttribute("aria-disabled") === "true",
          );
          return refresh !== undefined;
        },
        undefined,
        { timeout: 10000 },
      )
      .catch(() => undefined);
    // the label flipping back is not enough: the session's own birth pull
    // can still be queued behind this one (session.create returns before
    // pull() reaches core.refreshing), and its stash window lands on the
    // review's diff. 저장 is only safe once the refresh button has stayed
    // pressable AND the worktree reads dirty with no stash parked — twice
    // in a row, so a pull starting between samples resets the count.
    const worktreeSettled = async () => {
      const stash = execSync(`git -C ${JSON.stringify(WORK_ROOT)} stash list`, {
        encoding: "utf8",
      }).trim();
      const status = execSync(`git -C ${JSON.stringify(WORK_ROOT)} status --porcelain`, {
        encoding: "utf8",
      });
      const pressable = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll(".screenpanel__bar button")];
        const refresh = buttons.find((b) => b.textContent?.includes("최신 변경 받아오기"));
        return refresh !== undefined && refresh.getAttribute("aria-disabled") !== "true";
      });
      return (
        pressable &&
        stash === "" &&
        status.includes("D CLAUDE.md") &&
        status.includes("M index.html") &&
        status.includes("?? src/")
      );
    };
    for (let stable = 0, tries = 0; stable < 3 && tries < 120; tries += 1) {
      if (await worktreeSettled()) stable += 1;
      else stable = 0;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!(await worktreeSettled())) {
      console.error(
        "SETTLE DUMP stash:",
        execSync(`git -C ${JSON.stringify(WORK_ROOT)} stash list`, { encoding: "utf8" }).trim() ||
          "(none)",
        "status:",
        execSync(`git -C ${JSON.stringify(WORK_ROOT)} status --porcelain`, {
          encoding: "utf8",
        }).trim() || "(clean)",
        "pressable:",
        await page.evaluate(() => {
          const buttons = [...document.querySelectorAll(".screenpanel__bar button")];
          const refresh = buttons.find((b) => b.textContent?.includes("최신 변경 받아오기"));
          return refresh !== undefined && refresh.getAttribute("aria-disabled") !== "true";
        }),
      );
      throw new Error("worktree never settled");
    }

    // --- 저장은 상단 바 한 번 — 검토 몸통은 없다 (비개발자 저장) ------------
    // 저장 전 diff 펼침보기는 없다: 바뀐 파일의 목록은 화면 패널의 변경 점
    // 스트립이 이미 들고, 코드 검토는 개발자가 PR 에서 한다.
    const saveButton = page
      .locator(".screenpanel__bar")
      .getByRole("button", { name: "저장", exact: true });
    await saveButton.waitFor({ timeout: 20000 });
    // 메모는 비워 보낸다: 이 스텁의 메모 턴은 실패하므로 커밋은 기본 메시지로
    // 쓰인다. aria-disabled 는 클릭을 막지 않으므로 열릴 때까지 기다린다.
    await page.waitForFunction(
      () => {
        const button = [...document.querySelectorAll(".screenpanel__bar button")].find(
          (b) => b.textContent?.trim() === "저장",
        );
        return button?.getAttribute("aria-disabled") !== "true";
      },
      null,
      { timeout: 20000 },
    );
    await saveButton.click();
    // 저장이 끝나면 기록의 `저장했어요` 카드가 자리에 남고, 그 밑에 넘기기로
    // 이어가는 복도가 선다.
    await page
      .getByText("저장했어요")
      .waitFor({ timeout: 120000 })
      .catch(async () => {
        console.error(
          "SAVE DUMP:",
          (
            await page
              .locator("body")
              .innerText()
              .catch(() => "(none)")
          )
            .slice(0, 1500)
            .replace(/\n+/g, " | "),
        );
        console.error(
          "GIT LOG:",
          execSync(`git -C ${JSON.stringify(WORK_ROOT)} log --oneline -5 --all`, {
            encoding: "utf8",
          }),
        );
        console.error(
          "GIT STATUS:",
          execSync(`git -C ${JSON.stringify(WORK_ROOT)} status --porcelain`, {
            encoding: "utf8",
          }).trim() || "(clean)",
        );
        throw new Error("save never settled");
      });
    const corridor = page.getByRole("button", { name: "개발자에게 넘기기로 이어가기" });
    await corridor.waitFor({ timeout: 10000 });
    check("the settled save hands its seat to the record card and the corridor", true);

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
      "the memo turn's answer — here the stub's failure default — is the commit subject",
      subject.trim() === "Colo Design 화면 변경",
      subject.trim(),
    );

    // --- 넘기기: the corridor opens the in-chat card; the draft turn fails
    // on this stub, so the card must open on the browser's own proposal —
    // never on an empty form (비개발자 넘기기).
    await corridor.click();
    const handoffCard = page.locator(".handoffcard");
    await handoffCard.waitFor({ timeout: 10000 });
    await page.waitForFunction(
      () => !document.body.innerText.includes("개발자가 읽을 제목과 내용을 만드는 중"),
      undefined,
      { timeout: 20000 },
    );
    // 목업 02: 미리보기의 자동 첨부가 실제 본문에 붙는 `### 바뀐 파일` 절을
    // 그대로 보여 준다 — 개발자가 받을 규모가 카드에서 읽힌다.
    const previewText = await handoffCard.innerText();
    check(
      "the handoff preview carries the cycle's file summary",
      previewText.includes("바뀐 파일") && previewText.includes("index.html"),
      previewText.split("\n").slice(0, 12).join(" / "),
    );
    // 제목 필드는 `직접 고치기` 폴드 안에 있다 — 읽기 우선 카드의 규칙.
    await handoffCard.getByText("직접 고치기", { exact: true }).click();
    const proposedTitle = await page.getByLabel("넘길 제목").inputValue();
    check(
      "a draft that cannot land leaves the browser's proposal in the fields",
      proposedTitle.length > 0 && !(await handoffCard.innerText()).includes("AI가 쓴 초안"),
      proposedTitle,
    );
    await handoffCard.getByRole("button", { name: "접기", exact: true }).click();
    check("the handoff card folds", (await handoffCard.count()) === 0);

    // --- ⌘/ 시트 ------------------------------------------------------------
    await page.keyboard.press("Meta+/");
    const sheet = page.locator('[role="dialog"][aria-label="단축키"]');
    await sheet.waitFor({ timeout: 5000 });
    const sheetText = await sheet.innerText();
    check(
      "the ⌘/ sheet lists the pin and the reload rows",
      sheetText.includes("⌥+클릭") && sheetText.includes("⌘R"),
      sheetText.split("\n").slice(0, 3).join(" / "),
    );
    await sheet.getByRole("button", { name: "단축키 닫기" }).click();
    check("the sheet closes", (await sheet.count()) === 0);

    // --- a failed turn is a card, not a silence ---------------------------
    // The tree offers two ways to start one (the row's ＋ and, for a project
    // with no conversations, its own row); this drives the row's ＋.
    await page.locator(".node__add").first().click();
    const field = page.locator(".composer textarea");
    await field.fill("화면을 만들어 줘");
    await field.press("Enter");
    try {
      await page.waitForSelector(".turnfail", { timeout: 30000 });
    } catch {
      const log = existsSync(join(DIR, "bin", "prompts.log"))
        ? readFileSync(join(DIR, "bin", "prompts.log"), "utf8")
        : "(no prompts.log)";
      console.error(
        "TURNFAIL DUMP:",
        (await page.locator("body").innerText()).slice(0, 1500).replace(/\n+/g, " | "),
        "\nPROMPTS:",
        log.slice(0, 500),
      );
      throw new Error("no turnfail card");
    }
    check(
      "a failed turn is a card that says what happened",
      (await page.locator(".turnfail").last().innerText()).includes("답을 마치지 못했습니다"),
    );
    // The retry is the LAST card's own button: with the
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
    // 시드 한 번 + 실패 카드의 다시 보내기 두 번 — 같은 말이 세 번 선에 섰다.
    check("retrying sends the same words again", sends === 3, `${sends} send(s) on the wire`);
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
