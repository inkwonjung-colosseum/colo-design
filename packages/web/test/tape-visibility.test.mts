/**
 * 테이프의 보이는 규칙 — 설정의 `생각 과정 보기` · `작업 과정 보기`가 블록을
 * 어떻게 거르는지. 계획 카드(TodoWrite, PLAN D48)와 캡처 카드(PLAN D56)는
 * 도구여도 언제나 자리를 지킨다는 예외가 여기서 못 들어오게 한다 — "도구는
 * 전부 숨긴다" 로 단순해진 필터는 계획과 화면을 함께 지워 버린다.
 *
 * Run: node --experimental-transform-types --test packages/web/test/tape-visibility.test.mts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Block } from "../src/daemon-client.ts";
import { blockOnTape } from "../src/tape-visibility.ts";

const tool = (name: string, id = "k1"): Block =>
  ({ type: "tool", id, name, input: {}, done: true }) as unknown as Block;
const thinking = (id = "t1"): Block =>
  ({ type: "thinking", id, text: "음", agentId: null, streaming: false }) as unknown as Block;
const other = (type: Block["type"], id: string): Block => ({ type, id }) as unknown as Block;

test("작업 과정이 꺼져 있으면 도구 묶음은 테이프에서 빠진다", () => {
  assert.equal(blockOnTape(tool("Bash"), false, false), false);
  assert.equal(blockOnTape(tool("Write"), false, false), false);
  assert.equal(blockOnTape(tool("Grep"), false, true), true);
});

test("계획 카드와 캡처 카드는 스위치와 무관하게 남는다(PLAN D48·D56)", () => {
  assert.equal(blockOnTape(tool("TodoWrite"), false, false), true);
  assert.equal(blockOnTape(tool("mcp__colo-preview__screen_screenshot"), false, false), true);
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
