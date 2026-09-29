// 휴대폰 폭 넘침 점검(2026-09-29)의 시험 — 드라이버의 재료를 거르는 문턱(overflowOf),
// 화면 하나의 판정(judgeScreen), 게이트의 두 번째 열기(inspectScreens), 브리프 · 통계,
// 그리고 runGate 통합. 진짜 창 없이 가짜 드라이버로 돈다(재는 쪽은 desktop 의
// overflow-probe 이고, 그것은 진짜 Electron 창에서 따로 확인한다).
// `../dist` 임포트인 이유는 screen-check.test.ts 와 같다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BROWSER_TOOLS, type ToolDef } from "../dist/browser-tools.js";
import { COMMON_INSTRUCTIONS } from "../dist/common-instructions.js";
import type { DaemonNotice } from "../dist/notices.js";
import type {
  PreviewConsoleLine,
  PreviewDriver,
  PreviewDriverFactory,
  PreviewOpenResult,
  PreviewOverflow,
  PreviewViewport,
} from "../dist/preview-driver.js";
import {
  gateOutcomeStats,
  type PreviewDriverDeps,
  PreviewDrivers,
} from "../dist/preview-drivers.js";
import type { RepoWorkspace } from "../dist/repo.js";
import {
  gateBrief,
  inspectScreens,
  judgeScreen,
  MAX_GATE_SCREENS,
  MAX_OVERFLOW_OFFENDERS,
  MAX_TROUBLE_CAPTURES,
  OVERFLOW_TOLERANCE_PX,
  overflowOf,
  type ScreenTrouble,
} from "../dist/screen-gate.js";
import type { Session } from "../dist/session.js";

/** 문서가 `over` px 만큼 화면 밖으로 밀리는 재료 — 390 폭 화면. */
function measure(over: number, extra: Partial<PreviewOverflow> = {}): PreviewOverflow {
  return {
    viewportWidth: 390,
    documentWidth: 390 + over,
    scrollable: true,
    offenders: [{ label: "table.member-list", right: 390 + over }],
    ...extra,
  };
}

// ————— overflowOf — 재료를 문턱으로 거른다 —————

test("overflowOf — 재료가 없으면 판정도 없다", () => {
  assert.equal(overflowOf(undefined), null);
});

test("overflowOf — 뷰포트가 넘침을 가리면(scrollable 거짓) 문서가 밀리지 않으므로 세지 않는다", () => {
  assert.equal(overflowOf(measure(400, { scrollable: false })), null);
});

test("overflowOf — 문턱 안쪽의 차이는 반올림의 흔들림이다", () => {
  assert.equal(overflowOf(measure(0)), null);
  assert.equal(overflowOf(measure(OVERFLOW_TOLERANCE_PX)), null, "문턱과 같으면 세지 않는다");
  const over = overflowOf(measure(OVERFLOW_TOLERANCE_PX + 1));
  assert.notEqual(over, null, "문턱을 넘으면 밀림이다");
  assert.equal(over?.documentWidth, 390 + OVERFLOW_TOLERANCE_PX + 1);
  assert.equal(over?.viewportWidth, 390);
});

test("overflowOf — 숫자가 아닌 폭은 판정하지 않는다", () => {
  assert.equal(overflowOf(measure(400, { documentWidth: Number.NaN })), null);
  assert.equal(overflowOf(measure(400, { viewportWidth: Number.POSITIVE_INFINITY })), null);
});

test("overflowOf — 요소 줄은 한 줄로 조이고 폭은 반올림한다", () => {
  const got = overflowOf(
    measure(100, {
      viewportWidth: 390.4,
      documentWidth: 809.6,
      offenders: [{ label: '  table.member-list \n  "이름 이메일"  ', right: 808.4 }],
    }),
  );
  assert.deepEqual(got, {
    viewportWidth: 390,
    documentWidth: 810,
    offenders: ['table.member-list "이름 이메일" — 오른쪽 끝 808px'],
  });
});

