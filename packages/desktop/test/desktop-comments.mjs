/**
 * Desktop comments suite (재설계 1단계 — 핀은 첨부, 문장은 컴포저; PLAN D67 · D78 ·
 * D79 · D86 · D87 · D89 · 자동 정리) — the native preview path, driven end to end
 * against the dev entry with Playwright _electron: 핀은 모드 없이 ⌥+클릭으로 찍혀
 * 컴포저 트레이의 행이 되고(ⓐ), 문장과 함께 한 턴으로 나간다(ⓑ), 보낸 핀은 그
 * 자리에서 화면을 떠난다(ⓒ) — 새로 고침 뒤에도 보내지 않은 핀의 배지는 돌아온다
 * (ⓓ). 보낸 코멘트는 대화에서 소비된다 — 도구에 되읽는 목록은 없고, 저장소는
 * 넘길 때 개발자가 읽을 본문의 재료로만 남는다(ⓔ).
 * 화면(상태)을 옮겨도 핀 행은 살아 남는다(ⓕ). 크롭과 rect 는 찍는 순간의 것이다
 * (ⓖ'), 턴 중에 보내면 대기 줄이 보인다(ⓘ), 래퍼 없는 페이지에서도 ⌥+클릭은 핀을
 * 남기고 그 경로가 화면 id 가 된다(ⓚ), 화면 보여 주기는 카드가 되고(ⓛ) 같은 화면의
 * 연타는 두 번째 요청으로 표식이 붙는다(ⓜ).
 * 핀은 컴포저의 하나의 submit 을 탄다 — 와이어의 줄이 영수증이다(기준 5).
 * 거부된 전송의 보존(수용 기준 2)은 계획 먼저와 함께 이 파일에서 자리를 비웠다
 * — 아래 그 자리의 주석이 왜, 무엇이 있어야 돌아오는지 말한다.
 *
 * The main window's page is the planner UI; the VIEW's page is reached
 * through the main process (`globalThis.coloDesignPlannerPreview`) because a
 * WebContentsView is not a window Playwright can adopt. What runs inside the
 * view is the real compiled preload — the overlay, the bridge door —
 * same as a packaged app.
 *
 * Prerequisites: pnpm build (all four packages) — same as desktop-smoke.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * The turn must really RUN for the pins to survive and settle — the stub
 * answers version/auth, scans the stdin it is fed (control requests first,
 * then the user line), lingers on a comment turn, and logs every line so the
 * suite can prove what Claude actually received. One turn per process: the
 * user line ends it, whatever its words. A look turn (화면 보여 주기) never
 * answers on its own — a real CLI keeps reading the screen until told to
 * stop, the suite's mid-turn checks (연타 가드 · 대기줄) need the turn to RUN,
 * and 중지 is how every look turn ends here — and an interrupt is answered
 * the way the real CLI closes a stopped turn.
 *
 * set_permission_mode is the one control request the daemon AWAITS at session
 * birth (전부 맡기기 now survives reload, so the branch is real): left
 * unanswered it wedged startSession forever and the comment envelope never
 * reached this CLI. Answering it — and only it — keeps every other request as
 * pending as the real SDK leaves it in this suite.
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
      "const log = process.env.COLO_PROMPT_LOG;",
      'let buf = "";',
      'let sessionId = "stub";',
      "const seen = () => {",
      "  let idx;",
      '  while ((idx = buf.indexOf("\\n")) !== -1) {',
      "    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);",
      "    // 헤더의 약속(모든 줄을 기록)을 이행한다 — 수용 기준 5 의 영수증은",
      "    // 이 로그의 줄 순서다: set_permission_mode 요청이 핀 턴보다 먼저다.",
      "    try {",
      '      if (log) fs.appendFileSync(log, line + "\\n");',
      "    } catch {}",
      '    if (line.includes(\'"subtype":"set_permission_mode"\')) {',
      '      const id = (line.match(/"request_id":"([^"]*)"/) || [])[1];',
      "      // 거부 주입 (커밋 게이트 §3.12-2): the marker file primes ONE error",
      "      // answer — 계획 먼저가 그 거부를 submit 안으로 나르던 도구였다.",
      "      // 지금은 부르는 자리가 없다(아래 §3.12 수용 기준 2 의 빈 자리를",
      "      // 보라). 문은 열어 둔다: 거부를 다시 꽂을 길이 생기면 표식 하나로",
      "      // 돌아온다.",
      "      let refuse = false;",
      "      try {",
      "        const flag = process.env.COLO_REFUSE_MODE_FLAG;",
      "        if (flag && fs.existsSync(flag)) {",
      "          fs.unlinkSync(flag);",
      "          refuse = true;",
      "        }",
      "      } catch {}",
      "      process.stdout.write(JSON.stringify({",
      '        type: "control_response",',
      '        response: { subtype: refuse ? "error" : "success", request_id: id },',
      '      }) + "\\n");',
      "      continue;",
      "    }",
      '    if (line.includes(\'"subtype":"interrupt"\')) {',
      '      const id = (line.match(/"request_id":"([^"]*)"/) || [])[1];',
      "      process.stdout.write(JSON.stringify({",
      '        type: "control_response",',
      '        response: { subtype: "success", request_id: id },',
      '      }) + "\\n");',
      "      process.stdout.write(JSON.stringify({",
      '        type: "result", subtype: "error_during_execution", is_error: true,',
      '        session_id: sessionId, result: "interrupted", num_turns: 1, duration_ms: 5,',
      '      }) + "\\n");',
      "      setTimeout(() => process.exit(0), 200);",
      "      return;",
      "    }",
      '    if (line.includes(\'"type":"user"\')) {',
      '      sessionId = (line.match(/"session_id":"([^"]*)"/) || [])[1] || sessionId;',
      '      const look = line.includes("이 화면이 이렇게 보입니다");',
      '      const comment = line.includes("미리보기에서 가리킨 요소");',
      "      if (look) {",
      "        // A real CLI keeps looking at the screen until it is told to",
      "        // stop — the suite's mid-turn checks (연타 가드 · 대기줄) need a",
      "        // turn that RUNS, and 중지 is how every look turn ends here.",
      "        return;",
      "      }",
      "      // A real CLI answers pending control requests BEFORE the turn's",
      "      // result. The SDK flushes a set_permission_mode with this very",
      "      // user message (기준 5 경로), so its line lands a chunk later:",
      "      // defer the result a beat — answering the control request AFTER",
      "      // the result wedges the daemon's awaited promise forever.",
      "      const sid = sessionId;",
      "      const linger = comment ? 8000 : 700;",
      "      setTimeout(() => {",
      "        process.stdout.write(JSON.stringify({",
      '          type: "result", subtype: "success", is_error: false,',
      '          session_id: sid, result: "알겠습니다.", num_turns: 1, duration_ms: 10,',
      '        }) + "\\n");',
      "        setTimeout(() => process.exit(0), linger);",
      "      }, 400);",
      "      continue;",
      "    }",
      "  }",
      "};",
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
  app.evaluate(() => globalThis.coloDesignPlannerPreview?.webContents()?.getURL() ?? null);

/** The badges the overlay still draws, by their labels (`핀 1 (보냄)`). */
const pinLabels = (app) =>
  inView(
    app,
    `Array.from(document.querySelectorAll('[data-colo-design-overlay] [data-pin]'))
       .map((node) => node.getAttribute("aria-label"))
       .join(" · ")`,
  );

