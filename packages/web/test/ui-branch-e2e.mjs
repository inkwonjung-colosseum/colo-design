/**
 * 정산 줄과 분기 — 브라우저 수준 스위트.
 *
 * 턴이 끝난 줄(정산 줄)에는 세 가지가 함께 선다: 걸린 시간(`N초 걸렸습니다`),
 * 그 요청이 낸 답 전부를 담는 `전체 복사`, 그리고 `여기서 새 대화`(분기).
 * 분기를 누르면 기억을 이어받은 새 대화로 갈아탄다 — 사이드바에는 새 행이
 * 활성으로 생기고, 원래 대화의 행은 그대로 남으며, 분기 자체로 나가는
 * 말은 없다. 스텁 CLI 는 대화록 저장소를 남기지 않으므로 갈아탄 대화의
 * 테이프는 비어 보인다(폴백의 정직함) — 절단점 계산은 데몬 단위 시험의 몫.
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
const DIR = join(tmpdir(), "colo-design-branch-ui-e2e");
const PORT = 5437;

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

/** 모든 턴에 곧바로 답하는 스탭 CLI — 프롬프트 로그를 남긴다(무전송 판정용). */
function instantStubClaude(dir, logPath) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      'const fs = require("fs");',
      `const log = ${JSON.stringify(logPath)};`,
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
      '    if (line.includes(\'"type":"user"\')) {',
      '      if (log) { try { fs.appendFileSync(log, line + "\\n"); } catch {} }',
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
  const promptLog = join(DIR, "prompts.log");
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
    COLO_DESIGN_CLAUDE_BIN: instantStubClaude(join(DIR, "bin"), promptLog),
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

  const composer = page.getByLabel("메시지");
  const sendLine = async (text) => {
    await composer.fill(text);
    await composer.press("Enter");
  };

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
    await page.getByRole("button", { name: "연결" }).click();
    await page.waitForSelector(".onboarding--start", { timeout: 60000 });

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
              const timer = setTimeout(
                () => fail(new Error(`${message.type} timed out`)),
                timeoutMs,
              );
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

    await call({
      type: "project.create",
      name: "분기화면",
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

    // 두 턴을 흘려 보낸다 — 정산 줄이 두 개 생긴다. 스텁은 300ms 뒤 스스로
    // 끝나므로 죽어 가는 질의에 얹힌 전송은 거절된다 — 같은 말을 다시
    // 보내면 이어진다(되감기 e2e 의 관용과 같은 재시도).
    const sendUntilSettled = async (text, turns) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await sendLine(text);
        try {
          await page.waitForFunction(
            (n) => document.querySelectorAll(".turndone").length >= n,
            turns,
            { timeout: 15000 },
          );
          return;
        } catch {
          // 죽어 가는 질의의 거절 — 같은 말로 다시.
        }
      }
      await page.waitForFunction((n) => document.querySelectorAll(".turndone").length >= n, turns, {
        timeout: 30000,
      });
    };

    await sendUntilSettled("첫 번째 화면을 만들어 주세요", 1);
    await sendUntilSettled("두 번째 화면도 만들어 주세요", 2);

    // --- 정산 줄의 세 가지: 시간 · 전체 복사 · 여기서 새 대화 --------------
    const firstLine = page.locator(".turndone").first();
    check(
      "the settled line reads the turn's elapsed time",
      (await firstLine.innerText()).includes("걸렸습니다"),
      await firstLine.innerText(),
    );
    // 스텁 턴은 흐른 답 조각 없이 결과만 온다 — resultText 폴백이 복사를
    // 살려야 여기서 두 개가 센다. 분기 아이콘도 같은 조건 없이 선다 —
    // 결과만 온 턴도 "이 답까지"의 지점이므로.
    check(
      "the settled line carries the whole-answer copy",
      (await page.locator(".turndone .turndone__act").count()) === 4,
      "turndone__act icon buttons (copy + branch per turn)",
    );
    check(
      "the settled line offers 여기서 새 대화 on both turns",
      (await page.locator('.turndone__act[aria-label="여기서 새 대화"]').count()) === 2,
      "branch icon buttons",
    );
    // P2-2: 분기가 무엇을 되감는지는 마우스 뒤가 아니라 줄 위에 선다 — 화면도
    // 함께 되돌아간다고 읽은 사람이 답을 잃는 자리였다.
    check(
      "the settled line says out loud that branching rewinds only the conversation",
      (await firstLine.innerText()).includes(
        "대화만 이 답까지로 이어받아요. 화면은 지금 모습 그대로입니다.",
      ),
      await firstLine.innerText(),
    );
    check(
      "and the same line points at where the screens can be rewound",
      (await page.locator(".turndone__restore").first().innerText()) === "작업 기록에서 되돌리기",
      await page.locator(".turndone__restore").first().innerText(),
    );

    // --- 분기: 첫 답에서 갈라 나간다 --------------------------------------
    const beforeRows = await page.locator(".leaf[data-thread-id]").count();
    const promptsBefore = readPrompts(promptLog);

    await page.locator('.turndone__act[aria-label="여기서 새 대화"]').first().click();
    // 갈아탄 대화가 활성 행이 된다 — 원래 행은 그대로 남는다.
    await page.waitForFunction(
      (prev) => document.querySelectorAll(".leaf[data-thread-id]").length > prev,
      beforeRows,
      { timeout: 30000 },
    );
    check(
      "branching adds a conversation row to the sidebar",
      (await page.locator(".leaf[data-thread-id]").count()) === beforeRows + 1,
      `${beforeRows} → ${await page.locator(".leaf[data-thread-id]").count()}`,
    );
    check(
      "the original row survives as the inactive one beside the branch",
      (await page.locator(".leaf[data-thread-id]").count()) === 2 &&
        (await page.locator(".leaf[data-thread-id]:not(.leaf--active)").count()) === 1,
      "two rows, one active",
    );
    check(
      "the branch sends no words — the next turn is the user's",
      readPrompts(promptLog) === promptsBefore,
      "prompts.log unchanged",
    );
    // 스텁은 대화록을 남기지 않으므로 갈아탄 대화의 테이프는 처음 상태다 —
    // 폴백이 거짓 기억을 꾸미지 않는다는 뜻이다.
    await page.locator(".empty__lead").waitFor({ timeout: 15000 });
    check(
      "the branched conversation opens as its own (empty here) tape",
      (await page.locator(".empty__lead").count()) === 1,
      "empty tape",
    );

    // 갈라 나온 대화에서도 말은 그대로 흐른다.
    await sendLine("분기한 대화의 첫 문장입니다");
    await page.locator(".turndone").first().waitFor({ timeout: 30000 });
    check(
      "the branched conversation carries the next turn",
      readPrompts(promptLog) !== promptsBefore,
      "prompts.log diff",
    );

    check("no page errors while branching", failures.length === 0, failures.join(" | "));
  } finally {
    await browser.close();
    server.close();
    await stopDaemon(daemon);
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAILED: ${f.name}`);
    process.exit(1);
  }
}

function readPrompts(log) {
  try {
    return readFileSync(log, "utf8");
  } catch {
    return "";
  }
}

await main();
