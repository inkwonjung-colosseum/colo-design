import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(next-connection-copy.test.ts 와 같은 모양).
import { themeSwapMode } from "../src/lib/settings.ts";

test("themeSwapMode: 새 창은 startViewTransition 의 교차 페이드로 갈아입는다", () => {
  assert.equal(themeSwapMode(false, false, true), "view");
});

test("themeSwapMode: view transition 이 없는 낡은 창은 50ms 건너뛰기로", () => {
  assert.equal(themeSwapMode(false, false, false), "skip");
});

test("themeSwapMode: 첫 그림과 움직임을 끈 창은 바로 칠한다", () => {
  // 비교할 팔레트가 없는 첫 그림 — 건너뛸 프레임도 없다.
  assert.equal(themeSwapMode(true, false, true), "plain");
  assert.equal(themeSwapMode(true, false, false), "plain");
  // 움직임을 끈 창 — view transition 도, 건너뛰기도 필요 없다.
  assert.equal(themeSwapMode(false, true, true), "plain");
  assert.equal(themeSwapMode(false, true, false), "plain");
});
