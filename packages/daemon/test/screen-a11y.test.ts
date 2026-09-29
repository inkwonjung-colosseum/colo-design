// 접근성 점검(2026-09-29)의 시험 — 대비 계산(contrastOf) · 재료를 거르는 문턱(a11yOf) ·
// 지난번과의 차(freshA11y) · 게이트의 기억(inspectScreens) · 브리프 · screen_check 인자 ·
// runGate 통합. 진짜 창 없이 가짜 드라이버로 돈다(재료를 모으는 쪽은 desktop 의
// a11y-probe 이고, 그것은 진짜 Electron 창에서 따로 확인한다).
// `../dist` 임포트인 이유는 screen-check.test.ts 와 같다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BROWSER_TOOLS, type ToolDef } from "../dist/browser-tools.js";
import { COMMON_INSTRUCTIONS } from "../dist/common-instructions.js";
import type { DaemonNotice } from "../dist/notices.js";
import type {
  PreviewA11y,
  PreviewDriver,
  PreviewDriverFactory,
  PreviewOpenOptions,
  PreviewOpenResult,
} from "../dist/preview-driver.js";
import {
  gateOutcomeStats,
  type PreviewDriverDeps,
  PreviewDrivers,
} from "../dist/preview-drivers.js";
import type { RepoWorkspace } from "../dist/repo.js";
import {
  type A11yBaseline,
  a11yLines,
  a11yOf,
  CONTRAST_SEVERE_RATIO,
  contrastOf,
  freshA11y,
  gateBrief,
  inspectScreens,
  judgeScreen,
  MAX_A11Y_BASELINE_ROUTES,
  MAX_A11Y_LINES,
  normalizeScreenCheckArgs,
  type ScreenA11y,
  type ScreenTrouble,
} from "../dist/screen-gate.js";
import type { Session } from "../dist/session.js";

type Text = PreviewA11y["texts"][number];

/** 글자 색 조합 하나 — 기본은 흰 배경 위의 16px. */
function text(color: [number, number, number, number], over: Partial<Text> = {}): Text {
  return {
    label: "p.hint",
    color,
    opacity: 1,
    backgrounds: ["rgb(255, 255, 255)"],
    fontSize: 16,
    fontWeight: 400,
    count: 1,
    ...over,
  };
}

const gray = (level: number, over: Partial<Text> = {}): Text =>
  text([level, level, level, 1], over);

const raw = (over: Partial<PreviewA11y> = {}): PreviewA11y => ({
  unnamed: [],
  unnamedTotal: 0,
  texts: [],
  ...over,
});

const iconButton = { role: "button", label: "button.icon-btn" };

/** 소수 둘째 자리까지 같은가 — WCAG 비율의 알려진 값과 견준다. */
const near = (got: number | null, want: number): void => {
  assert.ok(got !== null && Math.abs(got - want) < 0.02, `${got} ≈ ${want}`);
};

// ————— contrastOf — WCAG 대비 —————

test("contrastOf — 알려진 값과 같다: 검정/흰색 21, #767676 은 4.54, #ccc 는 1.6", () => {
  near(contrastOf(text([0, 0, 0, 1])), 21);
  near(contrastOf(gray(0x76)), 4.54);
  near(contrastOf(gray(0xcc)), 1.6);
  near(contrastOf(gray(0x88)), 3.54);
  near(contrastOf(gray(0xff)), 1);
});

test("contrastOf — 어두운 글자가 밝은 배경 위든 밝은 글자가 어두운 배경 위든 같은 비율이다", () => {
  near(contrastOf(text([255, 255, 255, 1], { backgrounds: ["rgb(0, 0, 0)"] })), 21);
  near(contrastOf(text([0, 0, 0, 1], { backgrounds: ["rgb(255, 255, 255)"] })), 21);
});

test("contrastOf — 그라디언트는 가장 나쁜 배경으로 잰다", () => {
  const onGradient = text([0x88, 0x88, 0x88, 1], {
    backgrounds: ["rgb(255, 255, 255)", "rgb(0, 0, 0)"],
  });
  near(contrastOf(onGradient), 3.54);
});

test("contrastOf — 불투명도와 글자색의 알파는 배경 위에 얹어 셈한다", () => {
  // #111 이 불투명도 0.3 이면 흰 배경 위에서 사실상 옅은 회색이다.
  near(contrastOf(gray(0x11, { opacity: 0.3 })), 1.99);
  // 검정 50% 는 흰 배경 위에서 127.5 회색이다 — 휘도 0.214 → 1.05 / 0.264 = 3.98.
  near(contrastOf(text([0, 0, 0, 0.5])), 3.98);
  // 글자색의 알파와 조상의 불투명도는 곱해진다: 0.5 × 0.5 = 0.25 → 191.25 회색 → 1.8.
  near(contrastOf(text([0, 0, 0, 0.5], { opacity: 0.5 })), 1.83);
});

