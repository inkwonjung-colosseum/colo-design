/**
 * Browser-level check of the first-run wizard (DESIGN §8, PLAN M1), fully
 * offline.
 *
 * The daemon boots with no project at all, against a local fixture repo and
 * the recorded onboarding Confluence fixtures, so the wizard blocks the
 * workspace and the test drives the exact sequence a 기획자 would: connect
 * Confluence, then name a project, point it at a Confluence location and a
 * repo, and start. The project step is the one that used to be "연결 레포" —
 * a repo only means something once a project says which.
 *
 * Prerequisites: `pnpm build` (daemon + web dist)
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createFixtureRepo, freePort } from "../../daemon/test/fixture-repo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const daemonEntry = join(repoRoot, "packages", "daemon", "dist", "index.js");
const webDist = join(repoRoot, "packages", "web", "dist");
const DIR = join(tmpdir(), "drafthouse-onboard-ui-e2e");
const PORT = 5401;

const REPO_PAT = "onboard_ui_pat";
const API_TOKEN = "onboard_ui_token";

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") {
    throw new Error(`check("${name}") was called without a verdict`);
  }
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function serveDist() {
  const server = createServer((req, res) => {
    const requested = (req.url ?? "/").split("?")[0];
    let file = join(webDist, requested === "/" ? "index.html" : requested);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(webDist, "index.html");
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(PORT, "127.0.0.1", () => ok(server)));
}

async function main() {
  if (!existsSync(webDist)) throw new Error("web dist missing. Run: pnpm --filter @drafthouse/web build");
  if (!existsSync(daemonEntry)) throw new Error("daemon dist missing. Run: pnpm --filter @drafthouse/daemon build");

  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port: await freePort() });

  const env = {
    ...process.env,
    DRAFTHOUSE_PORT: String(await freePort()),
    DRAFTHOUSE_REPO_DIR: join(DIR, "work"),
    DRAFTHOUSE_REPO_SETTINGS: join(DIR, "repo.json"),
    // The registry decides what "the repo" and "the mirror" mean, so it has to
    // live in the throwaway directory too: a previous run's projects.json
    // would otherwise hand this daemon a deleted fixture remote.
    DRAFTHOUSE_PROJECTS_SETTINGS: join(DIR, "projects.json"),
    DRAFTHOUSE_PROJECTS_DIR: join(DIR, "projects"),
    // Deliberately NO repo url and NO confluence credentials: the wizard must
    // block, then unblock through its own inputs.
    DRAFTHOUSE_CONFLUENCE_DIR: join(DIR, "mirror"),
    DRAFTHOUSE_CONFLUENCE_SETTINGS: join(DIR, "confluence.json"),
    DRAFTHOUSE_CONFLUENCE_FIXTURE: join(
      repoRoot,
      "packages",
      "daemon",
      "test",
      "fixtures",
      "confluence",
      "onboarding",
    ),
    DRAFTHOUSE_CREDENTIAL_STORE: "memory",
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

  const stepStatus = (id) =>
    page.locator(`.onboarding__step:has(h2:text-is("${id === "repo" ? "연결 레포" : id === "confluence" ? "Confluence" : id}")) .onboarding__status`).innerText();

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
    await page.getByRole("button", { name: "연결" }).click();

    // --- 1. the wizard blocks the first run --------------------------------
    await page.waitForSelector(".onboarding", { timeout: 20000 });
    check("the first run opens the wizard, not the tabs", true);
    await page
      .waitForFunction(
        () => document.querySelectorAll(".onboarding__step").length === 4,
        undefined,
        { timeout: 30000 },
      )
      .catch(() => undefined);
    const stepTitles = await page.locator(".onboarding__stephead h2").allInnerTexts();
    check(
      "the four gates are listed in order, with the project last",
      JSON.stringify(stepTitles) === JSON.stringify(["Claude Code", "git", "Confluence", "프로젝트"]),
      stepTitles.join(" · "),
    );
    check(
      "the workspace stays closed while a step fails",
      (await page.locator(".planner__body").count()) === 0,
    );

    // --- 2. Confluence is machine-wide: the credentials are the whole gate --
    // Mirroring moved to the project, so this step passes on authentication
    // alone and never warns about an empty mirror.
    await page.getByLabel("Confluence 사이트 주소").fill("https://example.atlassian.net");
    await page.getByLabel("Confluence 이메일").fill("dev@example.com");
    await page.getByLabel("Confluence API 토큰").fill(API_TOKEN);
    await page.getByRole("button", { name: "연결 확인" }).click();
    await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll(".onboarding__step")].some(
            (step) =>
              step.querySelector("h2")?.textContent === "Confluence" &&
              step.classList.contains("onboarding__step--pass"),
          ),
        undefined,
        { timeout: 30000 },
      )
      .catch(() => undefined);
    check(
      "authenticating Confluence passes its gate without mirroring anything",
      (await stepStatus("confluence")) === "통과",
      await stepStatus("confluence"),
    );
    check(
      "the workspace is still closed — there is no project yet",
      (await page.locator(".planner__body").count()) === 0,
    );

    // --- 3. the project: a name, a Confluence location, a repo -------------
    await page.getByLabel("프로젝트 이름").fill("결제");
    await page.getByLabel("기획서가 있는 스페이스").selectOption("ENG");
    // The root picker reads the space's pages straight from Confluence. The
    // fixture space is empty, so 스페이스 전체 is the only choice and this
    // project owns the whole space — the subtree path is covered daemon-side.
    await page.getByLabel("기획서가 있는 상위 페이지").waitFor({ timeout: 20000 });
    await page.getByLabel("연결 레포 주소").fill(fixture.remote);
    await page.getByLabel("연결 레포 개인 액세스 토큰").fill(REPO_PAT);
    await page.getByRole("button", { name: "프로젝트 만들기" }).click();

    // The wizard is replaced by the one workspace; the page tree is the first
    // thing in it, so its presence is what "opened" means now.
    await page.waitForSelector(".planner__body .pagetree", { timeout: 90000 });
    check("creating the project opens the workspace", true);
    check(
      "the switcher names the project the planner just made",
      (await page.locator(".project .selector__chip").innerText()).includes("결제"),
    );
    // The switcher is also the only way to reach a second project, so it has
    // to be a real menu even with one — a bare label was a dead end.
    await page.locator(".project .selector__chip").click();
    check(
      "and offers a way to start another one",
      (await page.locator(".selector__row", { hasText: "새 프로젝트" }).count()) === 1,
    );
    await page.keyboard.press("Escape");

    // A brand new project has an empty subtree, and every column used to say
    // so in its own words while offering no way forward (PLAN D14). One
    // invitation now, and the composer opens ready to answer it.
    const firstDoc = page.locator(".firstdoc");
    await firstDoc.waitFor({ timeout: 15000 });
    check(
      "an empty project offers one way in, not three dead ends",
      (await firstDoc.getByRole("button", { name: "첫 기획서 만들기" }).count()) === 1,
      (await firstDoc.innerText()).split("\n")[0] ?? "",
    );
    await firstDoc.getByRole("button", { name: "첫 기획서 만들기" }).click();
    const composer = page.locator(".composer textarea");
    await composer.waitFor({ timeout: 15000 });
    // Creating the thread is a round trip to the daemon, which has to start a
    // Claude session before the strip has a tab to show.
    await page
      .locator(".sessiontab--on")
      .waitFor({ timeout: 30000 })
      .catch(() => undefined);
    check(
      "it opens a 기획 thread with the first turn written but not sent",
      (await composer.inputValue()).includes("새 기획서를 하나 만들어 주세요") &&
        (await page.locator(".bubble--user").count()) === 0,
      `draft=${JSON.stringify(await composer.inputValue())} tabs=${await page
        .locator(".sessiontab")
        .count()} on=${await page.locator(".sessiontab--on").count()}`,
    );

    check(
      "the secrets never reached the browser",
      !JSON.stringify(await page.evaluate(() => localStorage)).includes(REPO_PAT) &&
        !JSON.stringify(await page.evaluate(() => localStorage)).includes(API_TOKEN),
    );
    await page.screenshot({ path: join(here, "ui-onboarding-done.png") });
  } finally {
    await browser.close();
    server.close();
    daemon.kill("SIGKILL");
    rmSync(DIR, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0 || errors.length > 0) {
    if (errors.length > 0) console.error(`Console errors: ${errors.join(" | ")}`);
    console.error(`Failed: ${failed.map((r) => r.name).join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  rmSync(DIR, { recursive: true, force: true });
  process.exit(1);
});
