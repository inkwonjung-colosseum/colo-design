/**
 * 화면 카드 상태 칩의 판정(docs/plan/chat.md §3.3) — 목업 이야기
 * (저장 전 → 저장됨+확인 중 → 반영, 고침 라운드는 다시 저장 전)가
 * 입력 조합으로 재현되는지. "마지막 저장"이 답변 **뒤**의 저장임은
 * latestSaveAfter 의 계약이다.
 *
 * Run: node --experimental-transform-types --test packages/web/test/screen-state.test.mts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Block } from "../src/lib/daemon-client.ts";
import { latestSaveAfter, screenChips } from "../src/lib/screen-state.ts";

const labels = (chips: { label: string }[]) => chips.map((chip) => chip.label);
const save = (id: string, routes: string[], at = "2026-09-16T10:00:00Z"): Block =>
  ({
    type: "save",
    id,
    at,
    commit: "abc123",
    message: "저장",
    files: [],
    screens: routes.map((route) => ({ route, title: route })),
  }) as Block;
const text = (id: string): Block => ({
  type: "text",
  id,
  text: "답",
  agentId: null,
  streaming: false,
});

test("마지막 저장이 route 를 담지 않고 변경이 있으면 저장 전", () => {
  const chips = screenChips("/a", {
    pendingChanges: 3,
    savedScreens: [{ route: "/other" }],
    handoffState: null,
  });
  assert.deepEqual(labels(chips), ["저장 전"]);
  assert.equal(chips[0].tone, "default");
});

test("변경을 모르거나 없으면 저장 전을 말하지 않는다 — 데몬이 보고될 때까지 참는다", () => {
  assert.deepEqual(
    screenChips("/a", { pendingChanges: null, savedScreens: [], handoffState: null }),
    [],
  );
  assert.deepEqual(
    screenChips("/a", { pendingChanges: 0, savedScreens: [], handoffState: null }),
    [],
  );
});

test("저장됨은 여정의 누적 — 넘김·반영 칩이 곁들고, 없으면 홀로", () => {
  const saved = [{ route: "/a" }];
  assert.deepEqual(
    labels(screenChips("/a", { pendingChanges: 0, savedScreens: saved, handoffState: null })),
    ["저장됨"],
  );
  assert.deepEqual(
    screenChips("/a", { pendingChanges: 0, savedScreens: saved, handoffState: "open" }).map(
      (chip) => `${chip.label}:${chip.tone}`,
    ),
    ["저장됨:ok", "확인 중:info"],
  );
  assert.deepEqual(
    labels(
      screenChips("/a", {
        pendingChanges: 0,
        savedScreens: saved,
        handoffState: "changes_requested",
      }),
    ),
    ["저장됨", "확인 중"],
  );
  assert.deepEqual(
    labels(screenChips("/a", { pendingChanges: 0, savedScreens: saved, handoffState: "merged" })),
    ["저장됨", "반영됨"],
  );
  assert.deepEqual(
    screenChips("/a", { pendingChanges: 0, savedScreens: saved, handoffState: "closed" }).map(
      (chip) => `${chip.label}:${chip.tone}`,
    ),
    ["저장됨:ok", "반려:danger"],
  );
});

test("고침 라운드의 새 답변은 저장을 아직 갖지 못했다 — 넘김이 열려 있어도 저장 전", () => {
  const chips = screenChips("/a", { pendingChanges: 2, savedScreens: [], handoffState: "open" });
  assert.deepEqual(labels(chips), ["저장 전"]);
});

test("latestSaveAfter 는 답변 뒤의 마지막 저장을 내고, 없으면 null", () => {
  const blocks: Block[] = [
    save("s1", ["/a"]), // a1 보다 앞 — a1 의 것이 아니다
    text("a1"),
    save("s2", ["/b"]),
    save("s3", ["/a", "/c"]),
    text("a2"), // 뒤에 저장 없음 — 아직 저장되지 않은 새 답변
  ];
  const a1 = blocks.findIndex((block) => block.id === "a1");
  const cover = latestSaveAfter(blocks, a1);
  assert.ok(cover);
  assert.deepEqual(
    cover.screens.map((screen) => screen.route),
    ["/a", "/c"],
  );
  const a2 = blocks.findIndex((block) => block.id === "a2");
  assert.equal(latestSaveAfter(blocks, a2), null);
});