test("contrastOf — 반투명 배경은 흰 종이 위에 놓인 것으로 본다", () => {
  // 흰 글자가 검정 50% 배경 위에 있다 — 배경은 127.5 회색이 되어 위와 같은 3.98 이다.
  const onHalfBlack = text([255, 255, 255, 1], { backgrounds: ["rgba(0, 0, 0, 0.5)"] });
  near(contrastOf(onHalfBlack), 3.98);
});

test("contrastOf — 현대 표기 rgb(r g b / a) 와 백분율 알파도 읽는다", () => {
  near(contrastOf(text([255, 255, 255, 1], { backgrounds: ["rgb(0 0 0 / 100%)"] })), 21);
});

test("contrastOf — 못 읽는 색이면 null 이다(못 센 침묵이 잘못된 지적보다 싸다)", () => {
  assert.equal(contrastOf(text([Number.NaN, 0, 0, 1])), null);
  assert.equal(contrastOf(text([0, 0, 0, 1], { backgrounds: [] })), null);
  assert.equal(contrastOf(text([0, 0, 0, 1], { backgrounds: ["oklch(0.5 0.1 200)"] })), null);
  assert.equal(contrastOf(text([0, 0, 0, 1], { backgrounds: ["rgb(999, 0, 0)"] })), null);
  assert.equal(
    contrastOf({ ...text([0, 0, 0, 1]), color: "red" as unknown as Text["color"] }),
    null,
  );
  // 읽는 배경이 하나라도 있으면 그것으로 잰다.
  near(contrastOf(text([0, 0, 0, 1], { backgrounds: ["???", "rgb(255, 255, 255)"] })), 21);
});

// ————— a11yOf — 재료를 문턱으로 거르고 묶는다 —————

test("a11yOf — 재료가 없으면 null, 잰 결과 깨끗하면 빈 목록이다", () => {
  assert.equal(a11yOf(undefined), null);
  assert.deepEqual(a11yOf(raw()), { unnamed: [], contrast: [], truncated: false });
});

test("a11yOf — 이름 없는 컨트롤은 같은 것끼리 묶어 많은 순으로 선다", () => {
  const checkbox = { role: "checkbox", label: "input[type=checkbox]" };
  const got = a11yOf(
    raw({
      unnamed: [
        iconButton,
        checkbox,
        checkbox,
        checkbox,
        iconButton,
        { role: "textbox", label: "input.q" },
      ],
      unnamedTotal: 6,
    }),
  );
  assert.deepEqual(got?.unnamed, [
    { role: "checkbox", label: "input[type=checkbox]", count: 3 },
    { role: "button", label: "button.icon-btn", count: 2 },
    { role: "textbox", label: "input.q", count: 1 },
  ]);
  assert.equal(got?.truncated, false, "표본이 전체와 같으면 잘리지 않았다");
});

test("a11yOf — 같은 role 이라도 라벨이 다르면 다른 묶음이고, 같은 라벨이라도 role 이 다르면 다른 묶음이다", () => {
  const got = a11yOf(
    raw({
      unnamed: [
        { role: "button", label: "a" },
        { role: "button", label: "b" },
        { role: "link", label: "a" },
      ],
      unnamedTotal: 3,
    }),
  );
  assert.equal(got?.unnamed.length, 3);
});

test("a11yOf — 표본이 전체보다 적으면 truncated 다", () => {
  const got = a11yOf(raw({ unnamed: [iconButton, iconButton], unnamedTotal: 130 }));
  assert.equal(got?.truncated, true);
  assert.equal(a11yOf(raw({ unnamed: [iconButton], unnamedTotal: Number.NaN }))?.truncated, false);
});

test("a11yOf — 모양이 틀린 항목은 버리고 글자는 다시 조인다", () => {
  const dirty = a11yOf(
    raw({
      unnamed: [
        null,
        { role: 7, label: "x" },
        { role: "button", label: "   " },
        { role: "button", label: "  button \n .weird  " },
      ] as unknown as PreviewA11y["unnamed"],
      unnamedTotal: 4,
      texts: [
        null,
        { ...gray(0xcc), label: 5 },
        gray(0xcc, { label: "  p \n .hint " }),
      ] as unknown as PreviewA11y["texts"],
    }),
  );
  assert.deepEqual(dirty?.unnamed, [{ role: "button", label: "button .weird", count: 1 }]);
  assert.deepEqual(
    dirty?.contrast.map((row) => row.label),
    ["p .hint"],
  );
  const notLists = a11yOf({
    unnamed: "?",
    unnamedTotal: 0,
    texts: 3,
  } as unknown as PreviewA11y);
  assert.deepEqual(notLists, { unnamed: [], contrast: [], truncated: false });
});

