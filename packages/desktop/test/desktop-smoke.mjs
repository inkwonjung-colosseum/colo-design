/**
 * Desktop smoke — Playwright _electron against the DEV entry: the window
 * opens, the in-process daemon answers /health on its ephemeral port, the
 * renderer lands on the planner UI (onboarding wizard on a fresh machine),
 * and the update bridge answers. `PACKAGED_APP=<path>` points this at the
 * unpackaged electron-builder output instead (the packaged smoke).
 *
 * Usage: node packages/desktop/test/desktop-smoke.mjs [appPath]
 * Run: node packages/desktop/test/desktop-smoke.mjs release/mac-arm64/CDS Design.app/Contents/MacOS/CDS Design
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { closeApp } from "./close-app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "..");
const repo = join(desktop, "..", "..");
const packagedApp = process.argv[2] ?? process.env.PACKAGED_APP ?? null;

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") {
    throw new Error(`check("${name}") was called without a verdict`);
  }
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function main() {
  let appPath = packagedApp;

  if (!packagedApp) {
    run("pnpm", ["--filter", "@cds-design/protocol", "build"], repo);
    run("pnpm", ["--filter", "@cds-design/daemon", "build"], repo);
    run("pnpm", ["--filter", "@cds-design/web", "build"], repo);
    run("pnpm", ["--filter", "@cds-design/desktop", "build"], repo);
    const webDist = join(desktop, "web-dist");
    rmSync(webDist, { recursive: true, force: true });
    mkdirSync(webDist, { recursive: true });
    cpSync(join(repo, "packages", "web", "dist"), webDist, { recursive: true });
    appPath = desktop; // electron CLI runs the project dir with its main
  } else if (!existsSync(packagedApp)) {
    throw new Error(`packaged app not found: ${packagedApp}`);
  }

  // 데스크톱은 자기 userData 아래에서만 흔적을 남긴다(키체인·설정 오염 방지).
  const userData = join(tmpdir(), `cds-design-desktop-smoke-${Date.now()}`);
  const electronBinary = packagedApp
    ? undefined
    : join(desktop, "node_modules", ".bin", "electron");

  const app = await electron.launch({
    ...(electronBinary ? { executablePath: electronBinary, args: [appPath] } : { executablePath: appPath }),
    env: {
      ...process.env,
      // 온보딩 게이트를 통과시킬 stub — 실제 로그인/네트워크 없이.
      CDS_DESIGN_CLAUDE_BIN: stubClaude(join(userData, "bin")),
      CDS_DESIGN_CREDENTIAL_STORE: undefined,
      CDS_DESIGN_DESKTOP_SMOKE: "1",
    },
  });

  try {
    const window = await app.firstWindow();
    check("a window opens", Boolean(window));

    // 첫 창은 화면 작업 영역을 채운다 — 고정 크기는 큰 모니터에서 조그맣다.
    const [bounds, workArea] = await app.evaluate(({ BrowserWindow, screen }) => {
      const display = screen.getPrimaryDisplay();
      return [BrowserWindow.getAllWindows()[0]?.getBounds(), display.workArea];
    });
    check(
      "the first window fills the display work area",
      // 창 관리자는 축마다 1px 을 떼어 간다(xvfb 러너: 1279x1023 vs
      // 1280x1024). 여기서 보는 것은 '작업 영역을 채운다' 이지 픽셀 동일성이
      // 아니므로, 두 축에 같은 허용치를 준다.
      Boolean(bounds) && workArea.width - bounds.width <= 1 && workArea.height - bounds.height <= 1,
      bounds ? `${bounds.width}x${bounds.height} vs ${workArea.width}x${workArea.height}` : "no window",
    );

    // The renderer loaded from the daemon itself with a token — no connect screen.
    const url = window.url();
    check(
      "the renderer loads from the in-process daemon with a token",
      /^http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(url),
      url.replace(/token=\w+/, "token=***"),
    );

    const health = await window.evaluate(async (pageUrl) => {
      const response = await fetch(new URL("/health", pageUrl).toString());
      return response.json();
    }, url);
    check("the daemon /health answers on the internal port", health.ok === true, `protocol v${health.protocolVersion}`);

    await window.waitForSelector(".planner", { timeout: 30000 });
    check("the planner shell renders", (await window.locator(".planner").count()) === 1);
    await window.waitForSelector(".onboarding", { timeout: 30000 });
    check("a fresh machine lands on the onboarding wizard", (await window.locator(".onboarding").count()) === 1);

    // The wizard's gates run against the daemon the app hosts; the same
    // check answers over the WebSocket the renderer itself uses. The
    // runtime gate resolves node through the app's bundled runtime first,
    // so its detail names what the repo's commands would actually run —
    // "(앱에 포함됨)" when the bundle is present, the system node when not.
    const runtimeStep = await window.evaluate(
      (pageUrl) =>
        new Promise((ok, fail) => {
          const ws = new WebSocket(
            pageUrl.replace(/^http/, "ws").replace(/\?token=/, "?token="),
          );
          const id = `smoke-${Date.now()}`;
          const timer = setTimeout(() => fail(new Error("onboarding.check timed out")), 60000);
          ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "onboarding.check", id })));
          ws.addEventListener("message", (event) => {
            const reply = JSON.parse(String(event.data));
            if (reply.id !== id) return;
            clearTimeout(timer);
            ws.close();
            reply.type === "ok"
              ? ok(reply.data.find((step) => step.id === "runtime") ?? null)
              : fail(new Error(reply.message));
          });
          ws.addEventListener("error", () => fail(new Error("socket refused")));
        }),
      window.url(),
    );
    check(
      "onboarding.check reports a passing runtime gate naming its node",
      runtimeStep !== null &&
        runtimeStep.status === "pass" &&
        runtimeStep.detail.startsWith("Node.js "),
      runtimeStep ? runtimeStep.detail : "(no runtime step)",
    );

    const bridge = await window.evaluate(() => Boolean(window.cdsDesignDesktop));
    check("the desktop update bridge is exposed to the renderer", bridge);

    const errors = [];
    window.on("pageerror", (error) => errors.push(error.message));
    window.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await window.waitForTimeout(1500);
    const meaningful = errors.filter(
      (text) => !/favicon|net::ERR|Failed to load resource/i.test(text),
    );
    check("no console errors", meaningful.length === 0, meaningful.slice(0, 2).join(" | "));

    await closeApp(app);
  } finally {
    await closeApp(app);
    rmSync(userData, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

/** 온보딩 게이트용 stub CLI(버전·로그인만 답하고 나머지는 조용히 끝낸다). */
function stubClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  --version) echo "1.0.0-smoke"; exit 0;;',
      "  auth)",
      '    echo "{\\"loggedIn\\":true,\\"authMethod\\":\\"claude.ai\\",\\"subscriptionType\\":\\"team\\",\\"email\\":\\"planner@example.com\\"}"',
      "    exit 0;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

main().catch((error) => {
  console.error(`\nDESKTOP SMOKE ERROR: ${error.message}`);
  process.exit(2);
});
