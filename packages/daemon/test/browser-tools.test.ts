// PLAN 단계 6 시험 — 세션에 실리는 도구 목록의 판정 (L6 · O6).
// `../dist` 임포트인 이유: node --test 는 src 의 `.js` 지정자를 못 읽는다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { browserTools } from "../dist/browser-tools.js";

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