test("a11yOf — 대비는 3:1 미만만 문제고, 낮은 순으로 선다", () => {
  const got = a11yOf(
    raw({
      texts: [
        gray(0x88, { label: "p.mid" }), // 3.5 — AA 에는 못 미치지만 문제로 세지 않는다
        gray(0xcc, { label: "p.faint" }), // 1.6
        gray(0xaa, { label: "p.big", fontSize: 32.4, count: 4 }), // 2.3
        gray(0x77, { label: "p.ok" }), // 4.48
        text([255, 255, 255, 1], { label: "p.ghost" }), // 1.0
      ],
    }),
  );
  assert.deepEqual(got?.contrast, [
    { label: "p.ghost", ratio: 1, fontSize: 16, count: 1 },
    { label: "p.faint", ratio: 1.6, fontSize: 16, count: 1 },
    { label: "p.big", ratio: 2.3, fontSize: 32, count: 4 },
  ]);
});

test("a11yOf — 문턱(3:1) 위아래: 2.9 는 문제, 딱 문턱은 문제가 아니다", () => {
  // #999 는 2.85:1, #949494 는 3.03:1.
  assert.equal(a11yOf(raw({ texts: [gray(0x99)] }))?.contrast.length, 1);
  assert.equal(a11yOf(raw({ texts: [gray(0x94)] }))?.contrast.length, 0);
  assert.equal(CONTRAST_SEVERE_RATIO, 3);
});

test("a11yOf — 색을 못 읽은 글자는 판정하지 않는다", () => {
  const got = a11yOf(raw({ texts: [gray(0xcc, { backgrounds: [] }), gray(0xcc)] }));
  assert.equal(got?.contrast.length, 1);
});

// ————— freshA11y — 지난번과의 차 —————

const sample = (): ScreenA11y => ({
  unnamed: [{ role: "button", label: "button.icon-btn", count: 3 }],
  contrast: [{ label: "p.hint", ratio: 1.9, fontSize: 16, count: 2 }],
  truncated: false,
});

test("freshA11y — 처음 보는 화면은 전부 새것이고, 그 지문이 기억이 된다", () => {
  const { fresh, seen } = freshA11y(undefined, sample());
  assert.deepEqual(fresh, sample());
  assert.equal(seen.size, 2);
});

test("freshA11y — 지난번과 같은 문제는 다시 말하지 않는다", () => {
  const { seen } = freshA11y(undefined, sample());
  const again = freshA11y(seen, sample());
  assert.equal(again.fresh, null);
  assert.deepEqual([...again.seen].sort(), [...seen].sort());
});

test("freshA11y — 개수나 비율이 움직여도 같은 문제다", () => {
  const { seen } = freshA11y(undefined, sample());
  const moved = sample();
  moved.unnamed[0] = { role: "button", label: "button.icon-btn", count: 9 };
  moved.contrast[0] = { label: "p.hint", ratio: 2.4, fontSize: 16, count: 5 };
  assert.equal(freshA11y(seen, moved).fresh, null);
});

test("freshA11y — 새 문제만 남는다", () => {
  const { seen } = freshA11y(undefined, sample());
  const grown = sample();
  grown.unnamed.push({ role: "textbox", label: "input.q", count: 1 });
  const { fresh } = freshA11y(seen, grown);
  assert.deepEqual(fresh?.unnamed, [{ role: "textbox", label: "input.q", count: 1 }]);
  assert.deepEqual(fresh?.contrast, [], "옛 대비 문제는 빠진다");
});

test("freshA11y — 글자 크기가 다르면 다른 대비 문제다", () => {
  const { seen } = freshA11y(undefined, sample());
  const bigger = sample();
  bigger.contrast[0] = { label: "p.hint", ratio: 1.9, fontSize: 24, count: 2 };
  assert.equal(freshA11y(seen, bigger).fresh?.contrast.length, 1);
});

test("freshA11y — 고쳐서 사라졌다가 되돌아온 문제는 다시 새것이다(기억을 합치지 않고 갈아 끼운다)", () => {
  const first = freshA11y(undefined, sample());
  const fixed = freshA11y(first.seen, {
    unnamed: [],
    contrast: [],
    truncated: false,
  });
  assert.equal(fixed.fresh, null);
  assert.equal(fixed.seen.size, 0, "깨끗한 점검의 기억은 비어 있다");
  const regressed = freshA11y(fixed.seen, sample());
  assert.deepEqual(regressed.fresh, sample(), "되돌아온 것은 다시 말한다");
});

test("freshA11y — 재료가 없으면(null) 새것도 기억도 없다", () => {
  const got = freshA11y(new Set(["unnamed|button|x"]), null);
  assert.equal(got.fresh, null);
  assert.equal(got.seen.size, 0);
});

