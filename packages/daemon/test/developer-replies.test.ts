import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewToTurn } from "@colo-design/protocol";
// `../dist` 임포트인 이유: 형제를 `.js` 지정자로 부르는 모듈은 src 직접 로드가
// 그 지정을 못 고친다(cycle-supervisor.test.ts 와 같은 길).
import { extractDeveloperReplies, replyFooter } from "../dist/developer-replies.js";
import { isBotRow } from "../dist/github.js";

test("답장 줄을 코멘트별로 뽑는다 — 여러 줄이면 그 코멘트의 것이다", () => {
  const text = [
    "화면을 고쳤습니다.",
    "",
    "개발자에게 (#101): 버튼 문구를 '저장'에서 '보관'으로 바꿨습니다.",
    "개발자에게 (#102): 여백은 바꾸지 않았습니다. 디자인 시스템 값이라서입니다.",
  ].join("\n");
  const replies = extractDeveloperReplies(text, [101, 102]);
  assert.equal(replies.get(101), "버튼 문구를 '저장'에서 '보관'으로 바꿨습니다.");
  assert.equal(replies.get(102), "여백은 바꾸지 않았습니다. 디자인 시스템 값이라서입니다.");
});

test("줄이 없는 코멘트는 맵에 없다 — 게시 쪽의 폴백이 이어받는다", () => {
  const replies = extractDeveloperReplies("개발자에게 (#101): 라인이 있습니다.", [101, 202]);
  assert.ok(replies.has(101));
  assert.ok(!replies.has(202), "줄이 없으면 맵에 없다");
});

test("ids 에 없는 id 의 줄은 무시한다", () => {
  const text = "개발자에게 (#999): 모르는 코멘트입니다.";
  assert.equal(extractDeveloperReplies(text, [101]).size, 0);
});

test("같은 id 가 두 줄이면 첫 줄이 이긴다 · ids 가 중복돼도 한 번", () => {
  const text = ["개발자에게 (#101): 첫 줄입니다.", "개발자에게 (#101): 두 번째 줄입니다."].join(
    "\n",
  );
  assert.equal(extractDeveloperReplies(text, [101]).get(101), "첫 줄입니다.");
  assert.equal(extractDeveloperReplies(text, [101, 101]).size, 1);
});

test("줄바꿈으로 이어지는 문장은 한 문장으로 잇는다 — 빈 줄에서 끊는다", () => {
  const text = [
    "개발자에게 (#101): 버튼 문구를 바꿨습니다.",
    "추가로 툴팁도 함께 고쳤습니다.",
    "",
    "이 뒤는 답장이 아닌 다른 이야기다.",
  ].join("\n");
  assert.equal(
    extractDeveloperReplies(text, [101]).get(101),
    "버튼 문구를 바꿨습니다. 추가로 툴팁도 함께 고쳤습니다.",
  );
});

test("머리의 콜론은 붙여 쓰기도 한다 — 모델의 쓰는 법을 넉넉하게 본다", () => {
  const replies = extractDeveloperReplies("개발자에게 (#7) 콜론 없이 답합니다.", [7]);
  assert.equal(replies.get(7), "콜론 없이 답합니다.");
});

test("대리 표기 — 이름이 없으면 '사용자'", () => {
  assert.equal(replyFooter("김기획"), "— Colo Design 이 김기획 님 대신 남김");
  assert.equal(replyFooter(null), "— Colo Design 이 사용자 님 대신 남김");
});

test("봇 판정 — user.type 이 Bot 이거나 로그인이 [bot] 으로 끝난다", () => {
  assert.ok(isBotRow({ user: { login: "ci", type: "Bot" } }));
  assert.ok(isBotRow({ user: { login: "github-actions[bot]" } }));
  assert.ok(!isBotRow({ user: { login: "dev1", type: "User" } }));
  assert.ok(!isBotRow({}), "user 없는 행은 봇이 아니다");
});

test("reviewToTurn — 답장 규칙 줄과 코멘트 id 를 싣는다 (PLAN L9)", () => {
  const turn = reviewToTurn([
    { id: 11, pr: 3, author: "dev1", body: "만료 행을 회색으로" },
    { id: 12, pr: 3, author: "dev1", body: "정렬도 맞춰 주세요" },
  ]);
  assert.ok(turn.includes("개발자에게 (#<id>)"), "답장 규칙 줄이 있어야 한다");
  assert.ok(turn.includes("(#11)"), "목록에 코멘트 id 가 붙어야 한다");
  assert.ok(turn.includes("(#12)"));
});

test("reviewToTurn — intro 가 첫 문장을 바꾼다(반려의 길)", () => {
  const turn = reviewToTurn([{ id: 5, pr: 1, author: "dev1", body: "이유" }], {
    intro: "개발자가 이번 요청을 닫았습니다. 아래 이유를 반영해 고쳐 주세요.",
  });
  assert.ok(turn.includes("개발자가 이번 요청을 닫았습니다. 아래 이유를 반영해 고쳐 주세요."));
  assert.ok(!turn.includes("건에 답합니다"), "기본 첫 문장은 물러난다");
});
