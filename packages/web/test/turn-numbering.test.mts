/**
 * 되감기 · 체크포인트의 턴 번호 셈 — 데몬의 정의(k 번째 프롬프트)를 웹이
 * 그대로 따르는지. 예전의 text 블록 셈이 만들던 어긋남(도구만 돈 턴의 누락,
 * 한 턴에 답이 둘일 때의 초과)이 다시 못 들어오는 것을 여기서 잡는다.
 *
 * Run: node --experimental-transform-types --test packages/web/test/turn-numbering.test.mts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Block } from "../src/daemon-client.ts";
import { answerTurnNumbers, promptTotal } from "../src/turn-numbering.ts";

const block = (type: Block["type"], id: string): Block => ({ type, id }) as unknown as Block;

test("promptTotal: 기획자의 말과 기계 턴을 모두 센다", () => {
  const blocks = [
    block("user", "u1"),
    block("text", "a1"),
    block("user", "u2"), // 기계 턴(코멘트 묶음)도 프롬프트다
    block("tool", "t1"),
    block("text", "a2"),
  ];
  assert.equal(promptTotal(blocks), 2);
});

test("답의 턴은 그 답을 낸 프롬프트의 순번 — 한 턴에 답이 둘여도 같은 턴", () => {
  const blocks = [
    block("user", "u1"),
    block("text", "a1"), // 텍스트
    block("tool", "t1"), // 도구
    block("text", "a2"), // 이어지는 답 — 같은 1턴
    block("user", "u2"),
    block("text", "a3"),
  ];
  const turns = answerTurnNumbers(blocks);
  assert.equal(turns.get("a1"), 1);
  assert.equal(turns.get("a2"), 1, "같은 턴의 둘째 답은 첫째와 같은 번호");
  assert.equal(turns.get("a3"), 2);
});

test("도구만 돈 턴 뒤의 답은 프롬프트 순번을 잃지 않는다", () => {
  const blocks = [
    block("user", "u1"),
    block("text", "a1"),
    block("user", "u2"),
    block("tool", "t1"), // 답 없이 끝난 턴
    block("user", "u3"),
    block("text", "a3"),
  ];
  const turns = answerTurnNumbers(blocks);
  // 옛 셈은 a3 를 2로 셌다(text 2개째) — u2 의 존재가 사라졌다.
  assert.equal(turns.get("a3"), 3);
  assert.equal(promptTotal(blocks), 3);
});

test("프롬프트 없이 홀로 남은 답은 1로 매겨 유효한 번호를 지킨다", () => {
  const turns = answerTurnNumbers([block("text", "orphan")]);
  assert.equal(turns.get("orphan"), 1);
  assert.equal(promptTotal([block("text", "orphan")]), 0);
});

test("하위 작업이 한 말은 답이 아니다 — 되감기의 k 를 밀지 않는다 (PLAN D98)", () => {
  const subagentSay = { type: "text", id: "s1", agentId: "toolu_9" } as unknown as Block;
  const blocks = [
    block("user", "u1"),
    block("tool", "t1"),
    subagentSay, // 보조 에이전트의 수다
    block("text", "a1"), // 계획자가 읽는 답
    block("user", "u2"),
    block("text", "a2"),
  ];
  const turns = answerTurnNumbers(blocks);
  assert.equal(turns.has("s1"), false, "하위 작업의 말에는 턴 번호가 없다");
  assert.equal(turns.get("a1"), 1);
  assert.equal(turns.get("a2"), 2);
});
