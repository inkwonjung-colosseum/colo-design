import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
// `../dist` 임포트인 이유: cycle-observe · repo-core 는 형제를 `.js` 지정자로
// 부른다 — src 직접 로드는 그 지정을 못 고친다(shelf-recover 와 같은 길).
import { emptyLedger } from "../dist/cycle-ledger.js";
import { nextCycleAction } from "../dist/cycle-reconcile.js";
import { STASH_MESSAGE } from "../dist/repo-core.js";
import { type HandoffLike, makeScene, type Scene } from "./helpers/cycle-harness.ts";

const BRANCH = "colo-design/20260924-1";

/** 레지스트리가 기억하는 넘긴 요청의 시험용 모양. */
function handoff(number: number): HandoffLike {
  return {
    number,
    url: `https://github.test/colo-design/harness/pull/${number}`,
    title: "화면 작업",
    state: "open",
    branch: BRANCH,
  };
}

/** 클론에 커밋 — 도구의 자동 보관이 한 차례 지나간 모양. */
async function commit(scene: Scene, files: Record<string, string>, message: string) {
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(scene.clone.path, name), body);
  }
  await scene.git(["add", "-A"]);
  await scene.git(["commit", "-m", message]);
}

/** 사이클 브랜치에 커밋을 올리고 PR 을 여는 자리 — 넘긴 세계의 시작점. */
async function openCycle(
  scene: Scene,
  commits: Array<[Record<string, string>, string]>,
): Promise<number> {
  await scene.git(["checkout", "-b", BRANCH]);
  for (const [files, message] of commits) await commit(scene, files, message);
  await scene.git(["push", "-u", "origin", BRANCH]);
  const number = await scene.github.openPull({ head: BRANCH });
  scene.core.setCycle(BRANCH, handoff(number));
  return number;
}

test("깨끗한 클론, 사이클 없음 — 모든 수가 0이고 gitOp 가 없다", async () => {
  const scene = await makeScene();
  try {
    const snap = await scene.observe({ fetch: true });
    assert.equal(snap.gitOp, null);
    assert.equal(snap.taggedStash, null);
    assert.equal(snap.headBranch, "main");
    assert.equal(snap.registryBranch, null);
    assert.equal(snap.baseBranch, "main");
    assert.equal(snap.originBaseExists, true);
    assert.equal(snap.dirtyFiles, 0);
    assert.equal(snap.aheadOfBase, 0);
    assert.equal(snap.behindBase, 0);
    assert.equal(snap.remoteBranchExists, false);
    assert.equal(snap.localAheadOfRemote, 0);
    assert.equal(snap.remoteAheadOfLocal, 0);
    assert.equal(snap.pr, null);
    assert.equal(snap.commitsAfterPrHead, null);
    assert.deepEqual(snap.conflictFiles, []);
    assert.deepEqual(snap.markersLeft, []);
    assert.deepEqual(snap.newReviewIds, []);
    assert.equal(snap.githubReachable, true);
    assert.equal(snap.githubAuthExpired, false);
    assert.equal(snap.hygieneDue, false);
  } finally {
    scene.dispose();
  }
});

test("커밋 안 된 변경 — dirtyFiles", async () => {
  const scene = await makeScene();
  try {
    writeFileSync(join(scene.clone.path, "screen.txt"), "수정\n");
    const snap = await scene.observe({});
    assert.equal(snap.dirtyFiles, 1);
  } finally {
    scene.dispose();
  }
});

test("사이클 없이 base 에 로컬 커밋 — aheadOfBase, 조정은 adoptStrayCommits", async () => {
  const scene = await makeScene();
  try {
    await commit(scene, { "screen.txt": "로컬\n" }, "로컬 커밋");
    const snap = await scene.observe({});
    assert.equal(snap.aheadOfBase, 1);
    assert.equal(snap.registryBranch, null);
    const decision = nextCycleAction(snap, emptyLedger());
    assert.equal(decision.action.kind, "adoptStrayCommits");
  } finally {
    scene.dispose();
  }
});

test("개발자가 base 에 올림 — behindBase, 조정은 fastForwardBase", async () => {
  const scene = await makeScene();
  try {
    await scene.dev.pushToBase({ "dev.txt": "개발자\n" }, "베이스 커밋");
    const snap = await scene.observe({ fetch: true });
    assert.equal(snap.behindBase, 1);
    assert.equal(snap.aheadOfBase, 0);
    const decision = nextCycleAction(snap, emptyLedger());
    assert.equal(decision.action.kind, "fastForwardBase");
  } finally {
    scene.dispose();
  }
});

test("사이클 브랜치의 올리지 않은 커밋 — localAheadOfRemote, 원격 브랜치 없음, 조정은 push", async () => {
  const scene = await makeScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    await commit(scene, { "screen.txt": "사이클\n" }, "사이클 첫 커밋");
    scene.core.setCycle(BRANCH, null);
    const snap = await scene.observe({});
    assert.equal(snap.registryBranch, BRANCH);
    assert.equal(snap.remoteBranchExists, false);
    assert.equal(snap.localAheadOfRemote, 1);
    assert.equal(snap.remoteAheadOfLocal, 0);
    const decision = nextCycleAction(snap, emptyLedger());
    assert.equal(decision.action.kind, "push");
  } finally {
    scene.dispose();
  }
});