/**
 * Waits until the overlay carries no pin at all. 자동 정리 left the overlay
 * holding drafts only — there is no recorded-pin element to look for any
 * more, so "nothing came back" and "the pin left" are the same question.
 *
 * A timeout answers with what is STILL there: (보냄) means the grey ghost
 * outlived its turn (the web never dismissed it), a plain badge means an
 * unsent pin — two different bugs that used to reach CI as the same
 * verdictless `false`.
 */
async function waitForNoPin(app, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (!(await pinLabels(app))) return "";
    await new Promise((ok) => setTimeout(ok, 250));
  }
  return (await pinLabels(app)) || "(gone at the last look)";
}

/**
 * Waits until the overlay draws a badge again — the web's pin list is the
 * truth, and after a reload the sync re-anchors it (재설계 C5).
 */
async function waitForPin(app, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const there = await inView(
      app,
      `Boolean(document.querySelector('[data-colo-design-overlay] [data-pin]'))`,
    );
    if (there) return true;
    await new Promise((ok) => setTimeout(ok, 250));
  }
  return false;
}

/**
 * Clears the pin tray, however many re-renders swallow a single click — a
 * × that lands mid re-render removes nothing, and a planner would simply
 * click again.
 */
async function clearTray(page, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if ((await page.locator(".pintray__row").count()) === 0) return true;
    await page
      .locator(".pintray__row")
      .first()
      .getByRole("button", { name: /지우기/ })
      .click()
      .catch(() => {});
    await new Promise((ok) => setTimeout(ok, 300));
  }
  return (await page.locator(".pintray__row").count()) === 0;
}

