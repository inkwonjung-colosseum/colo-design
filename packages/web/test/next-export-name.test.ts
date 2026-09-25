import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(next-thread.test.ts 와 같은 모양).
import { exportFileName } from "../src/next/lib/export-name.ts";

const DAY = new Date(2026, 8, 5); // 2026-09-05 — 달은 0부터 센다.

test("exportFileName: 제목 뒤에 그날의 날짜를 붙인다", () => {
  assert.equal(exportFileName("회원 목록", DAY), "회원 목록-2026-09-05");
  assert.equal(exportFileName("회원 목록", new Date(2026, 10, 25)), "회원 목록-2026-11-25");
});

test("exportFileName: 파일에 쓸 수 없는 글자를 눌러 닫는다", () => {
  assert.equal(exportFileName('a/b\\c:d*e?f"g<h>i|j', DAY), "a_b_c_d_e_f_g_h_i_j-2026-09-05");
});

test("exportFileName: 흰칸을 한 칸으로 누르고 끝을 다듬는다", () => {
  assert.equal(exportFileName("  회원\t 목록 \n", DAY), "회원 목록-2026-09-05");
});

test("exportFileName: 빈 제목은 conversation", () => {
  assert.equal(exportFileName("", DAY), "conversation-2026-09-05");
  assert.equal(exportFileName("   ", DAY), "conversation-2026-09-05");
});
