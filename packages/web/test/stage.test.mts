/**
 * Where a 기획서 has got to, and what the one primary button therefore says
 * (PLAN D8).
 *
 * This function decides both the stepper and the page tree's mark, so a wrong
 * answer here shows up twice and disagrees with itself nowhere. The rows below
 * are the table in PLAN §D8 plus the orderings that table does not settle by
 * reading — which check wins when two are true at once.
 *
 * Run: node --experimental-transform-types --test packages/web/test/stage.test.mts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveStage, pageMark, STAGES, type StageInput } from "../src/stage.ts";

const PATH = "ENG/회원 관리 기획서.md";

const page = (over: Partial<import("@drafthouse/protocol").DocSummary> = {}) => ({
  path: PATH,
  title: "회원 관리 기획서",
  pageId: "1926987901",
  parentPageId: null,
  version: 3,
  modified: false,
  conflict: false,
  isNew: false,
  ...over,
});

const screen = (spec: string | null = PATH) => ({
  route: "/member/MemberList",
  title: "회원 목록",
  states: ["default"],
  spec,
});

const handoff = (
  over: Partial<import("@drafthouse/protocol").HandoffStatus> = {},
): import("@drafthouse/protocol").HandoffStatus => ({
  number: 1,
  url: "https://github.com/org/repo/pull/1",
  title: "회원 관리",
  state: "open",
  branch: "drafthouse/20260910-1",
  pageIds: ["1926987901"],
  ...over,
});

const at = (over: Partial<StageInput> = {}): StageInput => ({
  page: page(),
  screens: [],
  pendingChanges: 0,
  branch: null,
  handoff: null,
  ...over,
});

// --- the seven rows of the §D8 table ---------------------------------------

test("no page open: the stepper asks for one and offers no button", () => {
  const derived = deriveStage(at({ page: null }));
  assert.equal(derived.id, "writing");
  assert.equal(derived.primary, null);
});

test("a 기획서 that has never been published wants 게시", () => {
  const derived = deriveStage(at({ page: page({ isNew: true }) }));
  assert.equal(derived.id, "publish");
  assert.equal(derived.primary?.label, "기획서 게시");
});

test("a locally edited 기획서 wants 게시 too", () => {
  const derived = deriveStage(at({ page: page({ modified: true }) }));
  assert.equal(derived.id, "publish");
  assert.equal(derived.primary?.action, "publishDoc");
});

test("published, no screen: build one", () => {
  const derived = deriveStage(at({ screens: [] }));
  assert.equal(derived.id, "build");
  assert.equal(derived.primary?.label, "이 문서로 화면 만들기");
});

test("a screen exists and the clone is dirty: save it", () => {
  const derived = deriveStage(at({ screens: [screen()], pendingChanges: 3 }));
  assert.equal(derived.id, "revise");
  assert.equal(derived.primary?.action, "save");
  assert.match(derived.reason, /3건/);
});

test("saved and clean: hand it over", () => {
  const derived = deriveStage(
    at({ screens: [screen()], pendingChanges: 0, branch: "drafthouse/20260910-1" }),
  );
  assert.equal(derived.id, "save");
  assert.equal(derived.primary?.action, "handoff");
});

test("handed over: the button re-reads the developer's answer", () => {
  const derived = deriveStage(
    at({ screens: [screen()], branch: "drafthouse/20260910-1", handoff: handoff() }),
  );
  assert.equal(derived.id, "handoff");
  assert.equal(derived.primary?.action, "refreshHandoff");
});

test("merged: nothing left to press", () => {
  const derived = deriveStage(
    at({ screens: [screen()], handoff: handoff({ state: "merged" }) }),
  );
  assert.equal(derived.id, "merged");
  assert.equal(derived.primary, null);
});

// --- the orderings the table does not settle by reading ---------------------

test("an unpublished 기획서 wants 게시 even when a screen already names it", () => {
  // The pull request body links Confluence. A 기획서 that only exists on this
  // machine cannot be what a developer reads, whatever got built from it.
  const derived = deriveStage(at({ page: page({ modified: true }), screens: [screen()] }));
  assert.equal(derived.id, "publish");
});

test("a new change after a handoff goes back to 검토·수정, not to 넘김", () => {
  const derived = deriveStage(
    at({ screens: [screen()], pendingChanges: 2, handoff: handoff() }),
  );
  assert.equal(derived.id, "revise");
  assert.equal(derived.primary?.action, "save");
});

test("merged wins over a dirty clone: that cycle is over", () => {
  const derived = deriveStage(
    at({ screens: [screen()], pendingChanges: 5, handoff: handoff({ state: "merged" }) }),
  );
  assert.equal(derived.id, "merged");
});

test("a handoff naming another page does not claim this one", () => {
  // One pull request carries a whole cycle, so it usually names several pages.
  // A page it does NOT name is still this planner's to work on.
  const derived = deriveStage(
    at({ screens: [screen()], handoff: handoff({ pageIds: ["999"] }) }),
  );
  assert.ok(derived.id !== "handoff" && derived.id !== "merged", derived.id);
  assert.equal(derived.id, "revise");
});

test("changes_requested is still 넘김 — the developer is holding it", () => {
  const derived = deriveStage(
    at({ screens: [screen()], handoff: handoff({ state: "changes_requested" }) }),
  );
  assert.equal(derived.id, "handoff");
});

test("a screen from an earlier cycle, nothing saved: look at it", () => {
  // Clean worktree, no branch: whatever built this screen was not this cycle,
  // so there is nothing to save and nothing to hand over. The useful move is
  // to go and look — which is also where the next change comes from.
  const derived = deriveStage(at({ screens: [screen()], pendingChanges: 0, branch: null }));
  assert.equal(derived.id, "revise");
  assert.equal(derived.primary?.action, "viewScreen");
  assert.match(derived.reason, /이번에 저장한 변경이 없습니다/);
});

test("a screen built from another 기획서 does not count as this one's", () => {
  const derived = deriveStage(at({ screens: [screen("ENG/주문 정책.md"), screen(null)] }));
  assert.equal(derived.id, "build");
});

// --- the tree reads the same verdict ---------------------------------------

test("the tree's mark comes from the same function as the stepper", () => {
  assert.equal(pageMark(page(), [], null).mark, "○");
  assert.equal(pageMark(page(), [screen()], null).mark, "◐");
  assert.equal(pageMark(page(), [screen()], handoff()).mark, "✓");
  assert.equal(pageMark(page(), [screen()], handoff({ state: "merged" })).mark, "●");
});

test("the tree keeps its own words for the mark it shows", () => {
  // The verdict is shared with the stepper; the wording is not. A sidebar row
  // must not talk about uncommitted files or branches — those belong to the
  // whole project, not to one 기획서.
  assert.match(pageMark(page(), [], null).title, /^기획 중 —/);
  assert.match(pageMark(page(), [screen()], null).title, /^화면 있음 —/);
  assert.match(pageMark(page(), [screen()], handoff()).title, /^넘김 —/);
  assert.match(pageMark(page(), [screen()], handoff({ state: "merged" })).title, /^반영됨 —/);
});

test("every stage id has a label and they are in pipeline order", () => {
  assert.deepEqual(
    STAGES.map((entry) => entry.id),
    ["writing", "publish", "build", "revise", "save", "handoff", "merged"],
  );
  assert.ok(STAGES.every((entry) => entry.label.trim().length > 0));
});

test("the index always points at its own row", () => {
  for (const entry of STAGES) {
    const derived = deriveStage(at({ page: null }));
    assert.equal(STAGES[derived.index]?.id, derived.id);
    assert.ok(entry.label);
  }
});
