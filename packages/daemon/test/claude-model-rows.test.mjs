/**
 * 모델 목록의 외톨이, 오프라인 단위: CLI 는 자기 프로세스가 상속한
 * `ANTHROPIC_MODEL` 을 "Custom model" 행으로 되돌려준다. 에이전트 조립판
 * 터미널에서 앱을 띄우면 그 변수가 따라 오므로, 피커는 구독으로 굴러가지
 * 않는 이름을 행으로 팔게 된다. 이 파일이 지키는 한 줄이다 — 상속된 에코는
 * 목록에서 거두되, 기동 때 박은 모델의 행은 살아 있다.
 *
 * Usage: node --test packages/daemon/test/claude-model-rows.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { ClaudeAgentSession } = await import("../dist/agent/drivers/claude/session.js");

const CATALOG_ROWS = [
  {
    value: "default",
    displayName: "Default (recommended)",
    resolvedModel: "claude-opus-5[1m]",
    description: "Opus 5 with 1M context · Best for everyday, complex tasks",
  },
  {
    value: "sonnet",
    displayName: "Sonnet",
    resolvedModel: "claude-sonnet-5",
    description: "Sonnet 5 · Efficient for routine tasks",
  },
];

/** CLI 가 에코를 붙인 목록 — 실제 응답과 같은 모양. */
function catalogWithEcho() {
  return [
    ...CATALOG_ROWS,
    {
      value: "stub-model",
      displayName: "stub-model",
      resolvedModel: "stub-model",
      description: "Custom model",
      supportsEffort: true,
    },
  ];
}

/** prototype-call 스텁 — fast-mode.test.mjs 의 걸음. */
function modelsSession({ pinnedModel } = {}) {
  return {
    run: { supportedModels: async () => catalogWithEcho() },
    pinnedModel,
  };
}

test("상속된 ANTHROPIC_MODEL 의 에코 행은 목록에서 거둔다", async () => {
  process.env.ANTHROPIC_MODEL = "stub-model";
  try {
    const rows = await ClaudeAgentSession.prototype.models.call(modelsSession());
    assert.deepEqual(
      rows.map((row) => row.value),
      ["default", "sonnet"],
    );
  } finally {
    delete process.env.ANTHROPIC_MODEL;
  }
});

test("기동 때 박은 모델의 에코 행은 살아 있다 — 고른 것이다, 상속이 아니다", async () => {
  process.env.ANTHROPIC_MODEL = "stub-model";
  try {
    const rows = await ClaudeAgentSession.prototype.models.call(
      modelsSession({ pinnedModel: "stub-model" }),
    );
    assert.equal(rows.length, 3);
  } finally {
    delete process.env.ANTHROPIC_MODEL;
  }
});

test("변수가 없으면 같은 모양의 행도 거두지 않는다", async () => {
  delete process.env.ANTHROPIC_MODEL;
  const rows = await ClaudeAgentSession.prototype.models.call(modelsSession());
  assert.equal(rows.length, 3);
});

test("이름이 겹쳐도 CLI 가 Custom model 이라 부르지 않은 행은 목록에 남는다", async () => {
  process.env.ANTHROPIC_MODEL = "sonnet";
  try {
    const rows = await ClaudeAgentSession.prototype.models.call(modelsSession());
    assert.deepEqual(
      rows.map((row) => row.value),
      ["default", "sonnet", "stub-model"],
    );
  } finally {
    delete process.env.ANTHROPIC_MODEL;
  }
});
