/**
 * Throwaway desktop repro: launch the Electron app (in-process daemon +
 * fixture repo + vite dev server), reach the workspace, open 더 보기, hover
 * 핀 — capture the exact surface from the user's screenshot.
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
import { _electron as electron } from "playwright";
import { createFixtureRepo, freePort } from "../../daemon/test/fixture-repo.mjs";

const DIR = join(tmpdir(), "colo-design-repro-desktop");
const WORK_ROOT = join(DIR, "work");
const VITE_PORT = 29991;

function writeStubClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  const script = [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
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
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "claude-config"), { recursive: true });
  const previewPort = await freePort();
  const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port: previewPort });

  // vite dev server for the renderer (the dev:hmr path)
  const vite = spawn("pnpm", ["--filter", "@colo-design/web", "exec", "vite", "--port", String(VITE_PORT), "--strictPort"], {
    cwd: join(__dirname, "..", "..", ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  vite.stderr.on("data", (d) => process.stderr.write(`[vite] ${d}`));
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("vite never became ready")), 30000);
    const tick = setInterval(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${VITE_PORT}/`);
        if (res.ok) { clearInterval(tick); clearTimeout(timer); ok(); }
      } catch { /* not up yet */ }
    }, 300);
  });

  const userData = join(DIR, "userdata");
  const env = {
    ...process.env,
    COLO_DESIGN_REPO_DIR: WORK_ROOT,
    COLO_DESIGN_REPO_URL: fixture.remote,
    COLO_DESIGN_REPO_SETTINGS: join(DIR, "settings.json"),
    COLO_DESIGN_PROJECTS_SETTINGS: join(DIR, "projects.json"),
    COLO_DESIGN_PROJECTS_DIR: join(DIR, "projects"),
    CLAUDE_CONFIG_DIR: join(DIR, "claude-config"),
    COLO_DESIGN_CLAUDE_BIN: writeStubClaude(join(DIR, "bin")),
    COLO_DESIGN_CREDENTIAL_STORE: "memory",
    COLO_DESIGN_DEV_SERVER: `http://127.0.0.1:${VITE_PORT}`,
    COLO_DESIGN_DESKTOP_SMOKE: userData,
    COLO_DESIGN_RUN_DIR: join(userData, "run"),
  };
  delete env.ANTHROPIC_API_KEY;

  const desktopDir = join(__dirname, "..", "..", "desktop");
  const app = await electron.launch({
    executablePath: join(desktopDir, "node_modules", ".bin", "electron"),
    args: [desktopDir],
    env,
  });
  process.on("exit", () => app.close().catch(() => undefined));

  try {
    const page = await app.firstWindow();
    page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
    await page.waitForSelector(".planner__work", { timeout: 60000 });
    console.log("planner up");

    // a small window like the user's
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setSize(1000, 470);
      w.center();
    });
    await page.waitForTimeout(800);

    // home (v3) first: try the rail's new-thread leaf, then the feed card,
    // then the project node — whatever opens a workspace.
    await page.waitForTimeout(1500);
    const leaf = page.locator(".leaf--start").first();
    if (await leaf.count()) {
      await leaf.click();
      console.log("clicked leaf--start");
    } else {
      const card = page.locator("text=연결 준비").first();
      if (await card.count()) {
        await card.click();
        console.log("clicked feed card");
      } else {
        await page.locator("text=내 프로젝트").first().click();
        console.log("clicked project node");
      }
    }
    try {
      await page.waitForSelector(".preview", { timeout: 300000 });
    } catch {
      console.error("BODY DUMP:", (await page.locator("body").innerText()).slice(0, 1200).replace(/\n+/g, " | "));
      throw new Error("preview never appeared");
    }
    await page.waitForTimeout(2500);
    await page.screenshot({ path: "/tmp/d-repro-1.png" });

    // pin mode on (the user's frame shows pin mode active: tip says 끕니다)
    const pinBtn = page.locator(".preview__widthbtn", { hasText: "핀" });
    console.log("pin button count:", await pinBtn.count());
    await pinBtn.click();
    await page.waitForTimeout(300);

    // open 더 보기
    await page.locator(".screenpanel__morebtn").click();
    await page.waitForSelector(".screenpanel__menu", { timeout: 5000 });
    await page.waitForTimeout(400); // let poprise finish
    await page.screenshot({ path: "/tmp/d-repro-2.png" });

    // hover the 핀 button while the menu is open
    await pinBtn.hover();
    await page.waitForTimeout(400);
    await page.screenshot({ path: "/tmp/d-repro-3.png" });

    const tips = await page.locator(".tip__bubble--shown").allInnerTexts();
    console.log("shown tips:", JSON.stringify(tips));

    const menuRect = await page.evaluate(() => {
      const m = document.querySelector(".screenpanel__menu");
      if (!m) return null;
      const r = m.getBoundingClientRect();
      const cs = getComputedStyle(m);
      return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, innerH: innerHeight, bg: cs.backgroundColor, opacity: cs.opacity, zIndex: cs.zIndex, position: cs.position };
    });
    console.log("menu rect:", JSON.stringify(menuRect));

    const rows = await page.locator(".screenpanel__menu .selector__row").evaluateAll((els) =>
      els.map((el) => ({
        label: el.querySelector(".selector__label")?.textContent ?? "",
        desc: el.querySelector(".selector__desc")?.textContent ?? "",
        ariaDisabled: el.getAttribute("aria-disabled"),
        bottom: el.getBoundingClientRect().bottom,
      })),
    );
    console.log("menu rows:", JSON.stringify(rows, null, 2));

    const bar = await page.locator(".screenpanel__bar").innerText();
    console.log("bar text:", JSON.stringify(bar));
    const toolbar = await page.locator(".preview__toolbar").innerText();
    console.log("toolbar text:", JSON.stringify(toolbar));
  } finally {
    await app.close().catch(() => undefined);
    vite.kill("SIGKILL");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
