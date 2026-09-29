import assert from "node:assert/strict";
import { test } from "node:test";
// 컴파일된 dist 를 읽는다 — 데몬 시험의 계약 (catalog-gate.test.ts 모양).
import { threadProvider } from "../dist/thread-provider.js";

test("새 대화 — 요청된 공급자를 쓴다", () => {
  assert.deepEqual(threadProvider({ requested: "codex" }), { provider: "codex" });
});

test("빈 resume 은 새 대화다 — 요청된 공급자를 쓴다", () => {
  assert.deepEqual(threadProvider({ resume: "", requested: "codex" }), { provider: "codex" });
});

test("빈 resume 은 새 대화다 — 요청이 없으면 claude", () => {
  assert.deepEqual(threadProvider({ resume: "" }), { provider: "claude" });
});
test("새 대화 — 아무것도 오지 않으면 claude", () => {
  assert.deepEqual(threadProvider({}), { provider: "claude" });
});

test("재개 — 저장소가 아는 주인이 드라이버다", () => {
  assert.deepEqual(threadProvider({ resume: "s1", stored: "codex" }), { provider: "codex" });
});

test("재개 — 요청이 주인과 같으면 그대로이고 ignored 는 없다", () => {
  assert.deepEqual(threadProvider({ resume: "s1", requested: "codex", stored: "codex" }), {
    provider: "codex",
  });
});

test("재개 — 다른 공급자를 실어 와도 주인이 이기고 무시한 값을 돌려준다", () => {
  assert.deepEqual(threadProvider({ resume: "s1", requested: "claude", stored: "codex" }), {
    provider: "codex",
    ignored: "claude",
  });
});

test("재개 — 살아 있는 세션이 저장소와 요청을 모두 이긴다", () => {
  assert.deepEqual(
    threadProvider({ resume: "s1", requested: "claude", live: "other", stored: "codex" }),
    { provider: "other", ignored: "claude" },
  );
});

test("재개 — 주인을 아무도 모르는 id 는 요청을 믿는다", () => {
  assert.deepEqual(threadProvider({ resume: "s1", requested: "codex" }), { provider: "codex" });
});

test("재개 — 주인도 요청도 없으면 던진다", () => {
  assert.throws(
    () => threadProvider({ resume: "s1" }),
    /이 대화를 저장한 에이전트를 찾지 못했습니다/,
  );
});