test("overflowOf — 요소 줄은 개수와 길이에서 잘리고 못 믿을 항목은 버린다", () => {
  const offenders = [
    { label: "a".repeat(200), right: 500 },
    { label: "b", right: 600 },
    { label: "c", right: 700 },
    { label: "d", right: 800 },
  ];
  const got = overflowOf(measure(100, { offenders }));
  assert.equal(
    got?.offenders.length,
    MAX_OVERFLOW_OFFENDERS,
    "드라이버가 더 줘도 여기서 한 번 더 지킨다",
  );
  assert.ok((got?.offenders[0] ?? "").startsWith(`${"a".repeat(60)} — `), "라벨은 60자에서 잘린다");

  const dirty = overflowOf(
    measure(100, {
      offenders: [
        null,
        { label: 7, right: 500 },
        { label: "x", right: Number.NaN },
        { label: "ok", right: 610 },
      ] as unknown as PreviewOverflow["offenders"],
    }),
  );
  assert.deepEqual(dirty?.offenders, ["ok — 오른쪽 끝 610px"]);

  const notAList = overflowOf(
    measure(100, { offenders: "?" as unknown as PreviewOverflow["offenders"] }),
  );
  assert.deepEqual(notAList?.offenders, [], "요소 줄이 배열이 아니어도 판정은 산다");
});

// ————— 가짜 드라이버 —————

interface ScreenScript {
  /** 데스크톱 폭으로 열었을 때의 답 — 없으면 멀쩡한 화면. */
  desktop?: PreviewOpenResult | (() => PreviewOpenResult);
  /** 휴대폰 폭으로 열었을 때의 답 — 없으면 멀쩡한 화면. */
  mobile?: PreviewOpenResult | (() => PreviewOpenResult);
  desktopLines?: PreviewConsoleLine[];
  mobileLines?: PreviewConsoleLine[];
}

/**
 * 화면마다 폭별 대본이 있는 가짜 드라이버. 부른 open 과, 그림을 찍은 순간 창이 어느
 * 화면 · 어느 폭에 서 있었는지를 기록한다.
 */
function scriptedDriver(script: Record<string, ScreenScript>): {
  driver: PreviewDriver;
  opens: string[];
  shots: string[];
} {
  const opens: string[] = [];
  const shots: string[] = [];
  let standing: { route: string; viewport: PreviewViewport } | null = null;
  const driver: PreviewDriver = {
    async open(route, options) {
      const viewport = options?.viewport ?? "desktop";
      opens.push(`${route}@${viewport}`);
      standing = { route, viewport };
      const screen = script[route] ?? {};
      const answer = viewport === "mobile" ? screen.mobile : screen.desktop;
      const result = typeof answer === "function" ? answer() : answer;
      return result ?? { ok: true, settled: true };
    },
    async screenshot() {
      shots.push(`${standing?.route}@${standing?.viewport}`);
      return { data: "c2hvdA==", mediaType: "image/webp" };
    },
    async consoleLines() {
      const screen = script[standing?.route ?? ""] ?? {};
      return (standing?.viewport === "mobile" ? screen.mobileLines : screen.desktopLines) ?? [];
    },
    async destroy() {},
  };
  return { driver, opens, shots };
}

const overflowing = (over = 400): ScreenScript => ({
  mobile: { ok: true, settled: true, overflow: measure(over) },
});

// ————— judgeScreen —————

test("judgeScreen — 휴대폰 폭에서 문턱을 넘은 밀림은 overflow 로 실린다", async () => {
  const { driver, opens } = scriptedDriver({ "/a": overflowing() });
  const verdict = await judgeScreen(driver, "/a", { viewport: "mobile" });
  assert.deepEqual(opens, ["/a@mobile"]);
  assert.ok(verdict.opened);
  if (!verdict.opened) return;
  assert.equal(verdict.overflow?.documentWidth, 790);
  assert.deepEqual(verdict.overflow?.offenders, ["table.member-list — 오른쪽 끝 790px"]);
});

test("judgeScreen — 밀리지 않거나 재료가 없으면 overflow 칸 자체가 없다", async () => {
  const { driver } = scriptedDriver({
    "/tiny": { mobile: { ok: true, settled: true, overflow: measure(OVERFLOW_TOLERANCE_PX) } },
    "/none": {},
  });
  for (const route of ["/tiny", "/none"]) {
    const verdict = await judgeScreen(driver, route, { viewport: "mobile" });
    assert.ok(verdict.opened);
    if (!verdict.opened) continue;
    assert.equal("overflow" in verdict, false, `${route} 는 칸이 없다`);
  }
});

