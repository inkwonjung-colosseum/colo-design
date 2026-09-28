// PLAN-HARNESS §3.D 의 시험 — 게이트 브리프의 타입 절과 runGate 의 타입 갈래.
// 브리프는 순수 함수로, runGate 는 가짜 deps 로 부른다(진짜 창 · 진짜 tsc 없이).
// `../dist` 임포트인 이유는 type-check.test.ts 와 같다.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DaemonNotice } from "../dist/notices.js";
import type { PreviewDriver, PreviewDriverFactory } from "../dist/preview-driver.js";
import { type PreviewDriverDeps, PreviewDrivers } from "../dist/preview-drivers.js";
import type { RepoWorkspace } from "../dist/repo.js";
import { gateBrief, type ScreenTrouble } from "../dist/screen-gate.js";
import type { Session } from "../dist/session.js";

// ————— 브리프 —————

/** 문제 화면 하나 — 콘솔 오류 한 줄만 실은 최소 모양. */
function troubleOf(route: string): ScreenTrouble {
  return {
    route,
    unsettled: false,
    blank: false,
    lines: [{ level: "error", text: "못 찾겠다" }],
    consoleCount: 1,
    netCount: 0,
    rescued: false,
  };
}

test("gateBrief — 둘째 인자가 없으면 지금의 모양 그대로다", () => {
  const brief = gateBrief([troubleOf("/list")]);
  assert.equal(
    brief,
    [
      '<!-- nova-design:gate {"step":"화면 확인"} -->',
      "사용자가 가리킨 화면을 도구가 다시 열어 봤습니다. 아래를 고친 뒤 답해 주세요.",
      "",
      "### /list",
      "error: 못 찾겠다",
    ].join("\n"),
  );
});

test("gateBrief — 타입 절만 있으면 그 절만으로 게이트가 선다", () => {
  const brief = gateBrief([], ["- src/a.ts:3:7 TS2322 형식이 맞지 않습니다"]);
  assert.ok(brief.startsWith('<!-- nova-design:gate {"step":"화면 확인"} -->'));
  assert.ok(
    brief.includes("이번 턴에 고친 파일을 도구가 타입 검사했습니다. 아래를 고친 뒤 답해 주세요."),
  );
  assert.ok(brief.includes("사용자가 가리킨 화면을") === false);
  assert.ok(
    brief.includes(
      "### 타입 검사\n이번 턴에 고친 파일에서 타입 검사가 찾은 오류입니다.\n- src/a.ts:3:7 TS2322 형식이 맞지 않습니다",
    ),
  );
});

test("gateBrief — 화면 문제 뒤에 타입 절이 실린다", () => {
  const brief = gateBrief([troubleOf("/list")], ["- src/a.ts:3:7 TS2322 형식이 맞지 않습니다"]);
  assert.ok(brief.includes("사용자가 가리킨 화면을 도구가 다시 열어 봤습니다."));
  const screenAt = brief.indexOf("### /list");
  const typeAt = brief.indexOf("### 타입 검사");
  assert.ok(screenAt > 0 && typeAt > screenAt);
  assert.ok(brief.endsWith("- src/a.ts:3:7 TS2322 형식이 맞지 않습니다"));
});

// ————— runGate — 가짜 deps —————

interface SentTurn {
  text: string;
  attachments: Array<{ name: string; mediaType: string; data: string }>;
}

/** 문제 없는 화면만 여는 가짜 드라이버 — judgeScreen 이 문제를 못 찾는 길. */
const quietFactory: PreviewDriverFactory = {
  forIsolated(): PreviewDriver {
    return {
      open: async () => ({ ok: true as const, settled: true }),
      screenshot: async () => ({ data: "", mediaType: "image/png" }),
      consoleLines: async () => [],
      destroy: async () => undefined,
    };
  },
};

/** 콘솔 오류를 내는 가짜 드라이버 — 화면 문제를 만드는 길. */
function noisyFactory(): PreviewDriverFactory {
  return {
    forIsolated(): PreviewDriver {
      return {
        open: async () => ({ ok: true as const, settled: true }),
        screenshot: async () => ({ data: "aGk=", mediaType: "image/png" }),
        consoleLines: async () => [{ level: "error", text: "못 찾겠다" }],
        destroy: async () => undefined,
      };
    },
  };
}

interface DepsOptions {
  previewUrl?: string;
  typeTroubles?: { lines: string[]; errors: number; ms: number } | null;
  factory?: PreviewDriverFactory;
}

