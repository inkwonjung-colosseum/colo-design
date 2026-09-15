/**
 * Browser-level check of the port-conflict policy (실사 결함의 회귀 검사).
 *
 * 실사에서: 포트 충돌로 준비이 실패하면 카드는 force 없는 "다시 시도" 만
 * 보여 줬고, 본문은 "다시 시작을 누르면 그 프로그램을 종료한다" 고 약속했다 —
 * 없는 버튼을 가리키는 안내였다. 지금의 정책은 그 함정을 아예 없앤다: 활성
 * 프로젝트가 선언한 포트의 주인은 활성 프로젝트다 — 묻지 않고 점유자를
 * 정리하고 그 자리에 미리보기를 띄운다. 이 스위트는 브라우저에서 그 회복을
 * 지켜본다. 덧붙여 .claude/settings.json 을 싣는 레포의 머리 경고가 한국어로
 * 읽히는지, 닫은 뒤 새로고침에도 조용한지도 함께 (역시 실사 결함).
 *
 * Prerequisites: `pnpm build` (daemon + web dist)
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createFixtureRepo, freePort, pushFixtureChange } from "../../daemon/test/fixture-repo.mjs";
import { stopDaemon } from "./stop-daemon.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const daemonEntry = join(repoRoot, "packages", "daemon", "dist", "index.js");
const webDist = join(repoRoot, "packages", "web", "dist");
const DIR = join(tmpdir(), "colo-design-port-busy-ui-e2e");
const PORT = 5407;

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

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** A stub CLI: the daemon needs one to answer --version and auth. */
function writeStubClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  --version) echo "1.0.0-stub"; exit 0;;',
      "  auth)",
      '    echo \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"planner@example.com"}\'',
      "    exit 0;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

/** The "foreign program" holding the declared preview port — ours, so the
    reclaim's kill has no collateral. */
function spawnSquatter(port) {
  return spawn(process.execPath, [
    "-e",
    `require("http").createServer((q,s)=>s.end("squatter")).listen(${port},"127.0.0.1",()=>console.log("up"))`,
  ]);
}

async function main() {
  if (!existsSync(webDist))
    throw new Error("web dist missing. Run: pnpm --filter @colo-design/web build");
  if (!existsSync(daemonEntry))
    throw new Error("daemon dist missing. Run: pnpm --filter @colo-design/daemon build");

  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "claude-config"), { recursive: true });
  const previewPort = await freePort();
  const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port: previewPort });
  // The header-warning repo: .claude/settings.json with permissions rides the
  // seed, so the warning line can be read in Korean once the clone is up.
  await pushFixtureChange(fixture.seed, fixture.remote, {
    ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }),
  });

  const squatter = spawnSquatter(previewPort);
  await new Promise((ok) => squatter.stdout.once("data", ok));

  const env = {
    ...process.env,
    COLO_DESIGN_PORT: String(await freePort()),
    COLO_DESIGN_PROJECTS_SETTINGS: join(DIR, "projects.json"),
    COLO_DESIGN_PROJECTS_DIR: join(DIR, "projects"),
    CLAUDE_CONFIG_DIR: join(DIR, "claude-config"),
    COLO_DESIGN_CLAUDE_BIN: writeStubClaude(join(DIR, "bin")),
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
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

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

  /** Poll until the clone reports the wanted phase; `want` may be "ready" or
      "error" — either is a verdict worth waiting for. */
  const waitPhase = async (phase, label, timeoutMs = 120000) => {
    let last = null;
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
      const status = await call({ type: "repo.status" }, 15000);
      last = status;
      if (status.phase === phase) return status;
      await sleep(1000);
    }
    throw new Error(
      `${label}: never reached ${phase} (stuck at ${last?.phase}: ${last?.detail ?? ""})`,
    );
  };

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
    await page.getByRole("button", { name: "연결" }).click();
    await page.waitForSelector(".onboarding", { timeout: 60000 });
    // 확인 방식 카드를 고른 뒤에야 마법사가 끝난다(설정 문서 P0#4).
    await page.getByRole("button", { name: /바로 실행/ }).click();
    const start = page.getByRole("button", { name: "시작하기" });
    await start.waitFor({ timeout: 30000 });
    await start.click();
    await page.waitForSelector(".planner__body", { timeout: 60000 });

    // --- 1. a busy declared port heals itself --------------------------------
    await call({
      type: "project.create",
      name: "포트실험",
      repoUrl: fixture.remote,
      approveCommands: true,
    });
    const ready = await waitPhase("ready", "the busy port's reclaim");
    check(
      "the clone reaches ready over a busy declared port — no error card",
      ready.phase === "ready",
      ready.detail ?? "",
    );
    const body = await fetch(`http://127.0.0.1:${previewPort}`).then((r) => r.text());
    check(
      "what answers the port now is the preview, not the squatter",
      body.includes("회원 관리"),
      `${body.length} bytes`,
    );
    await new Promise((ok) => {
      const timer = setTimeout(ok, 5000);
      squatter.once("exit", () => {
        clearTimeout(timer);
        ok();
      });
    });
    check(
      "the foreign holder is gone",
      squatter.exitCode !== null || squatter.signalCode !== null,
      `exit=${squatter.exitCode} signal=${squatter.signalCode}`,
    );

    // --- 2. the header warning reads in Korean -------------------------------
    // The warning rides the status snapshot the page read at connect — the
    // project was born after that, so look again with fresh eyes.
    await page.reload();
    await page.waitForSelector(".planner__body", { timeout: 60000 });
    const text = await page.locator(".planner").innerText();
    check(
      "a repo shipping .claude/settings.json warns in Korean",
      text.includes("이 레포가 보낸 .claude/settings.json(permissions)이 일부 도구를 미리 승인"),
    );
    // --- 3. 닫은 레포 경고는 새로고침해도 조용하다 ----------------------------
    // 뉴스는 한 번 읽히면 그만이다 — 닫고 새로고침해도 같은 문장이 돌아오지
    // 않는다(설정 파일이 바뀌어 지문이 달라질 때만 다시 보인다).
    await page.getByRole("button", { name: "경고 닫기" }).click();
    await page.waitForSelector(".planner__warnings", { state: "detached", timeout: 15000 });
    await page.reload();
    await page.waitForSelector(".planner__body", { timeout: 60000 });
    const quiet = await page.locator(".planner").innerText();
    check(
      "a closed repo warning stays closed across a reload",
      !quiet.includes("이 레포가 보낸 .claude/settings.json"),
    );

    check("no page errors while driving the planner", errors.length === 0, errors.join(" | "));
  } finally {
    squatter.kill("SIGKILL");
    await browser.close().catch(() => undefined);
    server.close();
    await stopDaemon(daemon);
    rmSync(DIR, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error(`Failed: ${failed.map((r) => r.name).join(", ")}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
