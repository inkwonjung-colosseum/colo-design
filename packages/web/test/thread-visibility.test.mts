import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProjectSummary, ThreadSummary } from "@colo-design/protocol";

const { hideAllThreads, hideThread, pruneHidden, unhideAllThreads, unhideThread, visibleThreads } =
  await import("../src/lib/thread-visibility.ts");

let seq = 0;
const thread = (id: string): ThreadSummary => ({
  id,
  title: `대화 ${id}`,
  state: "idle",
  updatedAt: new Date(2026, 0, 1, 9, ++seq).toISOString(),
});

const project = (slug: string, threads: ThreadSummary[] | null): ProjectSummary => ({
  slug,
  name: slug,
  repoUrl: null,
  baseBranch: "main",
  phase: "ready",
  pendingChanges: 0,
  working: false,
  handoff: null,
  conventionsStale: false,
  pendingCount: 0,
  ...(threads ? { threads } : {}),
});

test("지우기 승인 즉시 행이 사라진다 — 데몬 목록을 기다리지 않는다", () => {
  const threads = [thread("a"), thread("b")];
  let hidden = hideThread({}, "p", "a");
  assert.deepEqual(
    visibleThreads(threads, hidden, "p").map((t) => t.id),
    ["b"],
  );
  // 같은 id를 다시 숨겨도 목록이 중복되지 않는다.
  hidden = hideThread(hidden, "p", "a");
  assert.deepEqual(
    visibleThreads(threads, hidden, "p").map((t) => t.id),
    ["b"],
  );
});

test("모두 지우기는 그 프로젝트의 행만 전부 가린다", () => {
  const hidden = hideAllThreads(hideThread({}, "other", "x"), "p");
  assert.deepEqual(visibleThreads([thread("a")], hidden, "p"), []);
  // 다른 프로젝트의 숨김("x")은 이쪽 행("y")에 묻지 않는다.
  assert.deepEqual(
    visibleThreads([thread("y")], hidden, "other").map((t) => t.id),
    ["y"],
  );
});

test("데몬 목록에서 사라진 숨김은 조정으로 거둔다", () => {
  const hidden = hideThread({}, "p", "a");
  const projects = [project("p", [thread("b")])];
  assert.deepEqual(pruneHidden(hidden, projects), {});
});

test("스캔이 늦어 목록에 아직 남아 있는 id는 숨김을 유지한다 — 행이 반짝 돌아오지 않게", () => {
  const hidden = hideThread({}, "p", "a");
  const projects = [project("p", [thread("a"), thread("b")])];
  assert.deepEqual(pruneHidden(hidden, projects), { p: ["a"] });
});

test("모두 지우기의 숨김은 데몬 목록이 실제로 비는 순간에만 거둔다", () => {
  const hidden = hideAllThreads({}, "p");
  // 아직 스캔 전(threads 없음) — 행이 없을 뿐 숨김은 유지한다.
  const notScanned = [project("p", null)];
  assert.deepEqual(pruneHidden(hidden, notScanned), { p: "all" });
  // 스캔 지연으로 행이 남아 있으면 유지한다.
  const stale = [project("p", [thread("a")])];
  assert.deepEqual(pruneHidden(hidden, stale), { p: "all" });
  // 목록이 비었다 — 숨김의 역할이 끝했다.
  const emptied = [project("p", [])];
  assert.deepEqual(pruneHidden(hidden, emptied), {});
});

test("지우기가 실패하면 숨김을 풀어 행을 되돌린다", () => {
  let hidden = hideThread(hideThread({}, "p", "a"), "p", "b");
  hidden = unhideThread(hidden, "p", "a");
  assert.deepEqual(
    visibleThreads([thread("a"), thread("b")], hidden, "p").map((t) => t.id),
    ["a"],
  );
  // 마지막 하나를 풀면 프로젝트 자리도 치운다.
  hidden = unhideThread(hidden, "p", "b");
  assert.deepEqual(hidden, {});
  // 전체 숨김은 일괄 해제만 튼다.
  const all = hideAllThreads({}, "p");
  assert.deepEqual(unhideThread(all, "p", "a"), all);
  assert.deepEqual(unhideAllThreads(all, "p"), {});
});

test("프로젝트가 사라지면 그 숨김도 무의미하다 — 같이 거둔다", () => {
  const hidden = hideThread(hideAllThreads({}, "gone"), "stay", "a");
  const pruned = pruneHidden(hidden, [project("stay", [thread("a")])]);
  assert.deepEqual(pruned, { stay: ["a"] });
});
