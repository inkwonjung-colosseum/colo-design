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
/** The accordion row is the index now — most checks name the room they visit.
    이미 열린 방을 다시 누르면 접힌다는 아코디언 규칙이라, 열려 있으면 건너뛴다. */
const ROOM_ID = {
  화면: "screen",
  프로바이더: "providers",
  대화: "chat",
  동작: "behavior",
  알림: "notice",
  연결: "connection",
  "문제 해결": "troubleshoot",
};
const openCategory = async (page, name) => {
  const head = page.locator(`[data-testid="settings-nav-${ROOM_ID[name]}"]`);
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
};
/** 두세 태 고르기는 APG 라디오가 되었다 — 조각 이름으로 고르고, aria-checked
    로 읽는다. select 의 selectOption/inputValue 자리를 대신한다. */
const pick = (page, group, option) =>
  page
    .getByRole("radiogroup", { name: group })
    .getByRole("radio", { name: option, exact: true })
    .click();
const picked = (page, group, option) =>
  page
    .getByRole("radiogroup", { name: group })
    .getByRole("radio", { name: option, exact: true })
    .getAttribute("aria-checked")
    .then((v) => v === "true");

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
  // The browser's own confirm must never enter the
  // picture — every dangerous ask is the app's dialog.
  await page.addInitScript(() => {
    window.confirm = () => {
      window.__nativeConfirmUsed = true;
      return true;
    };
  });

  try {
    // 1. an unconfigured client opens on paper, whatever the OS says.
    //    The default is a decision about the work — reading a document
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
    const heads = await page.locator(".acc__head .acc__name").allInnerTexts();
    check(
      "the panel offers only what a planner sets",
      ["화면", "프로바이더", "대화", "동작", "알림", "연결", "문제 해결"].every((g) =>
        heads.includes(g),
      ) && heads.length === 7,
      heads.join(", "),
    );
    // The accordion's one-line summaries: a folded room introduces itself with
    // its current values — 화면 names the theme and the px it runs at.
    check(
      "a folded room reads its current values before being opened",
      (await page.locator('[data-testid="settings-nav-screen"] .acc__sum').innerText()) ===
        "밝게 · 13px",
      await page.locator('[data-testid="settings-nav-screen"] .acc__sum').innerText(),
    );
    // The word belongs to the program, not the planner's settings —
    // the diagnostics fold (where a developer debugs) is the only home left.
    check(
      "the planner's settings never say 데몬",
      !(await page.locator('[role="dialog"][aria-label="설정"]').innerText()).includes("데몬"),
    );
    // No daemon yet: the GitHub token form waits for one instead of pretending.
    await openCategory(page, "연결");
    check(
      "the token input waits for a daemon",
      (await page.getByLabel("GitHub 개인 액세스 토큰").isDisabled()) === true,
    );
    // A fresh profile starts on 전부 맡기기 (--dangerously-skip-permissions):
    // the first turn must not stall on a 확인 카드 nobody chose.
    await openCategory(page, "대화");
    check(
      "확인 방식 starts on 전부 맡기기",
      (await page.getByLabel("확인 방식").inputValue()) === "bypassPermissions",
    );

    // 3. theme applies live and persists. The picker is a gallery of live
    //    palette tiles now, not a select — a palette is chosen by its colour.
    await openCategory(page, "화면");
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
      ["claude", "rgb(250, 249, 245)"],
      ["codex", "rgb(33, 33, 33)"],
      ["cursor", "rgb(26, 25, 23)"],
      ["vscode", "rgb(31, 31, 31)"],
      ["linear", "rgb(8, 9, 10)"],
      ["jetbrains", "rgb(30, 31, 34)"],
      ["slack", "rgb(63, 14, 64)"],
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
    check("the chrome tint follows the last palette onto aubergine", chrome === "#3f0e40", chrome);

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
    await openCategory(page, "동작");
    await pick(page, "보내기 키", "⌘/Ctrl+Enter");
    const before = await stored(page);
    check(
      "the behaviour choice is stored and the delete-confirm row is gone",
      before?.sendKey === "modEnter" &&
        (await page.getByLabel("기획을 삭제하기 전에 확인").count()) === 0,
    );
    // The row's summary is the value's echo — a change rewrites it in place.
    check(
      "the 동작 summary echoes the choice just made",
      (await page.locator('[data-testid="settings-nav-behavior"] .acc__sum').innerText()) ===
        "⌘/Ctrl+Enter",
    );

    // 5b. the type scale: three px knobs that land on <html> as inline
    //     --*-scale custom properties — and move real text, not just state.
    const scaleVar = (name) =>
      page.evaluate(
        (n) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(n)),
        name,
      );
    const sizeField = (label) => page.getByRole("spinbutton", { name: label });
    const setSize = async (label, px) => {
      await sizeField(label).fill(String(px));
      await sizeField(label).press("Tab");
    };
    const sizeValue = (label) => sizeField(label).inputValue().then(Number);
    check(
      "type sizes start on each axis' base px",
      (await scaleVar("--ui-scale")) === 1 &&
        (await scaleVar("--content-scale")) === 1 &&
        (await scaleVar("--code-scale")) === 1,
    );
    await openCategory(page, "화면");
    const labelSize = () =>
      page.evaluate(() =>
        parseFloat(getComputedStyle(document.querySelector(".setting__label")).fontSize),
      );
    const uiBase = await labelSize();
    await setSize("인터페이스 크기", 15);
    await page.waitForFunction(
      (base) =>
        parseFloat(getComputedStyle(document.querySelector(".setting__label")).fontSize) > base,
      uiBase,
      { timeout: 3000 },
    );
    const uiScaled = await labelSize();
    check(
      "인터페이스 크기 15px resizes the controls",
      uiScaled > uiBase,
      `${uiBase}px → ${uiScaled}px`,
    );
    await setSize("콘텐츠 크기", 12);
    await setSize("코드 크기", 14);
    check(
      "the three px values persist together",
      (await stored(page))?.uiSize === 15 &&
        (await stored(page))?.contentSize === 12 &&
        (await stored(page))?.codeSize === 14,
    );

    // 5b-2. the token ladder: every scaled size in the stylesheet is a
    //     --font-* token now, so the contract lives at the tokens — each one
    //     rides exactly its own knob and nothing else. A probe element reads
    //     the resolved px straight out of the custom property, independent of
    //     which component happens to use it.
    const tokenPx = (name) =>
      page.evaluate((n) => {
        const probe = document.createElement("span");
        probe.style.fontSize = `var(${n})`;
        document.body.appendChild(probe);
        const px = parseFloat(getComputedStyle(probe).fontSize);
        probe.remove();
        return px;
      }, name);
    const near = (a, b) => Math.abs(a - b) < 0.01;
    await setSize("인터페이스 크기", 13);
    await setSize("콘텐츠 크기", 13.5);
    await setSize("코드 크기", 11.5);
    check(
      "at base px every token resolves to its own base",
      near(await tokenPx("--font-ui-130"), 13) &&
        near(await tokenPx("--font-ui-90"), 9) &&
        near(await tokenPx("--font-ui-340"), 34) &&
        near(await tokenPx("--font-content-135"), 13.5) &&
        near(await tokenPx("--font-content-120"), 12) &&
        near(await tokenPx("--font-code-115"), 11.5) &&
        near(await tokenPx("--font-code-120"), 12),
    );
    await setSize("인터페이스 크기", 15);
    check(
      "인터페이스 px rides only the interface knob",
      near(await tokenPx("--font-ui-130"), 15) &&
        near(await tokenPx("--font-ui-115"), 15 * (11.5 / 13)) &&
        near(await tokenPx("--font-content-135"), 13.5) &&
        near(await tokenPx("--font-code-115"), 11.5),
    );
    await setSize("콘텐츠 크기", 15);
    check(
      "콘텐츠 px moves prose and leaves the other knobs alone",
      near(await tokenPx("--font-content-135"), 15) &&
        near(await tokenPx("--font-ui-130"), 15) &&
        near(await tokenPx("--font-code-115"), 11.5),
    );
    await setSize("코드 크기", 14);
    check(
      "코드 px moves machine text and leaves the other knobs alone",
      near(await tokenPx("--font-code-115"), 14) &&
        near(await tokenPx("--font-ui-130"), 15) &&
        near(await tokenPx("--font-content-135"), 15),
    );
    // The −/+ steppers move on the 0.5px grid; a typed value outside the
    // axis' bounds clamps instead of breaking the page.
    await setSize("코드 크기", 11.5);
    await page.getByRole("button", { name: "코드 크기 키우기" }).click();
    check("the + stepper moves half a px", (await sizeValue("코드 크기")) === 12);
    await setSize("코드 크기", 99);
    check("a typed value clamps to the axis ceiling", (await sizeValue("코드 크기")) === 16);
    // A blob from the three-step build migrates: 크게 was base × 1.1.
    await page.evaluate(() => {
      const blob = JSON.parse(localStorage.getItem("colo-design.settings"));
      delete blob.uiSize;
      blob.uiScale = "large";
      localStorage.setItem("colo-design.settings", JSON.stringify(blob));
    });
    await page.reload();
    await page.waitForSelector(".connect__cmd", { timeout: 10000 });
    check(
      "a stored 크게 reads back as the px it meant",
      near(await scaleVar("--ui-scale"), 1.1),
      `--ui-scale = ${await scaleVar("--ui-scale")}`,
    );
    await page.getByRole("button", { name: "설정" }).click();
    await page.waitForSelector('[role="dialog"][aria-label="설정"]', {
      timeout: 5000,
    });
    await openCategory(page, "화면");
    check("the migrated 크게 shows as 14.3px", (await sizeValue("인터페이스 크기")) === 14.3);
    // The rest of the panel reads at the stored sizes — put the bases back.
    await setSize("인터페이스 크기", 13);
    await setSize("콘텐츠 크기", 13.5);
    await setSize("코드 크기", 11.5);

    await page.reload();
    await page.waitForSelector(".connect__cmd", { timeout: 10000 });
    check("theme is applied on load, not after a click", (await theme(page)) === "light");
    await page.getByRole("button", { name: "설정" }).click();
    await page.waitForSelector('[role="dialog"][aria-label="설정"]', {
      timeout: 5000,
    });
    await openCategory(page, "동작");
    check(
      "the panel reopens on the stored values",
      await picked(page, "보내기 키", "⌘/Ctrl+Enter"),
    );
    // 5c. 알림: 완료 알림만 시점을 고르고, 소리는 그 옆에
    //     산다. 기본은 "오래 걸린 턴만" — 모든 턴마다 울리지 않는다.
    await openCategory(page, "알림");
    check("완료 알림 starts on 오래 걸린 턴만", await picked(page, "완료 알림", "오래 걸린 턴만"));
    await pick(page, "완료 알림", "모든 턴");
    await page.getByLabel("알림 소리").click();
    check(
      "the notification policy is stored like every other preference",
      (await stored(page))?.notifications?.done === "all" &&
        (await stored(page))?.notifications?.sound === false,
      JSON.stringify((await stored(page))?.notifications),
    );

    // 6. the 프로바이더 room pins the provider's own defaults; 대화 keeps the
    //    conversation behaviour. They persist like any other preference.
    await openCategory(page, "프로바이더");
    await page.getByLabel("생각 시간").selectOption("high");
    await openCategory(page, "대화");
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
    await openCategory(page, "프로바이더");
    const effortBack = (await page.getByLabel("생각 시간").inputValue()) === "high";
    await openCategory(page, "대화");
    check(
      "they come back on the values that were chosen",
      effortBack && (await page.getByLabel("확인 방식").inputValue()) === "plan",
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
    await openCategory(page, "대화");
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
    await openCategory(page, "대화");
    check(
      "and a reload keeps it, like every other choice",
      (await page.getByLabel("확인 방식").inputValue()) === "bypassPermissions",
    );

    // "생각·작업 과정" 스위치는 대화 고르기의 평지에 있다 — 접지 않기로
    // 한 결정. 기본은 꺼짐이라 평지에 있어도 대화를 어지럽히지 않는다.

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
    await openCategory(page, "대화");
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
    await openCategory(page, "대화");
    check("and a reload brings it back on", await page.getByLabel("작업 과정 보기").isChecked());

    // 7. the diagnostics are reachable and no longer the first thing in view.
    //    fold 는 패널에 하나 — 문제 해결의 "연결 정보".
    await openCategory(page, "문제 해결");
    check(
      "connection details sit behind a fold",
      (await page.locator(".settings__acc .settings__fold").count()) === 1 &&
        (await page.getByLabel("접속 주소").isVisible()) === false,
    );
    await page.getByText("고급 · 연결 정보", { exact: true }).click();
    check(
      "opening the fold reveals them",
      (await page.getByLabel("접속 주소").isVisible()) === true,
    );

    // 7b. the one dangerous action on this panel asks in the app's dialog —
    //     the native confirm stays silent, cancelling keeps all.
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
    await openCategory(page, "동작");
    await page
      .getByRole("radiogroup", { name: "보내기 키" })
      .getByRole("radio", { name: "Enter", exact: true })
      .focus();
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
    await openCategory(page, "동작");
    check("a non-string send key falls back too", await picked(page, "보내기 키", "Enter"));
    check(
      "an absent type size falls back to each axis' base",
      (await scaleVar("--ui-scale")) === 1 &&
        (await scaleVar("--content-scale")) === 1 &&
        (await scaleVar("--code-scale")) === 1,
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