test("judgeScreen — 다 로드되지 못한 문서의 폭은 재지 않은 것으로 친다", async () => {
  const { driver } = scriptedDriver({
    "/a": { mobile: { ok: true, settled: false, overflow: measure(400) } },
  });
  const verdict = await judgeScreen(driver, "/a", { viewport: "mobile" });
  assert.ok(verdict.opened);
  if (!verdict.opened) return;
  assert.equal(verdict.unsettled, true);
  assert.equal("overflow" in verdict, false);
});

// ————— inspectScreens — 게이트의 두 번째 열기 —————

test("inspectScreens — 데스크톱에서 멀쩡한 화면은 휴대폰 폭으로 한 번 더 열고, 밀리면 문제다", async () => {
  const { driver, opens, shots } = scriptedDriver({ "/list": overflowing() });
  const troubles = await inspectScreens(driver, [{ route: "/list" }]);
  assert.deepEqual(
    opens,
    ["/list@desktop", "/list@mobile"],
    "데스크톱 → 휴대폰 순서, 화면당 두 번",
  );
  assert.equal(troubles.length, 1);
  const trouble = troubles[0] as ScreenTrouble;
  assert.equal(trouble.route, "/list");
  assert.equal(trouble.overflow?.documentWidth, 790);
  // 넘침만이 문제다 — 다른 칸은 멀쩡하다.
  assert.equal(trouble.unsettled, false);
  assert.equal(trouble.blank, false);
  assert.deepEqual(trouble.lines, []);
  assert.equal(trouble.consoleCount, 0);
  assert.equal(trouble.netCount, 0);
  // 그림은 창이 휴대폰 폭에 서 있을 때 찍힌다 — 휴대폰 폭의 문제는 휴대폰 폭의 그림이다.
  assert.deepEqual(shots, ["/list@mobile"]);
  assert.ok(trouble.capture);
});

test("inspectScreens — 휴대폰에서도 멀쩡하면 문제가 없고 그림도 없다", async () => {
  const { driver, opens, shots } = scriptedDriver({ "/ok": {} });
  assert.deepEqual(await inspectScreens(driver, [{ route: "/ok" }]), []);
  assert.deepEqual(opens, ["/ok@desktop", "/ok@mobile"]);
  assert.deepEqual(shots, []);
});

test("inspectScreens — 데스크톱에서 이미 문제인 화면은 휴대폰 폭으로 다시 열지 않는다", async () => {
  const { driver, opens } = scriptedDriver({
    "/console": { desktopLines: [{ level: "error", text: "렌더가 죽었다" }], ...overflowing() },
    "/blank": { desktop: { ok: true, settled: true, blank: true }, ...overflowing() },
    "/unsettled": { desktop: { ok: true, settled: false }, ...overflowing() },
  });
  const troubles = await inspectScreens(driver, [
    { route: "/console" },
    { route: "/blank" },
    { route: "/unsettled" },
  ]);
  assert.deepEqual(opens, ["/console@desktop", "/blank@desktop", "/unsettled@desktop"]);
  assert.equal(troubles.length, 3);
  for (const trouble of troubles) {
    assert.equal(trouble.overflow, undefined, `${trouble.route} 의 문제는 넘침이 아니다`);
  }
});

test("inspectScreens — 휴대폰 폭에서만 나는 콘솔 오류 · 빈 화면은 이 게이트의 판정이 아니다", async () => {
  const { driver } = scriptedDriver({
    "/a": {
      mobile: { ok: true, settled: true, blank: true },
      mobileLines: [{ level: "error", text: "휴대폰에서만 난다" }],
    },
  });
  assert.deepEqual(await inspectScreens(driver, [{ route: "/a" }]), []);
});

