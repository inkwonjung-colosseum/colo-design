import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlanUsage } from "@nova-design/protocol";
// 순수 모듈 — src 에서 곧장 읽는다(turn-screens.test.ts 와 같은 모양).
import { L } from "../src/next/labels.ts";
import {
  refillWhen,
  USAGE_HOT_MIN,
  USAGE_WORD_MIN,
  usageHeat,
  usageReading,
  usageRowName,
  usageRows,
} from "../src/next/lib/usage.ts";

const plan = (
  five: number | null,
  week: number | null,
  extras: PlanUsage["modelWeekly"] = [],
): PlanUsage => ({
  subscriptionType: "max",
  fiveHour: five === null ? null : { utilization: five, resetsAt: "2026-09-25T08:40:00Z" },
  sevenDay: week === null ? null : { utilization: week, resetsAt: null },
  modelWeekly: extras,
});

const fable = (utilization: number): PlanUsage["modelWeekly"][number] => ({
  label: "Fable 주간",
  name: "Fable",
  period: "week",
  utilization,
  resetsAt: "2026-10-02T18:00:00Z",
});

test("usageRows: 창을 모두 — 5시간 · 이번 주 · 그 밖의 창이 서버의 차례로", () => {
  assert.deepEqual(usageRows(null), []);
  assert.deepEqual(usageRows(plan(null, null)), []);
  const rows = usageRows(plan(38.4, 12, [fable(7.6)]));
  assert.deepEqual(
    rows.map((row) => [row.window.kind, row.pct, row.resetsAt]),
    [
      ["fiveHour", 38, "2026-09-25T08:40:00Z"],
      ["sevenDay", 12, null],
      ["extra", 8, "2026-10-02T18:00:00Z"],
    ],
  );
  assert.equal(usageRows(plan(140, -3))[0]?.pct, 100);
  assert.equal(usageRows(plan(140, -3))[1]?.pct, 0);
});

test("usageReading: 칩 옆 한 단어는 가장 찬 창 하나 — 같으면 5시간", () => {
  assert.equal(usageReading(null), null);
  assert.equal(usageReading(plan(null, null)), null);
  assert.deepEqual(usageReading(plan(38.4, 12))?.window, { kind: "fiveHour" });
  assert.deepEqual(usageReading(plan(40, 81))?.window, { kind: "sevenDay" });
  assert.equal(usageReading(plan(40, 40, [fable(92)]))?.pct, 92);
  assert.deepEqual(usageReading(plan(50, 50))?.window, { kind: "fiveHour" });
});

test("usageRowName: 창의 이름 — 모델별 창은 이름 · 기간, 기간을 모르면 데몬의 이름", () => {
  const names = (value: PlanUsage) => usageRows(value).map((row) => usageRowName(row, L));
  // Claude — 5시간 · 주간 · Fable 주간(2026-09-28 실측의 모양).
  assert.deepEqual(names(plan(44, 11, [fable(11)])), ["이번 5시간", "이번 주", "Fable · 이번 주"]);
  // Codex 의 모델별 한도는 5시간과 주간이 따로다 — 같은 이름 두 줄로 읽히지 않는다.
  assert.deepEqual(
    names(
      plan(12, 5, [
        { label: "Spark 5시간", name: "Spark", period: "fiveHour", utilization: 0, resetsAt: null },
        { label: "Spark 주간", name: "Spark", period: "week", utilization: 0, resetsAt: null },
      ]),
    ),
    ["이번 5시간", "이번 주", "Spark · 이번 5시간", "Spark · 이번 주"],
  );
  // Codex 무료 요금제 — 이름 없는 한 달 창 하나.
  assert.deepEqual(
    names(
      plan(null, null, [
        { label: "이번 달", name: null, period: "month", utilization: 1, resetsAt: null },
      ]),
    ),
    ["이번 달"],
  );
  // 이름 · 기간을 싣기 전의 읽기(디스크의 옛 캐시)와 세 기간 밖의 창은 적힌 이름 그대로.
  assert.deepEqual(
    names(
      plan(null, null, [
        { label: "Fable 주간", utilization: 8, resetsAt: null },
        { label: "Spark 3일", name: "Spark", period: null, utilization: 8, resetsAt: null },
      ]),
    ),
    ["Fable 주간", "Spark 3일"],
  );
});

test("refillWhen: 오늘은 시각만, 내일은 `내일`, 그 너머는 날짜와 요일까지", () => {
  // 2026-09-28 은 월요일 — 시간대에 매이지 않게 이 컴퓨터의 지역 시각으로 짓는다.
  const now = new Date(2026, 8, 28, 15, 0);
  const at = (...parts: [number, number, number, number, number]) =>
    new Date(...parts).toISOString();
  assert.equal(refillWhen(at(2026, 8, 28, 18, 0), now, L), "18:00");
  assert.equal(refillWhen(at(2026, 8, 29, 9, 5), now, L), "내일 09:05");
  assert.equal(refillWhen(at(2026, 9, 3, 3, 0), now, L), "10월 3일(토) 03:00");
  // 자정을 넘는 5시간 창은 몇 시간 뒤라도 `내일` 이다.
  assert.equal(refillWhen(at(2026, 8, 29, 3, 0), new Date(2026, 8, 28, 23, 30), L), "내일 03:00");
  // 지났거나 읽을 수 없는 때는 말하지 않는다 — 다음 읽기가 창을 새로 채운다.
  assert.equal(refillWhen(at(2026, 8, 28, 14, 0), now, L), null);
  assert.equal(refillWhen("not a date", now, L), null);
  assert.equal(
    L.chat.usageRefill(refillWhen(at(2026, 9, 3, 3, 0), now, L) ?? ""),
    "10월 3일(토) 03:00에 다시 차요",
  );
});

test("usageHeat: 칩 옆 한 단어와 같은 문턱 — 70% 주의 · 90% 위험", () => {
  assert.equal(USAGE_WORD_MIN, 70);
  assert.equal(USAGE_HOT_MIN, 90);
  assert.equal(usageHeat(69), "calm");
  assert.equal(usageHeat(70), "warm");
  assert.equal(usageHeat(89), "warm");
  assert.equal(usageHeat(90), "hot");
});
