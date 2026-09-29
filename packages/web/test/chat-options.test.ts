import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionModelInfo } from "@nova-design/protocol";
// 순수 모듈 — src 에서 곧장 읽는다(next-thread.test.ts 와 같은 모양).
import { modelName } from "../src/lib/chat-options.ts";

const row = (
  over: Pick<SessionModelInfo, "value" | "displayName" | "resolvedModel">,
): SessionModelInfo => ({
  description: "",
  supportsEffort: true,
  supportedEffortLevels: null,
  supportsFastMode: false,
  ...over,
});

// Claude CLI 의 supportedModels 가 실제로 답한 모양(2026-09-29 probe).
const claude = [
  row({
    value: "default",
    displayName: "Default (recommended)",
    resolvedModel: "claude-opus-5[1m]",
  }),
  row({ value: "opus[1m]", displayName: "Opus (1M context)", resolvedModel: "claude-opus-5[1m]" }),
  row({ value: "claude-fable-5-1[1m]", displayName: "Fable", resolvedModel: "claude-fable-5-1" }),
  row({ value: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-5" }),
];

test("modelName: 고른 행은 CLI 가 붙인 이름 그대로", () => {
  assert.equal(modelName(claude, "sonnet"), "Sonnet");
  assert.equal(modelName(claude, "claude-fable-5-1"), "Fable");
});

test("modelName: 고르지 않은 채(null)와 default 행은 같은 모델로 풀리는 행의 이름", () => {
  assert.equal(modelName(claude, null), "Opus (1M context)");
  assert.equal(modelName(claude, "default"), "Opus (1M context)");
  // 대화가 보고한 wire id 도 같은 행을 찾는다 — 창 표식([1m])이 빠져도.
  assert.equal(modelName(claude, "claude-opus-5[1m]"), "Opus (1M context)");
  assert.equal(modelName(claude, "claude-opus-5"), "Opus (1M context)");
});

test("modelName: 쌍이 없는 default 행은 풀린 id 를 이름으로 읽는다", () => {
  const [lone] = claude;
  assert.ok(lone);
  assert.equal(modelName([lone], null), "Opus 5");
});

test("modelName: 목록에 없는 id 는 버리지 않고 이름으로 읽는다", () => {
  assert.equal(modelName(claude, "claude-sonnet-5-5"), "Sonnet 5.5");
  assert.equal(modelName(claude, "claude-haiku-4-5-20251001"), "Haiku 4.5");
  // 날짜 꼬리는 버전이 아니다.
  assert.equal(modelName(claude, "claude-opus-5-20260101"), "Opus 5");
  assert.equal(modelName([], "gpt-5.2-codex"), "gpt-5.2-codex");
});

test("modelName: 아무것도 모델을 이름하지 않을 때만 null — 그때 칩은 AI 이름", () => {
  assert.equal(modelName([], null), null);
});
