import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlanUsage } from "@colo-design/protocol";
// 순수 모듈 — src 에서 곧장 읽는다(turn-screens.test.ts 와 같은 모양).
import { L } from "../src/next/labels.ts";
import {
  dedupeScreens,
  EFFORT_OF,
  effortWord,
  noticeKind,
  promptNumbers,
  retryCount,
  sizeText,
  splitDuration,
  USAGE_WORD_MIN,
  usageReading,
} from "../src/next/lib/thread.ts";

test("effortWord: 세 칸과 CLI 의 단계", () => {
  assert.equal(effortWord(null), "normal");
  assert.equal(effortWord("low"), "short");
  assert.equal(effortWord("medium"), "normal");
  assert.equal(effortWord("high"), "long");
  assert.equal(effortWord("max"), "long");
  assert.deepEqual(EFFORT_OF, { short: "low", normal: "medium", long: "high" });
});

const plan = (five: number | null, week: number | null, models: number[] = []): PlanUsage => ({
  subscriptionType: "max",
  fiveHour: five === null ? null : { utilization: five, resetsAt: "2026-09-25T08:40:00Z" },
  sevenDay: week === null ? null : { utilization: week, resetsAt: null },
  modelWeekly: models.map((utilization, index) => ({
    label: `m${index}`,
    utilization,
    resetsAt: null,
  })),
});

test("usageReading: 가장 찬 창 하나 — 같으면 5시간", () => {
  assert.equal(usageReading(null), null);
  assert.equal(usageReading(plan(null, null)), null);
  const five = usageReading(plan(38.4, 12));
  assert.equal(five?.pct, 38);
  assert.deepEqual(five?.window, { kind: "fiveHour" });
  assert.equal(five?.resetsAt, "2026-09-25T08:40:00Z");
  assert.deepEqual(usageReading(plan(40, 81))?.window, { kind: "sevenDay" });
  assert.deepEqual(usageReading(plan(40, 40, [92]))?.window, { kind: "model", label: "m0" });
  assert.deepEqual(usageReading(plan(50, 50))?.window, { kind: "fiveHour" });
  assert.equal(usageReading(plan(140, null))?.pct, 100);
});

test("사용량 한 단어는 70% 를 넘어야 선다(P6)", () => {
  assert.equal(USAGE_WORD_MIN, 70);
});

test("noticeKind: 데몬 알림의 첫머리로 종류를 알아본다", () => {
  assert.equal(
    noticeKind("일시적인 문제입니다 — 같은 말로 스스로 다시 시도합니다 (2/5).", L.daemonNotice),
    "retry",
  );
  assert.equal(
    noticeKind(
      "사용량이 다시 채워지는대로 스스로 이어서 합니다 — 잠시만 기다려 주세요.",
      L.daemonNotice,
    ),
    "wait",
  );
  assert.equal(
    noticeKind("AI 프로그램을 다시 켰어요 — 하던 일을 이어서 합니다", L.daemonNotice),
    "revive",
  );
  assert.equal(noticeKind("대화가 길어져 정리한 뒤 이어서 합니다", L.daemonNotice), null);
});

test("retryCount: 문장 끝의 (n/N)", () => {
  assert.deepEqual(retryCount("… 다시 시도합니다 (3/5)."), { n: 3, of: 5 });
  assert.equal(retryCount("다시 시도합니다"), null);
});

test("promptNumbers: 보낸 말의 순번 — 기계 턴도 센다", () => {
  const blocks = [
    { type: "user", id: "u1" },
    { type: "text", id: "t1" },
    { type: "turn", id: "e1" },
    { type: "user", id: "u2" },
    { type: "notice", id: "n1" },
    { type: "user", id: "u3" },
  ];
  assert.deepEqual(
    [...promptNumbers(blocks)],
    [
      ["u1", 1],
      ["u2", 2],
      ["u3", 3],
    ],
  );
});

test("dedupeScreens: 같은 화면은 한 번", () => {
  assert.deepEqual(dedupeScreens([{ screen: "a" }, { screen: "b" }, { screen: "a" }]), [
    { screen: "a" },
    { screen: "b" },
  ]);
});

test("splitDuration · sizeText", () => {
  assert.deepEqual(splitDuration(12_400), { minutes: 0, seconds: 12 });
  assert.deepEqual(splitDuration(65_000), { minutes: 1, seconds: 5 });
  assert.deepEqual(splitDuration(-5), { minutes: 0, seconds: 0 });
  assert.equal(sizeText(300), "1KB");
  assert.equal(sizeText(320 * 1024), "320KB");
  assert.equal(sizeText(2.4 * 1024 * 1024), "2.4MB");
});
