/**
 * Browser-level check of the cycle-status menu's 확인 읽기, fully offline.
 *
 * A project with no open handoff is where the menu lives most — 저장됨 and
 * 변경 없음 are both there. The daemon answers `repo.handoffStatus` with null
 * ("nothing to check"), and the panel must record that as a check anyway:
 * the menu's clock line may not sit on "이 창에서는 아직 확인하지 않았습니다"
 * forever. The old read dereferenced the null report, the quiet reuse
 * swallowed the throw, and the clock never set — a saved project's menu
 * claimed it had never checked, every day, in every window.
 *
 * Prerequisites: `pnpm build` (daemon + web dist)
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFixtureRepo, freePort } from "../../daemon/test/fixture-repo.mjs";
import { stopDaemon } from "./stop-daemon.mjs";

/**
 * The gate stub — the daemon only asks whether a claude is signed in; no turn
 * runs in this suite, so the answer's shape is all that matters.
 */
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

import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const daemonEntry = join(repoRoot, "packages", "daemon", "dist", "index.js");
const webDist = join(repoRoot, "packages", "web", "dist");
const DIR = join(tmpdir(), "colo-design-status-menu-ui-e2e");

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

function serveDist(port) {
  const server = createServer((req, res) => {
    const path = req.url === "/" ? "/index.html" : (req.url ?? "/").split("?")[0];
    const file = existsSync(join(webDist, path))
      ? join(webDist, path)
      : join(webDist, "index.html");
    res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok(server)));
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

  const pagePort = await freePort();
  const env = {
    ...process.env,
    COLO_DESIGN_PORT: String(await freePort()),
    COLO_DESIGN_PROJECTS_SETTINGS: join(DIR, "projects.json"),
    COLO_DESIGN_PROJECTS_DIR: join(DIR, "projects"),
    CLAUDE_CONFIG_DIR: join(DIR, "claude-config"),
    COLO_DESIGN_CLAUDE_BIN: writeStubClaude(join(DIR, "bin")),
    COLO_DESIGN_CREDENTIAL_STORE: "memory",
    // The page comes from this file's static server, not the daemon — the
    // upgrade's Origin must be named or the daemon 403s it.
    COLO_DESIGN_DEV_SERVER: `http://127.0.0.1:${pagePort}`,
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

  const server = await serveDist(pagePort);
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1680, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  /** The page's second socket: setup and polls without touching the UI. */
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

  const waitReady = async (label) => {
    for (let deadline = Date.now() + 90000; Date.now() < deadline; ) {
      const status = await call({ type: "repo.status" }, 15000);
      if (status.phase === "ready") return status;
      if (status.phase === "error") throw new Error(`${label}: ${status.detail ?? status.phase}`);
      await sleep(1000);
    }
    throw new Error(`${label}: never became ready`);
  };

  try {
    // 첫 실행 투어의 예시 창은 빈 대화마다 선다 — 이 스위트는 투어가
    // 아니라 그 아래의 화면을 본다.
    await page.addInitScript(() => localStorage.setItem("colo-design.tour-step", "done"));
    await page.goto(`http://127.0.0.1:${pagePort}/`);
    await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
    await page.getByRole("button", { name: "연결" }).click();
    await page.waitForSelector(".onboarding--start", { timeout: 60000 });

    // One project, cloned and ready — and never handed off. Every delivery
    // row from here (변경 없음, and 저장됨 once a branch exists) answers
    // repo.handoffStatus with null.
    await call({
      type: "project.create",
      name: "결제",
      repoUrl: fixture.remote,
      approveCommands: true,
    });
    await waitReady("the 결제 clone");

    // The bar lives in the thread view: one conversation row, clicked.
    const { sessionId } = await call({ type: "session.create" });
    await page.locator(`.leaf[data-thread-id="${sessionId}"]`).waitFor({ timeout: 30000 });
    await page.locator(`.leaf[data-thread-id="${sessionId}"]`).click();
    await page.locator(".screenpanel__bar").waitFor({ timeout: 30000 });

    // E′ — 다음 할 일 문장은 팝오버를 열기 전에 배송 바에 직접 보인다.
    // 이 시점의 사이클은 변경 없음(새로 만든 것이 없습니다)이고, 문장은
    // 칩과 더 보기 버튼 사이의 한 줄이다. P2-1 뒤로 이 자리에 `저장` 은 없다.
    const nextline = page.locator(".screenpanel__nextline");
    await nextline.waitFor({ timeout: 10000 });
    check(
      "the bar names the next chore without opening the menu",
      (await nextline.innerText()).includes("새로 만든 것이 없습니다"),
      await nextline.innerText(),
    );

    // The mount read has already fired by now (quiet reuse on activation).
    // Opening the menu must show a real clock, not the never-checked line.
    await page.locator(".screenpanel__statusbtn").click();
    await page.locator(".screenpanel__statusmenu").waitFor({ timeout: 10000 });
    const hint = page.locator(".screenpanel__statusrow .hint");
    await page.waitForFunction(
      () =>
        (document.querySelector(".screenpanel__statusrow .hint")?.textContent ?? "").includes(
          "마지막 확인",
        ),
      undefined,
      { timeout: 10000 },
    );
    check(
      "the menu's clock line names the check that just happened",
      !(await hint.innerText()).includes("아직 확인하지 않았습니다"),
      await hint.innerText(),
    );

    // The popup opens downward across the chat column's thread bar. Both bars
    // are glass stacking contexts, and while they shared z31 the DOM order —
    // .thread comes later — let the thread bar paint over the menu's first
    // line. The popup's own z-index cannot leave the header's context, so the
    // hit test at the menu's first line is the contract: the menu, or whatever
    // covers it, is what a click would actually meet.
    const stacking = await page.evaluate(() => {
      const menu = document.querySelector(".screenpanel__statusmenu");
      if (!menu) return { ok: false, detail: "menu not found" };
      const line = menu.querySelector(".screenpanel__statusline");
      const r = (line ?? menu).getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + 10, r.top + r.height / 2);
      return {
        ok: hit !== null && menu.contains(hit),
        detail: hit
          ? `${hit.tagName.toLowerCase()}${hit.classList.length ? "." + [...hit.classList].join(".") : ""}`
          : "nothing hit",
      };
    });
    check(
      "the menu paints over the thread bar — its first line is hit-testable",
      stacking.ok,
      stacking.detail,
    );

    check("no uncaught console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
    await page.screenshot({
      path: join(here, "ui-status-menu-e2e.png"),
      fullPage: true,
    });
  } finally {
    await browser.close();
    server.close();
    await stopDaemon(daemon);
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  rmSync(DIR, { recursive: true, force: true });
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