// ————— a11yLines —————

test("a11yLines — 이름 없는 것은 라벨과 곳 수, 흐린 글자는 비율과 크기", () => {
  const lines = a11yLines({
    unnamed: [
      { role: "checkbox", label: "input[type=checkbox]", count: 30 },
      { role: "button", label: "button.icon-btn", count: 1 },
    ],
    contrast: [
      { label: "p.hint", ratio: 1.9, fontSize: 16, count: 1 },
      { label: "td", ratio: 2.4, fontSize: 14, count: 12 },
    ],
    truncated: false,
  });
  assert.deepEqual(lines.unnamed, ["input[type=checkbox] — 30곳", "button.icon-btn"]);
  assert.deepEqual(lines.contrast, ["p.hint — 대비 1.9:1 (16px)", "td — 대비 2.4:1 (14px, 12곳)"]);
});

test("a11yLines — 줄 상한을 넘거나 표본이 잘렸으면 '더 있다' 한 줄이 붙는다", () => {
  const many = Array.from({ length: MAX_A11Y_LINES + 2 }, (_, i) => ({
    role: "button",
    label: `button.b${i}`,
    count: 1,
  }));
  const lines = a11yLines({ unnamed: many, contrast: [], truncated: false });
  assert.equal(lines.unnamed.length, MAX_A11Y_LINES + 1);
  assert.equal(lines.unnamed.at(-1), "그 밖에도 더 있습니다");

  const truncated = a11yLines({
    unnamed: [many[0] as (typeof many)[number]],
    contrast: [],
    truncated: true,
  });
  assert.deepEqual(truncated.unnamed, ["button.b0", "그 밖에도 더 있습니다"]);
  // 이름 없는 것이 없으면 잘렸다는 말도 없다.
  assert.deepEqual(a11yLines({ unnamed: [], contrast: [], truncated: true }).unnamed, []);
});

// ————— 가짜 드라이버 —————

interface A11yScript {
  /** 데스크톱 폭 열기의 접근성 재료 — 함수면 부를 때마다 새로 정한다. undefined 는 "못 쟀다". */
  a11y?: PreviewA11y | undefined | (() => PreviewA11y | undefined);
  desktop?: PreviewOpenResult;
  mobile?: PreviewOpenResult;
}

/** 접근성을 부탁받은 열기에만 재료를 싣는 가짜 드라이버. */
function a11yDriver(script: Record<string, A11yScript>): {
  driver: PreviewDriver;
  opens: Array<{ route: string; options?: PreviewOpenOptions }>;
  shots: number;
} {
  const opens: Array<{ route: string; options?: PreviewOpenOptions }> = [];
  const state = { shots: 0 };
  const driver: PreviewDriver = {
    async open(route, options) {
      opens.push({ route, options });
      const screen = script[route] ?? {};
      if (options?.viewport === "mobile") return screen.mobile ?? { ok: true, settled: true };
      const base = screen.desktop ?? { ok: true as const, settled: true };
      if (!base.ok || options?.a11y !== true) return base;
      const material = typeof screen.a11y === "function" ? screen.a11y() : screen.a11y;
      return material === undefined ? base : { ...base, a11y: material };
    },
    async screenshot() {
      state.shots += 1;
      return { data: "c2hvdA==", mediaType: "image/webp" };
    },
    async consoleLines() {
      return [];
    },
    async destroy() {},
  };
  return {
    driver,
    opens,
    get shots() {
      return state.shots;
    },
  };
}

const findings = (): PreviewA11y =>
  raw({ unnamed: [iconButton, iconButton], unnamedTotal: 2, texts: [gray(0xcc)] });

// ————— judgeScreen —————

test("judgeScreen — 접근성을 부탁하면 재료를 판정으로 싣고, 열기에 그 부탁이 그대로 간다", async () => {
  const { driver, opens } = a11yDriver({ "/a": { a11y: findings() } });
  const verdict = await judgeScreen(driver, "/a", { a11y: true });
  assert.deepEqual(opens[0]?.options, { a11y: true });
  assert.ok(verdict.opened);
  if (!verdict.opened) return;
  assert.equal(verdict.a11y?.unnamed[0]?.count, 2);
  assert.equal(verdict.a11y?.contrast[0]?.ratio, 1.6);
});

test("judgeScreen — 깨끗하면 빈 목록, 못 쟀으면 칸이 없다, 부탁하지 않았어도 칸이 없다", async () => {
  const { driver } = a11yDriver({
    "/clean": { a11y: raw() },
    "/failed": { a11y: undefined },
  });
  const clean = await judgeScreen(driver, "/clean", { a11y: true });
  const failed = await judgeScreen(driver, "/failed", { a11y: true });
  const unasked = await judgeScreen(driver, "/clean");
  assert.ok(clean.opened && failed.opened && unasked.opened);
  if (!clean.opened || !failed.opened || !unasked.opened) return;
  assert.deepEqual(clean.a11y, { unnamed: [], contrast: [], truncated: false });
  assert.equal("a11y" in failed, false);
  assert.equal("a11y" in unasked, false);
});

