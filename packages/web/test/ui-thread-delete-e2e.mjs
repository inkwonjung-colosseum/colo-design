/**
 * 대화 삭제 — 지운 스레드가 대화창에 되살아나지 않는다 (삭제 부활 결함).
 *
 * 열려 있는 스레드를 목록의 ··· 지우기로 삭제하면: 왼쪽 목록의 행은 사라지고,
 * 대화창은 스레드 없음 상태로 남아야 한다. 복원 효과("Reload 후 마지막 대화
 * 복원")는 activeId 가 null 로 떨어지는 순간 저장된 포인터를 읽는데, 그 시점의
 * 목록은 아직 갱신 전이라 지워진 행을 담고 있다 — 포인터가 살아 있으면 방금
 * 지운 스레드가 대화창에 되살아난다(목록에는 없는데 화면에는 있는 유령).
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
const DIR = join(tmpdir(), "colo-design-thread-delete-e2e");
const PORT = 5409;

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
    // The wizard gate is gone from the first run: a project-less app draws
    // the full-window start wizard in the workspace's place, so
    // .onboarding--start is the boot receipt. The wire call below is what
    // stands the workspace up.
    await page.waitForSelector(".onboarding--start", { timeout: 60000 });

    await call({
      type: "project.create",
      name: "삭제부활",
      repoUrl: fixture.remote,
      approveCommands: true,
    });
    for (let deadline = Date.now() + 90000; Date.now() < deadline; ) {
      const status = await call({ type: "repo.status" }, 15000);
      if (status.phase === "ready") break;
      if (status.phase === "error") throw new Error(`clone: ${status.detail ?? status.phase}`);
      await sleep(1000);
    }

    // --- a thread with a transcript, open in the chat pane ------------------
    // DEBT (화면 구성 재설계, 2026-09-17): the leaf below never draws on the
    // current tree — wire-created threads don't surface (same failure in
    // ui-midturn-send-e2e / ui-sidebar-e2e). Blocked on the redesign's
    // thread-list plumbing; the rest of this suite is untouched.
    const doomed = await call({ type: "session.create" });
    await page.locator(`.leaf[data-thread-id="${doomed.sessionId}"]`).click();
    await page.locator(".thread__title").waitFor({ timeout: 30000 });
    await sendLine("간단한 화면 하나 부탁해요");
    await page.locator(".bubble--user").first().waitFor({ timeout: 30000 });

    // --- delete it through the leaf's own ··· menu --------------------------
    await page
      .locator(".leafwrap", { has: page.locator(`.leaf[data-thread-id="${doomed.sessionId}"]`) })
      .locator(".leaf__menu-btn")
      .click();
    await page.getByRole("menuitem", { name: "지우기" }).click();
    const removeDialog = page.locator('[role="dialog"][aria-label="대화 삭제"]');
    await removeDialog.waitFor({ timeout: 15000 });
    await removeDialog.locator("button.danger").click();

    // --- the list row goes, and the chat pane must not resurrect it ---------
    await page
      .locator(`.leaf[data-thread-id="${doomed.sessionId}"]`)
      .waitFor({ state: "detached", timeout: 15000 });
    check("the deleted thread leaves the sidebar list", true);

    // The resurrection, if it happens, lands right after the refresh — give
    // it the settle window before judging the pane.
    await sleep(1000);
    check(
      "the deleted thread's chat head does not come back",
      (await page.locator(".thread__title").count()) === 0,
    );
    check(
      "the pane reads as no-thread-open, not as the deleted thread",
      (await page.locator('textarea[placeholder^="만들고 싶은 화면을"]').count()) === 1,
    );
    const saved = await page.evaluate(() => localStorage.getItem("colo-design.last-thread"));
    const pointers = Object.values(JSON.parse(saved ?? "{}"));
    check(
      "the saved last-thread pointer no longer names the deleted thread",
      !pointers.includes(doomed.sessionId),
      saved ?? "{}",
    );

    check("no page errors while deleting the thread", failures.length === 0, failures.join(" | "));
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
