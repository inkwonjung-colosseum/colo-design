/**
 * The Korean boundary at the daemon's RPC error reply (리뷰 C1·C3의 형제):
 * the daemon's own guards already answer in Korean, and a foreign error —
 * the SDK's "Query closed before response received" once rode the wire to
 * the chat banner — must reach the planner as the recovery sentence instead.
 * Everything runs offline; the raw line stays in the daemon log.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { asPlannerFacingError } from "../dist/session.js";

test("a foreign SDK message becomes the Korean recovery sentence", () => {
  const faced = asPlannerFacingError(new Error("Query closed before response received"));
  assert.match(faced.message, /다시 보내면 이어집니다/);
  assert.ok(!/Query closed/.test(faced.message), faced.message);
});

test("a non-Error foreign value is wrapped all the same", () => {
  const faced = asPlannerFacingError("EPIPE: broken pipe");
  assert.match(faced.message, /대화가 방금 끊겼습니다/);
});

test("the daemon's own Korean guards pass through untouched", () => {
  const guard = new Error("닫힌 대화입니다 — 목록에서 다시 열면 이어갑니다.");
  assert.equal(asPlannerFacingError(guard), guard);
  assert.equal(asPlannerFacingError("연결이 끊겼습니다").message, "연결이 끊겼습니다");
});