test("judgeScreen — 다 로드되지 못한 화면의 재료는 버린다", async () => {
  const { driver } = a11yDriver({
    "/a": { desktop: { ok: true, settled: false }, a11y: findings() },
  });
  const verdict = await judgeScreen(driver, "/a", { a11y: true });
  assert.ok(verdict.opened);
  if (!verdict.opened) return;
  assert.equal("a11y" in verdict, false);
});

// ————— inspectScreens — 게이트의 기억 —————

test("inspectScreens — 기억을 주지 않으면 접근성은 보지도 묻지도 않는다", async () => {
  const { driver, opens } = a11yDriver({ "/a": { a11y: findings() } });
  assert.deepEqual(await inspectScreens(driver, [{ route: "/a" }]), []);
  assert.equal(opens[0]?.options, undefined, "데스크톱 열기에 부탁이 실리지 않는다");
});

test("inspectScreens — 새 접근성 문제는 그림 없는 문제로 선다", async () => {
  const baseline: A11yBaseline = new Map();
  const { driver, opens } = a11yDriver({ "/list": { a11y: findings() } });
  const troubles = await inspectScreens(driver, [{ route: "/list" }], { a11y: baseline });
  assert.equal(troubles.length, 1);
  const trouble = troubles[0] as ScreenTrouble;
  assert.equal(trouble.route, "/list");
  assert.equal(trouble.a11y?.unnamed[0]?.count, 2);
  assert.equal(trouble.overflow, undefined);
  assert.equal(trouble.capture, undefined, "이름 · 대비는 그림 없이 요소 줄이 말한다");
  // 접근성은 데스크톱 열기에서 함께 잰다 — 여는 값은 그대로다(데스크톱 + 휴대폰).
  assert.deepEqual(
    opens.map((open) => [
      open.route,
      open.options?.viewport ?? "desktop",
      open.options?.a11y === true,
    ]),
    [
      ["/list", "desktop", true],
      ["/list", "mobile", false],
    ],
  );
});

test("inspectScreens — 같은 문제는 두 번째 점검에서 조용하다", async () => {
  const baseline: A11yBaseline = new Map();
  const { driver } = a11yDriver({ "/list": { a11y: findings() } });
  assert.equal((await inspectScreens(driver, [{ route: "/list" }], { a11y: baseline })).length, 1);
  assert.equal((await inspectScreens(driver, [{ route: "/list" }], { a11y: baseline })).length, 0);
  assert.equal((await inspectScreens(driver, [{ route: "/list" }], { a11y: baseline })).length, 0);
});

test("inspectScreens — 그 뒤에 새로 생긴 문제만 다시 말한다", async () => {
  const baseline: A11yBaseline = new Map();
  let material = findings();
  const { driver } = a11yDriver({ "/list": { a11y: () => material } });
  await inspectScreens(driver, [{ route: "/list" }], { a11y: baseline });
  material = raw({
    unnamed: [iconButton, { role: "textbox", label: "input.q" }],
    unnamedTotal: 2,
    texts: [gray(0xcc)],
  });
  const [trouble] = await inspectScreens(driver, [{ route: "/list" }], { a11y: baseline });
  assert.deepEqual(trouble?.a11y?.unnamed, [{ role: "textbox", label: "input.q", count: 1 }]);
  assert.deepEqual(trouble?.a11y?.contrast, [], "옛 대비 문제는 다시 말하지 않는다");
});

test("inspectScreens — 화면마다 따로 기억한다", async () => {
  const baseline: A11yBaseline = new Map();
  const { driver } = a11yDriver({ "/a": { a11y: findings() }, "/b": { a11y: findings() } });
  assert.equal((await inspectScreens(driver, [{ route: "/a" }], { a11y: baseline })).length, 1);
  const second = await inspectScreens(driver, [{ route: "/a" }, { route: "/b" }], {
    a11y: baseline,
  });
  assert.deepEqual(
    second.map((trouble) => trouble.route),
    ["/b"],
    "/a 는 조용하고 처음 보는 /b 는 말한다",
  );
});

test("inspectScreens — 재료를 못 얻은 점검은 기억을 건드리지 않는다", async () => {
  const baseline: A11yBaseline = new Map();
  let material: PreviewA11y | undefined = findings();
  const { driver } = a11yDriver({ "/list": { a11y: () => material } });
  await inspectScreens(driver, [{ route: "/list" }], { a11y: baseline });
  material = undefined; // 브라우저가 답하지 못했다
  assert.deepEqual(await inspectScreens(driver, [{ route: "/list" }], { a11y: baseline }), []);
  material = findings();
  assert.deepEqual(
    await inspectScreens(driver, [{ route: "/list" }], { a11y: baseline }),
    [],
    "못 잰 점검이 '문제 없음'으로 기록됐다면 옛 문제가 새것으로 되풀이됐을 것이다",
  );
});

