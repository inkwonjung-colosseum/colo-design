import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(next-thread.test.ts 와 같은 모양).
import { pinTitle, shownPinLabel } from "../src/next/lib/pin-name.ts";

const SPOT = "찍은 곳";

test("shownPinLabel: 태그 이름 하나뿐인 이름표는 찍은 곳으로", () => {
  for (const label of ["div", "span", "button", "section", "input", "table", "img"]) {
    assert.equal(shownPinLabel(label, SPOT), SPOT, label);
  }
  // SVG 도형 태그도 이름표에 실린 적이 있다.
  assert.equal(shownPinLabel("svg", SPOT), SPOT);
  assert.equal(shownPinLabel("path", SPOT), SPOT);
});

test("shownPinLabel: 요소의 글자 · 빈 이름표", () => {
  // 요소의 글자가 영어 낱말이어도 이름표로 남긴다 — 지우는 쪽보다 남기는 쪽.
  assert.equal(shownPinLabel("admin", SPOT), "admin");
  assert.equal(shownPinLabel("menu", SPOT), "menu");
  // 자기 글자를 다는 태그와 겹치는 낱말은 판정에서 뺐다.
  assert.equal(shownPinLabel("label", SPOT), "label");
  assert.equal(shownPinLabel("option", SPOT), "option");
  // 한국어 글자는 그대로.
  assert.equal(shownPinLabel("회원 목록", SPOT), "회원 목록");
  // 컴포넌트 이름(PascalCase)은 태그 이름이 아니다.
  assert.equal(shownPinLabel("MemberRow", SPOT), "MemberRow");
  // 대문자 태그 표기(`DIV`)는 쓴 적이 없다 — 있는 그대로 남긴다.
  assert.equal(shownPinLabel("DIV", SPOT), "DIV");
  // 비어 있으면 번호 자리가 선다 — 부르는 쪽이 넘긴 값으로.
  assert.equal(shownPinLabel("", SPOT), SPOT);
  assert.equal(shownPinLabel("  ", SPOT), SPOT);
});

test("pinTitle: 사람이 읽는 말이 먼저 — 접근성 이름 → 글자 → 종류 → 찍은 곳", () => {
  const words = {
    area: "영역",
    point: SPOT,
    kindButton: "버튼",
    kindLink: "링크",
    kindImage: "그림",
    kindInput: "입력칸",
  };
  const base = { component: "div", text: "" };
  assert.equal(pinTitle({ ...base, kind: "region" }, words), "영역");
  assert.equal(
    pinTitle({ ...base, text: "검색", a11y: { name: "회원 검색" } }, words),
    "회원 검색",
  );
  assert.equal(pinTitle({ ...base, text: "검색" }, words), "검색");
  // 긴 글자는 잘린다.
  assert.equal(
    pinTitle({ ...base, text: "가나다라마바사아자차카타파하가나다라마바" }, words),
    "가나다라마바사아자차카타파하가나다라…",
  );
  // 글자가 없으면 종류로.
  assert.equal(pinTitle({ ...base, component: "button" }, words), "버튼");
  assert.equal(pinTitle({ ...base, component: "A" }, words), "링크");
  assert.equal(pinTitle({ ...base, component: "svg" }, words), "그림");
  assert.equal(pinTitle({ ...base, component: "input" }, words), "입력칸");
  assert.equal(pinTitle({ ...base, a11y: { role: "button" } }, words), "버튼");
  // 끝까지 못 짚으면 찍은 곳.
  assert.equal(pinTitle(base, words), SPOT);
});
