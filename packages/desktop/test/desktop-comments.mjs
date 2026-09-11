/**
 * Desktop comments suite (PLAN §1 — D78 · D79 · D80 · D86 · D87 · D89) — the
 * native preview path, driven end to end against the dev entry with
 * Playwright _electron: 핀은 모드 없이 ⌥+클릭으로 찍히고(ⓐ), ⏎ 보내기 로
 * 하나만 보내지며(ⓑ), 턴이 끝나도 화면 위에 남고(ⓒ) 새로 고침 뒤 같은
 * 요소에 다시 선다(ⓓ). 말풍선의 해결이 핀을 치우고(ⓔ), 화면(상태)을 옮기면
 * 그 곳의 핀만 보인다(ⓕ). 보낸 봉투는 요소의 crop 을 실어 온다(ⓖ), 턴 중에
 * 보내면 대기 줄이 보인다(ⓘ), 래퍼 없는 화면에서 ⌥+클릭은 말한다(ⓚ), 화면
 * 보여 주기는 카드가 되고(ⓛ) 같은 화면의 연타는 두 번째 요청으로 표식이
 * 붙는다(ⓜ).
 *
 * The main window's page is the planner UI; the VIEW's page is reached
 * through the main process (`globalThis.cdsDesignPlannerPreview`) because a
 * WebContentsView is not a window Playwright can adopt. What runs inside the
 * view is the real compiled preload — the overlay, the bridge door, the stale
 * detection — same as a packaged app.
 *
 * Prerequisites: pnpm build (all four packages) — same as desktop-smoke.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { createFixtureRepo, freePort } from "../../daemon/test/fixture-repo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "..");
const repo = join(desktop, "..", "..");

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

/**
 * The turn must really RUN for the pins to survive and settle — the stub
 * answers version/auth and sleeps on a comment turn, logging every line it
 * is fed so the suite can prove what Claude actually received.
 */
/**
 * The turn must really RUN for the pins to survive and settle — the stub
 * answers version/auth, scans the stdin it is fed (control requests first,
 * then the user line), lingers on a comment turn, and logs every line so the
 * suite can prove what Claude actually received. One turn per process: the
 * user line ends it, whatever its words.
 */
function slowStubClaude(dir, logPath) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      'const fs = require("fs");',
      "const args = process.argv.slice(2);",
      'if (args[0] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
      'if (args[0] === "auth") {',
      '  console.log(\'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"planner@example.com"}\');',
      "  process.exit(0);",
      "}",
      'const log = process.env.CDS_PROMPT_LOG;',
      'let buf = "";',
      'const seen = () => {',
      '  let idx;',
      '  while ((idx = buf.indexOf("\\n")) !== -1) {',
      '    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);',
      '    if (log) { try { fs.appendFileSync(log, line + "\\n"); } catch {} }',
      '    if (line.includes(\'"type":"user"\')) {',
      '      const sessionId = (line.match(/"session_id":"([^"]*)"/) || [])[1] || "stub";',
      '      process.stdout.write(JSON.stringify({',
      '        type: "result", subtype: "success", is_error: false,',
      '        session_id: sessionId, result: "알겠습니다.", num_turns: 1, duration_ms: 10,',
      '      }) + "\\n");',
      '      const linger = line.includes("화면 수정 요청") ? 2000 : 700;',
      '      setTimeout(() => process.exit(0), linger);',
      '      return;',
      '    }',
      '  }',
      '};',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { buf += chunk; seen(); });',
      'process.stdin.on("end", () => process.exit(0));',
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

/**
 * One step inside the view's page, through the main-process handle. Two
 * Playwright traps live here: `app.evaluate`'s callback receives the ELECTRON
 * MODULE first and the arg second, and a bare STRING arg means "evaluate
 * this as an expression" — the script rides an object, after the module.
 */