test("inspectScreens — 데스크톱 판정에서 이미 문제인 화면은 접근성을 보지도 기억하지도 않는다", async () => {
  const baseline: A11yBaseline = new Map();
  const { driver, opens } = a11yDriver({
    "/blank": { desktop: { ok: true, settled: true, blank: true }, a11y: findings() },
  });
  const troubles = await inspectScreens(driver, [{ route: "/blank" }], { a11y: baseline });
  assert.equal(troubles.length, 1);
  assert.equal(troubles[0]?.a11y, undefined);
  assert.equal(baseline.size, 0);
  assert.equal(opens.length, 1, "휴대폰 폭으로도 다시 열지 않는다");
});

test("inspectScreens — 접근성과 넘침이 함께면 한 화면의 한 문제 묶음이고 그림은 휴대폰 폭이다", async () => {
  const baseline: A11yBaseline = new Map();
  const fake = a11yDriver({
    "/list": {
      a11y: findings(),
      mobile: {
        ok: true,
        settled: true,
        overflow: {
          viewportWidth: 390,
          documentWidth: 800,
          scrollable: true,
          offenders: [{ label: "table.members", right: 800 }],
        },
      },
    },
  });
  const troubles = await inspectScreens(fake.driver, [{ route: "/list" }], { a11y: baseline });
  assert.equal(troubles.length, 1);
  assert.ok(troubles[0]?.a11y);
  assert.ok(troubles[0]?.overflow);
  assert.ok(troubles[0]?.capture, "넘침이 그림 예산을 쓴다");
  assert.equal(fake.shots, 1);
});

test("inspectScreens — 깨끗한 화면은 문제도 그림도 없고, 깨끗한 기억이 남는다", async () => {
  const baseline: A11yBaseline = new Map();
  const fake = a11yDriver({ "/ok": { a11y: raw() } });
  assert.deepEqual(await inspectScreens(fake.driver, [{ route: "/ok" }], { a11y: baseline }), []);
  assert.equal(fake.shots, 0);
  assert.equal(baseline.get("/ok")?.size, 0);
});

test("inspectScreens — 기억은 화면 수에 상한이 있고 가장 오래된 화면부터 잊는다", async () => {
  const baseline: A11yBaseline = new Map();
  const total = MAX_A11Y_BASELINE_ROUTES + 12;
  // 재료가 없는 드라이버는 기억을 남기지 않으므로, 화면마다 깨끗한 재료를 준다.
  const clean = a11yDriver(
    Object.fromEntries(Array.from({ length: total }, (_, i) => [`/s${i}`, { a11y: raw() }])),
  );
  for (let start = 0; start < total; start += 6) {
    const routes = Array.from({ length: Math.min(6, total - start) }, (_, i) => ({
      route: `/s${start + i}`,
    }));
    await inspectScreens(clean.driver, routes, { a11y: baseline });
  }
  assert.equal(baseline.size, MAX_A11Y_BASELINE_ROUTES);
  assert.equal(baseline.has("/s0"), false, "가장 오래된 화면을 잊는다");
  assert.equal(baseline.has(`/s${total - 1}`), true);
});

// ————— gateBrief · gateOutcomeStats —————

function a11yTrouble(route: string, a11y: ScreenA11y): ScreenTrouble {
  return {
    route,
    unsettled: false,
    blank: false,
    lines: [],
    consoleCount: 0,
    netCount: 0,
    rescued: false,
    a11y,
  };
}

test("gateBrief — 접근성은 이름 · 대비 · 범위 문장을 한 묶음으로 말한다", () => {
  const brief = gateBrief([a11yTrouble("/member/list", sample())]);
  assert.equal(
    brief,
    [
      '<!-- nova-design:gate {"step":"화면 확인"} -->',
      "사용자가 가리킨 화면을 도구가 다시 열어 봤습니다. 아래를 고친 뒤 답해 주세요.",
      "",
      "### /member/list",
      "이름이 없는 컨트롤 · 그림이 있습니다 — 화면 낭독기가 읽어 줄 이름이 없습니다:",
      "- button.icon-btn — 3곳",
      "글자가 없는 버튼 · 링크에는 이름을, 입력칸에는 label 을, 그림에는 alt 를 달아 주세요. 이 레포가 이름을 다는 방식(컴포넌트의 속성 · aria-label · 숨김 글자)이 있으면 그것을 따르세요.",
      "글자와 배경의 대비가 너무 낮은 곳이 있습니다 — 3:1 도 안 되어 읽기 어렵습니다:",
      "- p.hint — 대비 1.9:1 (16px, 2곳)",
      "글자색을 배경에서 더 벌려 주세요. 이 레포가 색을 정하는 방식(토큰 · 테마 · 클래스)이 있으면 그 안에서 더 진한 색을 고르고, 레포의 규칙이 정해 둔 색이라 바꿀 수 없으면 바꾸지 말고 답에 그 사실을 한 줄 남겨 주세요.",
      "이번 턴에 만들거나 고친 요소의 문제만 고치고, 원래 있던 요소는 그대로 두세요. 고친 뒤에는 screen_check 의 a11y: true 로 확인해 주세요.",
    ].join("\n"),
  );
});

