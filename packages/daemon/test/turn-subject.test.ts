import assert from "node:assert/strict";
import { test } from "node:test";
import { markTurn, reviewToTurn } from "@colo-design/protocol";
import { COMMON_INSTRUCTIONS, turnSubjectOf } from "../src/common-instructions.ts";

test("사용자의 말은 첫 줄이 제목이 된다 — 80자에서 자른다", () => {
  const long = `${"쿠폰 발급 화면을 만들어 줘".repeat(10)} — 그리고 나머지 문장`;
  const subject = turnSubjectOf(long);
  assert.deepEqual(subject, { message: long.slice(0, 80) });
});

test("gate 브리프는 말이 없는 턴이다 — 화면 확인 문장이 커밋을 적시지 않는다", () => {
  const gate = markTurn(
    { kind: "gate", step: "화면 확인" },
    "사용자가 가리킨 화면을 도구가 다시 열어 봤습니다. 아래를 고친 뒤 답해 주세요.",
  );
  assert.deepEqual(turnSubjectOf(gate), {});
});

test("error · brief 마커도 같다 — 도구의 자기 보고는 제목이 될 수 없다", () => {
  const error = markTurn(
    { kind: "error", route: "coupon/CouponIssue", errorKind: "build" },
    "./src/screens/coupon/CouponInspection.screen.tsx\n빌드가 실패했습니다.",
  );
  assert.deepEqual(turnSubjectOf(error), {});
  const brief = markTurn(
    { kind: "brief", title: "원격의 최신 변경" },
    "원격의 최신 변경 2건을 받아 왔습니다.",
  );
  assert.deepEqual(turnSubjectOf(brief), {});
});

test("고치기(review) 턴은 요청의 뜻을 싣므로 제목이 된다", () => {
  const review = reviewToTurn([{ id: 1, pr: 3, author: "dev", body: "만료 행을 회색으로" }]);
  assert.deepEqual(turnSubjectOf(review), {
    message: "개발자 코멘트 1건에 답합니다 — 아래 코멘트를 반영해 화면을 고쳐 주세요.",
  });
});

test("공통 규칙 블록은 사용자의 말이 아니다 — 제목이 앱 안내문이 되는 일을 막는다", () => {
  assert.deepEqual(turnSubjectOf(COMMON_INSTRUCTIONS), {});
  assert.deepEqual(turnSubjectOf(null), {});
  assert.deepEqual(turnSubjectOf("   \n\n"), {});
});
