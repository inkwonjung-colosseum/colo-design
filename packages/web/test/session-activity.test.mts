/**
 * The finished-tab rule (PLAN D2): a thread that ends a turn while the planner
 * is reading a different one gets marked until they look.
 *
 * Run: node --experimental-transform-types --test packages/web/test/session-activity.test.mts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { settleTransitions } from "../src/session-activity.ts";

test("a background turn that ends is what gets marked", () => {
  // First pass: nothing was running before, so nothing has finished — an idle
  // thread already on disk at launch must not arrive pre-marked.
  const launch = settleTransitions({}, { a: "idle", b: "running" }, "b");
  assert.deepEqual(launch.settled, []);
  assert.deepEqual(launch.running, { a: false, b: true });

  // b keeps running while the planner reads a: still nothing.
  assert.deepEqual(settleTransitions(launch.running, { a: "idle", b: "running" }, "a").settled, []);

  // b settles while the planner is still on a: that is the whole feature.
  assert.deepEqual(settleTransitions(launch.running, { a: "idle", b: "idle" }, "a").settled, ["b"]);
});

test("the thread the planner is watching is never marked", () => {
  // They are looking at it settle; a badge would tell them what they just saw.
  const watched = settleTransitions({ b: true }, { b: "idle" }, "b");
  assert.deepEqual(watched.settled, []);

  // An error ends a turn too — the planner still has to be told it stopped.
  assert.deepEqual(settleTransitions({ b: true }, { b: "error" }, null).settled, ["b"]);
});

test("a thread that stops to ask is awaiting, not finished (PLAN D50)", () => {
  // Permission and question waits are the orange dot in the tree, not the
  // finished mark: the turn is not over, it wants an answer.
  const permission = settleTransitions({ b: true }, { b: "waiting_permission" }, "a");
  assert.deepEqual(permission.awaiting, ["b"]);
  assert.deepEqual(permission.settled, []);

  const question = settleTransitions({ b: true }, { b: "waiting_question" }, null);
  assert.deepEqual(question.awaiting, ["b"]);
  assert.deepEqual(question.settled, []);

  // The thread on screen stops to ask where they can see it: never marked.
  const watched = settleTransitions({ b: true }, { b: "waiting_permission" }, "b");
  assert.deepEqual(watched.awaiting, []);
  assert.deepEqual(watched.settled, []);
});

test("a thread that vanished cannot be marked", () => {
  // Deleted between passes: it is not in the states map, so it contributes
  // nothing and drops out of the running record instead of leaking forever.
  const gone = settleTransitions({ a: true, b: true }, { a: "idle" }, null);
  assert.deepEqual(gone.settled, ["a"]);
  assert.deepEqual(gone.running, { a: false });
});
