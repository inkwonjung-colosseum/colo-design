import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectSummary } from "@colo-design/protocol";
// 순수 모듈 — src 에서 곧장 읽는다(turn-screens.test.ts 와 같은 모양).
import { L } from "../src/next/labels.ts";
import { initialNav, navReducer } from "../src/next/lib/nav.ts";
import { neverPrepared, projectNote, projectStatus } from "../src/next/lib/project-note.ts";

const BASE: ProjectSummary = {
  slug: "member",
  name: "회원 관리",
  baseBranch: "main",
  phase: "ready",
  pendingChanges: 0,
  working: false,
  handoff: null,
  pendingCount: 0,
};

const handoff = (state: "open" | "changes_requested" | "merged" | "closed") => ({
  number: 7,
  url: "https://github.com/o/r/pull/7",
  title: "t",
  state,
  branch: "colo-design/20260925-1",
});

const note = (patch: Partial<ProjectSummary>, extra = {}) =>
  projectNote({ ...BASE, ...patch }, L, extra);

test("우선순위 — 준비 중 > 만드는 중 > 답을 기다려요 > AI 실패 > 코멘트 > 반영 > 사이클", () => {
  const all: Partial<ProjectSummary> = {
    phase: "installing",
    working: true,
    pendingCount: 2,
    handoff: handoff("open"),
    lastEventKind: "comments",
  };
  const extra = { aiFailed: true, comments: 3 };
  assert.equal(note(all, extra).kind, "preparing");
  assert.equal(note({ ...all, phase: "ready" }, extra).kind, "making");
  const waiting = note({ ...all, phase: "ready", working: false }, extra);
  assert.equal(waiting.kind, "waiting");
  assert.equal(waiting.text, "답을 기다려요 2");
  const failed = note({ ...all, phase: "ready", working: false, pendingCount: 0 }, extra);
  assert.equal(failed.kind, "failed");
  assert.equal(failed.text, L.vocab.aiFailed);
  const comments = note(
    { ...all, phase: "ready", working: false, pendingCount: 0 },
    { comments: 3 },
  );
  assert.equal(comments.kind, "comments");
  assert.equal(comments.text, "코멘트 3");
  const merged = note({ handoff: handoff("merged"), lastEventKind: "merged" });
  assert.equal(merged.kind, "merged");
  assert.equal(merged.tone, "green");
  const quiet = note({ handoff: handoff("open") });
  assert.equal(quiet.kind, "cycle");
  assert.equal(quiet.text, L.cycle.review);
});

test("코멘트 수를 모르면 도착했다는 말만 한다", () => {
  const n = note({ handoff: handoff("changes_requested"), lastEventKind: "changes_requested" });
  assert.equal(n.kind, "comments");
  assert.equal(n.text, L.shell.commentsArrived);
});

test("반영 뒤에 쌓인 작업이 있으면 반영이 아니라 제출 전이다", () => {
  const n = note({ handoff: handoff("merged"), lastEventKind: "merged", branch: "b2" });
  assert.equal(n.kind, "cycle");
  assert.equal(n.text, L.cycle.draft);
});

test("한 번도 연 적 없는 프로젝트 — 아직 열지 않음, 전환기는 처음 열 때 준비해요를 단다", () => {
  const fresh = { ...BASE, phase: "missing" as const };
  assert.equal(neverPrepared(fresh), true);
  assert.equal(projectStatus(fresh, L).text, L.sidebar.notOpened);
  assert.equal(projectNote(fresh, L).text, L.sidebar.notOpened);
});

test("사이클 한 단어 — 제출 전 · 개발자가 보고 있어요 · 반영됐어요", () => {
  assert.equal(projectStatus(BASE, L).text, "제출 전");
  assert.equal(
    projectStatus({ ...BASE, handoff: handoff("open") }, L).text,
    "개발자가 보고 있어요",
  );
  assert.equal(projectStatus({ ...BASE, handoff: handoff("merged") }, L).text, "반영됐어요");
  assert.equal(projectStatus({ ...BASE, working: true }, L).spin, true);
});

test("셸 이동 — 대화를 열면 서랍이 닫히고, 프로젝트가 바뀌면 홈부터", () => {
  let s = initialNav(false);
  assert.equal(s.view, "home");
  s = navReducer(s, { type: "drawer", open: true });
  s = navReducer(s, { type: "thread" });
  assert.equal(s.view, "thread");
  assert.equal(s.drawer, false);
  s = navReducer(s, { type: "tab", tab: "preview" });
  assert.equal(s.tab, "preview");
  s = navReducer(s, { type: "project-changed" });
  assert.deepEqual(s, {
    view: "home",
    tab: "chat",
    drawer: false,
    collapsed: false,
    discardableInvitePath: null,
  });
  // 같은 값은 같은 객체 — 렌더를 더 부르지 않는다.
  assert.equal(navReducer(s, { type: "tab", tab: "chat" }), s);
});

test("셸 이동 — 지울 수 있는 초대 파일의 자리는 세우고 거둔다(U11)", () => {
  let s = initialNav(false);
  assert.equal(s.discardableInvitePath, null);
  s = navReducer(s, { type: "invite-path", path: "/tmp/a.colo-invite" });
  assert.equal(s.discardableInvitePath, "/tmp/a.colo-invite");
  // 프로젝트가 바뀌어도 남는다 — 파일은 프로젝트의 것이 아니다.
  s = navReducer(s, { type: "project-changed" });
  assert.equal(s.discardableInvitePath, "/tmp/a.colo-invite");
  assert.equal(navReducer(s, { type: "invite-path", path: "/tmp/a.colo-invite" }), s);
  s = navReducer(s, { type: "invite-path", path: null });
  assert.equal(s.discardableInvitePath, null);
});
