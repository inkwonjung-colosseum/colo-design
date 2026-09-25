import assert from "node:assert/strict";
import { test } from "node:test";
// `../dist` 임포트인 이유: turn-retry 는 이제 형제(budgets)를 `.js` 지정자로
// 부른다 — src 직접 로드는 그 지정을 못 고친다(cycle-reconcile 와 같은 길).
import { BUDGETS } from "../dist/budgets.js";
import {
  classifyFailure,
  classifyRetry,
  MAX_AUTO_REVIVES,
  RETRY_DELAYS_MS,
} from "../dist/turn-retry.js";

test("사다리는 PLAN L7 의 다섯 계단이다", () => {
  assert.deepEqual(RETRY_DELAYS_MS, [4_000, 16_000, 60_000, 300_000, 900_000]);
  assert.equal(RETRY_DELAYS_MS.length, BUDGETS.turnRetry.attempts);
});

test("classifyRetry 는 계단을 차례로 오른다", () => {
  for (const [attempt, delay] of RETRY_DELAYS_MS.entries()) {
    const decision = classifyRetry({
      attempt,
      resultText: "temporary failure",
      rateLimit: null,
      now: 0,
      delays: RETRY_DELAYS_MS,
    });
    assert.deepEqual(decision, { action: "retry", delayMs: delay });
  }
});

test("로그인 만료 문장은 사다리를 타지 않고 auth 로 멈춘다", () => {
  const sentences = [
    "authentication_error: Invalid API key",
    "invalid api key provided",
    "OAuth token has expired",
    "Please run /login to authenticate",
    "You are not logged in",
    "Request failed with status code 401",
    "HTTP 401 Unauthorized",
  ];
  for (const resultText of sentences) {
    assert.deepEqual(
      classifyRetry({
        attempt: 0,
        resultText,
        rateLimit: null,
        now: 0,
        delays: RETRY_DELAYS_MS,
      }),
      { action: "stop", reason: "auth" },
      resultText,
    );
    assert.equal(classifyFailure(resultText), "auth", resultText);
  }
});

test("한도 기다림은 24시간 상한 안에서만 기다린다", () => {
  const now = 1_000_000_000_000;
  // 상한 안(23시간 뒤 재충전) — 기다린다.
  const within = classifyRetry({
    attempt: 0,
    resultText: "usage limit reached",
    rateLimit: { status: "blocked", resetsAt: now + 23 * 60 * 60_000 },
    now,
    delays: RETRY_DELAYS_MS,
  });
  assert.equal(within.action, "wait");
  // 상한 밖(25시간 뒤) — 기다리는 것이 아니라 잊는다.
  const beyond = classifyRetry({
    attempt: 0,
    resultText: "usage limit reached",
    rateLimit: { status: "blocked", resetsAt: now + 25 * 60 * 60_000 },
    now,
    delays: RETRY_DELAYS_MS,
  });
  assert.deepEqual(beyond, { action: "stop", reason: "limit-no-reset" });
});

test("되살리기 상한은 예산 표(10분 안에 3회)를 따른다", () => {
  assert.equal(MAX_AUTO_REVIVES, 3);
  assert.equal(BUDGETS.revive.max, 3);
  assert.equal(BUDGETS.revive.windowMs, 10 * 60_000);
});

test("classifyFailure — 길이 문제는 length 다", () => {
  assert.equal(classifyFailure("prompt is too long: 250000 tokens > 200000 maximum"), "length");
});

test("classifyFailure — 한도 문장은 limit 다", () => {
  assert.equal(classifyFailure("usage limit reached, try again later"), "limit");
  assert.equal(classifyFailure("rate limit exceeded for this account"), "limit");
});

test("classifyFailure — 스트림 오류는 짧고 근거가 있을 때만 stream 다", () => {
  assert.equal(
    classifyFailure("stream error unavailable: please try the model again later (error id: 1)"),
    "stream",
  );
  // 길고 문맥 있는 정상 답변이 stream error 를 화제로 설명하는 모양 — stream 이 아니다.
  const prose = `The user asked about stream error handling. ${"Here is a long explanation. ".repeat(40)}`;
  assert.equal(classifyFailure(prose), "other");
});

test("classifyFailure — 모르는 문장과 빈 문장은 other 다", () => {
  assert.equal(classifyFailure("something went sideways"), "other");
  assert.equal(classifyFailure(null), "other");
  assert.equal(classifyFailure(""), "other");
});

test("classifyRetry 는 기존 판정을 유지한다 — 상한 소진은 stop 다", () => {
  const decision = classifyRetry({
    attempt: RETRY_DELAYS_MS.length,
    resultText: "temporary failure",
    rateLimit: null,
    now: 0,
    delays: RETRY_DELAYS_MS,
  });
  assert.deepEqual(decision, { action: "stop", reason: "exhausted" });
});
