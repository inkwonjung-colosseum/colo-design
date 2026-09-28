import assert from "node:assert/strict";
import { test } from "node:test";
// 컴파일된 dist 를 읽는다 — `@colo-design/protocol` 의 스키마 import 가 얽혀 있다.
import { fastPairs, ompModelRows } from "../dist/agent/drivers/omp/catalog.js";

const devinRow = (id: string, name = id) => ({
  provider: "devin",
  id,
  name,
  reasoning: true,
  thinking: ["low", "medium", "high"],
});

test("베이스↔`-fast` 변종은 양방향으로 짝이 잡힌다", () => {
  const pairs = fastPairs([devinRow("claude-opus-5"), devinRow("claude-opus-5-fast")]);
  assert.equal(pairs.get("devin/claude-opus-5"), "devin/claude-opus-5-fast");
  assert.equal(pairs.get("devin/claude-opus-5-fast"), "devin/claude-opus-5");
});

test("베이스가 없는 `-fast` 행은 짝이 아니다 — 남고 칩도 서지 않는다", () => {
  const rows = ompModelRows([devinRow("orphan-fast")]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].supportsFastMode, false);
  assert.equal(fastPairs([devinRow("orphan-fast")]).size, 0);
});

test("짝 있는 `X Fast` 행은 목록에서 접힌다 — 베이스만 서고 ⚡ 를 받는다", () => {
  const rows = ompModelRows([
    devinRow("claude-opus-5", "Claude Opus 5"),
    devinRow("claude-opus-5-fast", "Claude Opus 5 Fast"),
    devinRow("gpt-5-5"),
  ]);
  assert.deepEqual(
    rows.map((r) => r.displayName),
    ["Claude Opus 5", "gpt-5-5"],
  );
  const base = rows.find((r) => r.value === "devin/claude-opus-5");
  assert.equal(base?.supportsFastMode, true);
  // 변종 짝이 없는 모델은 devin 의 가족 밖이라 칩이 서지 않는다.
  assert.equal(rows.find((r) => r.value === "devin/gpt-5-5")?.supportsFastMode, false);
});

test("지금 도는 몸이 변종이면 그 행은 접지 않는다 — 칩의 앞말과 ⚡ 상태가 읽는다", () => {
  const rows = ompModelRows(
    [devinRow("claude-opus-5"), devinRow("claude-opus-5-fast", "Claude Opus 5 Fast")],
    "devin/claude-opus-5-fast",
  );
  const fast = rows.find((r) => r.value === "devin/claude-opus-5-fast");
  assert.equal(fast?.displayName, "Claude Opus 5 Fast");
  assert.equal(fast?.supportsFastMode, true);
});

test("이름 가운데 fast 를 품은 fusion 행은 변종이 아니다", () => {
  const fusion = devinRow(
    "fusion-claude-fable-5-1-high-fast-sidekick-gpt-5-6-luna-high-priority",
  );
  const rows = ompModelRows([devinRow("claude-fable-5-1"), fusion]);
  assert.equal(rows.some((r) => r.value === `devin/${fusion.id}`), true);
  assert.equal(fastPairs([fusion]).size, 0);
});
