/**
 * Throwaway repro: boot daemon + fixture repo + built web UI, reach the
 * workspace, open the 더 보기 menu, hover the 핀 button, screenshot.
 * Mirrors packages/web/test/ui-publish-e2e.mjs bootstrapping.
 */
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { createFixtureRepo, freePort } from "/Users/developjik/.paseo/worktrees/37blf94g/durable-spider/packages/daemon/test/fixture-repo.mjs";

const run = promisify(execFile);
const REPO = "/Users/developjik/.paseo/worktrees/37blf94g/durable-spider";
const daemonEntry = join(REPO, "packages", "daemon", "dist", "index.js");
const webDist = join(REPO, "packages", "web", "dist");
const DIR = join(tmpdir(), "colo-design-repro");
const WORK_ROOT = join(DIR, "work");
const PORT = 5497;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
function serveDist() {
  const server = createServer((req, res) => {
    const requested = (req.url ?? "/").split("?")[0];
    let file = join(webDist, requested === "/" ? "index.html" : requested);
    if (!existsSync(file) || statSync(file).isDirectory())
      file = join(webDist, "index.html");
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(PORT, "127.0.0.1", () => ok(server)));
}

function writeStubClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  const script = [
    "#!/usr/bin/env node",
    'const args = process.argv.slice(2);',
    'if (args[0] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
    'if (args[0] === "auth") {',
    '  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "team", email: "planner@example.com" }));',
    "  process.exit(0);",
    "}",
    'const INIT = { type: "system", subtype: "init", session_id: "stub", tools: [], mcp_servers: [], model: "stub", permissionMode: "default", slash_commands: [], agents: [] };',
    'const RESULT = { type: "result", subtype: "success", is_error: false, session_id: "stub", total_cost_usd: 0, duration_ms: 10, num_turns: 1, result: "알겠습니다" };',
    'let buf = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => {',
    "  buf += chunk;",
    "  let idx;",
    '  while ((idx = buf.indexOf("\\n")) !== -1) {',
    "    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);",
    "    let o = null; try { o = JSON.parse(line); } catch { continue; }",
    '    if (o.type === "control_request") {',
    "      process.stdout.write(JSON.stringify({ type: \"control_response\", response: { subtype: \"success\", request_id: o.request_id } }) + \"\\n\");",
    "      continue;",
    "    }",
    '    if (o.type === "user") {',
    '      process.stdout.write(JSON.stringify(INIT) + "\\n");',
    '      process.stdout.write(JSON.stringify(RESULT) + "\\n");',
    "    }",
    "  }",
    "});",
    "",
  ].join("\n");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

async function main() {
  const { rmSync } = await import("node:fs");
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "claude-config"), { recursive: true });
  const previewPort = await freePort();
  const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port: previewPort });

  const env = {
    ...process.env,
    COLO_DESIGN_PORT: String(await freePort()),
    COLO_DESIGN_REPO_DIR: WORK_ROOT,
    COLO_DESIGN_REPO_URL: fixture.remote,
    COLO_DESIGN_REPO_SETTINGS: join(DIR, "settings.json"),
    COLO_DESIGN_PROJECTS_SETTINGS: join(DIR, "projects.json"),
    COLO_DESIGN_PROJECTS_DIR: join(DIR, "projects"),
    CLAUDE_CONFIG_DIR: join(DIR, "claude-config"),
    COLO_DESIGN_CLAUDE_BIN: writeStubClaude(join(DIR, "bin")),
    COLO_DESIGN_CREDENTIAL_STORE: "memory",
    COLO_DESIGN_DEV_SERVER: `http://127.0.0.1:${PORT}`,
  };
  delete env.ANTHROPIC_API_KEY;
  const daemon = spawn(process.execPath, [daemonEntry], { env, stdio: ["ignore", "pipe", "pipe"] });
  daemon.stderr.on("data", (d) => process.stderr.write(`[daemon] ${d}`));
  process.on("exit", () => daemon.kill("SIGKILL"));
  const daemonUrl = await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("daemon never printed a url")), 20000);
    let buffered = "";
    daemon.stdout.on("data", (chunk) => {
      buffered += String(chunk);
      const m = buffered.match(/client url: (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); ok(m[1]); }
    });
  });

  const server = await serveDist();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 560 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
    await page.getByRole("button", { name: "연결" }).click();
    await page.waitForSelector(".planner__work", { timeout: 60000 });
    await page.locator(".leaf--start").first().click();
    await page.waitForSelector(".planner__body:not(.planner__empty)", { timeout: 60000 });
    await page.waitForSelector(".screenpanel__bar", { timeout: 60000 });
    await page.waitForSelector(".preview", { timeout: 120000 });
    console.log("workspace reached");

    // give the preview pane its iframe content if it loads one
    await page.waitForTimeout(2500);
    await page.screenshot({ path: "/tmp/repro-1-workspace.png" });

    // open the 더 보기 menu
    await page.locator(".screenpanel__morebtn").click();
    await page.waitForSelector(".screenpanel__menu", { timeout: 5000 });
    await page.screenshot({ path: "/tmp/repro-2-menu.png" });

    // hover the 핀 button with the menu open (the user's frame)
    await page.locator(".preview__widthbtn", { hasText: "핀" }).hover();
    await page.waitForTimeout(400);
    await page.screenshot({ path: "/tmp/repro-3-menu-plus-pintip.png" });

    // pin tip text as rendered
    const tips = await page.locator(".tip__bubble--shown").allInnerTexts();
    console.log("shown tips:", JSON.stringify(tips));

    // menu rows as rendered
    const rows = await page.locator(".screenpanel__menu .selector__row").evaluateAll((els) =>
      els.map((el) => ({
        label: el.querySelector(".selector__label")?.textContent ?? "",
        desc: el.querySelector(".selector__desc")?.textContent ?? "",
        ariaDisabled: el.getAttribute("aria-disabled"),
        rect: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom }; })(),
      })),
    );
    console.log("menu rows:", JSON.stringify(rows, null, 2));

    const win = await page.evaluate(() => ({
      innerW: innerWidth,
      innerH: innerHeight,
      menuBottom: document.querySelector(".screenpanel__menu")?.getBoundingClientRect().bottom ?? null,
    }));
    console.log("viewport/menu:", JSON.stringify(win));

    // bar + toolbar structure dump for comparison
    const bar = await page.locator(".screenpanel__bar").innerText();
    console.log("bar text:", JSON.stringify(bar));
    const toolbar = await page.locator(".preview__toolbar").innerText();
    console.log("toolbar text:", JSON.stringify(toolbar));

    console.log("page errors:", JSON.stringify(errors));
  } finally {
    await browser.close();
    server.close();
    daemon.kill("SIGKILL");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
