/**
 * 실행 중 보내기 — the settings switch that decides what Enter means while a
 * turn runs.
 *
 * Default "queue" (PLAN D86): a mid-turn send shows the wait-line and rides
 * to the next turn. "interrupt" (끊고 보내기, PLAN D86 의 스위치): the same
 * Enter cuts the running turn and starts over with the new words — the
 * ⌥Enter path, promoted. The running turn here is a stub CLI that answers
 * interrupt control requests and never finishes a marker turn on its own, so
 * the composer's stop button can only disappear if the send really cut it.
 *
 * Free: no real Claude turn. Offline end to end — daemon, SDK, stub CLI.
 *
 * Prerequisite: `pnpm --filter @colo-design/web build`
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createFixtureRepo, freePort } from "../../daemon/test/fixture-repo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const daemonEntry = join(repoRoot, "packages", "daemon", "dist", "index.js");
const webDist = join(repoRoot, "packages", "web", "dist");
const DIR = join(tmpdir(), "colo-design-midturn-send-e2e");
const PORT = 5403;

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") throw new Error(`check("${name}") was called without a verdict`);
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

/**
 * A stub CLI the suite can steer: `--version`/`auth` for the wizard's gates,
 * `set_permission_mode` answered once at session birth, `interrupt` answered
 * the way the real CLI ends a stopped turn. A user line carrying the marker
 * never answers — that turn RUNS until something cuts it — and anything else
 * settles at once. One turn per process.
 */
function steerableStubClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      'if (process.argv[2] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
      'if (process.argv[2] === "auth") {',
      '  console.log(\'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"planner@example.com"}\');',
      "  process.exit(0);",
      "}",
      'let buf = "";',
      'let sessionId = "stub";',
      "let busy = false;",
      "const seen = () => {",
      "  let idx;",
      '  while ((idx = buf.indexOf("\\n")) !== -1) {',
      "    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);",
      '    if (line.includes(\'"subtype":"set_permission_mode"\')) {',
      '      const id = (line.match(/"request_id":"([^"]*)"/) || [])[1];',
      "      process.stdout.write(JSON.stringify({",
      '        type: "control_response",',
      '        response: { subtype: "success", request_id: id },',
      '      }) + "\\n");',
      "      continue;",
      "    }",
      '    if (line.includes(\'"subtype":"interrupt"\')) {',
      '      const id = (line.match(/"request_id":"([^"]*)"/) || [])[1];',
      "      process.stdout.write(JSON.stringify({",
      '        type: "control_response",',
      '        response: { subtype: "success", request_id: id },',
      '      }) + "\\n");',
      "      process.stdout.write(JSON.stringify({",
      // 실제 CLI 의 결과 한 줄에는 SDK 가 훑는 배열들이 들어 있다. 빠지면 SDK
      // 가 질의 안에서 터져(TypeError: reading 'map') 중지 뒤의 대화가 죽은
      // 질의가 되고, 이 스위트는 제품이 걷지 않는 길을 걷게 된다.
      '        type: "result", subtype: "error_during_execution", is_error: true,',
      '        session_id: sessionId, result: "interrupted", num_turns: 1, duration_ms: 5,',
      "        duration_api_ms: 0, total_cost_usd: 0, usage: {}, modelUsage: {},",
      "        permission_denials: [], errors: [],",
      '      }) + "\\n");',
      "      setTimeout(() => process.exit(0), 150);",
      "      return;",
      "    }",
      '    if (line.includes(\'"type":"user"\')) {',
      '      sessionId = (line.match(/"session_id":"([^"]*)"/) || [])[1] || sessionId;',
      "      // A marker turn RUNS until something cuts it — mid-turn sends land",
      "      // on stdin while it runs and must not settle it behind the suite's",
      "      // back (the real CLI keeps working until interrupted too).",
      "      if (busy) return;",
      '      if (line.includes("오래 걸리는 작업")) { busy = true; return; }',
      "      process.stdout.write(JSON.stringify({",
      '        type: "result", subtype: "success", is_error: false,',
      '        session_id: sessionId, result: "알겠습니다.", num_turns: 1, duration_ms: 10,',
      "        duration_api_ms: 0, total_cost_usd: 0, usage: {}, modelUsage: {},",
      "        permission_denials: [], errors: [],",
      '      }) + "\\n");',
      "      setTimeout(() => process.exit(0), 300);",
      "      return;",
      "    }",
      "  }",
      "};",
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { buf += chunk; seen(); });',
      'process.stdin.on("end", () => process.exit(0));',
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function main() {
  if (!existsSync(webDist))
    throw new Error("web dist missing. Run: pnpm --filter @colo-design/web build");
  if (!existsSync(daemonEntry))
    throw new Error("daemon dist missing. Run: pnpm --filter @colo-design/daemon build");

  rmDirSync(DIR);
  mkdirSync(join(DIR, "claude-config"), { recursive: true });
  const fixture = await createFixtureRepo({
    dir: join(DIR, "fixture"),
    port: await freePort(),
  });

  const env = {
    ...process.env,
    COLO_DESIGN_PORT: String(await freePort()),
    COLO_DESIGN_PROJECTS_SETTINGS: join(DIR, "projects.json"),
    COLO_DESIGN_PROJECTS_DIR: join(DIR, "projects"),
    CLAUDE_CONFIG_DIR: join(DIR, "claude-config"),
    COLO_DESIGN_CLAUDE_BIN: steerableStubClaude(join(DIR, "bin")),
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
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const failures = [];
  page.on("pageerror", (e) => failures.push(e.message));
  page.on("console", (m) => m.type() === "error" && failures.push(m.text()));

  /** A second socket from the page: setup and session wiring. */
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

  const composer = page.getByLabel("메시지");
  /** Type into the composer and press Enter — the plain send path. */
  const sendLine = async (text) => {
    await composer.fill(text);
    await composer.press("Enter");
  };

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
    await page.getByRole("button", { name: "연결" }).click();
    await page.waitForSelector(".onboarding", { timeout: 60000 });
    // 확인 방식 카드를 고른 뒤에야 마법사가 끝난다(설정 문서 P0#4). 이
    // 스위트가 기대하는 동작은 예전 기본값과 같은 `바로 실행`이다.
    await page.getByRole("button", { name: /바로 실행/ }).click();
    const start = page.getByRole("button", { name: "시작하기" });
    await start.waitFor({ timeout: 30000 });
    await start.click();
    await page.waitForSelector(".planner__body", { timeout: 60000 });

    await call({
      type: "project.create",
      name: "미드턴",
      repoUrl: fixture.remote,
      approveCommands: true,
    });
    for (let deadline = Date.now() + 90000; Date.now() < deadline; ) {
      const status = await call({ type: "repo.status" }, 15000);
      if (status.phase === "ready") break;
      if (status.phase === "error") throw new Error(`clone: ${status.detail ?? status.phase}`);
      await sleep(1000);
    }

    // --- a. default queue: a mid-turn send shows the wait-line -------------
    const first = await call({ type: "session.create" });
    await page.locator(`.leaf[data-thread-id="${first.sessionId}"]`).click();
    // Same receipt as check c: the leaf click's switch is async.
    await page.locator(".thread__title").waitFor({ timeout: 30000 });

    await sendLine("오래 걸리는 작업 시작해 줘");
    const stop = page.locator(".toolbar__stop");
    await stop.waitFor({ timeout: 30000 });
    check("a marker turn really runs", (await stop.count()) === 1);

    await sendLine("기다려 주세요");
    const waitLine = page.locator(".composer__queued");
    await waitLine.waitFor({ timeout: 10000 });
    check(
      "with the default, a mid-turn send shows the wait-line",
      (await waitLine.innerText()).includes("대기"),
      await waitLine.innerText(),
    );
    check(
      "and the running turn is untouched",
      (await stop.count()) === 1 && (await waitLine.count()) === 1,
    );

    // --- b. flip the setting in the dialog it lives in ---------------------
    await page.getByRole("button", { name: "설정" }).click();
    await page.waitForSelector('[role="dialog"][aria-label="설정"]', { timeout: 5000 });
    await page.getByLabel("실행 중 보내기").selectOption("interrupt");
    const storedBlob = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("colo-design.settings") ?? "null"),
    );
    check("the choice is stored", storedBlob?.midTurnSend === "interrupt");
    await page.keyboard.press("Escape");
    await page
      .locator('[role="dialog"][aria-label="설정"]')
      .waitFor({ state: "detached", timeout: 5000 });

    // --- c. interrupt send: the same Enter now cuts the turn ---------------
    const second = await call({ type: "session.create" });
    await page.locator(`.leaf[data-thread-id="${second.sessionId}"]`).click();
    await page.locator(".planner__project").waitFor({ timeout: 30000 });

    // The leaf click's switch is async — sending before it lands would hand
    // the words to the previous thread. The chat head is the receipt: the new
    // thread is open when its placeholder title sits in the header.
    await page.locator(".thread__title", { hasText: "새 화면" }).waitFor({ timeout: 30000 });
    await sendLine("오래 걸리는 작업 시작해 줘");
    await stop.waitFor({ timeout: 30000 });
    await sendLine("그만하고 이걸 먼저 고쳐 줘");
    // The stub never settles a marker turn on its own, so the stop button
    // vanishing can only mean the send cut it (interrupt answered).
    await stop.waitFor({ state: "detached", timeout: 15000 });
    check("a mid-turn send cut the running turn", true);
    await sleep(500); // the wait-line zeroes at the turn's end, not before
    check(
      "nothing is left waiting for the next turn",
      (await page.locator(".composer__queued").count()) === 0,
    );
    const bubbles = await page.locator(".bubble--user").allInnerTexts();
    check(
      "the cutting words reached the transcript",
      bubbles.some((row) => row.includes("그만하고 이걸 먼저 고쳐 줘")),
      JSON.stringify(bubbles),
    );

    // --- d. ⌥Enter keeps its meaning under either setting ------------------
    check(
      "the choice survived as 설정 wrote it",
      (await page.evaluate(
        () => JSON.parse(localStorage.getItem("colo-design.settings") ?? "null")?.midTurnSend,
      )) === "interrupt",
    );

    check("no page errors while steering the turn", failures.length === 0, failures.join(" | "));
  } finally {
    await browser.close();
    server.close();
    daemon.kill("SIGKILL");
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAILED: ${f.name}`);
    process.exit(1);
  }
}

function rmDirSync(dir) {
  rmSync(dir, { recursive: true, force: true });
}

await main();
