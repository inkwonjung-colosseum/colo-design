// 공통 지침의 모양 시험 (PLAN-MCP M-11) — 새 불릿이 `- ` 한 줄 형식을 지키는지와
// 지침이 새 도구 이름을 말하는지 본다. src 임포트인 이유는 turn-subject.test.ts 와 같다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMON_INSTRUCTIONS, stripCommonInstructions } from "../src/common-instructions.ts";

test("공통 지침은 새 도구 이름을 말한다 — 찾기 · 조사 · 화면 파일 · 개발자 쪽지", () => {
  for (const name of [
    "browser_find",
    "browser_inspect",
    "screen_files",
    "repo_diagnostics",
    "notify_developer",
  ]) {
    assert.ok(COMMON_INSTRUCTIONS.includes(name), `지침이 ${name} 을 언급한다`);
  }
  assert.ok(COMMON_INSTRUCTIONS.includes("routes"), "지침이 여러 화면의 한 번에 보기를 말한다");
  assert.ok(COMMON_INSTRUCTIONS.includes("viewport"), "지침이 화면 폭을 말한다");
  assert.ok(COMMON_INSTRUCTIONS.includes("capture"), "지침이 문제 화면의 그림을 말한다");
});

test("블록의 줄은 헤더 · 설명 · 빈 줄 · `- ` 불릿뿐이다 — 줄 걸음이 그 모양만 규칙으로 센다", () => {
  // stripCommonInstructions 의 줄 걸음 경로는 이 네 모양만 지나고 첫 벗어난 줄에서 멈춘다.
  // 새 불릿이 이 모양을 깨면 옛 저장본의 규칙 떼어내기가 사용자의 말을 삼킨다.
  const rows = COMMON_INSTRUCTIONS.split("\n").slice(1);
  for (const row of rows) {
    const trimmed = row.trim();
    assert.ok(
      trimmed === "" || trimmed.startsWith("- ") || trimmed.startsWith("이 규칙은"),
      `규칙 블록의 줄은 불릿 · 빈 줄 · 설명뿐이어야 한다: ${trimmed.slice(0, 40)}`,
    );
  }
});

test("새 불릿도 규칙 블록으로 걷힌다 — 블록 뒤에는 사용자의 말만 남는다", () => {
  const turn = `${COMMON_INSTRUCTIONS}\n회원 목록에 검색창을 넣어 줘`;
  assert.equal(stripCommonInstructions(turn), "회원 목록에 검색창을 넣어 줘");
});

test("줄 걸음 경로도 새 불릿을 걷는다 — 저장본의 불릿이 달라도 `- ` 모양이면 충분하다", () => {
  // 지침이 바뀌기 전에 저장된 턴은 상수와 정확히 같지 않다 — 이때는 헤더로
  // 시작하는 줄 걸음이 걷는다. 새 불릿이 한 줄 형식을 지키는 것이 이 길의 전제다.
  const elementBullet = COMMON_INSTRUCTIONS.split("\n").find((row) =>
    row.startsWith("- 화면의 요소를 다시 읽을 때는"),
  );
  assert.ok(elementBullet !== undefined, "요소 읽기 불릿이 실려 있다");
  const stored = [
    "# Nova Design 공통 규칙",
    "",
    "이 규칙은 어떤 레포를 연결했는지와 무관하게 모든 대화에 함께 간다.",
    "",
    "- 옛 불릿",
    elementBullet,
    "",
    "회원 목록에 검색창을 넣어 줘",
  ].join("\n");
  assert.equal(stripCommonInstructions(stored), "회원 목록에 검색창을 넣어 줘");
});
