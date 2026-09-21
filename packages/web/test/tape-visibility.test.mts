/**
 * 테이프의 보이는 규칙 — 설정의 `생각 과정 보기` · `작업 과정 보기`가 블록을
 * 어떻게 거르는지. 계획 카드(TodoWrite)는
 * 도구여도 언제나 자리를 지킨다는 예외가 여기서 못 들어오게 한다 — "도구는
 * 전부 숨긴다" 로 단순해진 필터는 계획을 함께 지워 버린다.
 *
 * Run: node --experimental-transform-types --test packages/web/test/tape-visibility.test.mts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Block } from "../src/lib/daemon-client.ts";
import { isToolRunning } from "../src/lib/progress.ts";
import { blockOnTape, mergeThinking, tailMoving } from "../src/lib/tape-visibility.ts";

/** 호출부(ChatColumn)가 잇는 바로 그 조합 — 검사도 같은 조합을 문의한다. */
const moving = (tape: Block[], showThinking = false, showTools = false): boolean =>
  tailMoving(tape, showThinking, showTools, isToolRunning);

const tool = (name: string, id = "k1"): Block =>
  ({ type: "tool", id, name, input: {}, done: true }) as unknown as Block;
type Thinking = Extract<Block, { type: "thinking" }>;
const thinking = (
  id = "t1",
  text = "음",
  streaming = false,
  agentId: string | null = null,
): Thinking => ({ type: "thinking", id, text, agentId, streaming });
const other = (type: Block["type"], id: string): Block => ({ type, id }) as unknown as Block;
/** 이어진 생각을 읽는 자리 — 좁히기가 여기 한 번 있고, 검사들은 값만 본다. */
const thoughtAt = (tape: Block[], index: number): Thinking => {
  const block = tape[index];
  if (!block || block.type !== "thinking") throw new Error(`${index}번째는 생각 블록이 아니다`);
  return block;
};

test("작업 과정이 꺼져 있으면 도구 묶음은 테이프에서 빠진다", () => {
  assert.equal(blockOnTape(tool("Bash"), false, false), false);
  assert.equal(blockOnTape(tool("Write"), false, false), false);
  assert.equal(blockOnTape(tool("Grep"), false, true), true);
});

test("계획 카드는 스위치와 무관하게 남는다", () => {
  assert.equal(blockOnTape(tool("TodoWrite"), false, false), true);
  // 화면 도구는 사라졌다 (게이트 재배선) — 옛 대화의 재생분은 일반 도구 행.
  assert.equal(blockOnTape(tool("mcp__colo-preview__screen_screenshot"), false, false), false);
});

test("생각 과정은 자기 스위치를 따르고, 작업 스위치가 대신하지 않는다", () => {
  assert.equal(blockOnTape(thinking(), false, true), false);
  assert.equal(blockOnTape(thinking(), true, false), true);
});

test("사람이 읽는 블록 — 말 · 턴 끝 · 안내 — 는 언제나 테이프에 있다", () => {
  for (const type of ["user", "text", "turn", "notice"] as const) {
    assert.equal(blockOnTape(other(type, "x1"), false, false), true, type);
  }
});

/**
 * 한 턴의 AI 는 도구를 부를 때마다 생각을 새 블록으로 끊는다. 작업 과정이
 * 꺼진 테이프에서는 그 조각들이 이웃이 되어 접힌 줄의 벽으로 쌓였다(실사 결함).
 */
test("이웃한 생각 조각은 한 생각으로 이어진다", () => {
  const merged = mergeThinking([thinking("t1", "먼저 읽는다"), thinking("t2", "다음엔 고친다")]);
  assert.equal(merged.length, 1);
  assert.equal(thoughtAt(merged, 0).id, "t1");
  assert.equal(thoughtAt(merged, 0).text, "먼저 읽는다\n\n다음엔 고친다");
});

test("이어진 생각의 진행은 마지막 조각의 것이다", () => {
  const merged = mergeThinking([
    thinking("t1", "끝난 생각", false),
    thinking("t2", "도는 생각", true),
  ]);
  assert.equal(thoughtAt(merged, 0).streaming, true);
});

test("사이에 읽을 것이 서면 생각은 잇지 않는다", () => {
  const tape = [thinking("t1"), other("text", "a1"), thinking("t2")];
  assert.equal(mergeThinking(tape).length, 3);
});

test("하위 작업의 속말은 본 스레드의 생각에 붙지 않는다", () => {
  const tape = [thinking("t1", "음", false, null), thinking("t2", "음", false, "k6")];
  assert.equal(mergeThinking(tape).length, 2);
});

/**
 * 대기 표시(turnlive)의 판정 — 꼬리가 움직이지 않는 매 순간에 줄이 선다.
 * 첫 보이는 블록 전의 빈 자리뿐 아니라, 도구와 도구 사이 생각만 흐르는
 * 침묵(생각 과정은 기본 숨김)도 그 자리다 — 그 빈 자리마다 도는 턴이
 * 스피너도 시계도 없는 화면으로 열렸다(실사 결함).
 */
test("아무것도 안 온 테이프와 사람 말 하나뿐인 테이프는 움직이지 않는다", () => {
  assert.equal(moving([]), false);
  assert.equal(moving([other("user", "u1")]), false);
});

test("도는 도구와 흐르는 말은 움직임이다 — 줄은 비켜 선다", () => {
  const running = { type: "tool", id: "k1", name: "Bash", input: {}, done: false };
  assert.equal(moving([other("user", "u1"), running as Block], false, true), true);
  assert.equal(
    moving([
      other("user", "u1"),
      { type: "text", id: "a1", text: "답", agentId: null, streaming: true },
    ]),
    true,
  );
});

test("끝난 도구 뒤의 침묵은 움직임이 아니다 — 줄이 다시 선다", () => {
  // 도구는 끝났는데 턴은 도는 중 — 생각(숨김)만 흐르는 구간. 활동 막대는
  // ✓를 보이고 화면엔 아는 표시가 하나도 없었는데, 이 판정이 그 자리를 채운다.
  const tape = [other("user", "u1"), tool("Bash", "k1")];
  assert.equal(moving(tape, false, true), false);
});

test("숨긴 생각만 흐르는 턴도 움직이지 않은 것으로 읽는다", () => {
  const tape = [other("user", "u1"), thinking("t1", "음", true), tool("Bash", "k2")];
  assert.equal(moving(tape), false);
  assert.equal(moving(tape, false, true), false, "끝난 도구는 켜도 움직임이 아니다");
  // 생각 과정을 켜면 흐르는 생각 자체가 움직임이다.
  assert.equal(moving(tape, true), true);
});

test("뒤에서 도는 작업은 보이는 테이프 위에서만 움직임이다", () => {
  const backgrounded = {
    type: "tool",
    id: "k3",
    name: "Bash",
    input: {},
    done: true,
    progress: { task: { backgrounded: true, status: "running" } },
  } as unknown as Block;
  // 작업 과정이 켜진 화면에선 도는 막대 자체가 움직임이다.
  assert.equal(moving([other("user", "u1"), backgrounded], false, true), true);
  // 꺼진 화면에선 막대가 없고, 그 몫은 WorkStrip 칩이 대신 본다.
  assert.equal(moving([other("user", "u1"), backgrounded]), false);
});
