/**
 * Comment-overlay e2e (DESIGN §6 v1): the REAL reference-repo dev preview in
 * the tool's iframe, the real overlay, the real wire. No model turn — the
 * daemon runs a stub CLI, and the structured turn is observed on the socket
 * the way publish-e2e observes onSessionTurn.
 *
 * Story: the repo (a local clone of reference-repo with a free preview port)
 * boots under the daemon; the web connects; inside the iframe the planner
 * enters comment mode, pins two real elements, sends — the tool renders the
 * pins summary, the active session receives one structured Korean turn whose
 * json fence carries the exact envelope, and the pins clear when the turn
 * settles. Finally: `pnpm check` and `pnpm build` in reference-repo stay
 * green and the production output contains no trace of the overlay.
 *
 * Prerequisites: `pnpm build` (hub), reference-repo/node_modules installed.
 */
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import ws from "../../daemon/node_modules/ws/index.js";
import { freePort } from "../../daemon/test/fixture-repo.mjs";

/**
 * A stub CLI that answers version/auth and then STAYS ALIVE for the query,
 * so the session really runs after the comment turn — the pins must survive
 * until the test settles the turn by closing the session.
 */
function writeSlowStubClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  --version) echo "1.0.0-stub"; exit 0;;',
      "  auth)",
      '    echo "{\\"loggedIn\\":true,\\"authMethod\\":\\"claude.ai\\",\\"subscriptionType\\":\\"team\\",\\"email\\":\\"planner@example.com\\"}"',
      "    exit 0;;",
      "esac",
      "# 턴이 들어오면 잠깐 있다가 끝낸다: 세션이 running 을 지나 closed 로",
      "# 정착하고, 도구의 핀이 그때 사라지는 것을 검증한다.",
      "while IFS= read -r line; do",
      "  case \"$line\" in",
      "    *화면\\ 수정\\ 요청*) sleep 2; exit 0;;",
      "  esac",
      "done",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

