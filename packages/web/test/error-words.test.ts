import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(delivery-words.test.ts 와 같은 모양).
import { errorWords, plainErrorTitle, RAW_ERROR_WORDS } from "../src/lib/error-words.ts";

test("오류 id 의 한국어 — 아는 것만, 모르면 null", () => {
  assert.equal(errorWords("overloaded"), "AI가 붐빕니다");
  assert.equal(errorWords("api_error"), "잠시 문제가 있었습니다");
  assert.equal(errorWords("nope"), null);
});

test("개발 실행이 아니면 데몬 원문 대신 한국어 한 줄 — 원문은 console 로 (PLAN L8)", () => {
  // 영어 원문도 한국어 한 줄로 덮는다 — 화면의 문제 문장은 셋(I2)뿐이다.
  assert.equal(plainErrorTitle("spawn claude ENOENT", false), RAW_ERROR_WORDS);
  assert.ok(!RAW_ERROR_WORDS.includes("ENOENT"));
  // 한국어 원문이라도 같은 한 줄로 덮는다 — 원문은 기록으로만 간다.
  assert.equal(plainErrorTitle("다른 프로젝트의 대화입니다", false), RAW_ERROR_WORDS);
  // 개발 실행은 원문 그대로 — 개발자가 원인을 읽는다.
  assert.equal(plainErrorTitle("spawn claude ENOENT", true), "spawn claude ENOENT");
});