test("gateBrief — 어떤 연결 레포에도 맞는 말이다: 특정 디자인 시스템을 전제하지 않고 레포의 방식을 먼저 따르라고 한다", () => {
  const brief = gateBrief([
    {
      ...a11yTrouble("/a", sample()),
      overflow: { viewportWidth: 390, documentWidth: 800, offenders: [] },
    },
  ]);
  // 이 도구의 목표는 연결 레포가 정한 규칙으로 화면을 만드는 것이다 — CDS 든 Tailwind 든
  // 자체 CSS 든, 일반 규칙(접근성 · 반응형)이 레포의 규칙을 덮어쓰면 안 된다.
  assert.ok(
    !/디자인 ?시스템|CDS|design.?system/i.test(brief),
    "특정 디자인 시스템을 말하지 않는다",
  );
  for (const way of ["이름을 다는 방식", "색을 정하는 방식", "반응형을 다루는 방식"]) {
    assert.ok(brief.includes(`이 레포가 ${way}`), `고치는 방향이 '${way}' 를 먼저 따르라고 한다`);
  }
  // 레포의 규칙이 정한 색을 일반 규칙이 덮어쓰지 않게 — 바꿀 수 없으면 바꾸지 말고 사실만 남긴다.
  assert.ok(brief.includes("레포의 규칙이 정해 둔 색이라 바꿀 수 없으면 바꾸지 말고"));
});

test("gateBrief — 한쪽만 있으면 그쪽 문장만 서고 범위 문장은 한 번이다", () => {
  const onlyNames = gateBrief([a11yTrouble("/a", { ...sample(), contrast: [] })]);
  assert.ok(onlyNames.includes("이름이 없는 컨트롤"));
  assert.ok(!onlyNames.includes("대비가 너무 낮은"));
  assert.equal(onlyNames.split("이번 턴에 만들거나 고친 요소").length, 2);
  const onlyContrast = gateBrief([a11yTrouble("/a", { ...sample(), unnamed: [] })]);
  assert.ok(!onlyContrast.includes("이름이 없는 컨트롤"));
  assert.ok(onlyContrast.includes("대비가 너무 낮은"));
});

test("gateBrief — 접근성은 넘침 뒤 · 콘솔 오류 앞에 선다", () => {
  const brief = gateBrief([
    {
      ...a11yTrouble("/a", sample()),
      overflow: { viewportWidth: 390, documentWidth: 800, offenders: [] },
      lines: [{ level: "error", text: "못 찾겠다" }],
      consoleCount: 1,
    },
  ]);
  const overflowAt = brief.indexOf("옆으로 밀립니다");
  const a11yAt = brief.indexOf("이름이 없는 컨트롤");
  const consoleAt = brief.indexOf("error: 못 찾겠다");
  assert.ok(overflowAt > 0 && a11yAt > overflowAt && consoleAt > a11yAt);
});

test("gateOutcomeStats — 새 접근성 문제가 있던 화면 수를 센다", () => {
  const troubles = [
    a11yTrouble("/a", sample()),
    a11yTrouble("/b", sample()),
    { ...a11yTrouble("/c", sample()), a11y: undefined, blank: true },
  ];
  const stats = gateOutcomeStats({ status: "trouble", kept: 3, troubles });
  assert.equal(stats.a11y, 2);
  assert.equal("a11y" in gateOutcomeStats({ status: "ok", kept: 1 }), false);
});

// ————— screen_check 인자와 도구 —————

test("normalizeScreenCheckArgs — a11y 는 기본 끔, colorScheme 은 없으면 칸이 없다", () => {
  const plain = normalizeScreenCheckArgs({ route: "/a" }, "http://127.0.0.1:5274");
  assert.ok(plain.ok);
  if (!plain.ok) return;
  assert.equal(plain.a11y, false);
  assert.equal("colorScheme" in plain, false);

  const asked = normalizeScreenCheckArgs(
    { route: "/a", a11y: true, colorScheme: "dark" },
    "http://127.0.0.1:5274",
  );
  assert.ok(asked.ok);
  if (!asked.ok) return;
  assert.equal(asked.a11y, true);
  assert.equal(asked.colorScheme, "dark");
});

