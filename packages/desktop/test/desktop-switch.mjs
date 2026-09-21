/**
 * Desktop switch suite — the native preview across a project switch, driven
 * end to end against the dev entry with Playwright _electron: two fixture
 * projects on two ports; leaving one and coming back shows the page the app
 * KEPT (a marker set in the page survives — no reload), the return is a
 * repaint's worth of time, and the pane's own facts (address bar) follow the
 * page on screen. The daemon side of the same promise (the
 * outgoing server stays warm) is projects-e2e's; this suite is the view's.
 *
 * Prerequisites: pnpm build (all four packages) — same as desktop-smoke.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
function stubClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      'if (args[0] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
      'if (args[0] === "auth") {',
      '  console.log(\'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"planner@example.com"}\');',
      "  process.exit(0);",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}
const inView = async (app, script) => {
  const outcome = await app.evaluate(
    async (_electronModule, { script: expression }) => {
      const contents = globalThis.coloDesignPlannerPreview?.webContents();
      if (!contents) return { error: "the preview view is gone" };
      try {
        return { value: await contents.executeJavaScript(expression) };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
    { script },
  );
  if (outcome && typeof outcome === "object" && "error" in outcome) {
    throw new Error(`in-view script failed: ${String(outcome.error)}`);
  }
  return outcome.value;
};
const viewUrl = (app) =>
  app.evaluate(() => globalThis.coloDesignPlannerPreview?.webContents()?.getURL() ?? null);

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = await predicate();
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // 함수 라벨은 던지는 순간의 상태를 담는다 — 호출 시점의 스냅샷은 기다림
  // 시작 전의 옛 상태라 원인을 말해 주지 못했다(CI 2026-09-21).
  const detail = typeof label === "function" ? JSON.stringify(await label()) : label;
  throw new Error(`timeout waiting for ${detail}`);
}

async function main() {
  buildDesktopBundle();

  const dir = join(tmpdir(), `colo-design-desktop-switch-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const alpha = await createFixtureRepo({
    dir: join(dir, "fixture-alpha"),
    port: await freePort(),
  });
  const beta = await createFixtureRepo({ dir: join(dir, "fixture-beta"), port: await freePort() });

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.COLO_DESIGN_REPO_DIR;
  delete env.COLO_DESIGN_REPO_URL;
  const app = await electron.launch({
    executablePath: join(desktop, "node_modules", ".bin", "electron"),
    args: [desktop],
    env: {
      ...env,
      COLO_DESIGN_PORT: String(await freePort()),
      COLO_DESIGN_REPO_SETTINGS: join(dir, "settings.json"),
      COLO_DESIGN_PROJECTS_SETTINGS: join(dir, "projects.json"),
      COLO_DESIGN_PROJECTS_DIR: join(dir, "projects"),
      COLO_DESIGN_DESKTOP_SMOKE: join(dir, "userData"),
      CLAUDE_CONFIG_DIR: join(dir, "claude-config"),
      COLO_DESIGN_CLAUDE_BIN: stubClaude(join(dir, "bin")),
      COLO_DESIGN_CREDENTIAL_STORE: "memory",
    },
  });

  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1720, height: 1000 });
    // 첫 실행 투어의 예시 창은 빈 대화마다 선다 — 이 스위트는 투어가 아니라
    // 그 아래의 화면을 본다. 창은 이미 로드됐으므로 시드 뒤 webContents 로 다시
    // 읽는다(page.goto/reload 는 webview 를 품은 이 창에서 load 를 기다리다
    // 멈춘다).
    await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      await win.webContents.executeJavaScript(
        'localStorage.setItem("colo-design.tour-step", "done")',
      );
      win.webContents.reload();
    });
    await page.waitForLoadState("domcontentloaded");
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.waitForLoadState("domcontentloaded");
    const daemon = new URL(page.url());
    const ws = new WebSocket(`ws://${daemon.host}?token=${daemon.searchParams.get("token")}`);
    const inbox = [];
    ws.addEventListener("message", (event) => inbox.push(JSON.parse(String(event.data))));
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    let nextId = 0;
    const request = async (message, timeoutMs = 60_000) => {
      nextId += 1;
      const id = `s${nextId}`;
      ws.send(JSON.stringify({ ...message, id }));
      const reply = await waitFor(() => inbox.find((m) => m.id === id), timeoutMs, message.type);
      if (reply.type === "ok") return reply.data;
      throw new Error(reply.message);
    };
    const waitReady = (label) =>
      waitFor(
        async () => {
          const current = await request({ type: "repo.status" });
          return current.phase === "ready" ? current : null;
        },
        60_000,
        label,
      );

    const a = await request({
      type: "project.create",
      name: "알파",
      repoUrl: alpha.remote,
      approveCommands: true,
    });
    await waitReady("알파 ready");
    const b = await request({
      type: "project.create",
      name: "베타",
      repoUrl: beta.remote,
      approveCommands: true,
    });
    const betaStatus = await waitReady("베타 ready");
    const betaOrigin = new URL(betaStatus.previewUrl).origin;
    const alphaOrigin = `http://127.0.0.1:${alpha.port}`;

    // The pane shows 베타 (the newest project is active). 홈 우선 워크스페이스
    // (2026-09) — 스레드를 열어야 무대(.planner__body)가 선다: ⌘T 가 새 대화
    // 자리를 연다(세션은 첫 입력 때 만들어진다).
    await page.waitForSelector(".planner__header", { timeout: 60000 });
    await page.keyboard.press("Meta+t");
    await page.waitForSelector(".planner__body", { timeout: 60000 });
    await waitFor(async () => (await viewUrl(app))?.startsWith(betaOrigin), 60_000, "베타 page");
    await waitFor(
      async () => (await inView(app, "document.readyState")) === "complete",
      30_000,
      "베타 loaded",
    );
    check("the pane shows the active project's page", true, await viewUrl(app));
    await inView(app, `window.__marker = "beta"; true`);

    // Switch to 알파: its page is created and loaded once.
    let t0 = Date.now();
    await request({ type: "project.activate", slug: a.slug });
    await waitFor(
      async () => (await viewUrl(app))?.startsWith(alphaOrigin),
      60_000,
      async () => ({
        wantAlpha: alphaOrigin,
        beta: betaOrigin,
        daemonRepo: await request({ type: "repo.status" }, 15_000).catch((error) => ({
          error: String(error),
        })),
        url: await viewUrl(app),
        webviews: await page.evaluate(() =>
          Array.from(document.querySelectorAll("webview")).map((w) => w.getAttribute("src")),
        ),
        project: await page.evaluate(
          () => document.querySelector(".planner__project")?.textContent ?? null,
        ),
        main: await app.evaluate(() => {
          const v = globalThis.coloDesignPlannerPreview;
          return {
            page: v?.page
              ? { home: v.page.home, origin: v.page.origin, mountedUrl: v.page.mountedUrl }
              : null,
            url: v?.webContents()?.getURL() ?? null,
          };
        }),
      }),
    );
    const firstSwitch = Date.now() - t0;
    await waitFor(
      async () => (await inView(app, "document.readyState")) === "complete",
      30_000,
      "알파 loaded",
    );
    await inView(app, `window.__marker = "alpha"; true`);
    check("switching shows the other project's page", true, `${firstSwitch}ms to the 알파 origin`);

    // Back to 베타: the kept page, exactly as left — the marker survives.
    t0 = Date.now();
    await request({ type: "project.activate", slug: b.slug });
    await waitFor(async () => (await viewUrl(app))?.startsWith(betaOrigin), 60_000, "베타 back");
    const backSwitch = Date.now() - t0;
    const betaMarker = await inView(app, "window.__marker ?? null");
    check(
      "coming back shows the kept page without a reload",
      betaMarker === "beta",
      `marker=${betaMarker} in ${backSwitch}ms`,
    );
    check("a warm return is fast", backSwitch < 1500, `${backSwitch}ms`);

    // And again to 알파.
    await request({ type: "project.activate", slug: a.slug });
    await waitFor(async () => (await viewUrl(app))?.startsWith(alphaOrigin), 60_000, "알파 back");
    const alphaMarker = await inView(app, "window.__marker ?? null");
    check("the other kept page also survives", alphaMarker === "alpha", `marker=${alphaMarker}`);

    // The address bar follows the page on screen (the replayed location).
    const address = await page.getByTestId("preview-address").inputValue();
    check("the address bar shows the page on screen", address.startsWith(alphaOrigin), address);
    // The datalist is gone — the address bar is the only door, and it
    // already shows the page on screen.

    check("no renderer errors", errors.length === 0, errors.slice(0, 3).join(" | "));
    ws.close();
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
