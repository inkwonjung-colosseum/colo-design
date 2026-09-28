import assert from "node:assert/strict";
import { test } from "node:test";
// 컴파일된 dist 를 읽는다 — `@nova-design/protocol` 의 스키마 import 가 얽혀 있다.
import { CatalogGate } from "../dist/plan-tracker.js";

const RETRY_MS = 5 * 60_000;

test("처음에는 묻는다", () => {
  const gate = new CatalogGate();
  assert.equal(gate.shouldRead("claude", 1_000), true);
});

test("도는 읽기 동안에는 다시 묻지 않는다 — in-flight", () => {
  const gate = new CatalogGate();
  gate.started("claude");
  assert.equal(gate.shouldRead("claude", 1_000 + RETRY_MS * 10), false);
});

test("성공한 뒤로는 이 실행에서 다시 묻지 않는다", () => {
  const gate = new CatalogGate();
  gate.started("claude");
  gate.settled("claude", true, 1_000);
  assert.equal(gate.shouldRead("claude", 1_001), false);
  assert.equal(gate.shouldRead("claude", 1_000 + RETRY_MS), false);
  assert.equal(gate.shouldRead("claude", Number.MAX_SAFE_INTEGER), false);
});

test("실패 뒤에는 retryMs 가 지나야 다시 묻는다", () => {
  const gate = new CatalogGate();
  gate.started("claude");
  gate.settled("claude", false, 10_000);
  assert.equal(gate.shouldRead("claude", 10_000 + RETRY_MS - 1), false);
  // 경계는 포함 — now >= 실패 시각 + retryMs.
  assert.equal(gate.shouldRead("claude", 10_000 + RETRY_MS), true);
});

test("프로바이더마다 따로 판정한다", () => {
  const gate = new CatalogGate();
  gate.started("claude");
  gate.settled("omp", true, 1_000);
  // claude 는 in-flight, omp 는 성공, codex 는 처음 — 셋이 서로를 못 잰다.
  assert.equal(gate.shouldRead("claude", 2_000), false);
  assert.equal(gate.shouldRead("omp", 2_000), false);
  assert.equal(gate.shouldRead("codex", 2_000), true);
});
