import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(next-connection-copy.test.ts 와 같은 모양).
import { L } from "../src/next/labels.ts";
import { connectionLock } from "../src/next/lib/connection-copy.ts";

test("connectionLock: 열려 있으면 잠그지 않는다", () => {
  assert.equal(connectionLock("open", L), null);
});

test("connectionLock: 끊겼거나 오류면 끊겼다고 말한다", () => {
  assert.equal(connectionLock("closed", L), L.chat.offline);
  assert.equal(connectionLock("error", L), L.chat.offline);
});

test("connectionLock: 아직 잇는 중이면 잇는 중이라고 말한다", () => {
  assert.equal(connectionLock("idle", L), L.chat.connecting);
  assert.equal(connectionLock("connecting", L), L.chat.connecting);
});