/** runGate 에 필요한 것만 있는 가짜 deps — 보낸 턴과 알림을 기록한다. */
function fakeDeps(opts: DepsOptions = {}): PreviewDriverDeps & {
  sent: SentTurn[];
  notices: DaemonNotice[];
} {
  const session = {
    state: "idle",
    title: "회원 목록",
    send: (text: string, attachments?: SentTurn["attachments"]) => {
      sent.push({ text, attachments: attachments ?? [] });
    },
  };
  const sent: SentTurn[] = [];
  const notices: DaemonNotice[] = [];
  const repo = {
    status: async () => (opts.previewUrl === undefined ? {} : { previewUrl: opts.previewUrl }),
  };
  return {
    sent,
    notices,
    factory: () => opts.factory ?? quietFactory,
    activeRepo: () => repo as unknown as RepoWorkspace,
    session: () => session as unknown as Session,
    sessions: () => [session as unknown as Session],
    notice: (notice) => notices.push(notice),
    ...(opts.typeTroubles === undefined ? {} : { typeTroubles: async () => opts.typeTroubles }),
  };
}

test("runGate — 화면 없이 타입 줄만으로 게이트 턴이 선다", async () => {
  const deps = fakeDeps({
    typeTroubles: { lines: ["- src/a.ts:3:7 TS2322 형식이 맞지 않습니다"], errors: 1, ms: 1200 },
  });
  const drivers = new PreviewDrivers(deps);
  const outcome = await drivers.runGate("s1");
  assert.equal(outcome.status, "trouble");
  assert.equal(outcome.typeErrors, 1);
  assert.equal(outcome.typeMs, 1200);
  assert.equal(deps.sent.length, 1);
  assert.ok(deps.sent[0]?.text.includes("### 타입 검사"));
  assert.ok(deps.sent[0]?.text.includes("이번 턴에 고친 파일을 도구가 타입 검사했습니다."));
  assert.equal(drivers.gatedSessions.has("s1"), true);
});

test("runGate — 미리보기가 없어도 타입 줄이면 보낸다", async () => {
  const deps = fakeDeps({
    typeTroubles: { lines: ["- a.ts:1:1 TS2322 오타"], errors: 1, ms: 300 },
  });
  const drivers = new PreviewDrivers(deps);
  drivers.notePinned("s1", "/list");
  const outcome = await drivers.runGate("s1");
  // 미리보기가 없으므로 화면 판정은 돌지 않는다 — 타입 절만 간다.
  assert.equal(outcome.status, "trouble");
  assert.equal(outcome.kept, 0);
  assert.equal(deps.sent.length, 1);
  assert.ok(deps.sent[0]?.text.includes("### 타입 검사"));
});

test("runGate — 타입 줄 없음은 지금과 같은 skipped, 돌렸으면 0 도 싣는다", async () => {
  const none = new PreviewDrivers(fakeDeps({ typeTroubles: null }));
  const outcome = await none.runGate("s1");
  assert.deepEqual(outcome, { status: "skipped", reason: "no-screens" });

  const checked = new PreviewDrivers(fakeDeps({ typeTroubles: { lines: [], errors: 0, ms: 640 } }));
  const zero = await checked.runGate("s1");
  assert.equal(zero.status, "skipped");
  assert.equal(zero.reason, "no-screens");
  assert.equal(zero.typeErrors, 0);
  assert.equal(zero.typeMs, 640);
});

test("runGate — 화면이 있는데 미리보기가 없고 타입 줄도 없으면 no-preview (F1)", async () => {
  const deps = fakeDeps({ typeTroubles: null });
  const drivers = new PreviewDrivers(deps);
  drivers.notePinned("s1", "/list");
  const outcome = await drivers.runGate("s1");
  assert.deepEqual(outcome, { status: "skipped", reason: "no-preview" });
  assert.equal(deps.sent.length, 0);
});

test("runGate — 화면 문제와 타입 줄이 한 브리프에 간다", async () => {
  const deps = fakeDeps({
    previewUrl: "http://127.0.0.1:5274",
    factory: noisyFactory(),
    typeTroubles: { lines: ["- a.ts:1:1 TS2322 오타"], errors: 1, ms: 300 },
  });
  const drivers = new PreviewDrivers(deps);
  drivers.notePinned("s1", "/list");
  const outcome = await drivers.runGate("s1");
  assert.equal(outcome.status, "trouble");
  assert.equal(outcome.kept, 1);
  assert.equal(outcome.typeErrors, 1);
  const text = deps.sent[0]?.text ?? "";
  assert.ok(text.includes("### /list"));
  assert.ok(text.includes("### 타입 검사"));
  // 문제 화면의 그림도 여전히 붙는다.
  assert.equal(deps.sent[0]?.attachments.length, 1);
});

test("runGate — 화면이 깨끗하고 타입 오류도 없으면 ok 에 0 을 싣는다", async () => {
  const deps = fakeDeps({
    previewUrl: "http://127.0.0.1:5274",
    typeTroubles: { lines: [], errors: 0, ms: 200 },
  });
  const drivers = new PreviewDrivers(deps);
  drivers.notePinned("s1", "/list");
  const outcome = await drivers.runGate("s1");
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.kept, 1);
  assert.equal(outcome.typeErrors, 0);
  assert.equal(deps.sent.length, 0);
});
