/**
 * 되감기 · 체크포인트의 턴 번호 셈 — 데몬의 정의(k 번째 프롬프트)를 웹이
 * 그대로 따르는지. 예전의 text 블록 셈이 만들던 어긋남(도구만 돈 턴의 누락,
 * 한 턴에 답이 둘일 때의 초과)이 다시 못 들어오는 것을 여기서 잡는다.
 *
 * Run: node --experimental-transform-types --test packages/web/test/turn-numbering.test.mts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Block } from "../src/lib/daemon-client.ts";
import {
  answerTurnNumbers,
  lastAnswerPerTurn,
  promptTotal,
  turnAnswerText,
  turnBlockNumbers,
} from "../src/lib/turn-numbering.ts";

const block = (type: Block["type"], id: string): Block => ({ type, id }) as unknown as Block;

const answer = (id: string, text: string): Block =>
  ({ type: "text", id, text, agentId: null, streaming: false }) as unknown as Block;
const turnDone = (id: string): Block =>
  ({
    type: "turn",
    id,
    subtype: "success",
    isError: false,
    costUsd: null,
    durationMs: 60_000,
    resultText: null,
  }) as unknown as Block;
const prompt = (id: string, text: string): Block =>
  ({ type: "user", id, text, images: 0 }) as unknown as Block;

test("promptTotal: 사용자의 말과 기계 턴을 모두 센다", () => {
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

test("하위 작업이 한 말은 답이 아니다 — 되감기의 k 를 밀지 않는다", () => {
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

test("한 턴의 마지막 답 — 되돌리기 · 다시 요청은 그 자리에만 둔다", () => {
  const blocks = [
    block("user", "u1"),
    block("text", "a1"),
    block("tool", "t1"),
    block("text", "a2"),
    block("user", "u2"),
    block("text", "a3"),
  ];
  const last = lastAnswerPerTurn(blocks);
  assert.equal(last.get(1), "a2");
  assert.equal(last.get(2), "a3");
  assert.equal(last.get(3), undefined, "없는 턴의 마지막 답은 없다");
});

test("하위 작업의 말은 마지막 답 자리를 빼앗지 않는다", () => {
  const subagentSay = { type: "text", id: "s1", agentId: "toolu_9" } as unknown as Block;
  const blocks = [block("user", "u1"), subagentSay, block("text", "a1")];
  assert.equal(lastAnswerPerTurn(blocks).get(1), "a1");
});

test("턴이 낸 답의 전문 — 조각을 빈 줄로 이어 붙여 한 번에 복사한다", () => {
  const blocks = [
    prompt("u1", "고쳐 줘"),
    answer("a1", "이제 타입 검사를 돌립니다"),
    block("tool", "t1"),
    answer("a2", "고쳤습니다"),
    turnDone("turn1"),
    prompt("u2", "또 고쳐 줘"),
    answer("a3", "두 번째 답"),
    turnDone("turn2"),
  ];
  const whole = turnAnswerText(blocks);
  assert.equal(whole.get("turn1"), "이제 타입 검사를 돌립니다\n\n고쳤습니다");
  assert.equal(whole.get("turn2"), "두 번째 답");
});

test("답 없이 끝난 턴과 하위 작업의 말은 전문에 들지 않는다", () => {
  const subagentSay = {
    type: "text",
    id: "s1",
    text: "수다",
    agentId: "toolu_9",
  } as unknown as Block;
  const blocks = [
    prompt("u1", "첫 요청"),
    subagentSay,
    turnDone("turn1"), // 답 없이 끝난 턴
    prompt("u2", "둘째 요청"),
    answer("a2", "답"),
    turnDone("turn2"),
  ];
  const whole = turnAnswerText(blocks);
  assert.equal(whole.has("turn1"), false);
  assert.equal(whole.get("turn2"), "답");
});

test("턴 끝 블록의 번호 — 그 턴의 답들과 같은 셈을 따른다", () => {
  const blocks = [
    prompt("u1", "첫 요청"),
    answer("a1", "답"),
    block("tool", "t1"),
    answer("a2", "조각"),
    turnDone("turn1"),
    prompt("u2", "둘째 요청"),
    answer("a3", "둘째 답"),
    turnDone("turn2"),
  ];
  const turns = turnBlockNumbers(blocks);
  assert.equal(turns.get("turn1"), 1);
  assert.equal(turns.get("turn2"), 2);
  // 정산 줄이 실은 되감기가 가리키는 체크포인트는 답의 것과 같아야 한다 —
  // 두 셈이 어긋나면 엉뚱한 스냅샷으로 돌아간다.
  const answers = answerTurnNumbers(blocks);
  assert.equal(answers.get("a1"), turns.get("turn1"));
  assert.equal(answers.get("a2"), turns.get("turn1"));
  assert.equal(answers.get("a3"), turns.get("turn2"));
});

test("답 없이 끝난 턴도 번호를 얻고, 프롬프트 없는 옛 턴은 1로 유효한 번호를 지킨다", () => {
  const blocks = [turnDone("turn0"), prompt("u1", "요청"), turnDone("turn1")];
  const turns = turnBlockNumbers(blocks);
  assert.equal(turns.get("turn0"), 1);
  assert.equal(turns.get("turn1"), 1);
});
