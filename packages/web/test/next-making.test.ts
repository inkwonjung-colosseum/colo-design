import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(turn-screens.test.ts 와 같은 모양).
import type { Block } from "../src/lib/daemon-client.ts";
import {
  FIRST_TURN_HINT_MS,
  firstTurn,
  heldPhase,
  MAKING_CHECK_MS,
  MAKING_HOLD_MS,
  makingPhase,
} from "../src/next/lib/making.ts";

let seq = 0;
const nextSeq = () => (seq += 1);

/** 도구 행 — 이름 · 끝났는지 · 주인(하위 에이전트면 그 id). */
const tool = (name: string, done: boolean, agentId: string | null = null): Block => ({
  type: "tool",
  id: `t${nextSeq()}`,
  name,
  input: null,
  agentId,
  done,
});

/** 사용자의 말 한 통 — 시험은 내용을 보지 않는다. */
const user = (): Block => ({ type: "user", id: `u${nextSeq()}`, text: "말", images: 0 });

/** 생각 행 — 턴 안의 도구 사이에 낀 것을 걷어내는지 보는 잉여. */
const thinking = (): Block => ({
  type: "thinking",
  id: `s${nextSeq()}`,
  text: "…",
  agentId: null,
  streaming: false,
});

/** 백그라운드로 맡긴 검사 — 행은 끝났지만 일은 돈다(progress.task). */
const backgrounded = (): Block => ({
  ...tool("Bash", true),
  progress: {
    task: {
      id: "bg",
      description: "검사",
      summary: null,
      lastTool: null,
      subagentType: null,
      tokens: 0,
      toolUses: 0,
      backgrounded: true,
      status: "running",
    },
  },
});

test("makingPhase: 도구가 없으면 말을 고르지 않는다 — 생각 중 · 막 보낸 참", () => {
  assert.equal(makingPhase([]), null);
  assert.equal(makingPhase([user()]), null);
  assert.equal(makingPhase([user(), thinking()]), null);
});

test("makingPhase: 읽기 도구만 있으면 살펴보는 중 — 사용자 말이 없어도 턴은 턴이다", () => {
  assert.equal(makingPhase([tool("Read", false)]), "read");
  assert.equal(makingPhase([user(), tool("Grep", true)]), "read");
});

test("makingPhase: 도는 것이 우선한다 — 끝난 읽기 뒤에 도는 편집이 말을 고른다", () => {
  assert.equal(makingPhase([user(), tool("Read", true), tool("Edit", false)]), "file");
});

test("makingPhase: 도는 것이 둘이면 마지막 것 — 읽다가 편집으로 옮겨 간 참", () => {
  assert.equal(makingPhase([user(), tool("Read", false), tool("write", false)]), "file");
});

test("makingPhase: 도는 것이 없으면 그 턴의 마지막 도구 — 끝난 편집 뒤 검사", () => {
  assert.equal(makingPhase([user(), tool("Edit", true), tool("Bash", true)]), "command");
});

test("makingPhase: 백그라운드로 맡긴 검사는 끝난 행에도 도는 중이다", () => {
  assert.equal(makingPhase([user(), tool("Edit", true), backgrounded()]), "command");
});

test("makingPhase: 하위 에이전트의 도구도 이 턴의 걸음이다", () => {
  assert.equal(makingPhase([user(), tool("Edit", true), tool("bash", false, "sub-1")]), "command");
  assert.equal(
    makingPhase([user(), tool("bash", true, "sub-1"), tool("edit", false, "sub-2")]),
    "file",
  );
});

test("makingPhase: 마지막 사용자 말 뒤만 센다 — 지난 턴의 도구는 잊는다", () => {
  assert.equal(
    makingPhase([user(), tool("Bash", false), user(), thinking(), tool("Grep", true)]),
    "read",
  );
});

test("makingPhase: 모르는 도구는 말을 바꾸지 않는다 — 그대로 `만드는 중`", () => {
  assert.equal(makingPhase([user(), tool("WebSearch", false)]), null);
});

test("firstTurn: 사용자의 말이 정확히 하나일 때만 첫 턴이다", () => {
  assert.equal(firstTurn([]), false);
  assert.equal(firstTurn([user()]), true);
  assert.equal(firstTurn([user(), thinking(), tool("Read", false)]), true);
  assert.equal(firstTurn([user(), tool("Read", true), user()]), false);
});

test("FIRST_TURN_HINT_MS: 첫 답의 안내는 60초 뒤에 붙는다", () => {
  assert.equal(FIRST_TURN_HINT_MS, 60_000);
});

test("heldPhase: 첫 말은 곧장 보인다 — 기억이 없으면 시계를 지금으로 시작한다", () => {
  assert.deepEqual(heldPhase(null, "read", 5_000), { phase: "read", at: 5_000 });
  assert.deepEqual(heldPhase(null, null, 7_000), { phase: null, at: 7_000 });
});

test("heldPhase: 입던 말은 최소 유지 시간을 채울 때까지 산다", () => {
  const shown = { phase: "read" as const, at: 1_000 };
  assert.deepEqual(heldPhase(shown, "file", 2_000), shown);
  assert.deepEqual(heldPhase(shown, "file", 1_000 + MAKING_HOLD_MS - 1), shown);
});

test("heldPhase: 시간이 차면 지금의 단계로 곧장 갈아입는다 — 그 사이는 건너뛴다", () => {
  const shown = { phase: "read" as const, at: 1_000 };
  assert.deepEqual(heldPhase(shown, "command", 1_000 + MAKING_HOLD_MS), {
    phase: "command",
    at: 1_000 + MAKING_HOLD_MS,
  });
  // read → file 로 바뀐 참이지만 이미 command 시대 — file 은 거치지 않는다.
  assert.deepEqual(heldPhase(shown, "command", 9_999), { phase: "command", at: 9_999 });
});

test("heldPhase: 같은 말이면 시계를 다시 못 박지 않는다", () => {
  const shown = { phase: "file" as const, at: 4_000 };
  assert.deepEqual(heldPhase(shown, "file", 9_000), shown);
});

test("MAKING_CHECK_MS: 답이 끝난 뒤 체크는 600ms 를 보인다", () => {
  assert.equal(MAKING_CHECK_MS, 600);
});