test("개발자가 PR 브랜치에 올림 — remoteAheadOfLocal, 조정은 pullRemoteBranch", async () => {
  const scene = await makeScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    await commit(scene, { "screen.txt": "사이클\n" }, "사이클 첫 커밋");
    await scene.git(["push", "-u", "origin", BRANCH]);
    scene.core.setCycle(BRANCH, null);
    await scene.dev.pushToBranch(BRANCH, { "review.txt": "리뷰 중 수정\n" }, "개발자 커밋");
    const snap = await scene.observe({ fetch: true });
    assert.equal(snap.remoteBranchExists, true);
    assert.equal(snap.remoteAheadOfLocal, 1);
    assert.equal(snap.localAheadOfRemote, 0);
    const decision = nextCycleAction(snap, emptyLedger());
    assert.equal(decision.action.kind, "pullRemoteBranch");
  } finally {
    scene.dispose();
  }
});

test("PR 병합(merge) 뒤 로컬 커밋 2개 — pr merged, commitsAfterPrHead 2, 조정은 land carry", async () => {
  const scene = await makeScene();
  try {
    const number = await openCycle(scene, [[{ "screen.txt": "사이클\n" }, "사이클 첫 커밋"]]);
    await scene.github.merge(number, "merge");
    await commit(scene, { "b.txt": "둘\n" }, "두 번째");
    await commit(scene, { "c.txt": "셋\n" }, "세 번째");
    const snap = await scene.observe({ fetch: true });
    assert.equal(snap.pr?.state, "merged");
    assert.equal(snap.commitsAfterPrHead, 2);
    const decision = nextCycleAction(snap, emptyLedger());
    assert.equal(decision.action.kind, "land");
    if (decision.action.kind === "land") assert.equal(decision.action.carry, true);
  } finally {
    scene.dispose();
  }
});

test("PR 스쿼시 병합 뒤 로컬 커밋 1개 — commitsAfterPrHead 1 (스쿼시에서도 맞다)", async () => {
  const scene = await makeScene();
  try {
    const number = await openCycle(scene, [[{ "screen.txt": "사이클\n" }, "사이클 첫 커밋"]]);
    await scene.github.merge(number, "squash");
    await commit(scene, { "b.txt": "둘\n" }, "두 번째");
    const snap = await scene.observe({ fetch: true });
    assert.equal(snap.pr?.state, "merged");
    assert.equal(snap.commitsAfterPrHead, 1);
  } finally {
    scene.dispose();
  }
});

test("PR 병합, headSha 가 로컬에 없는 경우 — commitsAfterPrHead 가 0 이 아니다", async () => {
  const scene = await makeScene();
  try {
    const number = await openCycle(scene, [[{ "screen.txt": "사이클\n" }, "사이클 첫 커밋"]]);
    // 개발자가 PR 브랜치에 올린 뒤 스쿼시 병합 — 그 커밋은 베이스의 조상이 아니다.
    await scene.dev.pushToBranch(BRANCH, { "dev.txt": "개발자\n" }, "개발자 커밋");
    await scene.github.merge(number, "squash");
    // 브랜치가 다시 쓰여 병합 순간의 head 는 어느 ref 에도 닿지 않는다 — 도구의
    // 클론은 fetch 해도 그 객체를 얻지 못한다.
    await scene.dev.rewriteBranch(BRANCH, { "new.txt": "새 판\n" }, "브랜치 다시 쓰기");
    const snap = await scene.observe({ fetch: true });
    assert.equal(snap.pr?.state, "merged");
    // 넉넉한 규칙: headSha 를 못 믿으면 origin/base 기준으로 센다 — 0 이 아니다.
    assert.equal(snap.commitsAfterPrHead, 1);
  } finally {
    scene.dispose();
  }
});

test("PR 반려(close) — pr closed, commitsAfterPrHead = 브랜치 전체 커밋 수", async () => {
  const scene = await makeScene();
  try {
    const number = await openCycle(scene, [
      [{ "screen.txt": "사이클\n" }, "사이클 첫 커밋"],
      [{ "b.txt": "둘\n" }, "두 번째"],
    ]);
    scene.github.close(number);
    const snap = await scene.observe({ fetch: true });
    assert.equal(snap.pr?.state, "closed");
    assert.equal(snap.commitsAfterPrHead, 2);
  } finally {
    scene.dispose();
  }
});

