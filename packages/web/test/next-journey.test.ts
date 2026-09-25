import assert from "node:assert/strict";
import { test } from "node:test";
import type { HandoffStatus, RepoStatus } from "@colo-design/protocol";
// 순수 모듈 — src 에서 곧장 읽는다(turn-screens.test.ts 와 같은 모양).
import { L } from "../src/next/labels.ts";
import { deriveJourney, type JourneyInput } from "../src/next/lib/journey.ts";
import { submitCopy } from "../src/next/lib/submit-copy.ts";

const REPO: RepoStatus = {
  root: "/tmp/r",
  phase: "ready",
  detail: null,
  previewUrl: "http://127.0.0.1:5274/",
  previewPort: 5274,
  previewEpoch: 1,
  url: null,
  branch: null,
  baseBranch: "main",
  handoff: null,
  pendingChanges: 0,
};

const handoff = (state: HandoffStatus["state"]): HandoffStatus => ({
  number: 7,
  url: "https://github.com/o/r/pull/7",
  title: "t",
  state,
  branch: "colo-design/20260925-1",
  reviewers: ["dev1"],
});

const screen = (title: string, at: string) => ({ route: `/${title}`, title, note: "n", at });

// 셸과 같은 모양 — 제출 상태의 문장은 부르는 쪽이 지어 건넨다.
const run = (repo: Partial<RepoStatus>, rest: Partial<JourneyInput> = {}) => {
  const full = { ...REPO, ...repo };
  return deriveJourney(
    {
      repo: full,
      diffStatus: null,
      running: false,
      submitCopy: submitCopy(full.submit, L),
      ...rest,
    },
    L,
  );
};

test("제출 전 — 첫 점이 지금 점이고 화면 수를 말한다", () => {
  const j = run({
    branch: "colo-design/20260925-1",
    cycleScreens: [screen("회원 목록", "2026-09-25T01:00:00Z"), screen("", "2026-09-25T01:01:00Z")],
  });
  assert.equal(j.cycle, "draft");
  assert.equal(j.current, 0);
  // 제목 없는 화면(화면을 만지지 않은 차례)은 세지 않는다.
  assert.deepEqual(
    j.points.map((p) => [p.label, p.state]),
    [
      ["제출 전 · 화면 1개", "cur"],
      ["개발자 확인", "todo"],
      ["반영됨", "todo"],
    ],
  );
  assert.equal(j.submit.enabled, true);
  assert.equal(j.submit.reason, L.submit.whyReady(1));
  assert.equal(j.submit.more, false);
});

test("만든 것이 없으면 제출은 잠기고 이유를 말한다", () => {
  const j = run({});
  assert.equal(j.points[0].label, L.journey.before);
  assert.equal(j.submit.enabled, false);
  assert.equal(j.submit.reason, L.submit.whyNothing);
});

test("화면 목록을 모르는 데몬이어도 작업이 있으면 제출은 열린다", () => {
  const j = run({ branch: "colo-design/20260925-1" });
  assert.equal(j.points[0].label, L.journey.before);
  assert.equal(j.submit.enabled, true);
  assert.equal(j.submit.reason, L.shell.submitReadyAny);
});

test("개발자 확인 — 둘째 점이 지금 점, 코멘트 수가 붙는다", () => {
  const j = run({ branch: "b", handoff: handoff("open") }, { comments: 2 });
  assert.equal(j.cycle, "review");
  assert.equal(j.current, 1);
  assert.deepEqual(
    j.points.map((p) => [p.label, p.state]),
    [
      ["제출됨", "done"],
      ["개발자가 보고 있어요 · 코멘트 2", "cur"],
      ["반영됨", "todo"],
    ],
  );
  assert.equal(j.submit.more, true);
  for (const state of ["changes_requested", "closed"] as const) {
    assert.equal(run({ branch: "b", handoff: handoff(state) }).cycle, "review", state);
  }
});

test("열린 요청 — 보낸 뒤 바뀐 화면을 세고, 없으면 잠근다", () => {
  const log = [{ at: "2026-09-25T02:00:00Z", text: "제출했어요" }];
  const base = {
    branch: "b",
    handoff: handoff("open"),
    submit: { phase: "idle" as const, attempts: 1, log },
  };
  const more = run({
    ...base,
    cycleScreens: [screen("가", "2026-09-25T01:00:00Z"), screen("나", "2026-09-25T03:00:00Z")],
  });
  assert.equal(more.submit.enabled, true);
  assert.equal(more.submit.reason, L.submit.whyMoreReady(1));
  const none = run({ ...base, cycleScreens: [screen("가", "2026-09-25T01:00:00Z")] });
  assert.equal(none.submit.enabled, false);
  assert.equal(none.submit.reason, L.submit.whyNoMore);
});

