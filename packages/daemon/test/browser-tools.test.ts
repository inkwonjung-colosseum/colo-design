// PLAN 단계 6 시험 — 세션에 실리는 도구 목록의 판정 (L6 · O6).
// `../dist` 임포트인 이유: node --test 는 src 의 `.js` 지정자를 못 읽는다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BROWSER_TOOLS, browserTools, submitNoteOf } from "../dist/browser-tools.js";

test("browserTools — submit_for_review 는 판정이 켜진 세션에만 실린다", () => {
  const full = browserTools(true);
  const cut = browserTools(false);
  assert.ok(
    full.some((tool) => tool.name === "submit_for_review"),
    "켜면 실린다",
  );
  assert.ok(!cut.some((tool) => tool.name === "submit_for_review"), "끄면 빠진다");
  assert.equal(cut.length, full.length - 1, "빠지는 것은 그 하나뿐이다");
  for (const tool of cut) assert.ok(full.includes(tool), "나머지 도구는 그대로다");
});

test("submit_for_review — note 를 선언하지만 required 는 아니다", () => {
  const tool = browserTools(true).find((t) => t.name === "submit_for_review");
  assert.ok(tool, "켜면 실린다");
  assert.equal(tool.properties.note?.type, "string", "note 는 문자열 인자다");
  assert.ok(!tool.required?.includes("note"), "한마디는 선택이다 — required 에서 빠진다");
});

test("submitNoteOf — 공백을 걷고 200자에서 자르며 빈 문자열은 없음이다", () => {
  assert.equal(submitNoteOf({}), undefined, "인자가 없으면 한마디도 없다");
  assert.equal(submitNoteOf({ note: 42 }), undefined, "문자열이 아니면 한마디가 아니다");
  assert.equal(submitNoteOf({ note: "   " }), undefined, "공백만 있으면 한마디가 아니다");
  assert.equal(
    submitNoteOf({ note: "  주말에 봐 주세요  " }),
    "주말에 봐 주세요",
    "앞뒤 공백을 걷는다",
  );
  assert.equal(submitNoteOf({ note: "가".repeat(201) }).length, 200, "200자에서 자른다");
  assert.equal(submitNoteOf({ note: "가".repeat(200) }).length, 200, "정확히 200자는 그대로다");
});

test("BROWSER_TOOLS — 배열 인자는 모두 items 를 선언한다", () => {
  for (const tool of BROWSER_TOOLS) {
    for (const [name, property] of Object.entries(tool.properties)) {
      if (property.type !== "array") continue;
      assert.equal(
        property.items?.type,
        "string",
        `${tool.name}.${name} — items 없는 배열은 OpenAI·Gemini 계열이 도구 정째를 거절한다`,
      );
    }
  }
});
