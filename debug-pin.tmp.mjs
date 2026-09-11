import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { createFixtureRepo, freePort } from "/Users/developjik/.paseo/worktrees/37blf94g/durable-spider/packages/daemon/test/fixture-repo.mjs";

const desktop = "/Users/developjik/.paseo/worktrees/37blf94g/durable-spider/packages/desktop";
const repo = "/Users/developjik/.paseo/worktrees/37blf94g/durable-spider";
function run(cmd, args, cwd) { const r = spawnSync(cmd, args, { stdio: "inherit", cwd }); if (r.status !== 0) process.exit(r.status ?? 1); }
const inView = async (app, script) => {
  const outcome = await app.evaluate(async (_e, { script }) => {
    const c = globalThis.cdsDesignPlannerPreview?.webContents();
    if (!c) return { error: "gone" };
    try { return { value: await c.executeJavaScript(script) }; } catch (e) { return { error: String(e) }; }
  }, { script });
  if (outcome && typeof outcome === "object" && "error" in outcome) throw new Error(String(outcome.error));
  return outcome.value;
};


function stubClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  writeFileSync(path, [
    "#!/bin/sh",
    'case "$1" in',
    '  --version) echo "1.0.0-stub"; exit 0;;',
    "  auth)",
    '    echo "{\\"loggedIn\\":true,\\"authMethod\\":\\"claude.ai\\",\\"subscriptionType\\":\\"team\\",\\"email\\":\\"p@x.com\"}"',
    "    exit 0;;",
    "esac",
    "exit 0",
  ].join("\n"));
  chmodSync(path, 0o755);
  return path;
}

const dir = join(tmpdir(), `cds-debug-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const fixture = await createFixtureRepo({ dir: join(dir, "fixture"), port: await freePort() });
const workRoot = join(dir, "work");
run("git", ["clone", "--quiet", fixture.remote, workRoot]);
const env = { ...process.env }; delete env.ANTHROPIC_API_KEY;
const app = await electron.launch({
  executablePath: join(desktop, "node_modules", ".bin", "electron"),
  args: [desktop],
  env: { ...env, CDS_DESIGN_PORT: String(await freePort()), CDS_DESIGN_REPO_DIR: workRoot, CDS_DESIGN_REPO_URL: fixture.remote,
    CDS_DESIGN_REPO_SETTINGS: join(dir, "settings.json"), CDS_DESIGN_PROJECTS_SETTINGS: join(dir, "projects.json"),
    CDS_DESIGN_PROJECTS_DIR: join(dir, "projects"), CLAUDE_CONFIG_DIR: join(dir, "cc"), CDS_DESIGN_CREDENTIAL_STORE: "memory", CDS_DESIGN_CLAUDE_BIN: stubClaude(join(dir, "bin")) },
});
try {
  const page = await app.firstWindow();
  await page.waitForSelector(".planner__body", { timeout: 60000 });
    await page.waitForSelector(".screenpanel__bar", { timeout: 120000 });
  const picker = page.getByRole("combobox", { name: "화면" });
  await picker.waitFor({ timeout: 60000 });
  await picker.selectOption({ label: "회원 목록" });
  await page.waitForTimeout(1500);
  // record a comment directly over the socket so a pin exists
  await page.evaluate(() => {
    return new Promise((ok) => {
      const url = document.querySelector("[data-testid=connect-info]")?.textContent;
      ok(url);
    }).catch(() => null);
  });
  // push pins through the bridge from the main side is not possible; instead record via daemon ws from page
  const pushed = await page.evaluate(async () => {
    const res = await fetch(window.location.href).catch(() => null); // no-op
    return true;
  });
  // Simulate the web push by calling the bridge directly in the main window:
  const okPush = await page.evaluate(() => {
    const bridge = window.cdsDesignDesktop?.preview;
    if (!bridge?.pins) return "no bridge";
    bridge.pins({ items: [{ id: "t1", screen: "member/MemberList", state: "default", text: "점 검사용", elementText: "회원 관리", element: { component: "h1", path: 'div[data-screen="member/MemberList"] > h1', rect: { x: 10, y: 10, width: 80, height: 24 } }, at: new Date().toISOString(), resolved: false }], attention: ["t1"] });
    return "pushed";
  });
  console.log("PUSH:", okPush);
  await page.waitForTimeout(500);
  console.log("DOT:", await inView(app, `Boolean(document.querySelector('[data-cds-design-overlay] [data-rpin]'))`));
  // toggle the state attribute in the page and see whether the dot re-filters
  await inView(app, `document.querySelector('[data-screen]').setAttribute('data-state', 'empty')`);
  await page.waitForTimeout(600);
  console.log("AFTER STATE CHANGE:", await inView(app, `JSON.stringify({
    state: document.querySelector('[data-screen]')?.getAttribute('data-state'),
    dots: document.querySelectorAll('[data-cds-design-overlay] [data-rpin]').length,
  })`));
  const clicked = await inView(app, `(() => { const d = document.querySelector('[data-cds-design-overlay] [data-rpin]'); if (!d) return "no dot"; d.click(); return "clicked"; })()`);
  console.log("CLICK:", clicked);
  await page.waitForTimeout(500);
  console.log("OVERLAY:", await inView(app, `document.querySelector('[data-cds-design-overlay]').innerText.slice(0, 300)`));
  console.log("BUTTONS:", await inView(app, `[...document.querySelectorAll('[data-cds-design-overlay] button')].map(b => b.textContent).join(" | ")`));
} finally {
  await app.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
