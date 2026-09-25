import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(turn-screens.test.ts 와 같은 모양).
import { L } from "../src/next/labels.ts";
import { submitCopy } from "../src/next/lib/submit-copy.ts";

const log = [
  { at: "2026-09-25T01:00:00Z", text: "a" },
  { at: "2026-09-25T03:00:00Z", text: "c" },
  { at: "2026-09-25T02:00:00Z", text: "b" },
];

test("submitCopy: 선로가 없거나 쉬면 제출 그대로 — 판정은 여정의 몫", () => {
  for (const submit of [undefined, null, { phase: "idle" as const, attempts: 0, log: [] }]) {
    const copy = submitCopy(submit, L);
    assert.equal(copy.phase, "idle");
    assert.equal(copy.label, L.submit.idle);
    assert.equal(copy.busy, null);
    assert.equal(copy.firstPoint, null);
    assert.equal(copy.reason, null);
    assert.equal(copy.lastAt, null);
  }
});

test("submitCopy: 도는 제출 · 다시 제출하는 중", () => {
  const running = submitCopy({ phase: "running", attempts: 1, log: [] }, L);
  assert.equal(running.label, "제출하는 중…");
  assert.equal(running.busy, "running");
  const retrying = submitCopy({ phase: "retrying", attempts: 2, lastError: "network", log }, L);
  assert.equal(retrying.label, "다시 제출하는 중…");
  assert.equal(retrying.busy, "retrying");
  assert.equal(retrying.firstPoint, null);
});

test("submitCopy: 막힘 — 버튼은 제출하지 못했어요, 첫 점과 잠긴 이유", () => {
  const auth = submitCopy({ phase: "blocked", attempts: 3, lastError: "auth", log }, L);
  assert.equal(auth.label, "제출하지 못했어요");
  assert.equal(auth.busy, null);
  assert.equal(auth.firstPoint, "제출 전 · 제출하지 못했어요");
  assert.equal(auth.reason, "연결 코드가 만료돼 제출이 막혔어요 — 새 초대 파일이 필요해요");
  for (const lastError of ["network", "rejected", "other", undefined] as const) {
    const notified = submitCopy({ phase: "blocked", attempts: 5, lastError, log }, L);
    assert.equal(
      notified.reason,
      "제출이 막혀 개발자에게 알렸어요 — 풀리면 도구가 다시 제출해요, 지금은 계속 만들어도 돼요",
      String(lastError),
    );
  }
});

test("submitCopy: 마지막 제출 시각은 기록 중 가장 늦은 것 — 순서와 표기에 기대지 않는다", () => {
  assert.equal(submitCopy({ phase: "idle", attempts: 1, log }, L).lastAt, "2026-09-25T03:00:00Z");
  const mixed = [
    { at: "2026-09-25T11:30:00+09:00", text: "x" },
    { at: "2026-09-25T02:00:00Z", text: "y" },
  ];
  assert.equal(
    submitCopy({ phase: "idle", attempts: 1, log: mixed }, L).lastAt,
    "2026-09-25T11:30:00+09:00",
  );
});
