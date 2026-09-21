/**
 * 핀 턴의 첫 자세 (pin-effort.ts) 단위 검사.
 *
 * 계약: COLO_DESIGN_PIN_EFFORT 가 정한 값은 "핀(comments)으로 여는 첫 턴,
 * 아무도 노력을 고르지 않은 세션"에만 얹힌다 — 환경변수가 없거나, 첫 턴이
 * 아니거나, 표식이 다르거나, 사람이 이미 고르거나, low 이면 손대지 않는다
 * (null). 순수 함수이므로 판정만 여기서 본다.
 *
 * Run: node --test packages/daemon/test/pin-effort.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PIN_EFFORT_ENV, pinEffortFor } from "../dist/pin-effort.js";

const base = { first: true, markerKind: "comments", effort: null, explicit: false };

test("핀으로 여는 첫 턴에 환경변수의 노력이 얹힌다", () => {
  assert.equal(pinEffortFor({ [PIN_EFFORT_ENV]: "medium" }, base), "medium");
  assert.equal(pinEffortFor({ [PIN_EFFORT_ENV]: "high" }, base), "high");
});

test("환경변수가 없거나 말도 안 되면 손대지 않는다", () => {
  assert.equal(pinEffortFor({}, base), null);
  assert.equal(pinEffortFor({ [PIN_EFFORT_ENV]: "" }, base), null);
  assert.equal(pinEffortFor({ [PIN_EFFORT_ENV]: "turbo" }, base), null);
});

test("low 는 받지 않는다 — 비개발자에게 질문 카드를 늘리는 쪽이다", () => {
  assert.equal(pinEffortFor({ [PIN_EFFORT_ENV]: "low" }, base), null);
});

test("첫 턴이 아니거나 표식이 핀이 아니면 없던 일이다", () => {
  assert.equal(pinEffortFor({ [PIN_EFFORT_ENV]: "medium" }, { ...base, first: false }), null);
  assert.equal(
    pinEffortFor({ [PIN_EFFORT_ENV]: "medium" }, { ...base, markerKind: "brief" }),
    null,
  );
  assert.equal(pinEffortFor({ [PIN_EFFORT_ENV]: "medium" }, { ...base, markerKind: null }), null);
});

test("사람이 이미 고른 노력은 자동 기본값이 덮지 않는다", () => {
  assert.equal(
    pinEffortFor({ [PIN_EFFORT_ENV]: "medium" }, { ...base, effort: "high", explicit: true }),
    null,
  );
  // 칩이 null 로 되돌아온 뒤(명시적 해제)에도 다시 얹지 않는다 — 해제도 뜻이다.
  assert.equal(
    pinEffortFor({ [PIN_EFFORT_ENV]: "medium" }, { ...base, effort: null, explicit: true }),
    null,
  );
});
