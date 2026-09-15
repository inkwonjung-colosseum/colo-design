/**
 * Settings panel check. Free: no daemon, no model turn.
 *
 * The panel is reachable from the connect screen on purpose — the theme is a
 * browser preference and should not need a daemon to change — so the whole
 * thing can be driven against the built app served from disk.
 *
 * Prerequisite: `pnpm --filter @colo-design/web build`
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const webDist = join(repoRoot, "packages", "web", "dist");
const PORT = 5397;
const APP = `http://127.0.0.1:${PORT}/`;

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") throw new Error(`check("${name}") was called without a verdict`);
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

function serveDist() {
  const server = createServer((req, res) => {
    const requested = (req.url ?? "/").split("?")[0];
    let file = join(webDist, requested === "/" ? "index.html" : requested);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(webDist, "index.html");
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
    });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(PORT, "127.0.0.1", () => ok(server)));
}

const theme = (page) => page.evaluate(() => document.documentElement.dataset.theme);
const stored = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("colo-design.settings") ?? "null"));

async function main() {
  if (!existsSync(webDist))
    throw new Error("web dist missing. Run: pnpm --filter @colo-design/web build");

  const server = await serveDist();
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const failures = [];
  page.on("pageerror", (e) => failures.push(e.message));
  page.on("console", (m) => m.type() === "error" && failures.push(m.text()));
  // 결함③ (PLAN 0단계): the browser's own confirm must never enter the
  // picture — every dangerous ask is the app's dialog.
  await page.addInitScript(() => {
    window.confirm = () => {
      window.__nativeConfirmUsed = true;
      return true;
    };
  });

  try {
    // 1. an unconfigured client opens on paper, whatever the OS says (PLAN
    //    D13). The default is a decision about the work — reading a document
    //    beside a rendered screen — not about what the OS happens to prefer.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(APP);
    await page.waitForSelector(".connect__cmd", { timeout: 10000 });
    check("no stored settings means the light palette stands", (await theme(page)) === "light");
    check(
      "the browser chrome tint lands on the palette",
      (await page.evaluate(() => document.querySelector('meta[name="theme-color"]')?.content)) ===
        "#ffffff",
    );
    await page.emulateMedia({ colorScheme: "light" });
    check(
      "nothing is written to storage until something is changed",
      (await stored(page)) === null,
    );

    // 2. settings open from the connect screen, before any daemon exists.
    await page.getByRole("button", { name: "설정" }).click();
    await page.waitForSelector('[role="dialog"][aria-label="설정"]', {
      timeout: 5000,
    });
    await page.screenshot({ path: join(here, "ui-settings-dark.png") });
    const groups = await page.locator(".settings__groupTitle").allInnerTexts();
    check(
      "the panel offers only what a planner sets",
      ["화면", "대화", "동작", "알림", "GITHUB", "연결 레포", "문제 해결"].every((g) =>
        groups.includes(g),
      ) && groups.length === 7,
      groups.join(", "),
    );
    // PLAN D39: the word belongs to the program, not the planner's settings —
    // the diagnostics fold (where a developer debugs) is the only home left.
    check(
      "the planner's settings never say 데몬",
      !(await page.locator('[role="dialog"][aria-label="설정"]').innerText()).includes("데몬"),
    );
    // No daemon yet, so the repo fields wait for one instead of pretending.
    // No daemon yet: the GitHub token form and the repo url field wait for
    // one instead of pretending.
    check(
      "the token input and repo url wait for a daemon",
      (await page.getByLabel("GitHub 개인 액세스 토큰").isDisabled()) === true &&
        (await page.getByLabel("연결 레포 주소").isDisabled()) === true,
    );
    // A fresh profile starts on 전부 맡기기 (--dangerously-skip-permissions):
    // the first turn must not stall on a 확인 카드 nobody chose.
    check(
      "확인 방식 starts on 전부 맡기기",
      (await page.getByLabel("확인 방식").inputValue()) === "bypassPermissions",
    );
    check(
      "실행 중 보내기 starts on 다음 턴에 보내기",
      (await page.getByLabel("실행 중 보내기").inputValue()) === "queue",
    );

    // 3. theme applies live and persists. The picker is a gallery of live
    //    palette tiles now, not a select — a palette is chosen by its colour.
    await page.locator('[data-testid="theme-dark"]').click();
    await page
      .waitForFunction(() => document.documentElement.dataset.theme === "dark", undefined, {
        timeout: 3000,
      })
      .catch(() => undefined);
    check("the console palette is still one choice away", (await theme(page)) === "dark");
    await page.screenshot({ path: join(here, "ui-settings-dark.png") });
    await page.locator('[data-testid="theme-light"]').click();
    // A frame, not a reload: the attribute lands from React's commit.
    await page
      .waitForFunction(() => document.documentElement.dataset.theme === "light", undefined, {
        timeout: 3000,
      })
      .catch(() => undefined);
    check("choosing light repaints without a reload", (await theme(page)) === "light");
    // Surfaces cross-fade for 120ms; let them settle so the shot is the real thing.
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(here, "ui-settings-light.png") });
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check("light theme actually swaps the surface colour", bodyBg === "rgb(255, 255, 255)", bodyBg);
    check("the choice is stored", (await stored(page))?.theme === "light");

    // 3b. The extra palettes are full themes: each applies live, persists,
    // and really swaps the page surface, not just the attribute.
    const palettes = [
      ["sepia", "rgb(247, 241, 228)"],
      ["midnight", "rgb(13, 18, 32)"],
      ["contrast", "rgb(0, 0, 0)"],
      ["dracula", "rgb(40, 42, 54)"],
      ["solarized", "rgb(0, 43, 54)"],
      ["catppuccin", "rgb(30, 30, 46)"],
      ["nord", "rgb(46, 52, 64)"],
      ["gruvbox", "rgb(40, 40, 40)"],
      ["tokyonight", "rgb(26, 27, 38)"],
      ["rosepine", "rgb(25, 23, 36)"],
      ["everforest", "rgb(45, 53, 59)"],
      ["onedark", "rgb(40, 44, 52)"],
      ["github", "rgb(13, 17, 23)"],
      ["monokai", "rgb(39, 40, 34)"],
      ["latte", "rgb(239, 241, 245)"],
    ];
    for (const [id, surface] of palettes) {
      await page.locator(`[data-testid="theme-${id}"]`).click();
      await page
        .waitForFunction((want) => document.documentElement.dataset.theme === want, id, {
          timeout: 3000,
        })
        .catch(() => undefined);
      check(`the ${id} palette applies live`, (await theme(page)) === id);
      await page.waitForTimeout(300); // let the surface transition settle
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      check(`the ${id} palette swaps the surface colour`, bg === surface, bg);
      check(`the ${id} choice is stored`, (await stored(page))?.theme === id);
      await page.screenshot({ path: join(here, `ui-settings-${id}.png`) });
    }

    const chrome = await page.evaluate(
      () => document.querySelector('meta[name="theme-color"]')?.content,
    );
    check("the chrome tint follows the last palette onto paper", chrome === "#eff1f5", chrome);

    // 4. "system" follows the OS, in both directions, without a reload.
    await page.locator('[data-testid="theme-system"]').click();
    // The palettes loop leaves a non-light palette on <html>, so the attribute
    // genuinely has to move — wait for the commit, as the dark direction below.
    await page
      .waitForFunction(() => document.documentElement.dataset.theme === "light", undefined, {
        timeout: 3000,
      })
      .catch(() => undefined);
    check("system resolves to the OS light mode", (await theme(page)) === "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark", undefined, {
      timeout: 3000,
    });
    check("switching the OS to dark moves the app with it", (await theme(page)) === "dark");
    await page.emulateMedia({ colorScheme: "light" });

    // A request for more contrast outranks light/dark, both ways, live.
    await page.emulateMedia({ contrast: "more" });
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "contrast",
      undefined,
      { timeout: 3000 },
    );
    check(
      "a high-contrast request pulls in the contrast palette",
      (await theme(page)) === "contrast",
    );
    await page.emulateMedia({ contrast: null });
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "light",
      undefined,
      { timeout: 3000 },
    );
    check("dropping the request hands control back to light/dark", (await theme(page)) === "light");

    // 5. behaviour choices survive a reload.
    await page.getByLabel("보내기 키").selectOption("modEnter");
    await page.getByLabel("실행 중 보내기").selectOption("interrupt");
    const before = await stored(page);
    check(
      "behaviour choices are stored together and the delete-confirm row is gone",
      before?.sendKey === "modEnter" &&
        before?.midTurnSend === "interrupt" &&
        (await page.getByLabel("기획을 삭제하기 전에 확인").count()) === 0,
    );

    // 5b. the type scale (설정 벤치마크 P1 #13): three 3-step knobs that ride
    //     <html> attributes into CSS variables — and move real text, not
    //     just state.
    const scales = () =>
      page.evaluate(() => [
        document.documentElement.dataset.ui,
        document.documentElement.dataset.content,
        document.documentElement.dataset.code,
      ]);
    check(
      "type scale starts on 보통 across the three knobs",
      (await scales()).join() === "normal,normal,normal",
    );
    const labelSize = () =>
      page.evaluate(() =>
        parseFloat(getComputedStyle(document.querySelector(".setting__label")).fontSize),
      );
    const uiBase = await labelSize();
    await page.getByLabel("인터페이스 크기").selectOption("large");
    await page.waitForFunction(
      (base) =>
        parseFloat(getComputedStyle(document.querySelector(".setting__label")).fontSize) > base,
      uiBase,
      { timeout: 3000 },
    );
    const uiScaled = await labelSize();
    check(
      "인터페이스 크기 크게 resizes the controls",
      uiScaled > uiBase,
      `${uiBase}px → ${uiScaled}px`,
    );
    await page.getByLabel("콘텐츠 크기").selectOption("small");
    await page.getByLabel("코드 크기").selectOption("large");
    check(
      "the three choices land on <html> and persist together",
      (await scales()).join() === "large,small,large" &&
        (await stored(page))?.uiScale === "large" &&
        (await stored(page))?.contentScale === "small" &&
        (await stored(page))?.codeScale === "large",
    );

    await page.reload();
    await page.waitForSelector(".connect__cmd", { timeout: 10000 });
    check("theme is applied on load, not after a click", (await theme(page)) === "light");
    await page.getByRole("button", { name: "설정" }).click();
    await page.waitForSelector('[role="dialog"][aria-label="설정"]', {
      timeout: 5000,
    });
    check(
      "the panel reopens on the stored values",
      (await page.getByLabel("보내기 키").inputValue()) === "modEnter" &&
        (await page.getByLabel("실행 중 보내기").inputValue()) === "interrupt",
    );

    // 5c. 알림(설정 문서 P0#3): 완료 알림만 시점을 고르고, 소리는 그 옆에
    //     산다. 기본은 "오래 걸린 턴만" — 모든 턴마다 울리지 않는다.
    check(
      "완료 알림 starts on 오래 걸린 턴만",
      (await page.getByLabel("완료 알림").inputValue()) === "long",
    );
    await page.getByLabel("완료 알림").selectOption("all");
    await page.getByLabel("알림 소리").click();
    check(
      "the notification policy is stored like every other preference",
      (await stored(page))?.notifications?.done === "all" &&
        (await stored(page))?.notifications?.sound === false,
      JSON.stringify((await stored(page))?.notifications),
    );

    // 6. the 대화 group: the three chips that used to live in the composer
    //    (PLAN D10). They persist like any other preference — except one.
    await page.getByLabel("생각 시간").selectOption("high");
    await page.getByLabel("확인 방식").selectOption("plan");
    const chat = (await stored(page))?.chat;
    check(
      "conversation choices are stored with the rest",
      chat?.effort === "high" && chat?.permissionMode === "plan",
      JSON.stringify(chat),
    );

    await page.reload();
    await page.waitForSelector(".connect__cmd", { timeout: 10000 });
    await page.getByRole("button", { name: "설정" }).click();
    await page.waitForSelector('[role="dialog"][aria-label="설정"]', {
      timeout: 5000,
    });
    check(
      "they come back on the values that were chosen",
      (await page.getByLabel("생각 시간").inputValue()) === "high" &&
        (await page.getByLabel("확인 방식").inputValue()) === "plan",
    );

    // acceptEdits 는 메뉴로 돌아왔다(소유자 결정): 저장값은 이사 가지 않고
    // 고른 그대로 돌아온다. 대신 그 줄이 무엇을 여는지 — 편집만이 아니라
    // CLI 가 안전하다고 본 명령까지 — 설정이 한 줄로 말해야 한다.
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem("colo-design.settings") ?? "{}");
      raw.chat = { ...raw.chat, permissionMode: "acceptEdits" };
      localStorage.setItem("colo-design.settings", JSON.stringify(raw));
    });
    await page.reload();
    await page.waitForSelector(".connect__cmd", { timeout: 10000 });
    await page.getByRole("button", { name: "설정" }).click();
    await page.waitForSelector('[role="dialog"][aria-label="설정"]', {
      timeout: 5000,
    });
    check(
      "a stored acceptEdits comes back as acceptEdits",
      (await page.getByLabel("확인 방식").inputValue()) === "acceptEdits",
    );
    check(
      "and the row says what it opens beyond edits",
      (await page.locator('[role="dialog"][aria-label="설정"] .notice--warn').innerText()).includes(
        "명령까지 묻지 않고",
      ),
    );

    // 전부 맡기기 is the starting default now, so it restores like any other
    // choice — the stored value is the planner's own decision either way.
    await page.getByLabel("확인 방식").selectOption("bypassPermissions");
    check(
      "전부 맡기기 says what it costs, right where it is chosen",
      (await page.locator(".notice--warn").innerText()).includes("확인 카드 없이"),
    );
    check(
      "and it is written down like everything else",
      (await stored(page))?.chat?.permissionMode === "bypassPermissions",
    );
    await page.reload();
    await page.waitForSelector(".connect__cmd", { timeout: 10000 });
    await page.getByRole("button", { name: "설정" }).click();
    await page.waitForSelector('[role="dialog"][aria-label="설정"]', {
      timeout: 5000,
    });
    check(
      "and a reload keeps it, like every other choice",
      (await page.getByLabel("확인 방식").inputValue()) === "bypassPermissions",
    );

    // 생각 과정은 기본으로 보이지 않는다: 사용자가 읽어야 하는 것은 답이다.
    // 켜고 끄는 자리는 여기뿐이고, 켠 사실은 다른 선택처럼 남는다.
    check(
      "생각 과정 is off until the planner asks for it",
      (await page.getByLabel("생각 과정 보기").isChecked()) === false &&
        (await stored(page))?.chat?.showThinking !== true,
      JSON.stringify((await stored(page))?.chat?.showThinking),
    );
    await page.getByLabel("생각 과정 보기").check();
    check(
      "asking for it is written down like every other choice",
      (await stored(page))?.chat?.showThinking === true,
    );
    await page.reload();
    await page.waitForSelector(".connect__cmd", { timeout: 10000 });
    await page.getByRole("button", { name: "설정" }).click();
    await page.waitForSelector('[role="dialog"][aria-label="설정"]', {
      timeout: 5000,
    });
    check("and a reload brings it back on", await page.getByLabel("생각 과정 보기").isChecked());

    // 작업 과정(도구 호출 묶음)도 생각 과정과 같은 기본값이다: 꺼져 있어야
    // 하고, 켠 사실은 다른 선택처럼 남는다. 계획 카드 · 캡처 카드는 이
    // 스위치와 무관하다는 것이 이 검사의 밑에 깔린 규칙이다(tape-visibility).
    check(
      "작업 과정 is off until the planner asks for it",
      (await page.getByLabel("작업 과정 보기").isChecked()) === false &&
        (await stored(page))?.chat?.showTools !== true,
      JSON.stringify((await stored(page))?.chat?.showTools),
    );
    await page.getByLabel("작업 과정 보기").check();
    check(
      "asking for it is written down like every other choice",
      (await stored(page))?.chat?.showTools === true,
    );
    await page.reload();
    await page.waitForSelector(".connect__cmd", { timeout: 10000 });
    await page.getByRole("button", { name: "설정" }).click();
    await page.waitForSelector('[role="dialog"][aria-label="설정"]', {
      timeout: 5000,
    });
    check("and a reload brings it back on", await page.getByLabel("작업 과정 보기").isChecked());

    // 7. the diagnostics are reachable and no longer the first thing in view.
    check(
      "connection details sit behind a fold",
      (await page.locator(".settings__fold").count()) === 1 &&
        (await page.getByLabel("접속 주소").isVisible()) === false,
    );
    await page.locator(".settings__fold > summary").click();
    check(
      "opening the fold reveals them",
      (await page.getByLabel("접속 주소").isVisible()) === true,
    );

    // 7b. the one dangerous action on this panel asks in the app's dialog
    //     (결함③) — the native confirm stays silent, cancelling keeps all.
    await page.getByRole("button", { name: "접속 주소 지우기" }).click();
    const forgetDialog = page.locator('[role="dialog"][aria-label="접속 주소 지우기"]');
    await forgetDialog.waitFor({ timeout: 5000 });
    check(
      "주소 지우기 asks in the app's dialog, never window.confirm",
      (await page.evaluate(() => window.__nativeConfirmUsed ?? false)) === false,
    );
    await forgetDialog.getByRole("button", { name: "취소" }).click();
    await forgetDialog.waitFor({ state: "detached", timeout: 5000 });
    check(
      "cancelling keeps the panel and the address",
      (await page.locator('[role="dialog"][aria-label="설정"]').count()) === 1,
    );

    // 7c. the keyboard agrees with aria-modal: Tab wraps inside the panel no
    //     matter how far it walks, and closing hands focus back to the gear
    //     that opened the panel.
    const focusableCount = await page.evaluate(() => {
      const panel = document.querySelector('[role="dialog"][aria-label="설정"]');
      return panel
        ? panel.querySelectorAll(
            "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
          ).length
        : 0;
    });
    await page.getByLabel("보내기 키").focus();
    let escaped = false;
    for (let step = 0; step < focusableCount + 2 && !escaped; step += 1) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(
        () =>
          document
            .querySelector('[role="dialog"][aria-label="설정"]')
            ?.contains(document.activeElement) === true,
      );
      if (!inside) escaped = true;
    }
    check(
      "Tab stays inside the dialog however far it walks",
      escaped === false,
      `focusables: ${focusableCount}`,
    );
    await page.keyboard.press("Escape");
    await page
      .locator('[role="dialog"][aria-label="설정"]')
      .waitFor({ state: "detached", timeout: 5000 });
    check(
      "closing the dialog hands focus back to the opener",
      await page.evaluate(
        () => document.activeElement?.classList?.contains("connect__settings") === true,
      ),
    );

    // 8. a stored blob that is not a legal Settings must not brick the app.
    await page.evaluate(() =>
      localStorage.setItem("colo-design.settings", JSON.stringify({ theme: "neon", sendKey: 7 })),
    );
    await page.reload();
    await page.waitForSelector(".connect__cmd", { timeout: 10000 });
    check("nonsense in storage falls back to the defaults", (await theme(page)) === "light");
    await page.getByRole("button", { name: "설정" }).click();
    check(
      "a non-string send key falls back too",
      (await page.getByLabel("보내기 키").inputValue()) === "enter",
    );
    check(
      "an absent 실행 중 보내기 falls back to the queue default",
      (await page.getByLabel("실행 중 보내기").inputValue()) === "queue",
    );
    check(
      "an absent type scale falls back to 보통",
      (await scales()).join() === "normal,normal,normal",
    );

    // 9. Escape closes without touching anything.
    await page.keyboard.press("Escape");
    check(
      "escape closes the panel",
      (await page.locator('[role="dialog"][aria-label="설정"]').count()) === 0,
    );

    check("no page errors while driving the panel", failures.length === 0, failures.join(" | "));
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAILED: ${f.name}`);
    process.exit(1);
  }
}

await main();
