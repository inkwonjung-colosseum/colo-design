import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 판정 — src 에서 곧장 읽는다(turn-screens.test.ts 와 같은 모양).
import { pinsToTurn } from "../src/lib/preview-turns.ts";

/** 요소 핀 하나 — 새 정체 칸(xpath · 속성 · 주변)을 다 실은 채. */
const elementPin = {
  id: "p1",
  screen: "member/list",
  note: "이 버튼이 너무 작아요",
  element: {
    component: "button",
    text: "제출",
    path: "body > main > form > button",
    xpath: "/body/main/form/button",
    rect: { x: 10, y: 20, width: 80, height: 30 },
    attrs: { testId: "submit-btn", type: "submit" },
    a11y: { role: "button", name: "제출" },
    nearby: "회원 목록 검색 이름 등록",
    styles: { color: "rgb(70, 70, 70)", "font-size": "13px" },
    owners: ["MemberForm", "MemberList"],
    html: `<button type="submit" class="btn">${"x".repeat(900)}</button>`,
  },
} as Parameters<typeof pinsToTurn>[0][number];

/** 영역 핀 — 경로가 없는 좌표만의 핀. */
const regionPin = {
  id: "p2",
  screen: "member/list",
  note: "",
  element: {
    component: "영역",
    text: "",
    path: "",
    rect: { x: 0, y: 0, width: 300, height: 120 },
    kind: "region" as const,
  },
} as Parameters<typeof pinsToTurn>[0][number];

test("핀 턴: 요소의 정체 칸이 본문 줄에 다 선다", () => {
  const turn = pinsToTurn([elementPin], "고쳐 줘", (screen) =>
    screen === "member/list" ? "회원 목록" : null,
  );
  // 머리는 태그 이름, 요소의 글자는 인용으로 한 번 — 두벌로 나오지 않는다.
  assert.ok(turn.includes(`1. button — "제출"`), turn);
  assert.ok(!turn.includes(`1. 제출 — "제출"`), turn);
  assert.ok(turn.includes("   컴포넌트: MemberForm › MemberList"), turn);
  assert.ok(turn.includes("   위치: body > main > form > button (rect 10,20 80×30)"), turn);
  assert.ok(turn.includes("   xpath: /body/main/form/button"), turn);
  assert.ok(turn.includes('   셀렉터: [data-testid="submit-btn"]'), turn);
  assert.ok(turn.includes('   속성: type="submit"'), turn);
  assert.ok(turn.includes('   접근성: role button · 이름 "제출"'), turn);
  assert.ok(turn.includes("   주변: 회원 목록 검색 이름 등록"), turn);
  assert.ok(turn.includes("   스타일: color rgb(70, 70, 70) · font-size 13px"), turn);
});

test("핀 턴: HTML 줄은 800자에서 자른다", () => {
  const turn = pinsToTurn([elementPin], "", () => null);
  const htmlLine = turn.split("\n").find((line) => line.startsWith("   HTML:"));
  assert.ok(htmlLine, turn);
  assert.ok(htmlLine!.length <= "   HTML: ".length + 800, htmlLine!);
  assert.ok(!turn.includes("고쳐 줘"), "빈 문장은 문장 줄에 서지 않는다");
});

test("핀 턴: 영역 핀은 좌표만의 위치다 — 경로 · 속성 · 주변이 없다", () => {
  const turn = pinsToTurn([regionPin], "여기 여백이 좁아요", () => null);
  assert.ok(turn.includes("1. 영역 300×120"), turn);
  assert.ok(turn.includes("   위치: rect 0,0 300×120"), turn);
  assert.ok(!turn.includes("xpath:"), turn);
  assert.ok(!turn.includes("속성:"), turn);
  assert.ok(!turn.includes("주변:"), turn);
});
