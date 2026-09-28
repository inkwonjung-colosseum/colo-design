import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(next-*.test.ts 와 같은 모양).
import {
  SUBMIT_SHAKE_MS,
  SUBMIT_STORY_BAR_MS,
  SUBMIT_STORY_POINT_MS,
  submitStoryPhase,
} from "../src/next/lib/submit-story.ts";

test("submitStoryPhase: 이야기는 그려지는 체크로 시작한다", () => {
  assert.equal(submitStoryPhase(0), "draw");
  assert.equal(submitStoryPhase(SUBMIT_STORY_BAR_MS - 1), "draw");
});

test("submitStoryPhase: 체크가 그려진 뒤 첫 막대가 차고, 이어 둘째 점이 켜진다", () => {
  assert.equal(submitStoryPhase(SUBMIT_STORY_BAR_MS), "bar");
  assert.equal(submitStoryPhase(SUBMIT_STORY_POINT_MS - 1), "bar");
  assert.equal(submitStoryPhase(SUBMIT_STORY_POINT_MS), "point");
  assert.equal(submitStoryPhase(10_000), "point");
});

test("submitStoryPhase: 시작 전에는 이야기가 없다", () => {
  assert.equal(submitStoryPhase(-1), null);
});

test("submitStoryPhase: 순서는 앞으로만 흐른다 — 흔들림보다 체크가 먼저 끝난다", () => {
  assert.ok(SUBMIT_STORY_BAR_MS >= SUBMIT_SHAKE_MS);
  assert.ok(SUBMIT_STORY_POINT_MS > SUBMIT_STORY_BAR_MS);
});
