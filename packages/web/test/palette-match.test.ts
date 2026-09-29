import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(next-*.test.ts 와 같은 모양).
import { matchRange, rank, stepWalk } from "../src/components/shell/palette-match.ts";

test("rank: 접두가 중간보다 앞서고, 흩어진 글자는 세째다", () => {
  assert.equal(rank("결제", "결제 화면"), 1);
  assert.equal(rank("결제", "주문 결제 내역"), 2);
  assert.equal(rank("결제", "결ㅌㅔ가 흩어진 줄"), -1);
  assert.equal(rank("abc", "a-b-c"), 3);
  assert.equal(rank("", "아무 줄"), 0);
  assert.equal(rank("  ", "아무 줄"), 0);
  assert.equal(rank("결제", "결제"), 1);
});

test("rank: 대소문자와 앞뒤 공백은 묻지 않는다", () => {
  assert.equal(rank("Set", "settings"), 1);
  assert.equal(rank(" 설정 ", "설정"), 1);
});

test("matchRange: 이어진 덩이의 자리를 준다", () => {
  assert.deepEqual(matchRange("결제", "결제 화면"), [0, 2]);
  assert.deepEqual(matchRange("결제", "주문 결제 내역"), [3, 5]);
  assert.deepEqual(matchRange("SET", "Settings"), [0, 3]);
});

test("matchRange: 흩어져 맞거나 비었으면 하이라이트가 없다", () => {
  assert.equal(matchRange("ac", "a-b-c"), null);
  assert.equal(matchRange("", "결제"), null);
  assert.equal(matchRange("없는말", "결제"), null);
});

// 줄 3개 · 칩 2개 — 걸음은 0..4 한 줄이고, 3 부터가 칩이다.
test("stepWalk: ↑↓ 는 줄에서 칩까지 한 줄로 걷고, 끝에서는 머문다", () => {
  assert.equal(stepWalk("ArrowDown", 0, 3, 2), 1);
  assert.equal(stepWalk("ArrowDown", 2, 3, 2), 3, "마지막 줄 다음은 첫 칩");
  assert.equal(stepWalk("ArrowDown", 4, 3, 2), 4, "끝에서는 머문다");
  assert.equal(stepWalk("ArrowUp", 3, 3, 2), 2, "첫 칩에서 위는 마지막 줄");
  assert.equal(stepWalk("ArrowUp", 0, 3, 2), 0, "처음에서는 머문다");
});

test("stepWalk: ←/→ 는 칩 위에서만 걷고, 옮길 곳이 없으면 커서에 돌려준다", () => {
  assert.equal(stepWalk("ArrowRight", 3, 3, 2), 4);
  assert.equal(stepWalk("ArrowLeft", 4, 3, 2), 3);
  assert.equal(stepWalk("ArrowRight", 4, 3, 2), null, "마지막 칩 — 입력칸의 커서가 쓴다");
  assert.equal(stepWalk("ArrowLeft", 3, 3, 2), null, "첫 칩에서 줄로 넘어가지 않는다");
  assert.equal(stepWalk("ArrowRight", 1, 3, 2), null, "줄 위 — 입력칸의 커서가 쓴다");
  assert.equal(stepWalk("ArrowLeft", 1, 3, 2), null);
});

test("stepWalk: 줄이 없고 칩만 있어도 걷는다 — 「홈」만 맞는 검색", () => {
  assert.equal(stepWalk("ArrowDown", 0, 0, 3), 1);
  assert.equal(stepWalk("ArrowRight", 0, 0, 3), 1);
  assert.equal(stepWalk("ArrowLeft", 0, 0, 3), null);
  assert.equal(stepWalk("ArrowUp", 0, 0, 3), 0);
});

test("stepWalk: 걸을 것이 하나도 없어도 ↑↓ 는 죽지 않고, 다른 키는 가져가지 않는다", () => {
  assert.equal(stepWalk("ArrowDown", 0, 0, 0), 0);
  assert.equal(stepWalk("ArrowUp", 0, 0, 0), 0);
  assert.equal(stepWalk("ArrowRight", 0, 0, 0), null);
  assert.equal(stepWalk("Enter", 1, 3, 2), null);
  assert.equal(stepWalk("a", 1, 3, 2), null);
});
