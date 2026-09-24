import assert from "node:assert/strict";
import { test } from "node:test";
// `../dist` 임포트인 이유: cycle-reconcile 는 형제(budgets)를 `.js` 지정자로
// 부른다 — src 직접 로드는 그 지정을 못 고친다(revive-budget 와 같은 길).
import { type CycleLedger, emptyLedger } from "../dist/cycle-ledger.js";
import { type CycleSnapshot, nextCycleAction } from "../dist/cycle-reconcile.js";

const NOW = Date.parse("2026-09-24T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const BRANCH = "colo-design/20260924-1";

/** 모든 행이 조용한 중립 스냅샷 — 시험마다 필요한 필드만 바꾼다. */
function snap(over: Partial<CycleSnapshot> = {}): CycleSnapshot {
  return {
    now: NOW,
    turnRunning: false,
    gitOp: null,
    conflictFiles: [],
    markersLeft: [],
    taggedStash: null,
    headBranch: BRANCH,
    registryBranch: BRANCH,
    baseBranch: "main",
    originBaseExists: true,
    defaultBranch: "main",
    dirtyFiles: 0,
    aheadOfBase: 0,
    behindBase: 0,
    remoteBranchExists: true,
    localAheadOfRemote: 0,
    remoteAheadOfLocal: 0,
    pr: null,
    commitsAfterPrHead: null,
    newReviewIds: [],
    installStale: false,
    hygieneDue: false,
    githubReachable: true,
    githubAuthExpired: false,
    ...over,
  };
}

function led(over: Partial<CycleLedger> = {}): CycleLedger {
  return { ...emptyLedger(), ...over };
}

const kindOf = (out: { action: { kind: string } }) => out.action.kind;

// ————— 행마다 하나 —————

test("1행 — 도구가 시작하지 않은 rebase 는 중단한다", () => {
  assert.deepEqual(nextCycleAction(snap({ gitOp: "rebase" }), led()).action, {
    kind: "abortForeignOp",
    op: "rebase",
  });
  // 도구의 cherry-pick 과 종류가 같은 진행 표식은 남의 것이 아니다 — 2행으로 간다.
  const own = nextCycleAction(
    snap({ gitOp: "cherry-pick", markersLeft: ["src/a.ts"] }),
    led({
      pendingOp: { kind: "cherry-pick", files: ["src/a.ts"], startedAt: iso(NOW), briefs: 0 },
    }),
  );
  assert.equal(kindOf(own), "briefConflict");
});

test("2행 — 표식이 비었으면 도구가 마무리한다", () => {
  const out = nextCycleAction(
    snap({ gitOp: "merge", conflictFiles: ["src/a.ts"], markersLeft: [] }),
    led({ pendingOp: { kind: "merge", files: ["src/a.ts"], startedAt: iso(NOW), briefs: 1 } }),
  );
  assert.deepEqual(out.action, { kind: "finishToolOp", op: "merge" });
  assert.equal(out.attention, null);
});

test("2행 — 표식이 남았으면 AI 에게 정리 브리프를 보내고 셈을 올린다", () => {
  const ledger = led({
    pendingOp: { kind: "merge", files: ["src/a.ts"], startedAt: iso(NOW), briefs: 0 },
  });
  const out = nextCycleAction(snap({ gitOp: "merge", markersLeft: ["src/a.ts"] }), ledger);
  assert.deepEqual(out.action, { kind: "briefConflict", op: "merge", files: ["src/a.ts"] });
  assert.equal(out.attention, "ai-fixing");
  assert.equal(out.ledger.pendingOp?.briefs, 1);
  // 입력 원장의 briefs 는 그대로다.
  assert.equal(ledger.pendingOp?.briefs, 0);
});

test("2행 — stash 복원은 git 진행 표식 없이 unmerged 파일로 판다", () => {
  const ledger = led({
    pendingOp: { kind: "stash-pop", files: ["src/b.ts"], startedAt: iso(NOW), briefs: 0 },
  });
  const out = nextCycleAction(
    snap({ conflictFiles: ["src/b.ts"], markersLeft: ["src/b.ts"] }),
    ledger,
  );
  assert.deepEqual(out.action, { kind: "briefConflict", op: "stash-pop", files: ["src/b.ts"] });
});

test("2행 — 충돌 브리프 두 번 뒤 세 번째는 알림 한 번, 네 번째 틱에는 알림 없음", () => {
  const ledger = led({
    pendingOp: { kind: "merge", files: ["src/a.ts"], startedAt: iso(NOW), briefs: 0 },
  });
  const shot = snap({ gitOp: "merge", markersLeft: ["src/a.ts"] });
  const first = nextCycleAction(shot, ledger);
  assert.equal(kindOf(first), "briefConflict");
  const second = nextCycleAction(shot, first.ledger);
  assert.equal(kindOf(second), "briefConflict"); // 마지막 몫
  const third = nextCycleAction(shot, second.ledger);
  assert.equal(kindOf(third), "none");
  assert.deepEqual(third.notices, [
    { op: "raise", key: "conflict:stuck", reason: "충돌 표식이 두 번의 정리 뒤에도 남아 있습니다" },
  ]);
  assert.equal(third.attention, "developer-notified");
  const fourth = nextCycleAction(shot, third.ledger);
  assert.deepEqual(fourth.notices, []);
  assert.equal(fourth.attention, "developer-notified"); // 주의는 계속 말한다
});

test("2행 — 턴이 도는 중(AI 고침)이면 none + ai-fixing", () => {
  const ledger = led({
    pendingOp: { kind: "merge", files: ["src/a.ts"], startedAt: iso(NOW), briefs: 1 },
  });
  const out = nextCycleAction(
    snap({ turnRunning: true, gitOp: "merge", markersLeft: ["src/a.ts"] }),
    ledger,
  );
  assert.deepEqual(out.action, { kind: "none" });
  assert.equal(out.attention, "ai-fixing");
});

test("3행 — 도구 태그의 stash 를 복원한다", () => {
  const out = nextCycleAction(snap({ taggedStash: "refs/stash@{0}" }), led());
  assert.deepEqual(out.action, { kind: "popParkedStash", ref: "refs/stash@{0}" });
});

test("4행 — HEAD 가 레지스트리 브랜치가 아니면 맞추고, detached 면 새로 짓는다", () => {
  assert.deepEqual(nextCycleAction(snap({ headBranch: "main" }), led()).action, {
    kind: "alignBranch",
    name: BRANCH,
  });
  const detached = nextCycleAction(snap({ headBranch: null, registryBranch: null }), led());
  assert.deepEqual(detached.action, { kind: "branchFromHead" });
});

test("5행 — 커밋 안 된 변경을 보관한다", () => {
  assert.deepEqual(nextCycleAction(snap({ dirtyFiles: 3 }), led()).action, {
    kind: "commitPending",
  });
});

test("6행 — 사이클 없이 앞선 커밋을 새 사이클로 입양한다", () => {
  const out = nextCycleAction(
    snap({ registryBranch: null, headBranch: "main", aheadOfBase: 2 }),
    led(),
  );
  assert.deepEqual(out.action, { kind: "adoptStrayCommits" });
});

test("7행 — 베이스가 사라졌으면 GitHub 기본 가지로 겨냥을 바꾼다", () => {
  const out = nextCycleAction(snap({ originBaseExists: false, defaultBranch: "develop" }), led());
  assert.deepEqual(out.action, { kind: "retargetBase", to: "develop" });
});

test("7행 — 기본 가지도 모르면 base-missing 알림을 한 번만 올린다", () => {
  const shot = snap({ originBaseExists: false, defaultBranch: null });
  const first = nextCycleAction(shot, led());
  assert.equal(kindOf(first), "none");
  assert.deepEqual(first.notices, [
    {
      op: "raise",
      key: "base-missing",
      reason: "원격에 베이스 브랜치가 없고 GitHub 의 기본 가지도 알 수 없습니다",
    },
  ]);
  assert.equal(first.attention, "developer-notified");
  assert.deepEqual(nextCycleAction(shot, first.ledger).notices, []);
});

test("8행 — 병합된 PR 을 랜딩한다", () => {
  const pr = { number: 12, state: "merged" as const, headSha: "abc1234", mergeableState: null };
  const out = nextCycleAction(snap({ pr, commitsAfterPrHead: 0 }), led());
  assert.deepEqual(out.action, {
    kind: "land",
    outcome: "merged",
    pr: 12,
    headSha: "abc1234",
    carry: false,
  });
});

test("9행 — 닫힌 PR 을 랜딩하고 남은 커밋을 이월 표시한다", () => {
  const pr = { number: 12, state: "closed" as const, headSha: "abc1234", mergeableState: null };
  const out = nextCycleAction(snap({ pr, commitsAfterPrHead: 3 }), led());
  assert.deepEqual(out.action, {
    kind: "land",
    outcome: "closed",
    pr: 12,
    headSha: "abc1234",
    carry: true,
  });
});

test("8행 — 인증이 만료된 GitHub 의 PR 은 믿지 않고 다시 연결을 말한다", () => {
  const pr = { number: 12, state: "merged" as const, headSha: "abc1234", mergeableState: null };
  const out = nextCycleAction(snap({ pr, githubAuthExpired: true }), led());
  assert.equal(kindOf(out), "none");
  assert.equal(out.attention, "reconnect");
});

test("10행 — 원격 브랜치가 앞서면 당겨 온다", () => {
  assert.deepEqual(nextCycleAction(snap({ remoteAheadOfLocal: 2 }), led()).action, {
    kind: "pullRemoteBranch",
  });
});

test("11행 — 사이클 브랜치가 베이스 뒤처졌거나 PR 이 충돌 중이면 베이스를 합친다", () => {
  assert.deepEqual(nextCycleAction(snap({ behindBase: 3 }), led()).action, {
    kind: "mergeBase",
    reason: "behind",
  });
  const pr = { number: 12, state: "open" as const, headSha: "abc", mergeableState: "dirty" };
  assert.deepEqual(nextCycleAction(snap({ pr }), led()).action, {
    kind: "mergeBase",
    reason: "dirty-pr",
  });
});

test("11b 행 — 사이클 없이 곧은 클론이 뒤처졌으면 앞으로 당겨 온다", () => {
  const out = nextCycleAction(
    snap({ registryBranch: null, headBranch: "main", behindBase: 2 }),
    led(),
  );
  assert.deepEqual(out.action, { kind: "fastForwardBase" });
  // 앞선 커밋이 있으면(6행) · 트리가 더러우면(5행) 갈라진다 — 이 행이 아니다.
  assert.equal(
    kindOf(
      nextCycleAction(
        snap({ registryBranch: null, headBranch: "main", behindBase: 2, aheadOfBase: 1 }),
        led(),
      ),
    ),
    "adoptStrayCommits",
  );
  assert.equal(
    kindOf(
      nextCycleAction(
        snap({ registryBranch: null, headBranch: "main", behindBase: 2, dirtyFiles: 1 }),
        led(),
      ),
    ),
    "commitPending",
  );
});

test("12행 — 올라갈 커밋이 있으면 밀고, 사이클 브랜치가 원격에 없어도 민다", () => {
  assert.deepEqual(nextCycleAction(snap({ localAheadOfRemote: 1 }), led()).action, {
    kind: "push",
  });
  assert.deepEqual(nextCycleAction(snap({ remoteBranchExists: false }), led()).action, {
    kind: "push",
  });
});

test("13행 — 제출 의도가 남아 있으면 다음 단계를 밟는다(턴 중에도)", () => {
  const ledger = led({ submit: { requestedAt: iso(NOW), via: "button" } });
  assert.deepEqual(nextCycleAction(snap(), ledger).action, { kind: "submitStep" });
  assert.deepEqual(nextCycleAction(snap({ turnRunning: true }), ledger).action, {
    kind: "submitStep",
  });
});

test("14행 — 새 코멘트를 반영 브리프로 보내고 장부에 적는다", () => {
  const pr = { number: 12, state: "open" as const, headSha: "abc", mergeableState: null };
  const out = nextCycleAction(snap({ pr, newReviewIds: [5, 6] }), led());
  assert.deepEqual(out.action, { kind: "briefReviews", pr: 12, ids: [5, 6] });
  assert.equal(out.attention, "ai-fixing");
  assert.deepEqual(out.ledger.reviews["12"], { known: [5, 6], briefed: [5, 6], rounds: 1 });
});

test("14행 — PR 당 5 라운드를 다 쓰면 알림 한 번", () => {
  const pr = { number: 12, state: "open" as const, headSha: "abc", mergeableState: null };
  const shot = snap({ pr });
  let ledger = led();
  for (let i = 0; i < 5; i += 1) {
    const out = nextCycleAction({ ...shot, newReviewIds: [100 + i] }, ledger);
    assert.equal(kindOf(out), "briefReviews");
    ledger = out.ledger;
  }
  const sixth = nextCycleAction({ ...shot, newReviewIds: [200] }, ledger);
  assert.equal(kindOf(sixth), "none");
  assert.deepEqual(sixth.notices, [
    {
      op: "raise",
      key: "review:12:rounds",
      reason: "코멘트 반영이 PR 당 라운드 상한에 닿았습니다",
    },
  ]);
  assert.equal(sixth.attention, "developer-notified");
  assert.deepEqual(nextCycleAction({ ...shot, newReviewIds: [201] }, sixth.ledger).notices, []);
});

test("15행 · 16행 — 재설치와 위생", () => {
  assert.deepEqual(nextCycleAction(snap({ installStale: true }), led()).action, {
    kind: "reinstall",
  });
  assert.deepEqual(nextCycleAction(snap({ hygieneDue: true }), led()).action, { kind: "hygiene" });
});

// ————— 우선순위가 겹치는 조합 —————

test("더러운 트리 + 병합된 PR — 보관이 먼저(5행이 8행보다 앞선다)", () => {
  const pr = { number: 12, state: "merged" as const, headSha: "abc", mergeableState: null };
  assert.equal(kindOf(nextCycleAction(snap({ dirtyFiles: 2, pr }), led())), "commitPending");
});

test("병합됨 + 베이스 뒤처짐 — 랜딩이 먼저(끝난 PR 에 베이스를 합치는 건 헛수고)", () => {
  const pr = { number: 12, state: "merged" as const, headSha: "abc", mergeableState: null };
  assert.equal(kindOf(nextCycleAction(snap({ pr, behindBase: 3 }), led())), "land");
});

test("남의 rebase + 더러운 트리 — 중단이 먼저(클론의 무결성)", () => {
  assert.equal(
    kindOf(nextCycleAction(snap({ gitOp: "rebase", dirtyFiles: 5 }), led())),
    "abortForeignOp",
  );
});

// ————— 턴 중 규칙 —————

test("턴 중 — 더러운 트리는 기다리고 푸시는 간다", () => {
  assert.equal(
    kindOf(
      nextCycleAction(snap({ turnRunning: true, dirtyFiles: 2, localAheadOfRemote: 1 }), led()),
    ),
    "push",
  );
});

test("턴 중 — 무결성 문제는 예 행도 보지 않는다", () => {
  const out = nextCycleAction(
    snap({ turnRunning: true, gitOp: "revert", localAheadOfRemote: 3 }),
    led(),
  );
  assert.deepEqual(out.action, { kind: "none" });
  assert.equal(out.attention, null);
});

test("턴 중 — 도구의 병합 충돌 동안에도 푸시는 된다(이미 커밋된 것을 올린다)", () => {
  const ledger = led({
    pendingOp: { kind: "merge", files: ["src/a.ts"], startedAt: iso(NOW), briefs: 1 },
  });
  const out = nextCycleAction(
    snap({ turnRunning: true, gitOp: "merge", markersLeft: ["src/a.ts"], localAheadOfRemote: 2 }),
    ledger,
  );
  assert.deepEqual(out.action, { kind: "push" });
  assert.equal(out.attention, "ai-fixing");
});

test("턴 중 — 병합된 PR 의 랜딩은 턴이 끝날 때까지 기다린다", () => {
  const pr = { number: 12, state: "merged" as const, headSha: "abc", mergeableState: null };
  const out = nextCycleAction(snap({ turnRunning: true, pr }), led());
  assert.equal(kindOf(out), "none");
});

test("턴 중 — 베이스 재겨냥(7행)은 턴 중에도 된다", () => {
  const out = nextCycleAction(
    snap({ turnRunning: true, originBaseExists: false, defaultBranch: "develop" }),
    led(),
  );
  assert.equal(kindOf(out), "retargetBase");
});

// ————— 푸시 백오프와 밀림 알림 —————

test("백오프 창 안에서는 푸시하지 않는다", () => {
  const ledger = led({
    push: {
      behindSince: iso(NOW - 60_000),
      attempts: 1,
      nextAttemptAt: iso(NOW + 30_000),
      lastError: "network",
    },
  });
  const out = nextCycleAction(snap({ localAheadOfRemote: 1 }), ledger);
  assert.equal(kindOf(out), "none");
  assert.deepEqual(out.notices, []); // 1시간 전 — 알림도 없다
  // 창이 지나면 다시 민다.
  const due = nextCycleAction(snap({ now: NOW + 60_000, localAheadOfRemote: 1 }), ledger);
  assert.equal(kindOf(due), "push");
});

test("1시간 밀림 — push:behind 알림을 한 번만 올린다", () => {
  const ledger = led({
    push: {
      behindSince: iso(NOW - 61 * 60_000),
      attempts: 1,
      nextAttemptAt: iso(NOW - 1_000),
      lastError: "network",
    },
  });
  const shot = snap({ localAheadOfRemote: 1 });
  const first = nextCycleAction(shot, ledger);
  assert.equal(kindOf(first), "push");
  assert.deepEqual(first.notices, [
    { op: "raise", key: "push:behind", reason: "푸시가 1시간 넘게 올라가지 못하고 있습니다" },
  ]);
  assert.equal(first.attention, "developer-notified");
  // 조정자가 올렸다면(notices 에 기록) 다시 올리지 않는다.
  const standing = {
    ...first.ledger,
    notices: { "push:behind": { via: "pr" as const, ref: 12, raisedAt: iso(NOW), count: 1 } },
  };
  const second = nextCycleAction(shot, standing);
  assert.deepEqual(second.notices, []);
});

test("인증 거절 푸시 — 다시 연결을 말하고 알림을 한 번 올린다", () => {
  const ledger = led({
    push: {
      behindSince: iso(NOW - 60_000),
      attempts: 1,
      nextAttemptAt: iso(NOW - 1_000),
      lastError: "auth",
    },
  });
  const out = nextCycleAction(snap({ localAheadOfRemote: 1 }), ledger);
  assert.equal(kindOf(out), "push");
  assert.equal(out.attention, "reconnect");
  assert.deepEqual(
    out.notices.map((n) => n.key),
    ["push:auth"],
  );
});

test("밀림이 풀리면 서 있는 푸시 알림을 지우고 원장 흔적을 치운다", () => {
  const ledger = led({
    push: {
      behindSince: iso(NOW - 90 * 60_000),
      attempts: 2,
      nextAttemptAt: iso(NOW),
      lastError: "auth",
    },
  });
  const out = nextCycleAction(snap(), ledger);
  assert.equal(kindOf(out), "none");
  assert.deepEqual(out.notices, [
    { op: "resolve", key: "push:behind" },
    { op: "resolve", key: "push:auth" },
  ]);
  assert.equal(out.ledger.push, null);
  assert.equal(out.attention, null);
});

// ————— 순수함 —————

test("순수함 — 같은 입력에 같은 출력, 입력 원장은 바뀌지 않는다", () => {
  const snapshot = snap({ gitOp: "merge", markersLeft: ["src/a.ts"], localAheadOfRemote: 1 });
  const ledger = led({
    pendingOp: { kind: "merge", files: ["src/a.ts"], startedAt: iso(NOW), briefs: 0 },
  });
  const keep = structuredClone(ledger);
  const first = nextCycleAction(snapshot, ledger);
  const second = nextCycleAction(snapshot, ledger);
  assert.deepEqual(first, second);
  // 돌려받은 원장을 마음껏 바꿔도 입력은 그대로다.
  first.ledger.pendingOp = null;
  first.ledger.budgets["x"] = { spent: 9, firstAt: iso(NOW), lastAt: iso(NOW), escalated: true };
  assert.deepEqual(ledger, keep);
});