test("inspectScreens — 휴대폰 폭으로 열지 못하면 조용히 넘어간다", async () => {
  const { driver, opens } = scriptedDriver({
    "/refused": { mobile: { ok: false, reason: "닫힘" } },
    "/thrown": {
      mobile: () => {
        throw new Error("창이 죽었다");
      },
    },
    "/next": overflowing(),
  });
  // /thrown 은 D3 재시도(1초 한숨)를 한 번 지나간다 — 그래도 판정 없이 넘어가야 한다.
  const troubles = await inspectScreens(driver, [
    { route: "/refused" },
    { route: "/thrown" },
    { route: "/next" },
  ]);
  assert.deepEqual(
    troubles.map((trouble) => trouble.route),
    ["/next"],
    "못 연 화면은 판정이 아니고 다음 화면은 그대로 본다",
  );
  assert.equal(opens.filter((open) => open === "/thrown@mobile").length, 2, "D3 재시도는 한 번");
});

test("inspectScreens — 그림은 브리프 예산까지만 붙고 넘침 화면도 같은 예산을 쓴다", async () => {
  const routes = Array.from({ length: MAX_TROUBLE_CAPTURES + 1 }, (_, i) => `/s${i}`);
  const { driver } = scriptedDriver(Object.fromEntries(routes.map((r) => [r, overflowing()])));
  const troubles = await inspectScreens(
    driver,
    routes.map((route) => ({ route })),
  );
  assert.equal(troubles.length, MAX_TROUBLE_CAPTURES + 1);
  assert.equal(
    troubles.filter((trouble) => trouble.capture !== undefined).length,
    MAX_TROUBLE_CAPTURES,
  );
  assert.equal(troubles.at(-1)?.capture, undefined, "상한을 넘으면 글자만 간다");
});

test("inspectScreens — 다시 열어 보는 화면 수의 상한은 그대로다", async () => {
  const routes = Array.from({ length: MAX_GATE_SCREENS + 2 }, (_, i) => `/s${i}`);
  const { driver, opens } = scriptedDriver({});
  await inspectScreens(
    driver,
    routes.map((route) => ({ route })),
  );
  assert.equal(opens.length, MAX_GATE_SCREENS * 2, "상한까지의 화면을 각각 두 폭으로 본다");
  assert.ok(!opens.some((open) => open.startsWith(`/s${MAX_GATE_SCREENS}@`)));
});

// ————— gateBrief · gateOutcomeStats —————

function overflowTrouble(route: string, offenders: string[]): ScreenTrouble {
  return {
    route,
    unsettled: false,
    blank: false,
    lines: [],
    consoleCount: 0,
    netCount: 0,
    rescued: false,
    overflow: { viewportWidth: 390, documentWidth: 809, offenders },
  };
}

test("gateBrief — 넘침은 폭 · 삐져나온 요소 · 고치는 방향을 한 묶음으로 말한다", () => {
  const brief = gateBrief([
    overflowTrouble("/member/list", [
      'table.member-list "이름 이메일" — 오른쪽 끝 808px',
      "div.toolbar — 오른쪽 끝 604px",
    ]),
  ]);
  assert.equal(
    brief,
    [
      '<!-- nova-design:gate {"step":"화면 확인"} -->',
      "사용자가 가리킨 화면을 도구가 다시 열어 봤습니다. 아래를 고친 뒤 답해 주세요.",
      "",
      "### /member/list",
      "휴대폰 화면에서 문서 폭이 809px 로 화면 폭 390px 보다 넓어 옆으로 밀립니다. 화면 밖으로 삐져나온 요소:",
      '- table.member-list "이름 이메일" — 오른쪽 끝 808px',
      "- div.toolbar — 오른쪽 끝 604px",
      "PC 화면은 그대로 두고 휴대폰 폭에서만 고쳐 주세요 — 넘치는 요소를 화면 폭 안에 맞추고(표처럼 넓은 것은 그 안에서만 가로로 스크롤되게), body 의 overflow-x: hidden 으로 가리지 마세요. 이 레포가 반응형을 다루는 방식(브레이크포인트 · 유틸리티 · 공용 컴포넌트)이 있으면 그것을 따르세요.",
    ].join("\n"),
  );
});

test("gateBrief — 원인 요소를 못 찾은 넘침은 요소 목록 없이 폭만 말한다", () => {
  const brief = gateBrief([overflowTrouble("/a", [])]);
  assert.ok(brief.includes("옆으로 밀립니다.\nPC 화면은 그대로"), "머리 줄이 콜론 없이 끝난다");
  assert.ok(!brief.includes("삐져나온 요소"));
});

