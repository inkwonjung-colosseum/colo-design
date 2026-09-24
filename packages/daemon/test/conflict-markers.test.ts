import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈이라 src 에서 곧바로 싣는다(git-lane 시험과 같은 길).
import { conflictMarkers } from "../src/conflict-markers.ts";

test("표식이 짝을 이뤄 있으면 참이다", () => {
  const text = [
    "const a = 1;",
    "<<<<<<< HEAD",
    "const b = 2;",
    "=======",
    "const b = 3;",
    ">>>>>>> feature",
    "const c = 4;",
  ].join("\n");
  assert.equal(conflictMarkers(text), true);
});

test("표식이 없으면 거짓이다", () => {
  assert.equal(conflictMarkers("const a = 1;\nconst b = 2;\n"), false);
});

test("`=======` 한 줄만 있으면 거짓이다 — 코드 안 문자열·구분선은 충돌이 아니다", () => {
  const text = ['const divider = "=======";', "=======", 'const end = "x";'].join("\n");
  assert.equal(conflictMarkers(text), false);
});

test("문자열 리터럴 안의 표식은 거짓이다 — 줄 머리가 아니면 표식이 아니다", () => {
  const text = [
    'const start = "<<<<<<< HEAD";',
    'const middle = "=======";',
    'const end = ">>>>>>> feature";',
  ].join("\n");
  assert.equal(conflictMarkers(text), false);
});

test("diff3 의 `||||||| ` 가 있어도 참이다 — 공통 조상은 시작과 가운데 사이에 온다", () => {
  const text = [
    "<<<<<<< HEAD",
    "const b = 2;",
    "||||||| base",
    "const b = 1;",
    "=======",
    "const b = 3;",
    ">>>>>>> feature",
  ].join("\n");
  assert.equal(conflictMarkers(text), true);
});

test("CRLF 도 표식으로 읽는다", () => {
  const text = "<<<<<<< HEAD\r\na\r\n=======\r\nb\r\n>>>>>>> feature\r\n";
  assert.equal(conflictMarkers(text), true);
});

test("순서가 어긋나면 거짓이다 — 닫는 표식이 먼저 오는 것은 충돌이 아니다", () => {
  const text = [">>>>>>> feature", "=======", "<<<<<<< HEAD"].join("\n");
  assert.equal(conflictMarkers(text), false);
});

test("가운데가 없는 시작·끝만은 거짓이다", () => {
  const text = ["<<<<<<< HEAD", "const b = 2;", ">>>>>>> feature"].join("\n");
  assert.equal(conflictMarkers(text), false);
});

test("여덟 개 `=` 는 가운데가 아니다 — 정확히 일곱 개여야 한다", () => {
  const text = ["<<<<<<< HEAD", "a", "========", "b", ">>>>>>> feature"].join("\n");
  assert.equal(conflictMarkers(text), false);
});
