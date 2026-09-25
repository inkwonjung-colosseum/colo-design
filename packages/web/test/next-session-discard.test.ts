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

test("shouldDiscardOnFirstFailure: 시스템 안내만 남은 첫 보내기도 거둔다", () => {
  // 홈의 큰 입력창이 여는 첫 보내기(W4 재발 길) — 거절과 함께 데몬이 남기는 것은
  // 실패 안내 notice 뿐이다. 사용자의 말은 컴포저가 지키고 있으니 세션은 거둔다.
  assert.equal(
    shouldDiscardOnFirstFailure([{ type: "notice", id: "n1", level: "error", text: "…" }], 1),
    true,
  );
  assert.equal(
    shouldDiscardOnFirstFailure(
      [
        { type: "notice", id: "n1", level: "info", text: "…" },
        { type: "notice", id: "n2", level: "warn", text: "…" },
      ],
      1,
    ),
    true,
  );
  // 안내 사이에 사용자의 말(user) · AI 의 답(text)이 하나라도 섞였으면 빈 대화가
  // 아니다 — 거두지 않는다.
  assert.equal(
    shouldDiscardOnFirstFailure(
      [
        { type: "notice", id: "n1", level: "error", text: "…" },
        { type: "user", id: "u1", text: "회원 목록", images: 0 },
      ],
      1,
    ),
    false,
  );
  assert.equal(
    shouldDiscardOnFirstFailure(
      [
        { type: "notice", id: "n1", level: "error", text: "…" },
        { type: "text", id: "a1", text: "답", agentId: null, streaming: false },
      ],
      1,
    ),
    false,
  );
  // 시스템 안내만 남아 있어도 두 번째 보내기부터는 이미 대화다.
  assert.equal(
    shouldDiscardOnFirstFailure([{ type: "notice", id: "n1", level: "error", text: "…" }], 2),
    false,
  );
});