async function main() {
  buildDesktopBundle();

  const dir = join(tmpdir(), `colo-design-desktop-comments-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const promptLog = "/tmp/colo-prompts.log";
  const fixture = await createFixtureRepo({
    dir: join(dir, "fixture"),
    port: await freePort(),
  });
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
      COLO_DESIGN_PORT: String(await freePort()),
      COLO_DESIGN_REPO_DIR: workRoot,
      COLO_DESIGN_REPO_URL: fixture.remote,
      COLO_DESIGN_REPO_SETTINGS: join(dir, "settings.json"),
      COLO_DESIGN_PROJECTS_SETTINGS: join(dir, "projects.json"),
      COLO_REFUSE_MODE_FLAG: join(dir, "bin", "refuse-mode.flag"),
      COLO_DESIGN_PROJECTS_DIR: join(dir, "projects"),
      COLO_DESIGN_DESKTOP_SMOKE: join(dir, "userData"),
      CLAUDE_CONFIG_DIR: join(dir, "claude-config"),
      COLO_DESIGN_CLAUDE_BIN: slowStubClaude(join(dir, "bin"), promptLog),
      COLO_PROMPT_LOG: promptLog,
      COLO_DESIGN_CREDENTIAL_STORE: "memory",
    },
  });

  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1720, height: 1000 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.waitForSelector(".planner__body", { timeout: 60000 });
    await page.waitForSelector(".screenpanel__bar", { timeout: 60000 });
    check("the planner workspace renders with the fixture project", true);

    // --- the bridge speaks through the preload (D68) -----------------------
    // The picker is gone; the address bar is the screens' door. The bridge's
    // arrival shows as the datalist filling with the declared route.
    const address = page.getByTestId("preview-address");
    await address.waitFor({ timeout: 60000 });
    await page.waitForFunction(
      () =>
        Boolean(document.querySelector('#colo-frame-routes option[value="/member/MemberList"]')),
      { timeout: 60000 },
    );
    await address.click();
    await address.fill("/member/MemberList");
    await address.press("Enter");
    await page.waitForFunction(
      () =>
        // the bar shows the full address now; the fixture port is dynamic, so
        // the route is matched at the end of the value
        (document.querySelector('[data-testid="preview-address"]')?.value ?? "").endsWith(
          "/member/MemberList",
        ),
      { timeout: 30000 },
    );
    check("the view is on the fixture screen", true);

    // The overlay is ALWAYS there now (D79) — no mode needed to mount it.
    const overlayAlways = await inView(
      app,
      `Boolean(document.querySelector("[data-colo-design-overlay]"))`,
    );
    check("the overlay mounts without the comment mode", overlayAlways === true);

    // --- ⓐ 모드 꺼진 채 ⌥+클릭 — 핀은 컴포저 트레이의 행이 된다 (재설계 C1) --
    await inView(
      app,
      `(() => { window.__pageClicks = 0; document.addEventListener("click", () => { window.__pageClicks += 1; }); return true; })()`,
    );
    check("⌥+클릭 hit the element", (await altClick(app, "[data-screen] tbody td")) === true);
    // The row is the main window's composer; the badge is the view's overlay.
    const trayRow = page.locator(".pintray__row");
    await trayRow.waitFor({ timeout: 15000 });
    const badgeThere = await waitForPin(app);
    const pageClicks = await inView(app, `window.__pageClicks`);
    check(
      "ⓐ mode OFF + ⌥+클릭 pins the element and the page never sees the click",
      (await trayRow.count()) === 1 && badgeThere === true && pageClicks === 0,
      `rows:${await trayRow.count()} badge:${badgeThere} pageClicks:${pageClicks}`,
    );

    // The pin lands with the caret already in its memo field (재설계 C1):
    // a planner who just clicked an element is about to describe it, and a
    // second click to reach the box is a second click for every pin they make.
    let caretThere = false;
    const caretDeadline = Date.now() + 5000;
    while (Date.now() < caretDeadline && !caretThere) {
      caretThere = await page.evaluate(
        () => document.activeElement?.classList.contains("pintray__note") === true,
      );
      if (!caretThere) await new Promise((ok) => setTimeout(ok, 200));
    }
    check("the new pin's memo field holds the caret", caretThere === true);

    // --- ⓑ 문장과 한 턴으로 (재설계 C2) --------------------------------------
    await page.locator(".pintray__note").first().fill("이름 열을 가입일 역순으로 정렬해 주세요.");
    const composer = page.getByLabel("메시지");
    await composer.click();
    await composer.fill("가입일 순서도 한 번 봐 주세요.");
    await composer.press("Enter");

    // --- 가장자리 핀: 배지는 뷰포트 밖으로 나가지 않는다 --------------------
    // 뷰포트 오른쪽 끝의 요소를 ⌥+클릭한다 — 배지는 클램프 없이는 반쯤 잘린다.
    // 확인 뒤 이 핀은 트레이에서 지워 뒤 단계를 건드리지 않는다.
    const edgePinned = await inView(
      app,
      `(function () {
        for (const y of [140, 240, 360, 480]) {
          const target = document.elementFromPoint(window.innerWidth - 24, y);
          if (!target || target.closest("[data-colo-design-overlay]")) continue;
          target.dispatchEvent(new MouseEvent("click", {
            bubbles: true, cancelable: true, altKey: true, view: window,
          }));
          return target.tagName;
        }
        return null;
      })()`,
    );
    const edgeBox = await inView(
      app,
      `(function () {
        const wrap = document.querySelector("[data-colo-design-overlay] [data-pin]");
        if (!wrap) return null;
        const box = wrap.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          vw: window.innerWidth,
          vh: window.innerHeight,
        };
      })()`,
    );
    check(
      "a pin at the viewport's right edge keeps its editor inside",
      typeof edgePinned === "string" &&
        edgeBox !== null &&
        typeof edgeBox === "object" &&
        edgeBox.left >= 0 &&
        edgeBox.right <= edgeBox.vw &&
        edgeBox.top >= 0 &&
        edgeBox.bottom <= edgeBox.vh,
      JSON.stringify({ edgePinned, edgeBox }),
    );
    // 행이 하나라는 것만으로는 어느 하나인지 모른다: 보낸 핀 ⓑ 가 아직
    // 트레이를 떠나지 않은 순간에도 하나이고, 그때 비우면 방금 찍은 가장자리
    // 핀은 비운 뒤에 도착해 화면에 남는다(ⓒ 가 그 잔상을 잡아 CI 를 붉게 한
    // 판이 이것이다). 메모가 빈 행 하나 — 즉 ⓑ 는 떠났고 가장자리 핀은 왔다.
    await page.waitForFunction(() => {
      const rows = Array.from(document.querySelectorAll(".pintray__row"));
      return rows.length === 1 && rows[0].querySelector(".pintray__note")?.value === "";
    });
    check("the edge pin leaves via its tray button", (await clearTray(page)) === true);
    const card = page.locator(".machine--comments");
    await card.waitFor({ timeout: 30000 });
    const cardText = await card.innerText();
    check(
      "the transcript shows the 수정 요청 card with the sentence",
      cardText.includes("수정 요청 1건") &&
        cardText.includes("이름 열을 가입일 역순으로") &&
        cardText.includes("가입일 순서도 한 번 봐 주세요."),
      cardText.split("\n")[0],
    );

    // --- M5 회귀: 핀이 연 스레드는 하나, 그리고 도구가 지은 이름이다 -------
    // 이 전송은 열린 대화 없이 시작된다 — create 가 지은 스레드가 코멘트를
    // 받아야 한다. 옛 결함은 두 번째 이름 없는 스레드가 실어 가고, 이름 있는
    // 첫 스레드는 빈 채 목록에 남았다.
    const threadRow = page.locator(".leaf[data-thread-id]").first();
    await threadRow.waitFor({ timeout: 15000 });
    await threadRow.locator(".leaf__title", { hasText: "회원 목록" }).waitFor({ timeout: 15000 });
    const threadCount = await page.locator(".leaf[data-thread-id]").count();
    check(
      "the pin opened exactly one thread, named after the screen",
      threadCount === 1,
      `threads:${threadCount}`,
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

    // --- ⓒ 자동 정리: 보낸 핀은 그 자리에서 화면을 떠난다 -------------------
    // The turn settles when the composer's 중지 button goes back to 보내기.
    await page.locator(".toolbar__stop").waitFor({ state: "detached", timeout: 30000 });
    check("the carrying turn settled", true);
    const leftBehind = await waitForNoPin(app);
    check("ⓒ the sent pin left the screen at once", leftBehind === "", `still:${leftBehind}`);

    // --- ⓓ 새로 고침 뒤에도 보내지 않은 핀은 돌아온다 (재설계 C5) ------------
    // The web's list outlives the page — sessionStorage holds it, and the
    // sync re-anchors the badge once the reloaded page reports its location.
    await altClick(app, "[data-screen] tbody td");
    await page.locator(".pintray__row").waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "미리보기 새로 고침" }).click();
    await page.waitForTimeout(1200);
    check("ⓓ after a reload the unsent pin's badge returns", (await waitForPin(app)) === true);
    check("ⓓ' the reloaded pin clears on demand", (await clearTray(page)) === true);

    // --- ⓖ' 크롭과 rect 는 찍는 순간의 것이다 (재설계 C4) --------------------
    // The old flow re-measured at send, so a pin written while the planner
    // kept reading photographed the element's NEW slot. Now the crop rides
    // the pin: what the planner SAW is what Claude gets.
    const pinnedY = await inView(
      app,
      `(() => {
        const h1 = document.querySelector("[data-screen] h1");
        return Math.round(h1.getBoundingClientRect().y);
      })()`,
    );
    await altClick(app, "[data-screen] h1");
    await page.locator(".pintray__row").waitFor({ timeout: 15000 });
    await inView(
      app,
      `(() => {
        document.querySelector("[data-screen] h1").style.marginTop = "160px";
        return true;
      })()`,
    );
    // Where the element sits by send time — the number the rect must NOT be.
    const movedY = await inView(
      app,
      `Math.round(document.querySelector("[data-screen] h1").getBoundingClientRect().y)`,
    );
    await page.locator(".pintray__note").first().fill("제목 글씨를 키워 주세요");
    const movedComposer = page.getByLabel("메시지");
    await movedComposer.click();
    await movedComposer.press("Enter");
    // The SECOND card, once it exists: `.last()` on a list that has not grown
    // yet is the FIRST card, and its rect would quietly answer the question.
    const cards = page.locator(".machine--comments");
    const cardDeadline = Date.now() + 30000;
    while (Date.now() < cardDeadline && (await cards.count()) < 2) {
      await new Promise((ok) => setTimeout(ok, 250));
    }
    const movedCard = cards.nth(1);
    await movedCard.waitFor({ timeout: 5000 });
    await movedCard.getByRole("button", { name: "자세히" }).click();
    const movedBody = await movedCard.locator(".machine__body").innerText();
    const sentY = Number(movedBody.match(/rect \d+,(\d+)/)?.[1] ?? -1);
    check(
      "the sent rect is where the element was PINNED, not where it drifted",
      movedY > pinnedY && Math.abs(sentY - pinnedY) <= 2,
      `pinned:${pinnedY} moved:${movedY} sent:${sentY}`,
    );
    await page.locator(".toolbar__stop").waitFor({ state: "detached", timeout: 30000 });
    await inView(
      app,
      `(() => { document.querySelector("[data-screen] h1").style.marginTop = ""; return true; })()`,
    );

    // --- ⓔ 보낸 코멘트는 대화에서 소비된다 — 도구에 목록은 없다 --------------
    // 핀은 턴으로 나가 대화록의 카드가 되고, 저장소의 유일한 독자는 개발자가
    // 읽을 풀 리퀘스트 본문이다. 그래서 더 보기 ▾ 에는 코멘트 항목이 없고,
    // 기록이 정말 남았는지는 파일이 답한다.
    // 막대에는 이름이 겹치는 단추가 둘이다 — 사이클 상태의 `더 보기`(카드)와
    // 화면 메뉴의 `더 보기 ▾`. 이 검사가 묻는 것은 후자이므로 클래스로 집는다.
    await page.locator(".screenpanel__bar .screenpanel__morebtn").click();
    const menu = page.locator(".screenpanel__menu");
    await menu.waitFor({ timeout: 5000 });
    const commentRows = await menu.getByRole("menuitem", { name: /코멘트/ }).count();
    check(
      "ⓔ 더 보기 ▾ 에 보낸 코멘트를 되읽는 자리는 없다",
      commentRows === 0,
      (await menu.getByRole("menuitem").allInnerTexts()).join(" | "),
    );
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached", timeout: 5000 });
    const storeSlug = JSON.parse(readFileSync(join(dir, "projects.json"), "utf8")).projects[0].slug;
    const storeFile = join(dir, "projects", storeSlug, "comments.json");
    let storedRows = [];
    const storeDeadline = Date.now() + 5000;
    while (Date.now() < storeDeadline && storedRows.length !== 2) {
      try {
        storedRows = JSON.parse(readFileSync(storeFile, "utf8"));
      } catch {
        storedRows = [];
      }
      if (storedRows.length !== 2) await new Promise((ok) => setTimeout(ok, 250));
    }
    check(
      "ⓔ 두 번의 전송이 넘길 때 읽힐 저장소에 두 행으로 남는다",
      storedRows.length === 2 && storedRows.every((row) => row.resolved === true),
      JSON.stringify(storedRows.map((row) => [row.screen, row.resolved])),
    );

    // --- ⓕ 화면(상태)을 옮겨도 핀 행은 살아 남는다 (재설계 C5) ---------------
    await altClick(app, "[data-screen] h1");
    await page.locator(".pintray__row").waitFor({ timeout: 15000 });
    await page.locator(".pintray__note").first().fill("제목을 두 줄로 줄여 주세요");
    // Switch the state — the row keeps its pin and re-words its where-line;
    // the tray is the truth, the badge only projects the screen it sits on.
    await page
      .getByRole("group", { name: "상태" })
      .getByRole("button", { name: "비어 있음" })
      .click();
    await page.waitForTimeout(600);
    const whereText = await page.locator(".pintray__where").first().innerText();
    const rowSurvives = (await page.locator(".pintray__row").count()) === 1;
    check(
      "ⓕ the state switch keeps the pin row with its own state",
      rowSurvives === true && whereText.includes("기본"),
      `row:${rowSurvives} where:${whereText}`,
    );
    // §3.10 ⓕ · 커미티 차단 4: while the OTHER state is on, the badge hides —
    // the row keeps saying `회원 목록 · 기본` and the screen must not
    // contradict it by re-anchoring the same CSS path on the error view.
    const badgesOnOtherState = await inView(
      app,
      `document.querySelectorAll('[data-colo-design-overlay] [data-pin]').length`,
    );
    check(
      "ⓕ the state switch hides the badge that belongs to another state",
      badgesOnOtherState === 0,
      `badges:${badgesOnOtherState}`,
    );
    await page.getByRole("group", { name: "상태" }).getByRole("button", { name: "기본" }).click();
    await page.waitForTimeout(600);
    check("ⓕ back on its own state the badge returns", (await waitForPin(app)) === true);

    // --- 래퍼가 통째로 바뀌어도 핀 행은 남는다 (재설계 C5) -------------------
    // A router replaces the screen wrapper instead of rewriting its
    // attributes. The overlay's anchor dies with the old node — the next
    // sync re-anchors by path — and the web's row never blinked.
    await inView(
      app,
      `(() => {
        const wrapper = document.querySelector("[data-screen]");
        wrapper.replaceWith(wrapper.cloneNode(true));
        return true;
      })()`,
    );
    await page.waitForTimeout(600);
    check(
      "a swapped screen wrapper keeps the pin's row",
      (await page.locator(".pintray__row").count()) === 1,
    );
    check("the swapped wrapper's pin clears on demand", (await clearTray(page)) === true);

    // --- 거부된 전송의 e2e 자리는 계획 먼저와 함께 비었다 (§3.12 수용 기준 2) --
    // 이 자리에는 "거부된 전송은 말·핀·배지를 지키고 경고 띠 하나로 말한다"
    // 가 있었다. 그 거부를 실선에 꽂던 도구가 계획 먼저였다 — 그 칩만이
    // submit 안에 제어 요청(set_permission_mode)을 무조건 하나 넣었고,
    // 스텁은 그것을 error 로 받아 전송을 실패시켰다. 칩이 빠르게로 바뀌면서
    // (빠르게는 눌리는 즉시 나가지 submit 을 타지 않는다) 그 한 걸음이
    // 사라졌고, 남은 길 — 죽은 질의를 되살리는 전송 — 은 이 하네스에서
    // 결정적이지 않다: 크래시 뒤 앱이 다음 전송보다 먼저 스스로 되살려서
    // 보내기가 기다릴 제어 요청이 남지 않는다(실측: 거부 표식은 소비되지
    // 않고 turn 만 나갔다).
    //
    // 그래서 여기서는 억지 벡터를 만들지 않고 자리를 비워 둔다. 다시 채우려면
    // 전송을 결정적으로 거부할 문이 먼저 필요하다 — 스텁이 유저 턴 자체를
    // 거부할 수 있게 하거나, 데몬에 시험용 거부 문을 두거나.

    // A FRESH thread (⌘T) for the next criterion: the resurrected session
    // behind the recovery is a minefield of stub-exit races, and one clean
    // submit on one healthy session is what the receipt needs — not that.
    await page.keyboard.press("Meta+t");
    await page.waitForTimeout(800);

    // --- 핀은 하나의 submit 으로 나간다 (수용 기준 5) ------------------------
    // A fresh pin, one Enter: the composer's single submit carries the pin
    // turn and nothing else. The stub's prompt log is the receipt — exactly
    // one new turn line, and NO new mode request: ⌘T 가 대화를 만들면서 전부
    // 맡기기는 그때 이미 밀렸다. 한 번의 보내기가 한 번의 턴이라는 것이
    // 이 줄이 지키는 전부다.
    await altClick(app, "[data-screen] tbody td");
    await page.locator(".pintray__row").waitFor({ timeout: 15000 });
    await page.locator(".pintray__note").first().fill("간격도 함께 손봐 주세요");
    const pinComposer = page.getByLabel("메시지");
    await pinComposer.click();
    await pinComposer.fill("이 표 전체를 봐 주세요.");
    const logBefore = readFileSync(promptLog, "utf8").split("\n");
    // 영수증은 이 순서의 'plan' 요청이다 — 턴이 승인 없이 끝나면 종료 정리가
    // 원래 자세를 되돌리는 요청을 남긴다(after 로그). 그 복원도 같은
    // subtype 이라 세면 두 번째가 되어, 정리가 카운트 창 안에 들어오는 순간
    // 무조건 실패한다. 세는 것을 plan 진입으로만 좁힌다.
    const modeLine = (l) =>
      l.includes('"subtype":"set_permission_mode"') && l.includes('"mode":"plan"');
    const modeCountBefore = logBefore.filter(modeLine).length;
    const turnCountBefore = logBefore.filter((l) => l.includes("미리보기에서 가리킨 요소")).length;
    await pinComposer.press("Enter");
    // The toolbar's stop is a UI mood, not the wire's clock (커밋 게이트 교훈:
    // it can detach before the stub has appended the turn). The log's growth
    // IS the receipt — poll for exactly one new plan request and one new
    // pin-turn line, then judge.
    const turnLine = (l) => l.includes("미리보기에서 가리킨 요소");
    let modeCountAfter = modeCountBefore;
    let turnCountAfter = turnCountBefore;
    const logDeadline = Date.now() + 15000;
    while (Date.now() < logDeadline) {
      const lines = readFileSync(promptLog, "utf8").split("\n");
      modeCountAfter = lines.filter(modeLine).length;
      turnCountAfter = lines.filter(turnLine).length;
      if (turnCountAfter >= turnCountBefore + 1) break;
      await new Promise((ok) => setTimeout(ok, 250));
    }
    await page.locator(".toolbar__stop").waitFor({ state: "detached", timeout: 30000 });
    check(
      "the pins ride one composer submit and ask for nothing else (핀 한 번)",
      modeCountAfter === modeCountBefore && turnCountAfter === turnCountBefore + 1,
      `mode:${modeCountAfter}(was ${modeCountBefore}) turns:${turnCountAfter}(was ${turnCountBefore})`,
    );
    const trayLeftBehind = await waitForNoPin(app);
    check("the pin send empties the tray", trayLeftBehind === "", `still:${trayLeftBehind}`);

    // --- ⓚ 래퍼 없는 페이지에서도 핀은 찍힌다 — 경로가 화면 id ---------------
    // The claude-design loop: comment → fix must not wait for a declared
    // screen. A page with no [data-screen] wrapper — 아직 이 도구로 만지지
    // 않은 레포의 원래 화면 — pins by its path, and the turn names it.
    // 회원 목록의 핀 하나를 남겨 둔 채 래퍼를 벗긴다 — 두 화면의 핀이 한
    // 트레이에서 한 턴으로 나가는 것이 수용 기준의 핵심 경로다 (재설계 C6).
    await altClick(app, "[data-screen] tbody td");
    await page.locator(".pintray__row").waitFor({ timeout: 15000 });
    await inView(
      app,
      `(() => {
        const wrapper = document.querySelector("[data-screen]");
        wrapper.removeAttribute("data-screen");
        history.pushState(null, "", "/settings");
        return true;
      })()`,
    );
    check("ⓚ ⌥+클릭 hit the wrapper-less page", (await altClick(app, "h1")) === true);
    const trayRows = page.locator(".pintray__row");
    // The h1 pin lands one crop round trip behind the click — wait for the
    // SECOND row, not for the first one that is already there.
    await page.waitForFunction(
      () => document.querySelectorAll(".pintray__row").length === 2,
      undefined,
      { timeout: 15000 },
    );
    await waitForPin(app);
    // The badge projects the screen it sits on — the settings pin only; the
    // member-list pin's row stays, badgeless, until its screen returns.
    const badgesHere = await inView(
      app,
      `document.querySelectorAll('[data-colo-design-overlay] [data-pin]').length`,
    );
    check(
      "ⓚ two screens rest in one tray, one badge on the current screen",
      (await trayRows.count()) === 2 && badgesHere === 1,
      `rows:${await trayRows.count()} badges:${badgesHere}`,
    );
    // 핀만의 전송 — 문장이 없어도 목록 하나로 성립한다 (재설계 §3.9). The
    // count comes FIRST: the echo card renders the moment the send lands,
    // and one taken after would already count the card we are waiting for.
    const cardsBefore = await page.locator(".machine--comments").count();
    await page.locator(".composer__send").click();
    // The naked turn's card is the NEXT comments card — waiting on `.last()`
    // would race and re-read the previous turn's card.
    const nakedCard = page.locator(".machine--comments").nth(cardsBefore);
    await nakedCard.waitFor({ timeout: 30000 });
    const nakedText = await nakedCard.innerText();
    // The card's 자세히 fold shows the turn body — the exact words Claude reads.
    await nakedCard.getByRole("button", { name: "자세히" }).click();
    const nakedBody = await nakedCard.locator(".machine__body").innerText();
    check(
      "ⓚ the turn spans two screens — summary lead, per-row screens",
      nakedText.includes("화면 2곳") &&
        nakedText.includes("settings") &&
        nakedBody.includes("미리보기에서 가리킨 요소 2개입니다") &&
        nakedBody.includes(" · 회원 목록") &&
        nakedBody.includes(" · settings"),
      nakedBody.slice(0, 80),
    );
    await page.locator(".toolbar__stop").waitFor({ state: "detached", timeout: 30000 });
    // The stub answers a comment turn at once but exits only 2s later, and
    // the session's process is reused — a turn sent inside that window dies
    // with it. Let the linger pass before the look turn below.
    await page.waitForTimeout(2500);
    await inView(
      app,
      `(() => {
        document.querySelector("#app > div").setAttribute("data-screen", "member/MemberList");
        history.pushState(null, "", "/member/MemberList");
        return true;
      })()`,
    );

    // --- ⓣ 드래그 영역 핀, 의도 칩, 그리고 ⌘⇧P (재설계 C9·C10) --------------
    // ⌥+드래그(6px 초과)는 요소가 아니라 좌표를 가리킨다 — 영역 핀.
    const regionDragged = await inView(
      app,
      `(() => {
        const target = document.elementFromPoint(300, 300);
        if (!target || target.closest("[data-colo-design-overlay]")) return false;
        const fire = (type, x, y) => target.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true, altKey: true, button: 0,
          clientX: x, clientY: y, view: window,
        }));
        fire("mousedown", 300, 300);
        fire("mousemove", 340, 330);
        fire("mouseup", 340, 330);
        // A real browser fires the trailing click after mouseup — the
        // overlay swallows exactly that one (재설계 C9).
        fire("click", 340, 330);
        return true;
      })()`,
    );
    const regionRow = page.locator(".pintray__row");
    await regionRow.waitFor({ timeout: 15000 });
    const regionText = await regionRow.first().innerText();
    const regionBox = await inView(
      app,
      `Boolean(document.querySelector('[data-colo-design-overlay] [data-pin-box]'))`,
    );
    check(
      "ⓣ an ⌥+drag leaves a region pin — dashed box on the page, sized row",
      regionDragged === true && regionText.includes("영역 40×30") && regionBox === true,
      `drag:${regionDragged} row:${regionText.split("\\n")[0]} box:${regionBox}`,
    );
    // 질문으로 접었다가 보낸다 — 카드 제목과 안내줄이 따라 온다 (재설계 C10).
    await regionRow.first().getByRole("button", { name: "질문" }).click();
    await page.locator(".pintray__note").first().fill("이 영역은 왜 비어 있나요?");
    const cardsBeforeRegion = await page.locator(".machine--comments").count();
    await page.locator(".composer__send").click();
    const regionCard = page.locator(".machine--comments").nth(cardsBeforeRegion);
    await regionCard.waitFor({ timeout: 30000 });
    const regionCardText = await regionCard.innerText();
    await regionCard.getByRole("button", { name: "자세히" }).click();
    const regionBody = await regionCard.locator(".machine__body").innerText();
    check(
      "ⓣ a question-intent region pin reads as 질문 — card and turn both",
      regionCardText.includes("질문 1건") &&
        regionBody.includes("아래 요소에 대한 질문입니다") &&
        regionBody.includes("1. 영역 40×30") &&
        regionBody.includes("메모: 이 영역은 왜 비어 있나요?"),
      regionBody.slice(0, 80),
    );
    await page.locator(".toolbar__stop").waitFor({ state: "detached", timeout: 30000 });
    check("ⓣ the question turn settled", true);

    // ⌘⇧P — the pin mode's own chord, from the chat column's keyboard.
    const pinToggle = page.getByRole("button", { name: /핀/ }).first();
    const pressedBefore = await pinToggle.getAttribute("aria-pressed");
    await page.keyboard.press("Meta+Shift+P");
    await page.waitForTimeout(300);
    const pressedAfter = await pinToggle.getAttribute("aria-pressed");
    await page.keyboard.press("Meta+Shift+P");
    await page.waitForTimeout(300);
    const pressedBack = await pinToggle.getAttribute("aria-pressed");
    check(
      "ⓣ ⌘⇧P toggles the pin mode both ways",
      pressedBefore === "false" && pressedAfter === "true" && pressedBack === "false",
      `${pressedBefore}→${pressedAfter}→${pressedBack}`,
    );

    // --- ⓛ 화면 보여 주기 (D89) ---------------------------------------------
    await page.getByRole("button", { name: "이 화면 Claude에게 보여 주기" }).click();
    await page.getByLabel("화면 보여 주기에 덧붙이는 말").fill("가운데 정렬이 풀려 있어요");
    await page.locator(".frame__lookform").getByRole("button", { name: "보내기" }).click();
    const lookCard = page.locator(".machine--error").last();
    await lookCard.waitFor({ timeout: 30000 });
    const lookText = await lookCard.innerText();
    check(
      "ⓛ the look turn renders as 화면 보여 주기",
      lookText.includes("화면 보여 주기"),
      lookText.split("\n")[0],
    );
    // The card's 자세히 fold shows the turn body — the exact words Claude reads.
    await lookCard.getByRole("button", { name: "자세히" }).click();
    const lookBody = await lookCard.locator(".machine__body").innerText();
    check(
      "ⓛ the look body carries the sentence and the planner's line",
      lookBody.includes("이 화면이 이렇게 보입니다") &&
        lookBody.includes("가운데 정렬이 풀려 있어요"),
      lookBody.slice(0, 80),
    );

    // --- ⓜ 연타 가드, 그리고 두 번째 요청 (D89) -----------------------------
    // The first look's turn is still running — exactly the state the 연타
    // guard is for: the repeat must be BLOCKED with the toast, not doubled.
    // The stop button is the running turn's own lamp: waiting for it makes
    // the precondition explicit instead of racing the send pipeline.
    await page.locator(".toolbar__stop").waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: "이 화면 Claude에게 보여 주기" }).click();
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
    await page.getByRole("button", { name: "이 화면 Claude에게 보여 주기" }).click();
    await page.locator(".frame__lookform").getByRole("button", { name: "보내기" }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".machine--error").length >= 2,
      undefined,
      { timeout: 30000 },
    );
    const againText = await page.locator(".machine--error").last().innerText();
    check(
      "ⓜ the repeat after settle says 두 번째 요청",
      againText.includes("2번째 요청"),
      againText.split("\n")[0],
    );

    await page.locator(".machine--comments").last().waitFor({ timeout: 30000 });
    // While the turn runs, send one more pin — the wait-line must appear (D86).
    check(
      "ⓘ-setup second pin accepted mid-turn",
      (await altClick(app, "[data-screen] p")) === true,
    );
    await page.locator(".pintray__row").waitFor({ timeout: 15000 });
    await page.locator(".pintray__note").first().fill("설명 문장은 반영해 주세요");
    const queuedComposer = page.getByLabel("메시지");
    await queuedComposer.click();
    await queuedComposer.press("Enter");
    const queuedLine = page.locator(".composer__queued");
    await queuedLine.waitFor({ timeout: 15000 });
    const queuedText = await queuedLine.innerText();
    check("ⓘ a mid-turn send shows the wait-line", queuedText.includes("대기"), queuedText);
    // The queued batch is SENT — its badges grey out for the turn's life
    // (재설계 C10), whatever the wait-line is doing.
    let ghostGrey = false;
    const ghostDeadline = Date.now() + 10000;
    while (Date.now() < ghostDeadline && !ghostGrey) {
      ghostGrey = await inView(
        app,
        `Boolean([...document.querySelectorAll('[data-colo-design-overlay] [data-pin]')]
          .find((b) => (b.getAttribute("aria-label") || "").includes("보냄")))`,
      );
      if (!ghostGrey) await new Promise((ok) => setTimeout(ok, 250));
    }
    check("ⓘ' the queued batch's badges grey out as sent", ghostGrey === true);
    // The stub CLI serves one turn per process, so the queued message cannot
    // complete here — 중지 is the planner's way out, and the wait-line must go
    // with it (D86), no error band left behind (결함①).
    await page.locator(".toolbar__stop").click();
    await queuedLine.waitFor({ state: "detached", timeout: 15000 });
    // The band is what must NOT be there, so it is counted, not awaited: an
    // `innerText()` on an absent locator sits out Playwright's full 30s
    // auto-wait before its catch — half this suite's runtime for a string
    // only the failure message ever prints.
    const bands = page.locator(".notice--error");
    const bandCount = await bands.count();
    const bandText = bandCount === 0 ? "(none)" : await bands.first().innerText();
    check(
      "ⓘ 중지 clears the wait-line without an error band",
      bandCount === 0,
      `band:${bandText.slice(0, 96).replace(/\n/g, " ")}`,
    );
    // The turn left without answering — the grey badges go with it.
    let ghostGone = false;
    const goneDeadline = Date.now() + 10000;
    while (Date.now() < goneDeadline && !ghostGone) {
      ghostGone = !(await inView(
        app,
        `Boolean([...document.querySelectorAll('[data-colo-design-overlay] [data-pin]')]
          .find((b) => (b.getAttribute("aria-label") || "").includes("보냄")))`,
      ));
      if (!ghostGone) await new Promise((ok) => setTimeout(ok, 250));
    }
    check(
      "ⓘ' 중지 takes the grey sent badges with the wait-line",
      ghostGone === true,
      `badges:${JSON.stringify(
        await inView(
          app,
          `[...document.querySelectorAll('[data-colo-design-overlay] [data-pin]')].map((b) => b.getAttribute("aria-label"))`,
        ),
      )}`,
    );

    await page
      .locator(".toolbar__stop")
      .waitFor({ state: "detached", timeout: 30000 })
      .catch(() => {});

    // --- D85 브라우저 손질 --------------------------------------------------
    // ⓝ ⌘R 은 미리보기만 다시 읽는다 — 도구 UI 의 전역은 살아 있다.
    await page.evaluate(() => {
      window.__uiMarker = "alive";
    });
    await inView(app, `window.__viewMarker = "set"; true`);
    // The view is reloaded the way the planner does it (the menu item and
    // this button share view.reload()); the menu template's unit checks pin
    // the accelerator wiring itself.
    await page.getByRole("button", { name: "미리보기 새로 고침" }).click();
    await page.waitForTimeout(900);
    const uiMarker = await page.evaluate(() => window.__uiMarker);
    const viewAfterKey = await inView(app, `window.__viewMarker ?? "(gone)"`);
    check(
      "ⓝ ⌘R spares the tool UI",
      uiMarker === "alive" && viewAfterKey !== "set",
      `ui:${uiMarker} view:${viewAfterKey}`,
    );
    // ⓞ the address bar proposes the declared routes (D85 ⓓ).
    const options = await page.evaluate(() =>
      [...document.querySelectorAll("#colo-frame-routes option")].map((o) =>
        o.getAttribute("value"),
      ),
    );
    check(
      "ⓞ the address datalist offers the declared route",
      options.includes("/member/MemberList"),
      options.join(", "),
    );
    // ⓟ 배율: 두 번 확대 → 칩 140%, 모바일 폭 → 100% 복귀 (D85 ⓔ).
    await page.evaluate(() => void window.coloDesignDesktop.preview.zoom("in"));
    await page.waitForTimeout(400);
    const zoomChip = await page
      .getByTestId("preview-zoom")
      .innerText()
      .catch(() => "(none)");
    check("ⓟ zooming shows the percent chip", zoomChip === "120%", zoomChip);
    await page.getByRole("group", { name: "폭" }).getByRole("button", { name: "모바일" }).click();
    await page.waitForTimeout(400);
    const chipGone = (await page.getByTestId("preview-zoom").count()) === 0;
    await page.getByRole("group", { name: "폭" }).getByRole("button", { name: "데스크톱" }).click();
    check("ⓟ a width change resets the zoom to 100%", chipGone === true);
    // ⓠ 새 창은 보던 곳을 OS 브라우저에 (D85 ⓑ) — shell.openExternal 을 엿본다.
    await app.evaluate((electronModule) => {
      const sh = electronModule.shell;
      sh.__lastExternal = null;
      const original = sh.openExternal.bind(sh);
      sh.openExternal = (url) => {
        sh.__lastExternal = url;
        return original(url).catch(() => undefined);
      };
    });
    await page.getByRole("button", { name: "새 창" }).click();
    await page.waitForTimeout(500);
    const external = await app.evaluate((electronModule) => electronModule.shell.__lastExternal);
    check(
      "ⓠ the new-window button opens the CURRENT path externally",
      typeof external === "string" && external.includes("/member/MemberList"),
      String(external),
    );
    // ⓡ 로딩 중 버튼이 돌고 클릭이 중단이 되는 것은 채널이 이어 주고 있다 —
    // fixture 의 응답이 즉답이라 상태를 눈으로 담기 어려워 채널로 검증한다.
    const stopWired = await page.evaluate(async () => {
      await window.coloDesignDesktop.preview.stop();
      return true;
    });
    check("ⓡ the stop channel is wired", stopWired === true);

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
    await page.screenshot({
      path: join(here, "desktop-comments.png"),
      fullPage: true,
    });
  } finally {
    await closeApp(app);
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
