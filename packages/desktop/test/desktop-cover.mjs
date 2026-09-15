/**
 * D65 의 덮개 — the native preview view must never paint over a layer the
 * planner opened. Three contracts, driven against the real app with
 * Playwright _electron:
 *
 *   ⓐ 순서 — `preview:cover` answers only AFTER the view is hidden. The ack
 *     IS the contract: the freeze capture rides behind it, so a resolved
 *     call means the stage is already gone. (The old order awaited a
 *     capture first and left the stage drawn over the modal for as long as
 *     it took — measured up to 751ms while a page was loading.)
 *   ⓑ 실경로 — ⌘, opens 설정 and the watcher's own wiring (the layer
 *     selector, the observer, the bridge) hides the view. ⓐ injects the
 *     class and calls the bridge by hand; only this one proves the wiring.
 *   ⓒ 창 재오픈 — ⌘W then the dock icon builds a NEW window. The pane
 *     outlives it: its page must be re-attached to the new window and the
 *     cover state of the dead renderer must not survive as a hidden pane.
 *
 * Prerequisites: pnpm build (all four packages) — same as desktop-smoke.
 * Run: node packages/desktop/test/desktop-cover.mjs
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { createFixtureRepo, freePort } from "../../daemon/test/fixture-repo.mjs";
import { buildDesktopBundle } from "./build-desktop.mjs";
import { closeApp } from "./close-app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "..");

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

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** The pane as main knows it: is the page on screen visible, and whose child is it? */
function paneState(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const view = globalThis.coloDesignPlannerPreview;
    const page = view?.page ?? null;
    const windows = BrowserWindow.getAllWindows().filter((one) => !one.isDestroyed());
    const window = windows[0] ?? null;
    return {
      covered: view?.covered ?? null,
      hasPage: Boolean(page),
      visible: page ? page.view.getVisible() : null,
      attached: Boolean(page && window?.contentView.children.includes(page.view)),
      windows: windows.length,
    };
  });
}

async function waitForPage(app, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const state = await paneState(app);
    if (state.hasPage && state.visible) return state;
    await sleep(300);
  }
  return paneState(app);
}

