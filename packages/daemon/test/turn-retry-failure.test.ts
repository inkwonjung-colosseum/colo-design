import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFailure, classifyRetry, RETRY_DELAYS_MS } from "../src/turn-retry.ts";

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
