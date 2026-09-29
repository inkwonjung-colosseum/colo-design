import assert from "node:assert/strict";
import { test } from "node:test";
import { takeFreshKeys } from "../src/next/lib/fresh-keys.ts";
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

test("takeFreshKeys: 앞 렌더를 모를 때는 지금 있는 줄을 전부 이미 본 것으로 새긴다", () => {
  // 앱을 켜거나 프로젝트를 옮길 때 이미 있는 줄이 한꺼번에 등장하면 안 된다.
  const taken = takeFreshKeys(null, ["a", "b"]);
  assert.deepEqual(taken.fresh, []);
  assert.deepEqual([...taken.keys].sort(), ["a", "b"]);
});

test("takeFreshKeys: 앞 렌더에 없던 열쇠만 새 것이다", () => {
  const first = takeFreshKeys(null, ["a", "b"]);
  const second = takeFreshKeys(first.keys, ["c", "a", "b"]);
  assert.deepEqual(second.fresh, ["c"]);
  // 다음 렌더에는 c 도 이미 본 것이다 — 새 것은 한 번만 새 것이다.
  assert.deepEqual(takeFreshKeys(second.keys, ["c", "a", "b"]).fresh, []);
});

test("takeFreshKeys: 순서만 바뀐 재정렬은 새 것이 아니다", () => {
  // React 가 재정렬에서 옆 줄을 옮겨도 그 줄들이 다시 등장하면 안 된다.
  const first = takeFreshKeys(null, ["a", "b", "c"]);
  assert.deepEqual(takeFreshKeys(first.keys, ["c", "a", "b"]).fresh, []);
});

test("takeFreshKeys: 사라졌다 돌아온 열쇠는 다시 새 것이다", () => {
  // 지우기에 실패해 되살아난 줄은 다시 들어온 줄로 맞는다.
  const first = takeFreshKeys(null, ["a", "b"]);
  const gone = takeFreshKeys(first.keys, ["a"]);
  assert.deepEqual(gone.fresh, []);
  assert.deepEqual(takeFreshKeys(gone.keys, ["a", "b"]).fresh, ["b"]);
});

test("takeFreshKeys: 빈 목록에서 채워지는 것은 새 것이다(범위가 같을 때)", () => {
  // 기록 없이 시작한 목록(null)과 비어 있던 목록(빈 집합)은 다르다 — 앞의 것은 바탕이고
  // 뒤의 것은 첫 대화가 태어난 순간이다.
  assert.deepEqual(takeFreshKeys(new Set(), ["a"]).fresh, ["a"]);
  assert.deepEqual(takeFreshKeys(null, ["a"]).fresh, []);
});
