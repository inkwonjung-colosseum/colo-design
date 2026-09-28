import assert from "node:assert/strict";
import { test } from "node:test";
// 컴파일된 dist 를 읽는다 — `@colo-design/protocol` 의 스키마 import 가 얽혀 있다.
import { toModelRows } from "../dist/agent/drivers/claude/session.js";

/** `ANTHROPIC_MODEL` 을 잠깐 세웠다가 끝나면 반드시 되돌린다 — 다른 시험이 읽는다. */
function withAmbientModel(value: string, run: () => void): void {
  const previous = process.env.ANTHROPIC_MODEL;
  process.env.ANTHROPIC_MODEL = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = previous;
  }
}

test("빠진 선택 칸은 프로토콜의 기본값으로 채워진다", () => {
  const rows = toModelRows(
    [{ value: "sonnet", displayName: "Sonnet", description: "balanced" }],
    null,
  );
  assert.deepEqual(rows, [
    {
      value: "sonnet",
      displayName: "Sonnet",
      resolvedModel: null,
      description: "balanced",
      supportsEffort: false,
      supportedEffortLevels: null,
      supportsFastMode: false,
    },
  ]);
});

test("있는 값은 그대로 남는다", () => {
  const rows = toModelRows(
    [
      {
        value: "opus",
        displayName: "Opus",
        resolvedModel: "claude-opus-5",
        description: "deepest",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
        supportsFastMode: true,
      },
    ],
    null,
  );
  assert.equal(rows[0].resolvedModel, "claude-opus-5");
  assert.equal(rows[0].supportsEffort, true);
  assert.deepEqual(rows[0].supportedEffortLevels, ["low", "high"]);
  assert.equal(rows[0].supportsFastMode, true);
});

test("환경 변수가 반영한 Custom model 행은 걸러진다", () => {
  withAmbientModel("anthropic/claude-routed", () => {
    const rows = toModelRows(
      [
        { value: "sonnet", displayName: "Sonnet", description: "balanced" },
        {
          value: "anthropic/claude-routed",
          displayName: "claude-routed",
          description: "Custom model",
        },
      ],
      undefined,
    );
    assert.deepEqual(
      rows.map((row) => row.value),
      ["sonnet"],
    );
  });
});

test("그 행이 이번 세션에 고정된 모델이면 남는다", () => {
  withAmbientModel("anthropic/claude-routed", () => {
    const rows = toModelRows(
      [
        { value: "sonnet", displayName: "Sonnet", description: "balanced" },
        {
          value: "anthropic/claude-routed",
          displayName: "claude-routed",
          description: "Custom model",
        },
      ],
      "anthropic/claude-routed",
    );
    assert.deepEqual(
      rows.map((row) => row.value),
      ["sonnet", "anthropic/claude-routed"],
    );
  });
});
