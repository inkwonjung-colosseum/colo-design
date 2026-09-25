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
  // 영어 원문은 한국어 한 줄로 덮는다 — 화면의 문제 문장은 셋(I2)뿐이다.
  assert.equal(plainErrorTitle("spawn claude ENOENT", false), RAW_ERROR_WORDS);
  assert.ok(!RAW_ERROR_WORDS.includes("ENOENT"));
  // 개발 실행은 원문 그대로 — 개발자가 원인을 읽는다.
  assert.equal(plainErrorTitle("spawn claude ENOENT", true), "spawn claude ENOENT");
});

test("사용자가 고칠 수 있는 한국어 안내는 가리지 않는다", () => {
  // 한국어로 시작하고 영어 · 경로 · 스택 흔적이 없는 문장은 원문 그대로 —
  // 가리면 무엇을 고쳐야 하는지가 사라진다.
  const size = "8MB 를 넘는 파일은 붙일 수 없습니다.";
  assert.equal(plainErrorTitle(size, false), size);
  const other = "다른 프로젝트의 대화입니다 — 프로젝트를 전환한 뒤 보내 주세요.";
  assert.equal(plainErrorTitle(other, false), other);
  // 3자 이상의 라틴 뭉치(PDF · git · 파일명 조각)와 경로 표식은 가린다 — 보수 쪽.
  assert.equal(plainErrorTitle("PDF 파일은 읽지 못합니다.", false), RAW_ERROR_WORDS);
  // 영어가 섞였거나 경로가 샐 수 있는 문장은 한 줄로 가린다.
  assert.equal(plainErrorTitle("저장이 실패했습니다: spawn claude ENOENT", false), RAW_ERROR_WORDS);
  assert.equal(plainErrorTitle("파일 screen.tsx 를 읽지 못했습니다", false), RAW_ERROR_WORDS);
  // 한국어로 시작하지 않으면 가린다 — 영어 원문 · 스택 흔적.
  assert.equal(
    plainErrorTitle("Error: connect ECONNREFUSED 127.0.0.1:7823", false),
    RAW_ERROR_WORDS,
  );
});
