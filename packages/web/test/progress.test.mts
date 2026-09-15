/**
 * 진행의 병합 (PLAN D97 · D101) — 새 행을 만들지 않고 이름한 도구 행에 붙는
 * 규칙. 여기서 지키는 것 둘:
 *
 * 1. 뒤로 보낸 작업의 `tool_result` 는 자리표시자다. 도구 행이 done 이 되어도
 *    작업이 끝나기 전에는 "도는 중"이어야 한다 — 그렇지 않으면 사용자는 끝난
 *    줄 알고 다음 말을 시작한다.
 * 2. 붙을 행이 없는 사건(집안일, 되살아난 작업, 지나간 기록)은 아무 일도
 *    없었던 것처럼 지나간다 — 배열의 정체까지 그대로.
 *
 * Run: node --experimental-transform-types --test packages/web/test/progress.test.mts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Block } from "../src/daemon-client.ts";
import { attachProgress, isToolRunning, type ProgressEvent } from "../src/progress.ts";

type ToolBlock = Extract<Block, { type: "tool" }>;

const tool = (id: string, done = false): ToolBlock => ({
  type: "tool",
  id,
  name: "Task",
  input: {},
  agentId: null,
  done,
});

const started = (
  taskId: string,
  toolUseId: string | null,
  backgrounded: boolean,
): ProgressEvent => ({
  kind: "task.start",
  taskId,
  toolUseId,
  description: "화면 파일 훑기",
  subagentType: "Explore",
  backgrounded,
});

/** 이 배열의 유일한 도구 행 — 테스트가 읽는 대상. */
function only(blocks: Block[]): ToolBlock {
  const found = blocks.find((block) => block.type === "tool");
  assert.ok(found?.type === "tool", "도구 행이 있어야 한다");
  return found;
}

test("작업의 근황이 그 작업을 띄운 도구 행에 붙는다", () => {
  let blocks: Block[] = [tool("toolu_1")];
  blocks = attachProgress(blocks, started("task_1", "toolu_1", false));
  blocks = attachProgress(blocks, {
    kind: "task.progress",
    taskId: "task_1",
    toolUseId: "toolu_1",
    description: "화면 파일 훑기",
    summary: "인증 모듈 분석 중",
    lastTool: "Read",
    tokens: 1200,
    toolUses: 3,
    durationMs: 9000,
  });
  const task = only(blocks).progress?.task;
  assert.equal(task?.summary, "인증 모듈 분석 중");
  assert.equal(task?.toolUses, 3);
  assert.equal(task?.status, "running");
});

test("뒤로 보낸 작업은 도구 결과가 와도 끝난 것이 아니다", () => {
  let blocks: Block[] = [tool("toolu_1")];
  blocks = attachProgress(blocks, started("task_1", "toolu_1", true));
  // 자리표시자 결과: 도구 호출은 끝났지만 일은 돈다.
  blocks = blocks.map((block) => (block.type === "tool" ? { ...block, done: true } : block));
  assert.equal(isToolRunning(only(blocks)), true, "작업이 끝나기 전에는 도는 중이다");

  blocks = attachProgress(blocks, {
    kind: "task.end",
    taskId: "task_1",
    toolUseId: "toolu_1",
    status: "completed",
    summary: "네 화면을 확인했습니다",
    tokens: 4200,
    toolUses: 9,
    durationMs: 61_000,
  });
  assert.equal(isToolRunning(only(blocks)), false);
  assert.equal(only(blocks).progress?.task?.summary, "네 화면을 확인했습니다");
});

test("포그라운드 작업은 도구 결과를 믿는다 — 늦은 상태 변화에 매달리지 않는다", () => {
  let blocks: Block[] = [tool("toolu_1")];
  blocks = attachProgress(blocks, started("task_1", "toolu_1", false));
  blocks = blocks.map((block) => (block.type === "tool" ? { ...block, done: true } : block));
  // task.update 가 영영 오지 않아도 행이 영원히 돌면 안 된다.
  assert.equal(isToolRunning(only(blocks)), false);
});

test("도구 id 없는 상태 변화도 작업 id 로 제 행을 찾는다", () => {
  let blocks: Block[] = [tool("toolu_1")];
  blocks = attachProgress(blocks, started("task_1", "toolu_1", false));
  blocks = attachProgress(blocks, {
    kind: "task.update",
    taskId: "task_1",
    status: "killed",
    backgrounded: true,
    error: null,
  });
  const task = only(blocks).progress?.task;
  assert.equal(task?.status, "stopped", "killed 는 계획자에게 '중지됨'이다");
  assert.equal(task?.backgrounded, true);
});

test("붙을 행이 없는 사건은 배열을 그대로 둔다", () => {
  const blocks: Block[] = [tool("toolu_1")];
  const after = attachProgress(blocks, started("task_9", "toolu_없음", false));
  assert.equal(after, blocks, "같은 배열이어야 헛된 다시 그리기가 없다");
  assert.equal(
    attachProgress(blocks, {
      kind: "task.update",
      taskId: "task_모르는",
      status: "completed",
      backgrounded: null,
      error: null,
    }),
    blocks,
  );
});

test("경과 초와 재시도는 도구 행의 것이고, 작업 정보를 지우지 않는다", () => {
  let blocks: Block[] = [tool("toolu_1")];
  blocks = attachProgress(blocks, started("task_1", "toolu_1", false));
  blocks = attachProgress(blocks, {
    kind: "tool.progress",
    toolUseId: "toolu_1",
    elapsedSeconds: 42,
    agentId: null,
    retry: { attempt: 2, maxRetries: 5, delayMs: 1000 },
  });
  const progress = only(blocks).progress;
  assert.equal(progress?.elapsedSeconds, 42);
  assert.equal(progress?.retry?.attempt, 2);
  assert.equal(progress?.task?.id, "task_1", "심장 박동이 작업을 지워서는 안 된다");
});
