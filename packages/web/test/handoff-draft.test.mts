/**
 * The 넘기기 draft the browser contributes: the project name as the title
 * seed, an empty body the daemon's own proposal fills.
 *
 * Run: node --experimental-transform-types --test packages/web/test/handoff-draft.test.mts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffDraft, mergeHandoffBody } from "../src/lib/handoff-draft.ts";

test("the draft does not say 화면 twice", () => {
  assert.equal(handoffDraft("재고 실사 화면").title, "재고 실사 화면");
  assert.equal(handoffDraft("결제").title, "결제 화면");
  assert.equal(handoffDraft("").title, "");
});

test("the browser contributes no body — the daemon's proposal is the whole text", () => {
  assert.equal(handoffDraft("재고 실사 화면").body, "");
});

test("the draft is the whole proposal — merged as the planner typed it", () => {
  assert.equal(mergeHandoffBody("목록과 빈 상태를 만들었습니다."), "목록과 빈 상태를 만들었습니다.\n");
  // One trailing newline so the daemon's own sections start on their own line.
  assert.doesNotMatch(mergeHandoffBody("만들었습니다."), /\n{2}/);
});

test("빈 초안은 빈 문자열로 — 넘어가는 줄이 없다", () => {
  assert.equal(mergeHandoffBody(""), "");
  assert.equal(mergeHandoffBody("   "), "");
});