test("gateBrief — 넘침은 같은 화면의 다른 문제 뒤 · 콘솔 오류 앞에 선다", () => {
  const brief = gateBrief([
    {
      ...overflowTrouble("/a", []),
      blank: true,
      lines: [{ level: "error", text: "못 찾겠다" }],
      consoleCount: 1,
    },
  ]);
  const blankAt = brief.indexOf("화면이 비어 있습니다");
  const overflowAt = brief.indexOf("옆으로 밀립니다");
  const consoleAt = brief.indexOf("error: 못 찾겠다");
  assert.ok(blankAt > 0 && overflowAt > blankAt && consoleAt > overflowAt);
});

test("gateOutcomeStats — 밀린 화면 수를 센다", () => {
  const troubles = [
    overflowTrouble("/a", []),
    overflowTrouble("/b", []),
    { ...overflowTrouble("/c", []), overflow: undefined, blank: true },
  ];
  const stats = gateOutcomeStats({ status: "trouble", kept: 3, troubles });
  assert.equal(stats.overflow, 2);
  assert.equal(stats.blank, 1);
  assert.equal(stats.consoleLines, 0);
  assert.equal("overflow" in gateOutcomeStats({ status: "ok", kept: 1 }), false);
});

// ————— runGate 통합 —————

interface SentTurn {
  text: string;
  attachments: Array<{ name: string; mediaType: string; data: string }>;
}

function factoryOf(script: Record<string, ScreenScript>): PreviewDriverFactory {
  return { forIsolated: () => scriptedDriver(script).driver };
}

function fakeDeps(factory: PreviewDriverFactory): PreviewDriverDeps & {
  sent: SentTurn[];
  notices: DaemonNotice[];
} {
  const sent: SentTurn[] = [];
  const notices: DaemonNotice[] = [];
  const session = {
    state: "idle",
    title: "회원 목록",
    send: (text: string, attachments?: SentTurn["attachments"]) => {
      sent.push({ text, attachments: attachments ?? [] });
    },
  };
  const repo = { status: async () => ({ previewUrl: "http://127.0.0.1:5274" }) };
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

test("runGate — 휴대폰에서 밀리는 화면은 게이트 턴이 서고 휴대폰 폭의 그림이 붙는다", async () => {
  const deps = fakeDeps(factoryOf({ "/list": overflowing() }));
  const drivers = new PreviewDrivers(deps);
  drivers.notePinned("s1", "/list");
  const outcome = await drivers.runGate("s1");
  assert.equal(outcome.status, "trouble");
  assert.equal(gateOutcomeStats(outcome).overflow, 1);
  assert.equal(deps.sent.length, 1);
  assert.ok(deps.sent[0]?.text.includes("### /list"));
  assert.ok(deps.sent[0]?.text.includes("옆으로 밀립니다"));
  assert.equal(deps.sent[0]?.attachments.length, 1);
  assert.equal(drivers.gatedSessions.has("s1"), true, "사람의 턴 하나에 게이트는 한 번이다");
  assert.deepEqual(
    deps.notices.map((notice) => notice.kind),
    ["gate"],
  );
});

test("runGate — 두 폭 모두 멀쩡하면 통과다", async () => {
  const deps = fakeDeps(factoryOf({ "/list": {} }));
  const drivers = new PreviewDrivers(deps);
  drivers.notePinned("s1", "/list");
  const outcome = await drivers.runGate("s1");
  assert.equal(outcome.status, "ok");
  assert.equal(deps.sent.length, 0);
});

// ————— AI 에게 하는 말 —————

test("screen_check 도구와 공통 지침은 overflow 칸을 AI 에게 알린다", () => {
  const tool = BROWSER_TOOLS.find((entry) => entry.name === "screen_check") as ToolDef;
  assert.match(tool.description, /overflow/, "도구 설명이 돌려주는 칸을 말한다");
  assert.match(COMMON_INSTRUCTIONS, /overflow/, "공통 지침이 휴대폰 폭 확인의 뜻을 말한다");
});
