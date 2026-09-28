import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(next-install-step.test.ts 와 같은 모양).
import {
  type GateKey,
  inviteProgress,
  modalCloseMs,
  takeFreshPasses,
  themePeekHalves,
} from "../src/next/onboarding/motion.ts";

test("takeFreshPasses: 처음 볼 때는 통과를 전부 '본 것'으로 새긴다", () => {
  // 앱을 켰을 때 이미 통과한 항목이 튀면 안 된다 — 첫 그림은 새 것이 아니다.
  const taken = takeFreshPasses(null, ["tools", "agent"]);
  assert.deepEqual(taken.fresh, []);
  assert.deepEqual([...taken.seen].sort(), ["agent", "tools"]);
});

test("takeFreshPasses: 이번에 통과한 항목만 새 것이고, 다시는 새 것이 아니다", () => {
  const seen = new Set<GateKey>(["tools"]);
  const first = takeFreshPasses(seen, ["tools", "agent"]);
  assert.deepEqual(first.fresh, ["agent"]);
  const second = takeFreshPasses(first.seen, ["tools", "agent", "invite"]);
  assert.deepEqual(second.fresh, ["invite"]);
  const third = takeFreshPasses(second.seen, ["tools", "agent", "invite"]);
  assert.deepEqual(third.fresh, []);
});

test("inviteProgress: 진행기가 아는 만큼만, 넘치지 않게", () => {
  assert.equal(inviteProgress(0, 4), 0);
  assert.equal(inviteProgress(1, 4), 25);
  assert.equal(inviteProgress(4, 4), 100);
  assert.equal(inviteProgress(7, 4), 100);
  // 행이 없는 확인판 — 채울 것이 없으면 다 찬 것으로 말한다.
  assert.equal(inviteProgress(0, 0), 100);
});

test("themePeekHalves: 시스템 따르기는 밝음과 어두움의 반반이다", () => {
  assert.deepEqual(themePeekHalves("system"), ["light", "dark"]);
  assert.deepEqual(themePeekHalves("claude"), ["claude"]);
  assert.deepEqual(themePeekHalves("github"), ["github"]);
});

test("modalCloseMs: 역방향 pop 의 길이 — 움직임을 끈 창은 기다리지 않는다", () => {
  assert.equal(modalCloseMs(false), 120);
  assert.equal(modalCloseMs(true), 0);
});
