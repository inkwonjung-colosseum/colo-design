/**
 * Browser-level check of the 미리보기 칸's 변경 점 strip, fully offline.
 *
 * The strip is the preview column's floor (mockup 03 · 분할): what a 저장
 * would carry, listed under the stage it belongs to. The chain under test is
 * the one the planner actually rides — a write in the clone, a recount that
 * emits `repo.status`, and the strip listing exactly what the chip counts.
 * It must be absent on a clean tree, name every row with its word and ±,
 * fold and unfold on the head, and vanish again once the changes are gone.
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

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const daemonEntry = join(repoRoot, "packages", "daemon", "dist", "index.js");
const webDist = join(repoRoot, "packages", "web", "dist");
const DIR = join(tmpdir(), "colo-design-changed-strip-ui-e2e");

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
    await page.goto(`http://127.0.0.1:${pagePort}/`);
    await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
    await page.getByRole("button", { name: "연결" }).click();
    await page.waitForSelector(".onboarding--start", { timeout: 60000 });

    await call({
      type: "project.create",
      name: "변경점",
      repoUrl: fixture.remote,
      approveCommands: true,
    });
    await waitReady("the 변경점 clone");

    // The strip lives in the thread view: one conversation row, clicked.
    const { sessionId } = await call({ type: "session.create" });
    await page.locator(`.leaf[data-thread-id="${sessionId}"]`).waitFor({ timeout: 30000 });
    await page.locator(`.leaf[data-thread-id="${sessionId}"]`).click();
    await page.locator(".screenpanel__bar").waitFor({ timeout: 30000 });

    check("a clean tree draws no strip", (await page.locator(".cstrip").count()) === 0);

    // The planner's unsaved work: a tracked edit, a tracked deletion, and a
    // brand-new untracked screen — the three words the strip can say.
    const worktree = join(DIR, "projects", "변경점", "repo");
    const { execFileSync } = await import("node:child_process");
    const current = execFileSync("git", ["-C", worktree, "show", "HEAD:CLAUDE.md"], {
      encoding: "utf8",
    });
    writeFileSync(
      join(worktree, "CLAUDE.md"),
      current.replace(
        "- 만들거나 바꾼 화면을 이름과 경로로 답변에 남긴다.",
        "- 만들거나 바꾼 화면을 이름과 경로로 답변에 남깁니다.\n- 답변의 경로는 저장 전 그대로다.",
      ),
    );
    execFileSync("git", ["-C", worktree, "rm", "-q", "index.html"]);
    mkdirSync(join(worktree, "src", "screens", "new"), { recursive: true });
    writeFileSync(join(worktree, "src", "screens", "new", "New.screen.tsx"), "export {};\n");

    // The recount the same way the product triggers it: 최신화's wire path.
    await call({ type: "repo.refresh" }, 30000);
    await page.locator(".cstrip").waitFor({ timeout: 20000 });

    const countLine = await page.locator(".cstrip__count").innerText();
    check(
      "the strip counts what the chip counts",
      countLine.includes("3개"),
      countLine.replace(/\s+/g, " "),
    );
    const rows = page.locator(".cstrip__files .dfile");
    check("one row per changed file", (await rows.count()) === 3);
    for (const [selector, word] of [
      [".dfile__tag--modified", "수정"],
      [".dfile__tag--deleted", "삭제"],
      [".dfile__tag--added", "추가"],
    ]) {
      const tag = page.locator(`.cstrip__files ${selector}`).first();
      await tag.waitFor({ timeout: 5000 });
      check(`the ${word} row wears its word`, (await tag.innerText()).trim() === word);
    }
    const modifiedRow = page.locator(".cstrip__files .dfile", { hasText: "CLAUDE.md" }).first();
    const plus = await modifiedRow.locator(".plus").innerText();
    const minus = await modifiedRow.locator(".minus").innerText();
    check("sizes ride the row they belong to", plus === "+2" && minus === "−1", `${plus} ${minus}`);
    const addedRow = page.locator(".cstrip__files .dfile", { hasText: "New.screen.tsx" }).first();
    check(
      "an untracked row stays quiet about size",
      (await addedRow.locator(".plus").count()) === 0,
    );

    // The fold is the planner's gesture; the head stays as the floor's word.
    await page.locator(".cstrip__head").click();
    await sleep(100);
    check(
      "the fold hides the rows and keeps the count",
      (await page.locator(".cstrip__files").count()) === 0 &&
        (await page.locator(".cstrip__head").getAttribute("aria-expanded")) === "false",
    );
    await page.locator(".cstrip__head").click();
    await page.locator(".cstrip__files").waitFor({ timeout: 5000 });
    check("unfolding brings the rows back", (await rows.count()) === 3);

    // The suite's own picture: the strip listing what a 저장 would carry.
    await page.screenshot({ path: join(here, "ui-changed-strip-e2e.png"), fullPage: true });

    // And the strip only exists while there is something to list.
    await call({ type: "repo.discard" }, 60000);
    await page.waitForFunction(() => document.querySelector(".cstrip") === null, undefined, {
      timeout: 20000,
    });
    check("a clean tree after 버리기 draws no strip", true);

    check("no uncaught console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
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
