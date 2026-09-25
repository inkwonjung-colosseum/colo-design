import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(turn-screens.test.ts 와 같은 모양).
import { shouldDiscardOnFirstFailure } from "../src/next/lib/session-discard.ts";

test("shouldDiscardOnFirstFailure: 블록 0 의 첫 보내기만 거둔다", () => {
  // 갓 태어난 세션의 첫 보내기가 거절됐다 — 빈 「새 화면」 대화를 남기지 않는다.
  assert.equal(shouldDiscardOnFirstFailure([], 1), true);
  // 두 번째 보내기부터는 세션이 이미 대화다 — 그대로 둔다.
  assert.equal(shouldDiscardOnFirstFailure([], 2), false);
  assert.equal(shouldDiscardOnFirstFailure([], 3), false);
  // 블록이 남아 있으면 무엇인가 전해진 것이다 — 첫 보내기여도 둔다.
  assert.equal(shouldDiscardOnFirstFailure([{ id: "u1" }], 1), false);
  assert.equal(shouldDiscardOnFirstFailure([{ id: "u1" }, { id: "t1" }], 1), false);
});
