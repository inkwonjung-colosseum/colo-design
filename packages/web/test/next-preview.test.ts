import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(turn-screens.test.ts 와 같은 모양).
import {
  bubblePlacement,
  elapsedParts,
  prepProgress,
  prepStep,
} from "../src/next/lib/preview-geometry.ts";

const BOX = { width: 800, height: 600 };
const BUBBLE = { width: 300, height: 110 };

test("말풍선 — 요소 바로 아래, 게스트의 화면 위치만큼 옮겨서", () => {
  const place = bubblePlacement({
    rect: { x: 100, y: 50, width: 80, height: 30 },
    frame: { left: 20, top: 48 },
    zoom: 1,
    box: BOX,
    bubble: BUBBLE,
  });
  assert.deepEqual(place, { left: 106, top: 138, up: false });
});

test("말풍선 — 배율을 곱한다", () => {
  const place = bubblePlacement({
    rect: { x: 100, y: 50, width: 80, height: 30 },
    frame: { left: 0, top: 48 },
    zoom: 1.25,
    box: BOX,
    bubble: BUBBLE,
  });
  assert.equal(place.left, Math.round(125 - 14));
  assert.equal(place.top, Math.round(48 + (50 + 30) * 1.25 + 10));
});

test("말풍선 — 바닥을 넘으면 요소 위로 올라간다", () => {
  const place = bubblePlacement({
    rect: { x: 100, y: 480, width: 80, height: 40 },
    frame: { left: 0, top: 48 },
    zoom: 1,
    box: BOX,
    bubble: BUBBLE,
  });
  assert.equal(place.up, true);
  assert.equal(place.top, 48 + 480 - 10 - 110);
});

test("말풍선 — 가로는 칸 안에 묶인다, 칸보다 큰 요소는 칸 안에 붙든다", () => {
  const right = bubblePlacement({
    rect: { x: 760, y: 10, width: 20, height: 20 },
    frame: { left: 0, top: 0 },
    zoom: 1,
    box: BOX,
    bubble: BUBBLE,
  });
  assert.equal(right.left, 800 - 300 - 8);
  const left = bubblePlacement({
    rect: { x: 0, y: 10, width: 20, height: 20 },
    frame: { left: 0, top: 0 },
    zoom: 1,
    box: BOX,
    bubble: BUBBLE,
  });
  assert.equal(left.left, 8);
  const huge = bubblePlacement({
    rect: { x: 0, y: 0, width: 800, height: 600 },
    frame: { left: 0, top: 0 },
    zoom: 1,
    box: BOX,
    bubble: BUBBLE,
  });
  assert.equal(huge.top, 600 - 8 - 110);
  assert.equal(huge.up, false);
});

test("준비의 걸음 — 내려받기 · 설치하기 · 미리보기 켜기", () => {
  assert.equal(prepStep("missing"), 0);
  assert.equal(prepStep("cloning"), 0);
  assert.equal(prepStep("pulling"), 0);
  assert.equal(prepStep("installing"), 1);
  assert.equal(prepStep("starting"), 2);
  assert.equal(prepStep("ready"), null);
  assert.equal(prepStep("error"), null);
});

test("준비의 막대 — 걸음마다 오르고, 한 걸음 안에서 끝까지 차지 않는다", () => {
  const cloning = prepProgress("cloning", 0);
  const cloningLate = prepProgress("cloning", 600_000);
  const installing = prepProgress("installing", 0);
  const starting = prepProgress("starting", 10_000);
  assert.ok(cloning >= 2 && cloning < cloningLate);
  assert.ok(cloningLate < installing + 5);
  assert.ok(installing < starting);
  assert.ok(prepProgress("starting", 10_000_000) <= 99);
  assert.equal(prepProgress("ready", 0), 100);
  assert.equal(prepProgress("cloning", -5), prepProgress("cloning", 0));
});

test("흐른 시간 — 분과 초", () => {
  assert.deepEqual(elapsedParts(0), { minutes: 0, seconds: 0 });
  assert.deepEqual(elapsedParts(12_400), { minutes: 0, seconds: 12 });
  assert.deepEqual(elapsedParts(65_000), { minutes: 1, seconds: 5 });
  assert.deepEqual(elapsedParts(-1), { minutes: 0, seconds: 0 });
});