test("도구 태그 stash 가 남음 — taggedStash, 손으로 만든 stash 는 건드리지 않는다", async () => {
  const scene = await makeScene();
  try {
    writeFileSync(join(scene.clone.path, "README.md"), "사용자 변경\n");
    await scene.git(["stash", "push", "-m", "사용자가 직접"]);
    const before = await scene.observe({});
    assert.equal(before.taggedStash, null);
    writeFileSync(join(scene.clone.path, "README.md"), "도구 변경\n");
    await scene.git(["stash", "push", "-m", STASH_MESSAGE]);
    const snap = await scene.observe({});
    assert.equal(snap.taggedStash, "stash@{0}");
  } finally {
    scene.dispose();
  }
});

test("병합 충돌로 멈춘 상태 — gitOp merge, conflictFiles, markersLeft; 정리 뒤 markersLeft 빔", async () => {
  const scene = await makeScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    await commit(scene, { "README.md": "도구 판\n" }, "도구 변경");
    await scene.dev.pushToBase({ "README.md": "개발자 판\n" }, "개발자 변경");
    await scene.git(["fetch", "origin", "main"]);
    await scene.git(["merge", "origin/main"]).catch(() => "");
    const snap = await scene.observe({});
    assert.equal(snap.gitOp, "merge");
    assert.deepEqual(snap.conflictFiles, ["README.md"]);
    assert.deepEqual(snap.markersLeft, ["README.md"]);
    // AI 가 표식을 정리하고 add 한 모양 — MERGE_HEAD 는 아직 남아 있다.
    writeFileSync(join(scene.clone.path, "README.md"), "합쳐진 판\n");
    await scene.git(["add", "README.md"]);
    const after = await scene.observe({});
    assert.equal(after.gitOp, "merge");
    assert.deepEqual(after.conflictFiles, []);
    assert.deepEqual(after.markersLeft, []);
  } finally {
    scene.dispose();
  }
});

test("pendingOp.files 의 파일도 표식 검사 범위다 — unmerged 가 아니어도", async () => {
  const scene = await makeScene();
  try {
    // stash 복원이 남긴 표식은 git 의 진행 표식이 없다 — 원장의 파일 목록이
    // 유일한 실마리다(L3 2행).
    writeFileSync(
      join(scene.clone.path, "left.txt"),
      "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> stash\n",
    );
    const ledger = emptyLedger();
    ledger.pendingOp = {
      kind: "stash-pop",
      files: ["left.txt"],
      startedAt: new Date().toISOString(),
      briefs: 0,
    };
    const snap = await scene.observe({ ledger });
    assert.equal(snap.gitOp, null);
    assert.deepEqual(snap.conflictFiles, []);
    assert.deepEqual(snap.markersLeft, ["left.txt"]);
  } finally {
    scene.dispose();
  }
});

test("detached HEAD — headBranch null, 조정은 branchFromHead", async () => {
  const scene = await makeScene();
  try {
    await scene.git(["checkout", "--detach", "HEAD"]);
    const snap = await scene.observe({});
    assert.equal(snap.headBranch, null);
    const decision = nextCycleAction(snap, emptyLedger());
    assert.equal(decision.action.kind, "branchFromHead");
  } finally {
    scene.dispose();
  }
});

test("인증 만료 — pr null, githubAuthExpired; 만료된 토큰의 읽기도 pr null", async () => {
  const scene = await makeScene();
  try {
    await openCycle(scene, [[{ "screen.txt": "사이클\n" }, "사이클 첫 커밋"]]);
    const snap = await scene.observe({ deps: { githubAuthExpired: () => true } });
    assert.equal(snap.pr, null);
    assert.equal(snap.githubAuthExpired, true);
    // 전송이 401 을 내는 세계 — 관찰은 죽지 않고 pr 이 비며 githubReachable 이 꺼진다.
    scene.github.expireAuth();
    const after = await scene.observe({});
    assert.equal(after.pr, null);
    assert.equal(after.githubReachable, false);
  } finally {
    scene.dispose();
  }
});

test("새 코멘트 — newReviewIds, 원장의 known 에 있는 id 는 빠진다", async () => {
  const scene = await makeScene();
  try {
    const number = await openCycle(scene, [[{ "screen.txt": "사이클\n" }, "사이클 첫 커밋"]]);
    const a = scene.github.addComment(number, { kind: "issue", login: "dev1", body: "버튼 위치" });
    const b = scene.github.addComment(number, { kind: "pull", login: "dev1", body: "여백" });
    // 도구 자신의 코멘트와 본문 없는 리뷰는 새 코멘트가 아니다.
    scene.github.addComment(number, { kind: "issue", login: "colo-planner", body: "제 코멘트" });
    scene.github.addComment(number, { kind: "review", login: "dev1", body: "" });
    const snap = await scene.observe({});
    assert.deepEqual(snap.newReviewIds, [a, b]);
    const decision = nextCycleAction(snap, emptyLedger());
    assert.equal(decision.action.kind, "briefReviews");
    // 원장이 아는 id 는 새 것이 아니다.
    const ledger = emptyLedger();
    ledger.reviews[String(number)] = { known: [a], briefed: [a], rounds: 1 };
    const again = await scene.observe({ ledger });
    assert.deepEqual(again.newReviewIds, [b]);
  } finally {
    scene.dispose();
  }
});
