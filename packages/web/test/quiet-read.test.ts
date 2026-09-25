import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(turn-screens.test.ts 와 같은 모양).
import { FOCUS_READ_THROTTLE_MS, focusReadDue } from "../src/lib/quiet-read.ts";

test("창 포커스의 조용한 읽기는 20분 스로틀 — 시간당 세 번 이하", () => {
  assert.equal(FOCUS_READ_THROTTLE_MS, 20 * 60_000);
  const last = 1_000_000;
  assert.equal(focusReadDue(last, last + FOCUS_READ_THROTTLE_MS - 1), false);
  assert.equal(focusReadDue(last, last + FOCUS_READ_THROTTLE_MS), true);
  // 한 시간 안의 여섯 번 방문(10분마다) 중 첫 방문 포함 세 번만 읽는다 —
  // lastQuietRead 는 0(에포크)에서 시작하므로 첫 방문은 언제나 읽는다.
  let reads = 0;
  let at = -60 * 60_000;
  for (let i = 0; i < 6; i += 1) {
    const now = i * 10 * 60_000;
    if (focusReadDue(at, now)) {
      reads += 1;
      at = now;
    }
  }
  assert.equal(reads, 3);
});
