/**
 * Silently running turn: proof that the waiting line (.turnlive) reappears.
 * The stub answers the first line with a visible text block, then goes
 * silent for 4s (no visible block) before finishing the turn. While the turn
 * runs and nothing on the tape moves, the line + clock must stand — previously,
 * once the first visible block had landed, the line stayed hidden until turn
 * end (the reported defect).
 *
 * Free: offline end to end — daemon, stub CLI, Chromium.
 * Prerequisite: `pnpm --filter @colo-design/web build` + daemon dist.
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
const DIR = join(tmpdir(), "colo-design-silence-e2e");
const PORT = 5417;

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
 * Text → 4s silence → tool_use → tool_result → final text → result. The
 * silence between the first visible block and the tool call is the window
 * this suite measures.
 */
function silentStubClaude(dir) {
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
      '  const emit = (line) => process.stdout.write(line + "\\n");',
      '  const assistant = (id, content) => emit(JSON.stringify({ type: "assistant", message: { id, type: "message", role: "assistant", model: "stub", content, stop_reason: null }, session_id: sessionId }));',
      "const seen = () => {",
      "  let idx;",
      '  while ((idx = buf.indexOf("\\n")) !== -1) {',
      "    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);",
      '    if (line.includes(\'"subtype":"set_permission_mode"\')) {',
      '      const id = (line.match(/"request_id":"([^"]*)"/) || [])[1];',
      '      emit(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: id } }));',
      "      continue;",
      "    }",
      '    if (line.includes(\'"type":"user"\')) {',
      '      sessionId = (line.match(/"session_id":"([^"]*)"/) || [])[1] || sessionId;',
      '      assistant("m1", [{ type: "text", text: "먼저 어디를 고칠지 읽어 볼게요" }]);',
      "      setTimeout(() => {",
      '        assistant("m2", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "true", description: "읽기" } }]);',
      "        setTimeout(() => {",
      '          emit(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "ok" }] }] }, session_id: sessionId }));',
      "          setTimeout(() => {",
      '            assistant("m3", [{ type: "text", text: "다 읽었습니다." }]);',
      '            emit(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: sessionId, result: "다 읽었습니다.", num_turns: 1, duration_ms: 5000, duration_api_ms: 0, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], errors: [] }));',
      "            setTimeout(() => process.exit(0), 300);",
      "          }, 150);",
      "        }, 150);",
      "      }, 4000);",
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
    COLO_DESIGN_CLAUDE_BIN: silentStubClaude(join(DIR, "bin")),
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
      name: "침묵",
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

    await composer.fill("침묵 구간을 재는 문장입니다");
    await composer.press("Enter");

    // a. the quiet first seconds carry the line — unchanged contract.
    await page.locator(".turnlive").waitFor({ timeout: 30000 });
    check("the line stands in the first seconds", true);

    // b. the first visible block lands…
    await page.locator(".bubble--assistant", { hasText: "먼저 어디를 고칠지" }).waitFor({
      timeout: 30000,
    });

    // c. …and the 4s silence that follows must NOT go dark: the line, clock
    //    included, stands again while the turn runs and nothing moves.
    let seenLive = false;
    let seenClock = false;
    for (let at = Date.now() + 3500; Date.now() < at; ) {
      const live = await page.locator(".turnlive").count();
      if (live > 0) {
        seenLive = true;
        seenClock = (await page.locator(".turnlive .turnclock").count()) > 0;
        break;
      }
      await sleep(200);
    }
    check(
      "the line reappears in the mid-turn silence",
      seenLive,
      seenLive ? "" : "no .turnlive during the silent stretch",
    );
    check("the reappeared line carries the elapsed clock", seenClock);

    // d. the turn settles and the line leaves with it.
    try {
      await page.locator(".turndone").first().waitFor({ timeout: 30000 });
    } catch {
      const tail = await page
        .locator(".transcript")
        .innerText()
        .catch(() => "(no transcript)");
      const stop = await page.locator(".toolbar__stop").count();
      const pendingCards = await page.locator(".permission, .question, [role='dialog']").count();
      console.log(`[diag] stop=${stop} cards=${pendingCards}\n[tail] ${tail.slice(-600)}`);
      throw new Error("turn never settled");
    }
    await sleep(300);
    check("the line leaves when the turn ends", (await page.locator(".turnlive").count()) === 0);

    check("no page errors", failures.length === 0, failures.join(" | "));
  } finally {
    await browser.close();
    server.close();
    await stopDaemon(daemon);
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