test("반영됨 — 셋째 점, 제출은 다음 작업까지 잠긴다", () => {
  const j = run({ handoff: handoff("merged") });
  assert.equal(j.cycle, "merged");
  assert.equal(j.current, 2);
  assert.deepEqual(
    j.points.map((p) => p.label),
    ["제출됨", "확인됨", "반영됐어요"],
  );
  assert.equal(j.submit.enabled, false);
  assert.equal(j.submit.reason, L.submit.whyMerged);
});

test("반영 뒤에 쌓인 작업은 새 사이클의 제출 전이다", () => {
  const j = run({ handoff: handoff("merged"), branch: "colo-design/20260926-1" });
  assert.equal(j.cycle, "draft");
  assert.equal(j.submit.enabled, true);
  assert.equal(j.submit.more, false);
});

test("막힘 — 첫 점이 제출하지 못했어요, 제출은 잠기고 이유를 말한다", () => {
  const j = run({
    branch: "b",
    submit: { phase: "blocked", attempts: 3, lastError: "auth", log: [] },
  });
  assert.equal(j.blocked, true);
  assert.equal(j.points[0].label, L.journey.beforeBlocked);
  assert.equal(j.submit.enabled, false);
  // 연결 코드 만료(auth)는 새 초대 파일이 풀고, 그 밖은 개발자에게 알린 막힘이다.
  assert.equal(j.submit.reason, L.submit.whyAuth);
  const notified = run({
    branch: "b",
    submit: { phase: "blocked", attempts: 5, lastError: "network", log: [] },
  });
  assert.equal(notified.submit.reason, L.submit.whyBlocked);
  assert.equal(notified.points[0].label, "제출 전 · 제출하지 못했어요");
});

test("보낸 뒤의 화면은 시각을 수로 견준다 — git 의 +09:00 과 기록의 Z", () => {
  const j = run({
    branch: "b",
    handoff: handoff("open"),
    // 11:30+09:00 = 02:30Z — 02:00Z 제출 뒤다. 글자로 견주면 앞으로 읽힌다.
    cycleScreens: [screen("가", "2026-09-25T11:30:00+09:00")],
    submit: { phase: "idle", attempts: 1, log: [{ at: "2026-09-25T02:00:00Z", text: "x" }] },
  });
  assert.equal(j.submit.enabled, true);
  assert.equal(j.submit.reason, L.submit.whyMoreReady(1));
});

test("판정의 순서 — 다시 연결 > AI 도는 중 > 준비 중 > 제출 도는 중", () => {
  const busy = { branch: "b", submit: { phase: "running" as const, attempts: 1, log: [] } };
  assert.equal(run(busy, { reconnect: true, running: true }).submit.reason, L.submit.whyReconnect);
  const making = run(busy, { running: true });
  assert.equal(making.submit.reason, L.submit.whyRunning);
  assert.equal(making.making, true);
  assert.equal(run({ ...busy, phase: "installing" }).submit.reason, L.submit.whyPreparing);
  assert.equal(
    deriveJourney(
      { repo: null, diffStatus: null, running: false, submitCopy: submitCopy(null, L) },
      L,
    ).submit.reason,
    L.submit.whyPreparing,
  );
  const running = run(busy);
  assert.equal(running.submit.busy, "running");
  assert.equal(running.submit.enabled, false);
  const retrying = run({ branch: "b", submit: { phase: "retrying", attempts: 2, log: [] } });
  assert.equal(retrying.submit.busy, "retrying");
});

test("넘기기 방송만 제출로 읽는다 — 자동 보관의 푸시는 버튼을 바꾸지 않는다", () => {
  const pushing = run({ branch: "b" }, { diffStatus: { stage: "pushing" } });
  assert.equal(pushing.submit.busy, null);
  assert.equal(pushing.submit.enabled, true);
  const handing = run({ branch: "b" }, { diffStatus: { stage: "handing-off" } });
  assert.equal(handing.submit.busy, "running");
});

test("미리보기가 죽어도(error) 작업은 살아 있다 — 제출은 열린다", () => {
  assert.equal(run({ phase: "error", branch: "b" }).submit.enabled, true);
});
