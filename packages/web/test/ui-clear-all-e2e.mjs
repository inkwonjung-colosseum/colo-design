/**
 * 대화 모두 지우기 — 프로젝트 ··· 메뉴의 일괄 삭제 (session.deleteAll).
 *
 * 트리의 스레드 행은 데몬이 주기적으로 쓰는 클론별 캐시(project.threads)에서
 * 그려진다. 그 캐시가 늦게 차면 — 저장 스캔이 무거워 턴이 끝나도 한참 뒤에야
 * 목록이 닿으면 — 메뉴의 "대화 모두 지우기"는 threads.length > 0 게이트에
 * 걸려 아예 보이지 않고, 지운 뒤에도 행이 한동안 남은 것처럼 보인다. 그래서
 * 이 스위트는 첫 턴 직후 행이 빠르게 그려지는 것부터 단다: 메뉴 → 확인
 * 대화상자 → 모두 삭제 → 행이 비고, 새로고침에도 되살아나지 않는다.
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
const DIR = join(tmpdir(), "colo-design-clear-all-e2e");
const PORT = 5411;

const results = [];
function check(name, passed, detail = "") {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${passed ? "" : `  (${detail})`}`);
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
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
 * The suite's stub CLI: `--version`/`auth` for the wizard's gates,
 * `set_permission_mode` answered once at session birth, every user line
 * settles at once. One turn per process.
 */
function stubClaude(dir) {
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
    COLO_DESIGN_CLAUDE_BIN: stubClaude(join(DIR, "bin")),
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

  const threadRows = page.locator(".leaf[data-thread-id]");

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
    await page.getByRole("button", { name: "연결" }).click();
    await page.waitForSelector(".onboarding--start", { timeout: 60000 });

    await call({
      type: "project.create",
      name: "일괄삭제",
      repoUrl: fixture.remote,
      approveCommands: true,
    });
    for (let deadline = Date.now() + 90000; Date.now() < deadline; ) {
      const status = await call({ type: "repo.status" }, 15000);
      if (status.phase === "ready") break;
      if (status.phase === "error") throw new Error(`clone: ${status.detail ?? status.phase}`);
      await sleep(1000);
    }

    // --- two threads, one settled turn each ---------------------------------
    for (const label of ["첫", "둘"]) {
      const { sessionId } = await call({ type: "session.create", title: `${label}번째 대화` });
      await call({ type: "session.send", sessionId, text: `${label}번째 부탁` });
      await sleep(1500);
    }

    // --- the tree lists them while the turns are still fresh ----------------
    // The slow part of this window is the stores' disk scan — a sweep that
    // must not hold the tree's rows hostage for seconds.
    const listed = Date.now();
    await threadRows.nth(1).waitFor({ timeout: 20000 });
    check(
      "the tree lists the project's threads right after their turns",
      (await threadRows.count()) >= 2,
      `${Date.now() - listed}ms`,
    );

    // --- project ··· → 대화 모두 지우기 -------------------------------------
    await page.locator(".node", { hasText: "일괄삭제" }).first().locator(".node__menu-btn").click();
    await page.getByRole("menuitem", { name: "대화 모두 지우기" }).click();
    const dialog = page.locator('[role="dialog"][aria-label="대화 모두 삭제"]');
    await dialog.waitFor({ timeout: 10000 });
    check(
      "the confirm dialog names the project and its thread count",
      /일괄삭제 프로젝트의 대화 \d+개를 모두 삭제할까요\?/.test(await dialog.innerText()),
      await dialog.innerText(),
    );
    await dialog.locator("button.danger").click();

    // --- the rows go, and stay gone -----------------------------------------
    const cleared = Date.now();
    await threadRows
      .first()
      .waitFor({ state: "detached", timeout: 20000 })
      .catch(async () => {
        throw new Error(`rows never emptied; ${await threadRows.count()} left`);
      });
    check(
      "confirming empties the tree's rows",
      (await threadRows.count()) === 0,
      `${Date.now() - cleared}ms`,
    );

    await page.reload();
    await page.locator(".node", { hasText: "일괄삭제" }).waitFor({ timeout: 30000 });
    await sleep(2000); // the settle window a resurrection would need
    check(
      "the rows do not come back with a reload",
      (await threadRows.count()) === 0,
      `${await threadRows.count()} left`,
    );

    check(
      "no page errors while clearing every thread",
      failures.length === 0,
      failures.join(" | "),
    );
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

function rmDirSync(dir) {
  rmSync(dir, { recursive: true, force: true });
}

await main();
