/**
 * D65 의 단언 고리 — the rule that keeps the native preview view from
 * painting over a modal. What is pinned here is everything the old
 * fire-and-forget latch got wrong: one dropped call left the stage drawn
 * over an open settings dialog until the planner closed it, and no DOM
 * change ever came to trigger a retry, because a settled modal makes none.
 *
 * Run: node --experimental-transform-types --test packages/web/test/cover-reconciler.test.mts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COVER_LAYERS,
  COVER_RETRY_MS,
  type CoverTimer,
  createCoverReconciler,
} from "../src/cover-reconciler.ts";

/** A hand-cranked clock: the backoff must be observable, never awaited. */
function clock() {
  const pending = new Map<number, { run: () => void; at: number }>();
  let next = 1;
  return {
    setTimer: (run: () => void, ms: number): CoverTimer => {
      const id = next;
      next += 1;
      pending.set(id, { run, at: ms });
      return id;
    },
    clearTimer: (handle: CoverTimer) => {
      pending.delete(handle as number);
    },
    /** Waits armed right now, in arming order. */
    waits: () => [...pending.values()].map((entry) => entry.at),
    /** Fires every armed timer once. */
    async fire() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, entry] of due) entry.run();
      await settle();
    },
  };
}

/** Lets the reconciler's promise chain run to its end. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test("첫 단언은 조건 없이 나간다 — 메인의 상태는 이 문서보다 오래 산다", async () => {
  const calls: boolean[] = [];
  const reconciler = createCoverReconciler({
    desired: () => false,
    apply: async (on) => {
      calls.push(on);
    },
  });
  reconciler.sync();
  await settle();
  assert.deepEqual(calls, [false], "덮을 게 없어도 '없음'을 한 번은 말해야 한다");
  assert.equal(reconciler.applied(), false);
});

test("확인된 상태와 같으면 보내지 않는다 — 스트리밍 변이는 IPC 가 아니다", async () => {
  const calls: boolean[] = [];
  let layer = true;
  const reconciler = createCoverReconciler({
    desired: () => layer,
    apply: async (on) => {
      calls.push(on);
    },
  });
  reconciler.sync();
  await settle();
  for (let i = 0; i < 50; i++) {
    reconciler.sync(); // 전사가 흐르는 동안의 변이 폭풍
    await settle();
  }
  assert.deepEqual(calls, [true], "전이당 한 번");
  layer = false;
  reconciler.sync();
  await settle();
  assert.deepEqual(calls, [true, false]);
});

test("거부된 단언은 백오프로 다시 간다 — 정적 모달은 변이를 만들지 않는다", async () => {
  const timers = clock();
  const calls: boolean[] = [];
  let fail = true;
  const reconciler = createCoverReconciler({
    desired: () => true, // 설정 모달이 열린 채 가만히 있다
    apply: async (on) => {
      calls.push(on);
      if (fail) throw new Error("main이 못 받았다");
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  reconciler.sync();
  await settle();
  assert.deepEqual(calls, [true]);
  assert.equal(reconciler.applied(), null, "실패는 '모름'이지 '반대'가 아니다");
  assert.deepEqual(timers.waits(), [COVER_RETRY_MS[0]], "재시도가 걸려 있다");

  // 여기서 DOM 은 영원히 조용하다 — 오직 타이머만이 구조다.
  fail = false;
  await timers.fire();
  assert.deepEqual(calls, [true, true]);
  assert.equal(reconciler.applied(), true, "재시도가 덮개를 세웠다");
  assert.deepEqual(timers.waits(), [], "성공했으면 남은 재시도는 없다");
});

test("실패가 반대값을 기억하지 않는다 — 다음 단언은 같은 값을 다시 말한다", async () => {
  const timers = clock();
  const calls: boolean[] = [];
  let fail = true;
  const reconciler = createCoverReconciler({
    desired: () => true,
    apply: async (on) => {
      calls.push(on);
      if (fail) throw new Error("핸들러가 적용한 뒤에도 거부할 수 있다");
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  reconciler.sync();
  await settle();
  fail = false;
  reconciler.sync(); // 무언가 움직였다
  await settle();
  assert.deepEqual(calls, [true, true], "true 를 다시 말한다 — false 를 보내지 않는다");
  assert.equal(reconciler.applied(), true);
});

test("백오프는 소진되고, 새 변이가 예산을 되살린다", async () => {
  const timers = clock();
  const calls: boolean[] = [];
  const reconciler = createCoverReconciler({
    desired: () => true,
    apply: async (on) => {
      calls.push(on);
      throw new Error("계속 죽어 있다");
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  reconciler.sync();
  await settle();
  for (const wait of COVER_RETRY_MS) {
    assert.deepEqual(timers.waits(), [wait]);
    await timers.fire();
  }
  assert.equal(calls.length, 1 + COVER_RETRY_MS.length, "무한 재시도는 없다");
  assert.deepEqual(timers.waits(), [], "예산이 끝나면 조용해진다");

  reconciler.sync(); // 사용자가 다시 무언가를 한다
  await settle();
  assert.equal(calls.length, 2 + COVER_RETRY_MS.length, "새 증거는 예산을 되살린다");
  assert.deepEqual(timers.waits(), [COVER_RETRY_MS[0]]);
});

test("왕복 중에 층이 뒤집히면 정착한 뒤 따라잡는다", async () => {
  const calls: boolean[] = [];
  let layer = true;
  let release: (() => void) | null = null;
  const reconciler = createCoverReconciler({
    desired: () => layer,
    apply: async (on) => {
      calls.push(on);
      if (on) await new Promise<void>((ok) => (release = ok));
    },
  });
  reconciler.sync();
  await settle();
  assert.deepEqual(calls, [true]);

  layer = false; // 모달이 왕복 안에서 닫혔다
  reconciler.sync();
  await settle();
  assert.deepEqual(calls, [true], "한 번에 하나만 나간다");

  release?.();
  await settle();
  assert.deepEqual(calls, [true, false], "정착 뒤 현재 DOM 을 따라잡는다");
  assert.equal(reconciler.applied(), false);
});

test("stop 뒤에는 아무것도 보내지 않는다 — 걸린 재시도도 함께 죽는다", async () => {
  const timers = clock();
  const calls: boolean[] = [];
  const reconciler = createCoverReconciler({
    desired: () => true,
    apply: async (on) => {
      calls.push(on);
      throw new Error("죽었다");
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  reconciler.sync();
  await settle();
  reconciler.stop();
  assert.deepEqual(timers.waits(), [], "언마운트가 타이머를 거둔다");
  reconciler.sync();
  await settle();
  assert.equal(calls.length, 1);
});

test("덮개 목록은 무대 위 층 네 개와 열린 문 하나", () => {
  for (const selector of [
    ".modal",
    ".palette",
    ".selector__backdrop",
    ".pip--large",
    "[data-cover-stage]",
  ]) {
    assert.ok(COVER_LAYERS.includes(selector), `${selector} 가 목록에 있어야 한다`);
  }
});
