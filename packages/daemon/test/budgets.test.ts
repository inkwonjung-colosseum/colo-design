import assert from "node:assert/strict";
import { test } from "node:test";
// budgets.ts 는 형제를 import 하지 않는 순수 모듈 — src 에서 곧장 읽는다.
import { BUDGETS, backoffDelay, markEscalated, resetBudget, spend } from "../src/budgets.ts";

const T0 = Date.parse("2026-09-24T10:00:00.000Z");
const NO_WINDOW = { max: 2, windowMs: null };

test("첫 셈은 허용이고 원장에 ISO 시각으로 남는다", () => {
  const out = spend({}, "conflict:abc", NO_WINDOW, T0);
  assert.equal(out.allowed, true);
  assert.equal(out.exhausted, false);
  assert.deepEqual(out.ledger["conflict:abc"], {
    spent: 1,
    firstAt: "2026-09-24T10:00:00.000Z",
    lastAt: "2026-09-24T10:00:00.000Z",
    escalated: false,
  });
});

test("상한의 마지막 몫에서 exhausted, 그 다음은 거절한다", () => {
  const first = spend({}, "k", NO_WINDOW, T0);
  const second = spend(first.ledger, "k", NO_WINDOW, T0 + 1_000);
  assert.deepEqual([second.allowed, second.exhausted], [true, true]);
  const third = spend(second.ledger, "k", NO_WINDOW, T0 + 2_000);
  assert.deepEqual([third.allowed, third.exhausted], [false, true]);
  // 거절은 원장을 그대로 돌려온다 — 거절이 창을 늘리지 않는다.
  assert.equal(third.ledger, second.ledger);
});

test("창 밖의 셈은 잊는다 — 오래된 고장은 새 사건이다", () => {
  const day = { max: 1, windowMs: 24 * 60 * 60_000 };
  const first = spend({}, "reclone", day, T0);
  assert.equal(first.allowed, true);
  assert.equal(spend(first.ledger, "reclone", day, T0 + 60_000).allowed, false);
  const next = spend(first.ledger, "reclone", day, T0 + 24 * 60 * 60_000 + 1);
  assert.equal(next.allowed, true);
  // 창이 돌아온 첫 셈은 새 사건 — 첫 시각도 다시 찍는다.
  assert.equal(next.ledger.reclone?.firstAt, new Date(T0 + 24 * 60 * 60_000 + 1).toISOString());
});

test("markEscalated 는 표식을 한 번만 바꾸고, resetBudget 은 항목을 지운다", () => {
  const spent = spend({}, "k", NO_WINDOW, T0).ledger;
  const marked = markEscalated(spent, "k");
  assert.equal(marked.k?.escalated, true);
  assert.equal(markEscalated(marked, "k"), marked);
  const empty = {};
  assert.equal(resetBudget(empty, "k"), empty); // 없는 항목을 지울 때는 같은 원장을 돌려준다
  const reset = resetBudget(marked, "k");
  assert.equal("k" in reset, false);
});

test("backoffDelay — 30초에서 두 배씩, 10분에서 자른다", () => {
  const { baseMs, capMs } = BUDGETS.push;
  const steps = [1, 2, 3, 4, 5, 6, 7].map((attempt) => backoffDelay(attempt, baseMs, capMs));
  assert.deepEqual(steps, [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
  // 시도가 아무리 커도 capMs 를 넘지 않는다(오버플로 없이).
  assert.equal(backoffDelay(400, baseMs, capMs), capMs);
});

test("BUDGETS 표의 값이 PLAN L7 과 같다", () => {
  assert.deepEqual(BUDGETS.turnRetry, {
    attempts: 5,
    delaysMs: [4_000, 16_000, 60_000, 300_000, 900_000],
  });
  assert.deepEqual(BUDGETS.revive, { max: 3, windowMs: 10 * 60_000, graceMs: 1_500 });
  assert.deepEqual(BUDGETS.push, {
    baseMs: 30_000,
    capMs: 10 * 60_000,
    behindAlarmMs: 60 * 60_000,
  });
  assert.deepEqual(BUDGETS.conflict, { max: 2, windowMs: null });
  assert.deepEqual(BUDGETS.bringUpPerKind, { max: 2, windowMs: null });
  assert.deepEqual(BUDGETS.bringUpPerEpisode, { max: 4, windowMs: null });
  assert.deepEqual(BUDGETS.submitStep, { max: 5, windowMs: null });
  assert.deepEqual(BUDGETS.reviewRounds, { max: 5, windowMs: null });
  assert.deepEqual(BUDGETS.reclone, { max: 1, windowMs: 24 * 60 * 60_000 });
  assert.equal(BUDGETS.noticeRefreshMs, 10 * 60_000);
});