test("normalizeScreenCheckArgs — 참이 아닌 a11y 는 끔이고, 틀린 colorScheme 은 오류 문장이다", () => {
  const truthy = normalizeScreenCheckArgs({ route: "/a", a11y: "yes" }, "http://127.0.0.1:5274");
  assert.ok(truthy.ok);
  if (truthy.ok) assert.equal(truthy.a11y, false, "문자열 'yes' 는 참이 아니다");
  const bad = normalizeScreenCheckArgs(
    { route: "/a", colorScheme: "sepia" },
    "http://127.0.0.1:5274",
  );
  assert.ok(!bad.ok);
  if (!bad.ok) assert.match(bad.error, /colorScheme/);
});

test("screen_check 도구는 a11y · colorScheme 을 선언하고 공통 지침이 그 쓰임을 말한다", () => {
  const tool = BROWSER_TOOLS.find((entry) => entry.name === "screen_check") as ToolDef;
  assert.equal(tool.properties.a11y?.type, "boolean");
  assert.deepEqual(tool.properties.colorScheme?.enum, ["light", "dark"]);
  assert.match(tool.description, /a11y/);
  assert.match(COMMON_INSTRUCTIONS, /a11y: true/, "고친 뒤의 확인 방법을 말한다");
  assert.match(COMMON_INSTRUCTIONS, /aria-label/, "이름을 미리 다는 규칙을 말한다");
});

// ————— runGate 통합 —————

interface SentTurn {
  text: string;
  attachments: Array<{ name: string; mediaType: string; data: string }>;
}

function gateDeps(
  script: Record<string, A11yScript>,
  root: string,
): PreviewDriverDeps & { sent: SentTurn[]; notices: DaemonNotice[] } {
  const sent: SentTurn[] = [];
  const notices: DaemonNotice[] = [];
  const session = {
    state: "idle",
    title: "회원 목록",
    send: (text: string, attachments?: SentTurn["attachments"]) => {
      sent.push({ text, attachments: attachments ?? [] });
    },
  };
  const repo = { root, status: async () => ({ previewUrl: "http://127.0.0.1:5274" }) };
  const factory: PreviewDriverFactory = { forIsolated: () => a11yDriver(script).driver };
  return {
    sent,
    notices,
    factory: () => factory,
    activeRepo: () => repo as unknown as RepoWorkspace,
    session: () => session as unknown as Session,
    sessions: () => [session as unknown as Session],
    notice: (notice) => notices.push(notice),
  };
}

test("runGate — 새 접근성 문제는 게이트 턴이 서고, 같은 문제는 다음 사람의 턴에서 조용하다", async () => {
  const deps = gateDeps({ "/list": { a11y: findings() } }, "/projects/a");
  const drivers = new PreviewDrivers(deps);

  drivers.notePinned("s1", "/list");
  const first = await drivers.runGate("s1");
  assert.equal(first.status, "trouble");
  assert.equal(gateOutcomeStats(first).a11y, 1);
  assert.equal(deps.sent.length, 1);
  assert.ok(deps.sent[0]?.text.includes("이름이 없는 컨트롤"));
  assert.ok(deps.sent[0]?.text.includes("button.icon-btn — 2곳"));
  assert.equal(deps.sent[0]?.attachments.length, 0, "접근성만의 문제에는 그림이 없다");

  // 사람의 다음 턴 — 게이트가 다시 걸릴 수 있는 세션이 된다.
  drivers.gatedSessions.delete("s1");
  drivers.notePinned("s1", "/list");
  const second = await drivers.runGate("s1");
  assert.equal(second.status, "ok", "같은 문제는 지난번에 이미 말했다");
  assert.equal(deps.sent.length, 1);
});

test("runGate — 기억은 프로젝트마다 따로다", async () => {
  const script = { "/list": { a11y: findings() } };
  const a = gateDeps(script, "/projects/a");
  const b = gateDeps(script, "/projects/b");
  // 한 PreviewDrivers 가 두 프로젝트를 섬기는 모양 — 활성 레포만 바꾼다.
  let active = a;
  const drivers = new PreviewDrivers({
    ...a,
    activeRepo: () => active.activeRepo(),
    session: (id) => active.session(id),
  });
  drivers.notePinned("s1", "/list");
  assert.equal((await drivers.runGate("s1")).status, "trouble");
  drivers.gatedSessions.delete("s1");

  active = b;
  drivers.notePinned("s1", "/list");
  assert.equal(
    (await drivers.runGate("s1")).status,
    "trouble",
    "다른 프로젝트의 같은 주소는 처음 보는 화면이다",
  );
});
