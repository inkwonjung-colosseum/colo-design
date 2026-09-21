/**
 * 가득 찬 대화의 한 줄 안내(결함 5, 실사 2026-09-20) — 컨텍스트 윈도우의
 * 읽기가 문턱(98%)을 넘으면 입력창 위에 새 대화의 길이 한 줄로 서는지 잡는
 * 브라우저 수준 스위트.
 *
 * 읽기는 데몬의 `session.contextUsage` 답으로 온다 — 스텁 CLI 의 실제 읽기는
 * 운명이 아니므로 이 스위트는 그 답만 가로채 바꿔 싣는다(60 → 98 → 97).
 * 문턱의 양쪽을 모두 본다: 98 에선 안내가 서고, 97 에선 걷힌다. 안내는
 * 보내기를 막지 않는다 — 안내가 서 있는 판에서도 보낸 말이 턴이 되는 것까지
 * 본다. 같은 읽기가 링(ContextRing)의 퍼센트도 입히는지 같이 잡는다.
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
import { stopDaemon } from "./stop-daemon.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const daemonEntry = join(repoRoot, "packages", "daemon", "dist", "index.js");
const webDist = join(repoRoot, "packages", "web", "dist");
const DIR = join(tmpdir(), "colo-design-context-full-e2e");
const PORT = 5441;

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

/** 모든 턴에 곧바로 답하는 스탭 CLI — 읽기가 갱신될 턴을 가장 빨리 산다. */
function instantStubClaude(dir) {
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
      '    if (line.includes(\'"type":"user"\')) {',
      '      sessionId = (line.match(/"session_id":"([^"]*)"/) || [])[1] || sessionId;',
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

  rmSync(DIR, { recursive: true, force: true });
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
    COLO_DESIGN_CLAUDE_BIN: instantStubClaude(join(DIR, "bin")),
    COLO_DESIGN_CREDENTIAL_STORE: "memory",
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
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const failures = [];
  page.on("pageerror", (e) => failures.push(e.message));
  page.on("console", (m) => m.type() === "error" && failures.push(m.text()));

  // 이 창이 실을 컨텍스트 읽기 — 가로채서 스위트의 값으로 바꿔 싣는다.
  // 페이지의 조작 소켓(설정용 call())도 같은 주소를 쓰므로 양쪽 방향을
  // 그대로 통과시키고, `session.contextUsage` 의 답만 손본다. URL 이 표준형으로
  // 곧아지며 슬래시가 낄 수 있어(?token 앞) 그것까지 떼고 비교한다.
  let fakePct = 60;
  await page.routeWebSocket(
    (url) => url.href.replace("/?", "?").startsWith(daemonUrl),
    (ws) => {
      const server = ws.connectToServer();
      const usageIds = new Set();
      ws.onMessage((message) => {
        server.send(message);
        try {
          const parsed = JSON.parse(String(message));
          if (parsed.type === "session.contextUsage") usageIds.add(parsed.id);
        } catch {
          // 우리 선의 프레임만 본문이 있다 — 나머지는 그대로 통과한다.
        }
      });
      server.onMessage((message) => {
        try {
          const parsed = JSON.parse(String(message));
          if (parsed.type === "ok" && usageIds.has(parsed.id)) {
            usageIds.delete(parsed.id);
            parsed.data = {
              totalTokens: fakePct * 2000,
              maxTokens: 200_000,
              percentage: fakePct,
              sessionCostUsd: null,
              model: "stub",
            };
            ws.send(JSON.stringify(parsed));
            return;
          }
        } catch {
          // 못 읽는 프레임은 원문 그대로.
        }
        ws.send(message);
      });
    },
  );

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
  /** 정산이 읽기를 다시 심었는지의 동기점 — 링의 퍼센트가 기다린 값이 된다. */
  const waitRing = async (pct) => {
    await page.waitForFunction(
      (want) => document.querySelector(".ctx__pct")?.textContent === `${want}%`,
      pct,
      { timeout: 30000 },
    );
  };

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
    await page.getByRole("button", { name: "연결" }).click();
    await page.waitForSelector(".onboarding--start", { timeout: 60000 });

    await call({
      type: "project.create",
      name: "가득찬대화",
      repoUrl: fixture.remote,
      approveCommands: true,
    });
    for (let deadline = Date.now() + 90000; Date.now() < deadline; ) {
      const status = await call({ type: "repo.status" }, 15000);
      if (status.phase === "ready") break;
      if (status.phase === "error") throw new Error(`clone: ${status.detail ?? status.phase}`);
      await sleep(1000);
    }

    await page.locator(".leaf--start").first().click();
    await page.locator(".empty__lead").waitFor({ timeout: 15000 });

    // --- a. 문턱 아래(60%)의 읽기는 안내를 내지 않는다 -------------------
    await sendLine("첫 문장입니다");
    await page.locator(".turndone").first().waitFor({ timeout: 30000 });
    await waitRing(fakePct);
    check(
      "the reading below the threshold paints no guidance",
      (await page.locator(".composer__ctxfull").count()) === 0,
    );

    // --- b. 문턱(98%)의 읽기는 입력창 위에 한 줄을 세운다 ----------------
    fakePct = 98;
    await sendLine("둘째 문장입니다");
    await page
      .locator(".bubble--user", { hasText: "둘째 문장입니다" })
      .first()
      .waitFor({ timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll(".turndone").length >= 2, null, {
      timeout: 30000,
    });
    await waitRing(fakePct);
    const guidance = await page.locator(".composer__ctxfull").textContent();
    check(
      "the full reading raises the guidance line",
      guidance?.trim() === "이 대화는 가득 찼어요 — 새 대화로 옮겨 같은 맥락을 이어 받으세요",
      guidance ?? "no line",
    );

    // --- c. 안내는 보내기를 막지 않는다 ----------------------------------
    await sendLine("안내 아래의 셋째 문장입니다");
    await page
      .locator(".bubble--user", { hasText: "안내 아래의 셋째 문장입니다" })
      .first()
      .waitFor({ timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll(".turndone").length >= 3, null, {
      timeout: 30000,
    });
    await waitRing(fakePct);
    check(
      "the send under the guidance still became a turn",
      (await page.locator(".turndone").count()) === 3,
    );

    // --- d. 문턱의 바로 아래(97%)는 다시 조용하다 -----------------------
    fakePct = 97;
    await sendLine("넷째 문장입니다");
    await page
      .locator(".bubble--user", { hasText: "넷째 문장입니다" })
      .first()
      .waitFor({ timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll(".turndone").length >= 4, null, {
      timeout: 30000,
    });
    await waitRing(fakePct);
    check(
      "one point below the threshold retires the guidance",
      (await page.locator(".composer__ctxfull").count()) === 0,
    );

    check("no page errors while reading the context", failures.length === 0, failures.join(" | "));
  } finally {
    await browser.close();
    server.close();
    await stopDaemon(daemon);
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`FAIL  ${f.name}`);
    process.exit(1);
  }
}

await main();