const inView = async (app, script) => {
  const outcome = await app.evaluate(async (_electronModule, { script: expression }) => {
    const contents = globalThis.cdsDesignPlannerPreview?.webContents();
    if (!contents) return { error: "the preview view is gone" };
    try {
      return { value: await contents.executeJavaScript(expression) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, { script });
  if (outcome && typeof outcome === "object" && "error" in outcome) {
    throw new Error(`in-view script failed: ${String(outcome.error)}`);
  }
  return outcome.value;
};

/** ⌥+클릭 (D79): a real MouseEvent with altKey — element.click() cannot carry it. */
const altClick = (app, selector) =>
  inView(
    app,
    `(function () {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!target) return false;
      target.dispatchEvent(new MouseEvent("click", {
        bubbles: true, cancelable: true, altKey: true, view: window,
      }));
      return true;
    })()`,
  );

const viewUrl = (app) =>
  app.evaluate(() => globalThis.cdsDesignPlannerPreview?.webContents()?.getURL() ?? null);

const recordedDot = (app) =>
  inView(app, `Boolean(document.querySelector('[data-cds-design-overlay] [data-rpin]'))`);

/** Waits for the recorded pin to (dis)appear — the overlay redraws on a 100ms cadence. */
async function waitForDot(app, wanted, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if ((await recordedDot(app)) === wanted) return true;
    await new Promise((ok) => setTimeout(ok, 250));
  }
  return false;
}

/** Waits until the overlay's draft editor is gone (the send cleared it). */
async function waitForDraftGone(app, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const there = await inView(app, `Boolean(document.querySelector('[data-cds-design-overlay] [data-pin]'))`);
    if (!there) return true;
    await new Promise((ok) => setTimeout(ok, 200));
  }
  return false;
}

async function main() {
  run("pnpm", ["--filter", "@cds-design/protocol", "build"], repo);
  run("pnpm", ["--filter", "@cds-design/daemon", "build"], repo);
  run("pnpm", ["--filter", "@cds-design/web", "build"], repo);
  run("pnpm", ["--filter", "@cds-design/desktop", "build"], repo);
  const webDist = join(desktop, "web-dist");
  rmSync(webDist, { recursive: true, force: true });
  mkdirSync(webDist, { recursive: true });
  cpSync(join(repo, "packages", "web", "dist"), webDist, { recursive: true });

  const dir = join(tmpdir(), `cds-design-desktop-comments-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const promptLog = "/tmp/cds-prompts.log";
  const fixture = await createFixtureRepo({ dir: join(dir, "fixture"), port: await freePort() });
  // The daemon's active project points here — a clone of the fixture remote,
  // the same shape ui-publish-e2e boots.
  const workRoot = join(dir, "work");
  run("git", ["clone", "--quiet", fixture.remote, workRoot]);

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const app = await electron.launch({
    executablePath: join(desktop, "node_modules", ".bin", "electron"),
    args: [desktop],
    env: {
      ...env,
      CDS_DESIGN_PORT: String(await freePort()),
      CDS_DESIGN_REPO_DIR: workRoot,
      CDS_DESIGN_REPO_URL: fixture.remote,
      CDS_DESIGN_REPO_SETTINGS: join(dir, "settings.json"),
      CDS_DESIGN_PROJECTS_SETTINGS: join(dir, "projects.json"),
      CDS_DESIGN_PROJECTS_DIR: join(dir, "projects"),
      CLAUDE_CONFIG_DIR: join(dir, "claude-config"),
      CDS_DESIGN_CLAUDE_BIN: slowStubClaude(join(dir, "bin"), promptLog),
      CDS_PROMPT_LOG: promptLog,
      CDS_DESIGN_CREDENTIAL_STORE: "memory",
    },
  });

  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1720, height: 1000 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

    await page.waitForSelector(".planner__body", { timeout: 60000 });
    await page.waitForSelector(".screenpanel__bar", { timeout: 60000 });
    check("the planner workspace renders with the fixture project", true);

    // --- the bridge speaks through the preload (D68) -----------------------
    const picker = page.getByRole("combobox", { name: "화면" });
    await picker.waitFor({ timeout: 60000 });
    await picker.selectOption({ label: "회원 목록" });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="preview-address"]')?.value === "/member/MemberList",
      { timeout: 30000 },
    );
    check("the view is on the fixture screen", true);

    // The overlay is ALWAYS there now (D79) — no mode needed to mount it.
    const overlayAlways = await inView(
      app,
      `Boolean(document.querySelector("[data-cds-design-overlay]"))`,
    );
    check("the overlay mounts without the comment mode", overlayAlways === true);

    // --- ⓐ 모드 꺼진 채 ⌥+클릭 — 초안 핀, 페이지 클릭은 죽는다 (D79) --------
    await inView(
      app,
      `(() => { window.__pageClicks = 0; document.addEventListener("click", () => { window.__pageClicks += 1; }); return true; })()`,
    );
    check("⌥+클릭 hit the element", (await altClick(app, "[data-screen] tbody td")) === true);
    const draftThere = await inView(
      app,
      `Boolean(document.querySelector('[data-cds-design-overlay] textarea[aria-label="핀 1 코멘트"]'))`,
    );
    const pageClicks = await inView(app, `window.__pageClicks`);
    check(
      "ⓐ mode OFF + ⌥+클릭 pins the element and the page never sees the click",
      draftThere === true && pageClicks === 0,
      `draft:${draftThere} pageClicks:${pageClicks}`,
    );

    // --- ⓑ 편집기 ⏎ 보내기 — 핀 하나만 즉시 (D80) ---------------------------
    await inView(
      app,
      `(() => {
        const input = document.querySelector('textarea[aria-label="핀 1 코멘트"]');
        input.value = "이름 열을 가입일 역순으로 정렬해 주세요.";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const send = [...document.querySelectorAll("[data-cds-design-overlay] button")]
          .find((b) => (b.textContent || "").includes("보내기"));
        send.click();
        return true;
      })()`,
    );
    check("ⓑ the draft editor's ⏎ 보내기 cleared the draft", (await waitForDraftGone(app)) === true);
    const card = page.locator(".machine--comments");
    await card.waitFor({ timeout: 30000 });
    const cardText = await card.innerText();
    check(
      "the transcript shows the 수정 요청 card",
      cardText.includes("수정 요청 1건") && cardText.includes("이름 열을 가입일 역순으로"),
      cardText.split("\n")[0],
    );

    // --- ⓖ 봉투가 shot 을 실어 온다 (D87): the card draws the crop ----------
    const thumb = page.locator(".machine--comments .machine__thumb");
    await thumb.waitFor({ timeout: 15000 });
    const shotOk = await page.evaluate(async () => {
      const img = document.querySelector(".machine--comments .machine__thumb");
      if (!img) return "no img";
      const decode = img.cloneNode();
      decode.src = img.src;
      await new Promise((ok, fail) => {
        decode.onload = ok;
        decode.onerror = fail;
      });
      return {
        jpeg: img.src.startsWith("data:image/jpeg;base64,/9j/"),
        width: decode.naturalWidth,
        height: decode.naturalHeight,
      };
    });
    check(
      "ⓖ the envelope's shot is a JPEG crop, long side ≤ 600",
      typeof shotOk === "object" && shotOk.jpeg && Math.max(shotOk.width, shotOk.height) <= 600,
      JSON.stringify(shotOk),
    );

    // --- ⓒ 턴이 끝나도 핀은 남는다 (D78) — 기록된 핀(accent 점)이 선다 ------
    // The turn settles when the composer's 중지 button goes back to 보내기.
    await page.locator(".toolbar__stop").waitFor({ state: "detached", timeout: 30000 });
    check("the carrying turn settled", true);
    check("ⓒ the recorded pin still stands after the turn ends", (await waitForDot(app, true)) === true);

    // --- ⓓ 새로 고침 뒤 같은 요소에 다시 (D78 — did-navigate resend) --------
    await page.getByRole("button", { name: "미리보기 새로 고침" }).click();
    await page.waitForTimeout(1200);
    check("ⓓ after a reload the pin re-stands", (await waitForDot(app, true)) === true);

    // --- ⓔ 점 클릭 → 말풍선 → 해결 → 핀 사라짐 (D78) ------------------------
    async function clickWhenThere(app, findScript, timeout = 8000) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const clicked = await inView(
          app,
          `(function () {
            const node = (${findScript});
            if (!node) return false;
            node.click();
            return true;
          })()`,
        );
        if (clicked === true) return true;
        await new Promise((ok) => setTimeout(ok, 250));
      }
      return false;
    }
    check(
      "the recorded dot is clickable",
      (await clickWhenThere(app, `document.querySelector('[data-cds-design-overlay] [data-rpin] > button')`)) === true,
    );
    const bubble = await inView(
      app,
      `Boolean([...document.querySelectorAll("[data-cds-design-overlay] button")]
        .find((b) => b.textContent === "해결"))`,
    );
    check("the dot's bubble offers 해결", bubble === true);
    check(
      "해결 is clickable",
      (await clickWhenThere(
        app,
        `[...document.querySelectorAll("[data-cds-design-overlay] button")]
          .find((b) => b.textContent === "해결")`,
      )) === true,
    );
    check("ⓔ 해결 clears the pin from the screen", (await waitForDot(app, false)) === true);
    // the popover side: 해결된 것 보기 reveals the grey row (D78)
    await page.locator(".screenpanel__bar").getByRole("button", { name: "더 보기" }).click();
    await page.getByRole("menuitem", { name: "코멘트 목록" }).click();
    const dialog = page.locator('[role="dialog"][aria-label="코멘트 기록"]');
    await dialog.waitFor({ timeout: 5000 });
    const beforeShow = await dialog.locator(".diff__file").count();
    await dialog.getByText("해결된 것 보기").click();
    const afterShow = await dialog.locator(".diff__file").count();
    check(
      "해결된 것 보기 reveals the resolved row",
      beforeShow === 0 && afterShow === 1,
      `${beforeShow} → ${afterShow}`,
    );
    await dialog.getByRole("button", { name: "코멘트 기록 닫기" }).click();

    // --- ⓕ 화면(상태)을 옮기면 그 곳의 핀만 (D78 — screen·state filter) -----
    await altClick(app, "[data-screen] h1");
    await inView(
      app,
      `(() => {
        const input = document.querySelector('textarea[aria-label^="핀"]');
        input.value = "제목을 두 줄로 줄여 주세요";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const park = [...document.querySelectorAll("[data-cds-design-overlay] button")]
          .find((b) => b.textContent === "담아 두기");
        park.click();
        return true;
      })()`,
    );
    // 담아 두기 parked it; the bar sends the parked batch (D80).
    await inView(
      app,
      `(() => {
        const send = [...document.querySelectorAll("[data-cds-design-overlay] button")]
          .find((b) => (b.textContent || "").includes("수정 요청 1건 보내기"));
        if (!send) return false;
        send.click();
        return true;
      })()`,
    );
    await page.locator(".machine--comments").last().waitFor({ timeout: 30000 });
    // The turn settles before the state switch (the stub answers one turn per
    // process; a queued message would only confuse what follows).
    await page.locator(".toolbar__stop").waitFor({ state: "detached", timeout: 30000 });
    check("ⓕ the default-state pin stands", (await waitForDot(app, true)) === true);

    // Switch the state — the pin belongs to default, so it leaves the screen.
    await page.getByRole("group", { name: "상태" }).getByRole("button", { name: "비어 있음" }).click();
    check("ⓕ the empty state hides the default-state pin", (await waitForDot(app, false)) === true);
    await page.getByRole("group", { name: "상태" }).getByRole("button", { name: "기본" }).click();
    check("ⓕ coming back reveals it again", (await waitForDot(app, true)) === true);

    // --- ⓚ 래퍼 없는 화면의 ⌥+클릭은 말한다 (D89) ---------------------------
    await inView(
      app,
      `(() => {
        const wrapper = document.querySelector("[data-screen]");
        wrapper.removeAttribute("data-screen");
        return true;
      })()`,
    );
    await altClick(app, "h1");
    const told = await inView(
      app,
      `Boolean([...document.querySelectorAll("[data-cds-design-overlay] div")]
        .find((n) => (n.textContent || "").includes("이 화면에는 핀을 붙일 수 없습니다")))`,
    );
    const pinsWhileNaked = await inView(
      app,
      `document.querySelectorAll("[data-cds-design-overlay] [data-pin]").length`,
    );
    check(
      "ⓚ a wrapper-less ⌥+클릭 toasts and pins nothing",
      told === true && pinsWhileNaked === 0,
      `told:${told} pins:${pinsWhileNaked}`,
    );
    await inView(
      app,
      `(() => {
        const wrapper = document.querySelector("#app > div");
        wrapper.setAttribute("data-screen", "member/MemberList");
        return true;
      })()`,
    );

    // --- ⓛ 화면 보여 주기 (D89) ---------------------------------------------
    await page.getByRole("button", { name: "이 화면 Claude 에게 보여 주기" }).click();
    await page
      .getByLabel("화면 보여 주기에 덧붙이는 말")
      .fill("가운데 정렬이 풀려 있어요");
    await page.locator(".frame__lookform").getByRole("button", { name: "보내기" }).click();
    const lookCard = page.locator(".machine--error").last();
    await lookCard.waitFor({ timeout: 30000 });
    const lookText = await lookCard.innerText();
    check("ⓛ the look turn renders as 화면 보여 주기", lookText.includes("화면 보여 주기"), lookText.split("\n")[0]);
    // The card's 자세히 fold shows the turn body — the exact words Claude reads.
    await lookCard.getByRole("button", { name: "자세히" }).click();
    const lookBody = await lookCard.locator(".machine__body").innerText();
    check(
      "ⓛ the look body carries the sentence and the planner's line",
      lookBody.includes("이 화면이 이렇게 보입니다") && lookBody.includes("가운데 정렬이 풀려 있어요"),
      lookBody.slice(0, 80),
    );

    // --- ⓜ 연타 가드, 그리고 두 번째 요청 (D89) -----------------------------
    // The first look's turn is still running — exactly the state the 연타
    // guard is for: the repeat must be BLOCKED with the toast, not doubled.
    await page.getByRole("button", { name: "이 화면 Claude 에게 보여 주기" }).click();
    await page.locator(".frame__lookform").getByRole("button", { name: "보내기" }).click();
    const blocked = await page
      .locator(".notice--info")
      .innerText()
      .catch(() => "(none)");
    check(
      "ⓜ a mid-turn repeat is blocked with 이미 보냈습니다",
      blocked.includes("이미 보냈습니다"),
      blocked,
    );
    await page.locator(".toolbar__stop").click();
    await page.locator(".toolbar__stop").waitFor({ state: "detached", timeout: 30000 });
    // Settled: the real repeat carries the 두 번째 요청 mark.
    await page.getByRole("button", { name: "이 화면 Claude 에게 보여 주기" }).click();
    await page.locator(".frame__lookform").getByRole("button", { name: "보내기" }).click();
    await page
      .waitForFunction(() => document.querySelectorAll(".machine--error").length >= 2, undefined, { timeout: 30000 });
    const againText = await page.locator(".machine--error").last().innerText();
    check(
      "ⓜ the repeat after settle says 두 번째 요청",
      againText.includes("2번째 요청"),
      againText.split("\n")[0],
    );

    await page.locator(".machine--comments").last().waitFor({ timeout: 30000 });
    // While the turn runs, send one more pin — the wait-line must appear (D86).
    check("ⓘ-setup second pin accepted mid-turn", (await altClick(app, "[data-screen] p")) === true);
    await inView(
      app,
      `(() => {
        const input = document.querySelector('textarea[aria-label^="핀"]');
        if (!input) return false;
        input.value = "설명 문장은 반영해 주세요";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        [...document.querySelectorAll("[data-cds-design-overlay] button")]
          .find((b) => (b.textContent || "").includes("보내기")).click();
        return true;
      })()`,
    );
    const queuedLine = page.locator(".composer__queued");
    await queuedLine.waitFor({ timeout: 15000 });
    const queuedText = await queuedLine.innerText();
    check(
      "ⓘ a mid-turn send shows the wait-line",
      queuedText.includes("대기"),
      queuedText,
    );
    // The stub CLI serves one turn per process, so the queued message cannot
    // complete here — 중지 is the planner's way out, and the wait-line must go
    // with it (D86), no error band left behind (결함①).
    await page.locator(".toolbar__stop").click();
    await queuedLine.waitFor({ state: "detached", timeout: 15000 });
    check(
      "ⓘ 중지 clears the wait-line without an error band",
      (await page.locator(".notice--error").count()) === 0,
    );

    await page.locator(".toolbar__stop").waitFor({ state: "detached", timeout: 30000 }).catch(() => {});

    // --- the address bar's line (D66) — kept from the previous suite --------
    const foreign = page.locator('[data-testid="preview-address"]');
    await foreign.fill("https://example.com");
    await foreign.press("Enter");
    await page.waitForSelector(".frame__addrerror", { timeout: 5000 });
    const refused = await page.locator(".frame__addrerror").innerText();
    const urlAfter = await viewUrl(app);
    check(
      "another origin is refused in place",
      refused.includes("미리보기 서버 안의 주소만") &&
        typeof urlAfter === "string" &&
        urlAfter.includes("member/MemberList"),
      `${refused} · ${urlAfter ?? ""}`,
    );

    check("no uncaught renderer errors", errors.length === 0, errors.slice(0, 2).join(" | "));
    await page.screenshot({ path: join(here, "desktop-comments.png"), fullPage: true });
  } finally {
    await app.close().catch(() => undefined);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
