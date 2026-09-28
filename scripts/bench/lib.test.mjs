/**
 * 재생 벤치 순수 함수의 시험 — `pnpm test` 가 scripts/bench/*.test.mjs 를
 * 함께 돌린다. 데몬이나 미리보기는 부르지 않는다.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  collectRows,
  compareResults,
  judge,
  loadScenarios,
  median,
  pinHints,
  pinsOf,
  pinTurnText,
  renderCompareTable,
  renderSummaryTable,
  statsFiles,
  summaryOf,
  turnProgress,
  validateScenarios,
} from "./lib.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const turn = (over = {}) => ({
  at: "2026-09-28T01:00:00.000Z",
  sessionId: "s1",
  kind: "user",
  isError: false,
  durationMs: 10_000,
  tools: { read: 2, edit: 1, exec: 3, browser: 1, other: 0 },
  contextTokens: 12_000,
  firstEditMs: 9_000,
  browserMs: 400,
  ...over,
});
const gate = (over = {}) => ({
  at: "2026-09-28T01:01:00.000Z",
  sessionId: "s1",
  kind: "gateset",
  gateMs: 3_000,
  screens: 1,
  reopened: false,
  ...over,
});

// ---------------------------------------------------------------------------
// 시나리오 검증
// ---------------------------------------------------------------------------

test("시나리오 검증 — 저장소의 두 시나리오 파일은 통과한다", () => {
  assert.doesNotThrow(() => loadScenarios(join(HERE, "scenarios/fixture.json")));
  assert.doesNotThrow(() => loadScenarios(join(HERE, "scenarios/cds.json")));
});

test("시나리오 검증 — 필수 칸 · 종류 · 중복 id", () => {
  assert.throws(() => validateScenarios([]), /비어 있지 않은 배열/);
  assert.throws(
    () => validateScenarios([{ id: "a", kind: "reply", text: "x", expect: { files: ["a"] } }]),
    /kind 는/,
  );
  assert.throws(
    () => validateScenarios([{ id: "a", kind: "user", expect: { files: ["a"] } }]),
    /text 가 없습니다/,
  );
  assert.throws(
    () =>
      validateScenarios([
        { id: "a", kind: "pin", note: "메모", pins: [], expect: { files: ["a"] } },
      ]),
    /pins 목록이 없습니다/,
  );
  assert.throws(
    () =>
      validateScenarios([
        {
          id: "a",
          kind: "pin",
          note: "메모",
          pins: [{ screen: "list" }],
          expect: { files: ["a"] },
        },
      ]),
    /pins\[0\] 의 text/,
  );
  assert.throws(
    () => validateScenarios([{ id: "a", kind: "user", text: "x", expect: {} }]),
    /expect\.files/,
  );
  const ok = { id: "a", kind: "user", text: "x", expect: { files: ["a"] } };
  assert.throws(() => validateScenarios([ok, { ...ok }]), /겹칩니다/);
  assert.doesNotThrow(() => validateScenarios([ok]));
});

// ---------------------------------------------------------------------------
// 핀 턴
// ---------------------------------------------------------------------------

const PIN = {
  id: "pin-title",
  kind: "pin",
  note: "제목을 더 크게 해 줘",
  pins: [{ screen: "list", text: "회원 목록" }],
  expect: { files: ["server.js"] },
};

test("핀 턴 — 마커로 시작하고 items 의 id 가 pinHints 의 id 와 같다", () => {
  const text = pinTurnText(PIN);
  assert.ok(text.startsWith("<!-- colo-design:comments "));
  const firstLine = text.split("\n")[0];
  const marker = JSON.parse(
    firstLine.replace(/^<!-- colo-design:comments /, "").replace(/ -->$/, ""),
  );
  const hints = pinHints(PIN);
  assert.deepEqual(
    marker.items.map((item) => item.id),
    hints.map((hint) => hint.id),
  );
  assert.equal(marker.screen, "list");
  assert.equal(marker.note, "제목을 더 크게 해 줘");
  assert.equal(hints[0].screen, "list");
  assert.deepEqual(pinsOf(PIN), [{ screen: "list" }]);
});

test("핀 턴 — 문장 · 안내 한 줄 · 핀 줄 · 메모 한 줄", () => {
  // 마커 한 줄 다음이 본문이다: 문장, 빈 줄, 안내, 빈 줄, 핀 줄, 메모 줄.
  const [, sentence, blank, guide, blank2, pinLine, memoLine] = pinTurnText(PIN).split("\n");
  assert.equal(sentence, "제목을 더 크게 해 줘");
  assert.equal(blank, "");
  assert.equal(guide, "아래는 사용자가 가리킨 자리입니다 — 사용자의 말대로 해 주세요.");
  assert.equal(blank2, "");
  assert.equal(pinLine, '1. 회원 목록 — "회원 목록"');
  assert.equal(memoLine, "   제목을 더 크게 해 줘");
});

// ---------------------------------------------------------------------------
// 행 모으기 — 다른 세션 · 깨진 줄 무시 · 이틀 치
// ---------------------------------------------------------------------------

test("행 모으기 — 이틀 치를 시간 순으로, 남의 것과 깨진 줄은 무시한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-bench-"));
  const yesterday = join(dir, "turn-stats-2026-09-27.jsonl");
  const today = join(dir, "turn-stats-2026-09-28.jsonl");
  writeFileSync(
    yesterday,
    [
      JSON.stringify(turn({ at: "2026-09-27T23:59:00.000Z", sessionId: "other" })),
      "깨진 줄 {",
      "",
      JSON.stringify(turn({ at: "2026-09-27T23:58:00.000Z" })),
    ].join("\n"),
  );
  writeFileSync(
    today,
    [
      JSON.stringify(gate({ at: "2026-09-28T00:00:30.000Z" })),
      JSON.stringify(turn({ at: "2026-09-28T00:00:00.000Z" })),
    ].join("\n"),
  );
  const rows = collectRows([yesterday, today], "s1");
  assert.deepEqual(
    rows.map((row) => row.at),
    ["2026-09-27T23:58:00.000Z", "2026-09-28T00:00:00.000Z", "2026-09-28T00:00:30.000Z"],
  );

  const files = statsFiles("/logs", new Date("2026-09-28T12:00:00.000Z"));
  assert.deepEqual(
    files.map((file) => file.split("/").pop()),
    ["turn-stats-2026-09-28.jsonl", "turn-stats-2026-09-27.jsonl"],
  );
});

// ---------------------------------------------------------------------------
// 끝 판정
// ---------------------------------------------------------------------------

test("끝 판정 — 턴만 있으면 아직, 턴 뒤 gateset 이 오면 끝", () => {
  assert.deepEqual(turnProgress([turn()]), { done: false, waiting: "gateset" });
  assert.deepEqual(turnProgress([]), { done: false, waiting: "turn" });
  assert.deepEqual(turnProgress([turn(), gate()]), { done: true });
  // gateset 이 먼저 나오고 턴이 없으면 끝이 아니다.
  assert.deepEqual(turnProgress([gate()]), { done: false, waiting: "turn" });
});

test("끝 판정 — reopened 뒤에는 턴 하나를 더 기다린다", () => {
  const rows = [turn(), gate({ reopened: true })];
  assert.deepEqual(turnProgress(rows), { done: false, waiting: "reopen-turn" });
  const fixed = [...rows, turn({ at: "2026-09-28T01:05:00.000Z" })];
  assert.deepEqual(turnProgress(fixed), { done: true });
  // 게이트는 두 번 서지 않는다 — reopened 뒤의 gateset(skipped) 은 기다림이 아니다.
  const settled = [...fixed, gate({ at: "2026-09-28T01:06:00.000Z", skipped: "once" })];
  assert.deepEqual(turnProgress(settled), { done: true });
});

test("끝 판정 — 오류 · 중지로 끝난 턴은 gateset 을 기다리지 않는다", () => {
  // 오류 턴만 — 자동 보관이 서지 않아 gateset 행이 오지 않는다.
  assert.deepEqual(turnProgress([turn({ isError: true, failure: "stream" })]), { done: true });
  // 중지 턴만.
  assert.deepEqual(turnProgress([turn({ subtype: "interrupted" })]), { done: true });
  // reopened 뒤의 고침 턴이 오류로 끝나도 같은 규칙으로 끝난다.
  const reopenedThenError = [
    turn(),
    gate({ reopened: true }),
    turn({ at: "2026-09-28T01:05:00.000Z", isError: true }),
  ];
  assert.deepEqual(turnProgress(reopenedThenError), { done: true });
  // 오류 턴이 마지막이 아니면(뒤에 정상 턴이 이어지면) 규칙이 화하지 않는다.
  assert.deepEqual(
    turnProgress([turn({ isError: true }), turn({ at: "2026-09-28T01:02:00.000Z" })]),
    { done: false, waiting: "gateset" },
  );
});

// ---------------------------------------------------------------------------
// 판정
// ---------------------------------------------------------------------------

test("판정 — 파일 부분 일치 · 내용 · isError", () => {
  const scenario = {
    id: "s",
    kind: "user",
    text: "x",
    expect: { files: ["screens/member/"], contains: ["검색"] },
  };
  const contents = new Map([["src/screens/member/MemberList.screen.tsx", "여기 검색창이 있다"]]);
  assert.deepEqual(
    judge(scenario, ["src/screens/member/MemberList.screen.tsx"], contents, turn()),
    {
      pass: true,
      reasons: [],
    },
  );
  const noFile = judge(scenario, ["src/screens/order/OrderList.screen.tsx"], new Map(), turn());
  assert.equal(noFile.pass, false);
  assert.ok(noFile.reasons.some((reason) => reason.includes("screens/member/")));

  const noNeedle = judge(
    scenario,
    ["src/screens/member/MemberList.screen.tsx"],
    new Map([["src/screens/member/MemberList.screen.tsx", "없다"]]),
    turn(),
  );
  assert.ok(noNeedle.reasons.some((reason) => reason.includes("검색")));

  const errored = judge(
    { ...scenario, expect: { files: ["a"] } },
    ["a.ts"],
    new Map(),
    turn({ isError: true, failure: "stream" }),
  );
  assert.ok(errored.reasons.some((reason) => reason.includes("오류")));

  const noTurn = judge({ ...scenario, expect: { files: ["a"] } }, ["a.ts"], new Map(), null);
  assert.ok(noTurn.reasons.some((reason) => reason.includes("끝난 턴이 없습니다")));
});

// ---------------------------------------------------------------------------
// 요약과 비교
// ---------------------------------------------------------------------------

test("요약 칸 — 합 · 첫 턴의 첫 편집 · 컨텍스트 최대 · 게이트 재개", () => {
  const entry = {
    id: "search",
    pass: true,
    turns: [
      turn({ firstEditMs: 5_000, contextTokens: 10_000 }),
      turn({ contextTokens: 20_000, browserMs: null }),
    ],
    gate: gate({ reopened: true }),
  };
  const row = summaryOf(entry);
  assert.equal(row.pass, true);
  assert.equal(row.ms, 20_000);
  assert.equal(row.firstEditMs, 5_000);
  assert.equal(row.contextTokens, 20_000);
  assert.equal(row.browser, 2);
  assert.equal(row.browserMs, 400);
  assert.equal(row.exec, 6);
  assert.equal(row.reopened, true);

  const unmeasured = summaryOf({
    id: "x",
    pass: false,
    turns: [turn({ browserMs: null, contextTokens: null })],
  });
  assert.equal(unmeasured.browserMs, null);
  assert.equal(unmeasured.contextTokens, null);
  assert.equal(summaryOf({ id: "x", pass: false, turns: [] }).ms, 0);
});

test("비교 — 중앙값 · 변화율 · 한쪽에만 있는 id", () => {
  const a = {
    scenarios: [
      { id: "search", pass: true, turns: [turn({ durationMs: 10_000 })] },
      { id: "form", pass: true, turns: [turn({ durationMs: 4_000 })] },
    ],
  };
  const b = {
    scenarios: [
      {
        id: "search",
        pass: true,
        turns: [turn({ durationMs: 8_000 }), turn({ durationMs: 12_000 })],
      },
      { id: "new", pass: false, turns: [turn({ durationMs: 1_000 })] },
    ],
  };
  const rows = compareResults(a, b);
  assert.equal(rows.length, 3);
  const search = rows.find((row) => row.id === "search");
  assert.equal(search.ms.a, 10_000);
  // 한 번의 실행(= 시나리오 항목 하나)의 ms 는 그 턴들의 합이다 — 중앙값은 실행끼리 잰다.
  assert.equal(search.ms.b, 20_000);
  assert.equal(search.msChange, 1);
  const form = rows.find((row) => row.id === "form");
  assert.equal(form.ms.b, null);
  assert.equal(form.msChange, null);
  assert.equal(form.passB, 0);
  const fresh = rows.find((row) => row.id === "new");
  assert.equal(fresh.ms.a, null);
  assert.equal(fresh.passA, 0);
  assert.equal(fresh.msChange, null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test("표 — 헤더와 시나리오마다 한 줄씩", () => {
  const table = renderSummaryTable([{ id: "search", pass: true, turns: [turn()], gate: gate() }]);
  const lines = table.split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes("시나리오"));
  assert.ok(lines[2].includes("search"));
  const compare = renderCompareTable(compareResults({ scenarios: [] }, { scenarios: [] }));
  assert.ok(compare.includes("시나리오"));
});
