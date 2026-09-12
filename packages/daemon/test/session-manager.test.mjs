/**
 * 되감기의 절단점 (PLAN D95): the pure function that picks where a
 * truncating fork keeps and drops. Everything runs offline.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRewindCutoff } from "../dist/session-manager.js";

/** A synthetic transcript: prompts and answers with tool-result carriers. */
const msg = (type, uuid, extra = {}) => ({ type, uuid, ...extra });
const prompt = (uuid) => msg("user", uuid, { message: { content: "말" } });
const assistant = (uuid) => msg("assistant", uuid);
const carrier = (uuid) =>
  msg("user", uuid, {
    message: { content: [{ type: "tool_result", tool_use_id: "t" }] },
  });
const synthetic = (uuid) => msg("user", uuid, { isSynthetic: true, message: { content: "알림" } });

const TAPE = [
  prompt("p1"), // 1번째 턴 시작
  assistant("a1"),
  carrier("c1"), // 도구 결과 캐리어가 답 뒤에 붙는다
  prompt("p2"), // 2번째 턴
  assistant("a2"),
  synthetic("s1"), // 합성 알림은 프롬프트가 아니다
  prompt("p3"), // 3번째 턴
  assistant("a3"),
];

test("resolveRewindCutoff: kept 는 버리는 프롬프트 바로 앞의 마지막 체인 항목", () => {
  const cut = resolveRewindCutoff(TAPE, 2);
  assert.deepEqual(cut, { cut: "c1", drops: "p2", answerCount: 3 });
});

test("resolveRewindCutoff: k = 1 은 cut 없이 새 대화로", () => {
  const cut = resolveRewindCutoff(TAPE, 1);
  assert.deepEqual(cut, { cut: null, drops: "p1", answerCount: 3 });
});

test("resolveRewindCutoff: 마지막 답도 버릴 수 있고, 캐리어 뒤의 합성 행까지는 본다", () => {
  const cut = resolveRewindCutoff(TAPE, 3);
  assert.deepEqual(cut, { cut: "s1", drops: "p3", answerCount: 3 });
});

test("resolveRewindCutoff: 없는 답은 null — 호출자가 한국어로 거절한다", () => {
  assert.equal(resolveRewindCutoff(TAPE, 0), null);
  assert.equal(resolveRewindCutoff(TAPE, 4), null);
});