const { WebSocket } = ws;
const run = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const daemonEntry = join(repoRoot, "packages", "daemon", "dist", "index.js");
const webDist = join(repoRoot, "packages", "web", "dist");
const source = join(repoRoot, "reference-repo");
const DIR = join(tmpdir(), "cds-design-comments-e2e");
const CLONE = join(DIR, "clone");
const PORT = 5400;

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

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  if (!existsSync(webDist)) throw new Error("web dist missing. Run: pnpm --filter @cds-design/web build");
  if (!existsSync(daemonEntry)) throw new Error("daemon dist missing. Run: pnpm --filter @cds-design/daemon build");
  if (!existsSync(join(source, "node_modules"))) {
    throw new Error("reference-repo dependencies missing. Run: cd reference-repo && pnpm install");
  }

  // --- a local clone of the tool's own repo, on a free preview port ---------
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  await run("git", ["clone", "--quiet", source, CLONE]);
  const previewPort = await freePort();
  const config = JSON.parse(readFileSync(join(CLONE, "cds-design.json"), "utf8"));
  config.install = "true"; // deps are shared; the suite is about the overlay
  config.preview = {
    command: `./node_modules/.bin/next dev -p ${previewPort}`,
    port: previewPort,
  };
  writeFileSync(join(CLONE, "cds-design.json"), `${JSON.stringify(config, null, 2)}\n`);
  symlinkSync(join(source, "node_modules"), join(CLONE, "node_modules"));
  // registry.gen.ts is gitignored, so a fresh clone cannot compile until the
  // repo's own generator runs — the same step its dev/build scripts do first.
  await run("node", ["scripts/gen-registry.mjs", "--quiet"], { cwd: CLONE });

  const env = {
    ...process.env,
    CDS_DESIGN_PORT: String(await freePort()),
    CDS_DESIGN_REPO_DIR: CLONE,
    CDS_DESIGN_REPO_URL: source,
    CDS_DESIGN_PROJECTS_SETTINGS: join(DIR, "projects.json"),
    CDS_DESIGN_PROJECTS_DIR: join(DIR, "projects"),
    CDS_DESIGN_CLAUDE_BIN: writeSlowStubClaude(join(DIR, "bin")),
    CDS_DESIGN_CREDENTIAL_STORE: "memory",
  };
  delete env.ANTHROPIC_API_KEY;
  const daemon = spawn(process.execPath, [daemonEntry], { cwd: CLONE, env, stdio: ["ignore", "pipe", "pipe"] });
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

  // An observation socket: the structured turn must arrive as a user turn.
  const observer = new WebSocket(daemonUrl);
  const inbox = [];
  observer.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((resolve) => observer.once("open", resolve));

  const server = await serveDist();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1720, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
    await page.getByRole("button", { name: "연결" }).click();
    await page.waitForSelector(".planner__body", { timeout: 60000 });
    await page.waitForSelector(".preview__frame", { timeout: 180_000 });

    // --- inside the repo's own preview app --------------------------------
    const frame = page.frameLocator(".preview__frame");
    // The bridge root is a zero-size wrapper around fixed-position children,
    // so visibility lives on the toggle button.
    await frame.getByRole("button", { name: "댓글", exact: true }).waitFor({ timeout: 120_000 });
    check("the dev-only overlay mounts inside the preview", true);

    // --- the repo declares its screens, both surfaces offer them (PLAN D7) --
    const picker = page.getByRole("combobox", { name: "화면" });
    await picker.waitFor({ timeout: 60_000 });
    // textContent, not innerText: options inside a collapsed <select> have no
    // layout, and innerText comes back empty for every one of them.
    const offered = await picker.locator("option").allTextContents();
    check(
      "the toolbar offers exactly the screens the repo declared",
      offered.includes("회원 목록") && offered.includes("회원 상세") && offered.includes("예시 목록"),
      offered.join(" · "),
    );

    // The picker is the screens' only door now, and it keeps the old rail's
    // grouping (PLAN D3): the planner's own feature leads, the repo's
    // _example teaching material sinks.
    const groups = await picker
      .locator("optgroup")
      .evaluateAll((nodes) =>
        nodes.map((node) => [
          node.label,
          [...node.querySelectorAll("option")].map((option) => option.textContent),
        ]),
      );
    check(
      "the picker groups the declared screens by feature, member first",
      groups[0]?.[0] === "member" &&
        groups[0]?.[1].includes("회원 목록") &&
        groups[0]?.[1].includes("회원 상세") &&
        groups.at(-1)?.[1].includes("예시 목록"),
      groups.map(([name, titles]) => `${name}: ${titles.join(",")}`).join(" · "),
    );

    // --- picking a screen in the picker navigates the preview ---------------
    await picker.selectOption({ label: "회원 목록" });
    await frame.locator('[data-screen="member/MemberList"]').waitFor({ timeout: 60_000 });
    check("picking a screen in the picker navigates the preview to it", true);

    // --- a state chip shows the 기획서's other state ------------------------
    await page.getByRole("group", { name: "상태" }).getByRole("button", { name: "비어 있음" }).click();
    await frame.locator('[data-screen="member/MemberList"][data-state="empty"]').waitFor({ timeout: 60_000 });
    check("a state chip renders the screen in that state", true);

    // The mock data really changes — this is the interaction the planner is
    // meant to be checking, not a query string the app ignored.
    check(
      "the empty state is a different screen, not the same one with a query",
      (await frame.locator('[data-screen="member/MemberList"] table tbody tr').count()) === 0,
    );

    await page.getByRole("group", { name: "폭" }).getByRole("button", { name: "모바일" }).click();
    check(
      "the 폭 toggle narrows the frame without touching the app",
      (await page.locator(".preview__stage--mobile").count()) === 1 &&
        (await frame.locator('[data-screen="member/MemberList"]').count()) === 1,
    );
    await page.getByRole("group", { name: "폭" }).getByRole("button", { name: "데스크톱" }).click();

    // Back to the default state for the comment story below.
    await page.getByRole("group", { name: "상태" }).getByRole("button", { name: "기본" }).click();
    await frame.locator('[data-screen="member/MemberList"][data-state="default"]').waitFor({ timeout: 60_000 });

    // The screen is already open — the tool navigated there above, which is
    // the path the planner actually takes.
    check("a real screen renders under [data-screen]", true);

    // Comment mode on.
    await frame.getByRole("button", { name: "댓글", exact: true }).click();
    check("comment mode toggles on", (await frame.getByRole("button", { name: "댓글 모드 끄기" }).count()) === 1);

    // Pin 1: the first table cell (a name). Pin 2: the screen's first button.
    const firstCell = frame.locator('[data-screen="member/MemberList"] table tbody tr td').first();
    await firstCell.click();
    await frame.getByLabel("핀 1 코멘트").fill("이름 열을 가입일 역순으로 정렬해 주세요.");
    await frame.getByRole("button", { name: "저장", exact: true }).click();

    await frame.locator('[data-screen="member/MemberList"] button').first().click();
    await frame.getByLabel("핀 2 코멘트").fill("상세 버튼을 보조 스타일로 바꿔 주세요.");
    await frame.getByRole("button", { name: "저장", exact: true }).click();

    // --- send ---------------------------------------------------------------
    await frame.getByRole("button", { name: /수정 요청 2건 보내기/ }).click();

    // --- the tool side ------------------------------------------------------
    await page.locator('[data-testid="pins-summary"]').waitFor({ timeout: 15_000 });
    const summary = await page.locator('[data-testid="pins-summary"]').innerText();
    check(
      "the tool renders the pins summary",
      summary.includes("수정 요청 2건") && summary.includes("member/MemberList"),
      summary.split("\n")[0],
    );

    let echo = null;
    await waitFor(() => {
      echo = inbox.find(
        (m) =>
          m.type === "session.event" &&
          m.event?.kind === "user.echo" &&
          typeof m.event.text === "string" &&
          m.event.text.includes("화면 수정 요청 2건"),
      );
      return echo !== null && echo !== undefined;
    }, 30_000, "the structured comment turn on the socket").catch(() => {
      echo = null;
    });
    const turnText = echo?.event?.text ?? "";
    check("the bundle reaches the session as one user turn", turnText !== "");
    check(
      "the turn names the screen and every request",
      turnText.includes("member/MemberList") &&
        turnText.includes("이름 열을 가입일 역순으로") &&
        turnText.includes("보조 스타일"),
    );

    // The exact envelope, machine-checked out of the turn's json fence.
    const fence = /```json\n([\s\S]*?)\n```/.exec(turnText)?.[1];
    const envelope = fence ? JSON.parse(fence) : null;
    check(
      "the envelope carries the §6 element identity",
      envelope?.type === "cds-design.comments" &&
        envelope.screen === "member/MemberList" &&
        envelope.state === "default" &&
        envelope.items.length === 2 &&
        typeof envelope.items[0].element.component === "string" &&
        envelope.items[0].element.path.startsWith('div[data-screen="member/MemberList"]') &&
        typeof envelope.items[0].element.rect.x === "number" &&
        envelope.items[0].element.rect.width > 0,
      JSON.stringify(envelope?.items?.[0]?.element ?? null),
    );

    // The planner sees a card, not the turn (PLAN D9). The text above is what
    // Claude reads; what lands in the chat is what they asked for.
    const card = page.locator(".machine--comments");
    await card.waitFor({ timeout: 15_000 });
    const cardText = await card.innerText();
    check(
      "the transcript shows a 수정 요청 card naming the screen by its title",
      cardText.includes("수정 요청 2건") && cardText.includes("회원 목록"),
      cardText.split("\n").slice(0, 2).join(" / "),
    );
    check(
      "the card lists what was asked, element by element",
      cardText.includes("이름 열을 가입일 역순으로") && cardText.includes("보조 스타일"),
    );
    // The whole point of the card: none of Claude's half reaches the planner.
    check(
      "no CSS path, rect or json reaches the planner",
      !cardText.includes("data-screen") &&
        !cardText.includes("nth-of-type") &&
        !cardText.includes("rect ") &&
        !cardText.includes("cds-design.comments"),
      cardText.slice(0, 120),
    );
    check(
      "the raw turn is not rendered as a message bubble",
      (await page.locator(".bubble--user", { hasText: "화면 수정 요청 2건" }).count()) === 0,
    );

    // …and it is one fold away, for the turn that got a strange answer.
    await card.getByRole("button", { name: "자세히" }).click();
    const folded = await card.locator(".machine__body").innerText();
    check(
      "자세히 shows the text Claude actually received",
      folded.includes("data-screen") && folded.includes("cds-design.comments"),
      folded.slice(0, 80),
    );
    check("the marker itself is not shown", !folded.includes("<!-- cds-design:"));
    // Fold it back: the screenshot below is the artifact this milestone is
    // judged on, and it should show what a planner sees, not the fold.
    await card.getByRole("button", { name: "접기" }).click();

    // The strip is the one place a planner navigates by reading, so a thread
    // the TOOL opened is named after their 기획서 — never after the bundle this
    // app composed, and never after its card marker.
    // (A thread the tool OPENS is named at create time — ui-editor-e2e covers
    // that. Here the pins landed in a thread that already existed, so what
    // matters is that the bundle did not rename it.)
    const commentTab = await page.locator(".sessiontab--on").innerText();
    check(
      "a machine-authored turn never names the thread it lands in",
      !commentTab.includes("cds-design:") &&
        !commentTab.includes("화면 수정 요청") &&
        !commentTab.includes("member/MemberList"),
      commentTab.split("\n").join(" "),
    );

    // Pins stay while the turn runs (the slow stub keeps the session live)…
    await page.waitForTimeout(1500);
    check(
      "pins stay while the turn is running",
      (await page.locator('[data-testid="pins-summary"]').count()) === 1,
    );

    // …and clear once the turn settles: the stub ends the query itself.
    await page.locator('[data-testid="pins-summary"]').waitFor({ state: "detached", timeout: 30_000 });
    check("pins clear once the turn settles", true);

    // --- 넘기기 전 점검 (PLAN D5): one plain Korean turn into the CURRENT
    // thread — the tool never judges spec coverage itself, and the 기획서 is
    // already in the thread's specs/, so Claude is the one who reads it.
    await page.locator(".screenpanel__bar").getByRole("button", { name: "넘기기 전 점검" }).click();
    await waitFor(() => {
      echo = inbox.find(
        (m) =>
          m.type === "session.event" &&
          m.event?.kind === "user.echo" &&
          typeof m.event.text === "string" &&
          m.event.text.includes("넘기기 전 점검") &&
          m.event.text.includes("specs/"),
      );
      return echo !== null && echo !== undefined;
    }, 30_000, "the precheck turn on the socket").catch(() => {
      echo = null;
    });
    check("점검 asks Claude in one plain turn, naming the specs/ 근거", echo !== null);
    // The echo lands on this socket before the browser's own socket delivers
    // it, so give the render one grace window before judging the shape.
    await page
      .locator(".bubble--user", { hasText: "넘기기 전 점검" })
      .first()
      .waitFor({ timeout: 30_000 })
      .catch(() => undefined);
    check(
      "the precheck turn is a plain user turn, not a marker card",
      (await page.locator(".bubble--user", { hasText: "넘기기 전 점검" }).count()) === 1 &&
        (await page.locator(".machine", { hasText: "넘기기 전 점검" }).count()) === 0,
    );

    // The finished mark is for a turn that ended somewhere the planner was
    // NOT looking (PLAN D2). These settled in the open tab, under their
    // eyes, so marking them would be telling them what they just watched.
    check(
      "the tab the planner is reading gets no finished mark",
      (await page.locator(".sessiontab .dot--done").count()) === 0,
    );
    check("no uncaught console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
    await page.screenshot({ path: join(here, "ui-comments-e2e.png"), fullPage: true });
  } finally {
    await browser.close();
    server.close();
    observer.close();
    daemon.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(DIR, { recursive: true, force: true });
        break;
      } catch {
        // next dev flushes a moment after the kill.
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
  }

  // --- the repo stays clean: check + build, and no overlay in production ----
  const checkRun = await run("pnpm", ["check"], { cwd: source }).catch((e) => e);
  check("reference-repo pnpm check passes with the overlay", !(checkRun instanceof Error), String(checkRun).split("\n")[0] ?? "");
  rmSync(join(source, ".next"), { recursive: true, force: true });
  await run("pnpm", ["build"], { cwd: source });
  const leaking = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "cache") continue;
        walk(path);
      } else if (entry.name.endsWith(".js")) {
        if (readFileSync(path, "utf8").includes("cds-design.comments")) leaking.push(path);
      }
    }
  };
  walk(join(source, ".next", "static"));
  walk(join(source, ".next", "server", "chunks"));
  check("production output carries no overlay", leaking.length === 0, leaking.slice(0, 2).join(", "));

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nCOMMENTS E2E ERROR: ${error.message}`);
  rmSync(DIR, { recursive: true, force: true });
  process.exit(2);
});
