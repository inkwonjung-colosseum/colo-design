// PLAN-UI U13 의 순수 시험 — 제출 국면의 판정(deriveSubmitPhase) · 기록의 전이
// (advanceSubmitTrail) · 실패 분류(classifySubmitError). `../dist` 임포트인
// 이유는 cycle-ledger.test.ts 와 같다.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advanceSubmitTrail,
  classifySubmitError,
  deriveSubmitPhase,
  SUBMIT_LOG_TEXT,
} from "../dist/submit-state.js";

const AT = "2026-09-25T01:00:00.000Z";
const intent = (extra: Record<string, unknown> = {}) => ({
  requestedAt: AT,
  via: "button" as const,
  ...extra,
});
const base = { push: null, budgets: {}, notices: {}, authExpired: false };

test("deriveSubmitPhase — 의도가 없으면 idle", () => {
  assert.deepEqual(deriveSubmitPhase({ ...base, intent: null }), { phase: "idle", attempts: 0 });
});

test("deriveSubmitPhase — 실패가 없는 의도는 running", () => {
  assert.deepEqual(deriveSubmitPhase({ ...base, intent: intent() }), {
    phase: "running",
    attempts: 0,
  });
});

test("deriveSubmitPhase — 예산 안의 잠깐 실패는 retrying (단계 · 푸시 둘 다)", () => {
  assert.deepEqual(
    deriveSubmitPhase({ ...base, intent: intent({ attempts: 2, lastError: "network" }) }),
    { phase: "retrying", attempts: 2, lastError: "network" },
  );
  const push = { behindSince: AT, attempts: 3, nextAttemptAt: AT, lastError: "rejected" as const };
  assert.deepEqual(deriveSubmitPhase({ ...base, push, intent: intent() }), {
    phase: "retrying",
    attempts: 3,
    lastError: "rejected",
  });
});

test("deriveSubmitPhase — 인증은 예산보다 먼저 막힌다 (만료 기록 · 401)", () => {
  assert.deepEqual(deriveSubmitPhase({ ...base, authExpired: true, intent: intent() }), {
    phase: "blocked",
    attempts: 0,
    lastError: "auth",
    blockedBy: "auth",
  });
  const push = { behindSince: AT, attempts: 1, nextAttemptAt: AT, lastError: "auth" as const };
  assert.equal(deriveSubmitPhase({ ...base, push, intent: intent() }).blockedBy, "auth");
});

test("deriveSubmitPhase — 예산을 다 써 알렸으면 developer-notified", () => {
  const budgets = {
    "submit:pr": { spent: 5, firstAt: AT, lastAt: AT, escalated: true },
  };
  assert.deepEqual(
    deriveSubmitPhase({ ...base, budgets, intent: intent({ attempts: 5, lastError: "other" }) }),
    { phase: "blocked", attempts: 5, lastError: "other", blockedBy: "developer-notified" },
  );
  // 1시간 넘게 밀린 푸시의 서 있는 알림도 같은 막힘이다.
  const notices = { "push:behind": { via: "issue" as const, raisedAt: AT, count: 1 } };
  assert.equal(
    deriveSubmitPhase({ ...base, notices, intent: intent() }).blockedBy,
    "developer-notified",
  );
});

test("advanceSubmitTrail — 같은 국면은 기록하지 않는다(틱은 사건이 아니다)", () => {
  const trail = { phase: "retrying" as const, log: [{ at: AT, text: SUBMIT_LOG_TEXT.retrying }] };
  const step = advanceSubmitTrail(trail, { phase: "retrying", attempts: 3 }, AT);
  assert.equal(step.changed, false);
  assert.equal(step.blocked, null);
});

test("advanceSubmitTrail — 막힘은 들어설 때 한 번, 풀림과 성공이 차례로 적힌다", () => {
  let trail = advanceSubmitTrail(undefined, { phase: "running", attempts: 0 }, AT).trail;
  assert.deepEqual(trail.log, [], "누름 자체는 기록이 아니다");
  let step = advanceSubmitTrail(trail, { phase: "retrying", attempts: 1 }, AT);
  assert.deepEqual(
    step.trail.log.map((l) => l.text),
    [SUBMIT_LOG_TEXT.retrying],
  );
  step = advanceSubmitTrail(
    step.trail,
    { phase: "blocked", attempts: 5, blockedBy: "developer-notified" },
    AT,
  );
  assert.equal(step.blocked, "developer-notified");
  // 막힌 채 이유만 바뀌어도(인증) 다시 울리지 않는다.
  const again = advanceSubmitTrail(
    step.trail,
    { phase: "blocked", attempts: 5, blockedBy: "auth" },
    AT,
  );
  assert.equal(again.changed, false);
  assert.equal(again.blocked, null);
  step = advanceSubmitTrail(step.trail, { phase: "retrying", attempts: 5 }, AT);
  assert.equal(step.blocked, null);
  trail = advanceSubmitTrail(step.trail, { phase: "idle", attempts: 0 }, AT, true).trail;
  assert.equal(trail.phase, "idle");
  // 최근 셋만 남는다 — 가장 오래된 `다시 제출하는 중` 이 밀려난다.
  assert.deepEqual(
    trail.log.map((l) => l.text),
    [SUBMIT_LOG_TEXT.blocked, SUBMIT_LOG_TEXT.unblocked, SUBMIT_LOG_TEXT.succeeded],
  );
});

test("advanceSubmitTrail — 성공 없이 idle 로 돌아가면(보낼 것이 없음) 줄이 없다", () => {
  const trail = { phase: "running" as const, log: [] };
  const step = advanceSubmitTrail(trail, { phase: "idle", attempts: 0 }, AT);
  assert.equal(step.trail.phase, "idle");
  assert.deepEqual(step.trail.log, []);
});

test("classifySubmitError — 네 분류", () => {
  assert.equal(
    classifySubmitError("토큰이 유효하지 않거나 만료됐습니다 — 새 토큰을 넣어 주세요."),
    "auth",
  );
  assert.equal(
    classifySubmitError("GitHub 에 닿을 수 없습니다 — 연결 코드를 확인해 주세요."),
    "auth",
  );
  assert.equal(classifySubmitError("fetch failed"), "network");
  assert.equal(classifySubmitError("! [rejected] non-fast-forward"), "rejected");
  assert.equal(classifySubmitError("요청 열기 실패 (422)"), "other");
});
