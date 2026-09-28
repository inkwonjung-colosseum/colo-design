import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(next-*.test.ts 와 같은 모양).
import { matchRange, rank } from "../src/components/shell/palette-match.ts";

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
