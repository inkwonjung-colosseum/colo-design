/**
 * 할 일 목록의 읽기 — TodoWrite 입력의 방어적 파싱과 "최신 목록 하나" 규칙.
 * TodoWrite 는 덮어쓰는 도구다: 과거의 목록이 이기면 스트립이 끝난 일을
 * 다음 일처럼 읽힌다. 목록을 쓴 적이 없으면 null — 빈 카드는 소음이다.
 *
 * Run: node --experimental-transform-types --test packages/web/test/todo-plan.test.mts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Block } from "../src/lib/daemon-client.ts";
import { latestTodoItems, readTodoList } from "../src/lib/todo-plan.ts";

type ToolBlock = Extract<Block, { type: "tool" }>;

const todoTool = (id: string, todos: unknown): ToolBlock => ({
  type: "tool",
  id,
  name: "TodoWrite",
  input: { todos },
  agentId: null,
  done: true,
});

test("입력의 세 모양을 다 읽는다 — content · activeForm · subject", () => {
  const items = readTodoList({
    todos: [
      { content: "본문으로 쓴 일", status: "pending" },
      { activeForm: "activeForm 으로 쓴 일", status: "in_progress" },
      { subject: "subject 로 쓴 일", status: "completed" },
    ],
  });
  assert.deepEqual(
    items?.map((t) => t.text),
    ["본문으로 쓴 일", "activeForm 으로 쓴 일", "subject 로 쓴 일"],
  );
});

test("목록이 아니면 null — 알 수 없는 입력에 카드를 그리지 않는다", () => {
  assert.equal(readTodoList(null), null);
  assert.equal(readTodoList({}), null);
  assert.equal(readTodoList({ todos: "아니야" }), null);
});

test("모르는 상태는 미래의 일로 읽는다 — pending 이 안전한 기본이다", () => {
  const items = readTodoList({ todos: [{ content: "상태 없는 일", status: "weird" }] });
  assert.deepEqual(
    items?.map((t) => t.status),
    ["pending"],
  );
});

test("빈 줄 하나가 목록을 망치지 않는다 — 빈 항목은 빈 텍스트로 남는다", () => {
  const items = readTodoList({ todos: [{ content: "   ", status: "pending" }, null, 42] });
  assert.equal(items?.length, 3);
  assert.equal(items?.[0].text, "");
});

test("할 일은 마지막 목록 하나 — 과거의 목록이 이기지 않는다", () => {
  const blocks: Block[] = [
    todoTool("todo1", [
      { content: "옛날 일", status: "pending" },
      { content: "또 옛날 일", status: "completed" },
    ]),
    todoTool("todo2", [
      { content: "지금 일", status: "in_progress" },
      { content: "끝낸 일", status: "completed" },
      { content: "아직 일", status: "pending" },
    ]),
  ];
  const todos = latestTodoItems(blocks);
  assert.equal(todos?.length, 3);
  assert.deepEqual(
    todos?.map((t) => t.text),
    ["지금 일", "끝낸 일", "아직 일"],
  );
});

test("TodoWrite 가 없으면 null — 빈 목록 카드를 그리지 않는다", () => {
  const other: ToolBlock = {
    type: "tool",
    id: "t1",
    name: "Bash",
    input: { command: "ls" },
    agentId: null,
    done: true,
  };
  assert.equal(latestTodoItems([other]), null);
});