async function main() {
  buildDesktopBundle();

  const dir = join(tmpdir(), `colo-design-cover-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const fixture = await createFixtureRepo({
    dir: join(dir, "fixture"),
    port: await freePort(),
  });
  const workRoot = join(dir, "work");
  run("git", ["clone", "--quiet", fixture.remote, workRoot]);

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const app = await electron.launch({
    executablePath: join(desktop, "node_modules", ".bin", "electron"),
    args: [desktop],
    env: {
      ...env,
      COLO_DESIGN_PORT: String(await freePort()),
      COLO_DESIGN_REPO_DIR: workRoot,
      COLO_DESIGN_REPO_URL: fixture.remote,
      COLO_DESIGN_REPO_SETTINGS: join(dir, "settings.json"),
      COLO_DESIGN_PROJECTS_SETTINGS: join(dir, "projects.json"),
      COLO_DESIGN_PROJECTS_DIR: join(dir, "projects"),
      CLAUDE_CONFIG_DIR: join(dir, "claude-config"),
      COLO_DESIGN_CLAUDE_BIN: writeStubClaude(join(dir, "bin")),
      COLO_DESIGN_CREDENTIAL_STORE: "memory",
      COLO_DESIGN_DESKTOP_SMOKE: join(dir, "userdata"),
    },
  });

  try {
    let page = await app.firstWindow();
    await page.setViewportSize({ width: 1720, height: 1000 });
    await page.waitForSelector(".planner__body", { timeout: 60000 });
    await page.waitForSelector(".screenpanel__bar", { timeout: 60000 });
    const booted = await waitForPage(app);
    check(
      "미리보기 페이지가 화면에 올라온다",
      booted.hasPage && booted.visible === true,
      JSON.stringify(booted),
    );

    // --- ⓐ 순서: ack 는 "이미 숨겼다"는 뜻이다 ----------------------------
    await page.evaluate(() => {
      const layer = document.createElement("div");
      layer.className = "modal";
      layer.dataset.coverProbe = "1";
      document.body.appendChild(layer);
      return window.coloDesignDesktop.preview.cover(true);
    });
    const acked = await paneState(app);
    check(
      "ⓐ cover(true) 가 답한 시점에 뷰는 이미 숨어 있다",
      acked.visible === false && acked.covered === true,
      JSON.stringify(acked),
    );
    await page.evaluate(() => {
      document.querySelector("[data-cover-probe]")?.remove();
      return window.coloDesignDesktop.preview.cover(false);
    });
    const uncovered = await paneState(app);
    check(
      "ⓐ cover(false) 는 그 자리에서 뷰를 되돌린다",
      uncovered.visible === true,
      JSON.stringify(uncovered),
    );

    // --- ⓑ 실경로: ⌘, → 설정 모달 → 관찰자 → 브리지 ----------------------
    await page.keyboard.press("Meta+Comma");
    await page.waitForSelector(".modal", { timeout: 5000 });
    let hidden = null;
    const opened = Date.now();
    while (Date.now() - opened < 2000) {
      const state = await paneState(app);
      if (state.visible === false) {
        hidden = Date.now() - opened;
        break;
      }
      await sleep(20);
    }
    check("ⓑ ⌘, 로 연 설정 모달이 뷰를 덮는다", hidden !== null, `${hidden ?? "never"}ms`);

    // 모달이 떠 있는 내내 뷰는 돌아오지 않는다 — 스크린샷의 고착이 이 자리다.
    let stuck = false;
    for (let i = 0; i < 20; i++) {
      const state = await paneState(app);
      if (state.visible === true) stuck = true;
      await sleep(25);
    }
    check("ⓑ 모달이 떠 있는 동안 뷰가 다시 올라오지 않는다", !stuck);

    await page.keyboard.press("Escape");
    await page.waitForSelector(".modal", { state: "detached", timeout: 5000 });
    await sleep(200);
    const closed = await paneState(app);
    check("ⓑ 모달을 닫으면 뷰가 돌아온다", closed.visible === true, JSON.stringify(closed));

    // --- ⓒ 창 재오픈: pane 은 창보다 오래 산다 ----------------------------
    // 마지막 창을 닫고도 앱이 살아 있는 것은 mac 만의 계약이다 — main.ts 의
    // window-all-closed 는 darwin 이 아니면 app.quit() 하고, 되살릴 dock 아이콘
    // (activate)도 거기에만 있다. Linux CI 에서 이 구간은 이미 끝난 앱에
    // evaluate 를 걸어 "Target page, context or browser has been closed" 로
    // 죽었다 — 제품이 아니라 검사가 플랫폼을 잘못 가정한 자리였다. 배포
    // 대상인 mac 에서는 그대로 돌고, 나머지에서는 ⓐ·ⓑ 까지가 이 스위트다.
    if (process.platform === "darwin") {
      await page.keyboard.press("Meta+Comma");
      await page.waitForSelector(".modal", { timeout: 5000 });
      await sleep(300);
      await app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.close();
      });
      await sleep(800);
      await app.evaluate(({ app: electronApp }) => electronApp.emit("activate"));
      page = await app.waitForEvent("window", { timeout: 30000 });
      await page.waitForSelector(".planner__body", { timeout: 60000 });
      await page.waitForSelector(".screenpanel__bar", { timeout: 60000 });
      const reopened = await waitForPage(app);
      check(
        "ⓒ 재오픈한 창에 미리보기가 다시 붙고 보인다",
        reopened.attached === true && reopened.visible === true && reopened.covered === false,
        JSON.stringify(reopened),
      );

      // 새 창에서도 규약은 그대로 — 죽은 렌더러의 상태가 남지 않았다는 증거.
      await page.keyboard.press("Meta+Comma");
      await page.waitForSelector(".modal", { timeout: 5000 });
      let again = null;
      const reopenedAt = Date.now();
      while (Date.now() - reopenedAt < 2000) {
        const state = await paneState(app);
        if (state.visible === false) {
          again = Date.now() - reopenedAt;
          break;
        }
        await sleep(20);
      }
      check("ⓒ 재오픈 뒤에도 모달이 뷰를 덮는다", again !== null, `${again ?? "never"}ms`);
      await page.keyboard.press("Escape");
    } else {
      console.log("SKIP  ⓒ 창 재오픈 — 창을 모두 닫으면 앱이 끝나는 플랫폼이다 (mac 전용 계약)");
    }
  } finally {
    await closeApp(app);
  }

  const failed = results.filter((result) => !result.passed);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

await main();
