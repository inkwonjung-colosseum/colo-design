import assert from "node:assert/strict";
import { test } from "node:test";
// `../dist` 임포트인 이유: repo-publish 의 src 는 `.js` 지정자로 형제를
// 부른다 — src 직접 로드는 그 지정을 못 고친다(shelf-recover 와 같은 길).
import { cycleBranchName } from "../dist/repo-publish.js";

test("자정 직후의 이름은 그날 로컬 날짜로 짓는다 — UTC 가 아니다", () => {
  // 로컬 시간 생성자: 어느 시간대에서 돌아도 2026-03-05 00:05 이다. UTC 였다면
  // 시간대에 따라 어제(2026-03-04) 이름이 나왔다 — 하루의 경계는 사용자의 것이다.
  assert.equal(cycleBranchName(new Date(2026, 2, 5, 0, 5), 3), "colo-design/20260305-3");
});

test("한 자리 월 · 일은 0으로 채운다", () => {
  assert.equal(cycleBranchName(new Date(2026, 1, 9, 23, 59), 12), "colo-design/20260209-12");
});
