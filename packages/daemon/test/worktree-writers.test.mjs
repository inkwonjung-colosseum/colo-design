/**
 * 워크트리를 손대는 세 길(되돌리기 · 변경 버리기 · 체크포인트 복원)이
 * 작성자 슬롯을 실제로 잡는가 (감사 2026-09-19 C2ⓑ).
 *
 * 결함: 셋 다 `publishing`·`refreshing`·`shelving` 을 **기다리기만** 하고
 * 자신은 어디에도 등록하지 않았다. `pull()` 은 같은 세 자리만 보고 진행
 * 하므로(repo.ts 의 `refreshFromRemote` 앞), `session.create` 가 스스로
 * 쏘는 `void this.repo.pull(...)` 이 "비어 있다"고 읽고 반쯤 되감긴 트리
 * 위에 stash→이동→replay 를 얹었다. 코드 주석이 말하던
 * "the same worktree contract as a save" 가 절반만 구현된 자리.
 *
 * 계약(수정 후): 세 길은 일하는 동안 `refreshing` 을 차지하고, 끝나면
 * 자기 것만 내린다 — 뒤에 온 작성자가 이어받았으면 그대로 둔다.
 *
 * Run: node --test packages/daemon/test/worktree-writers.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const { RepoWorkspace } = await import("../dist/repo.js");

/**
 * git 을 부르지 않는 최소 워크스페이스 — 이 시험의 대상은 슬롯의 생애이지
 * git 의 동작이 아니다. `core` 를 직접 갈아 끼워 세 길의 본체를 가로챈다.
 */
function workspace() {
  const repo = new RepoWorkspace({
    root: "/tmp/colo-design-worktree-writers",
    url: null,
    pat: null,
    onStatus: () => undefined,
  });
  const core = repo.core;
  core.isCloned = () => true;
  core.mergeInProgress = async () => false;
  core.conflictedFiles = async () => [];
  return { repo, core };
}

/** 일이 도는 동안 슬롯을 들여다볼 수 있게 붙잡아 두는 손잡이. */
function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

test("변경 버리기는 도는 동안 refreshing 슬롯을 차지한다", async () => {
  const { repo, core } = workspace();
  const held = gate();
  let slotWhileWorking = null;
  core.clearUnsavedWork = async () => {
    slotWhileWorking = core.refreshing;
    await held.promise;
    return { removed: ["a.txt"] };
  };

  assert.equal(core.refreshing, null, "시작 전에는 비어 있다");
  const running = repo.discard();
  // 일이 시작되기까지 한 틱 — 슬롯은 그 전에 이미 서 있어야 한다(등록이
  // 첫 await 뒤면 같은 틱의 pull 이 빈 자리를 본다).
  assert.notEqual(core.refreshing, null, "일이 도는 동안 슬롯이 서 있어야 한다");
  await Promise.resolve();
  held.release();
  const outcome = await running;

  assert.deepEqual(outcome, { removed: ["a.txt"] });
  assert.notEqual(slotWhileWorking, null, "본체가 도는 시점에도 슬롯이 서 있어야 한다");
  assert.equal(core.refreshing, null, "끝나면 자기 슬롯은 내린다");
});

/**
 * 결함의 본 모습: pull 이 세 자리를 읽고 "비었다"고 판단하는 그 순간.
 * 수정 전에는 되돌리기가 도는 중에도 세 자리가 전부 비어 있어, 최신화가
 * 반쯤 되감긴 트리 위에서 출발했다.
 */
test("되돌리기가 도는 동안 최신화는 빈 워크트리로 읽지 않는다", async () => {
  const { repo, core } = workspace();
  const held = gate();
  let sawSlotFromPullSide = null;
  repo.runRestore = async () => {
    // pull 이 보는 것과 똑같은 세 자리를 그 시점에 읽는다.
    sawSlotFromPullSide = {
      publishing: core.publishing,
      refreshing: core.refreshing,
      shelving: core.shelving,
    };
    await held.promise;
    return { stage: "published", commit: "abc1234" };
  };

  const running = repo.restore("abc1234");
  await Promise.resolve();
  held.release();
  await running;

  assert.notEqual(
    sawSlotFromPullSide.refreshing,
    null,
    "되돌리기가 도는 동안 세 자리가 모두 비어 있으면 pull 이 그 위로 얹는다",
  );
});

test("뒤에 온 작성자가 슬롯을 이어받으면 앞사람은 그것을 내리지 않는다", async () => {
  const { repo, core } = workspace();
  const first = gate();
  core.clearUnsavedWork = async () => {
    await first.promise;
    return { removed: [] };
  };

  const running = repo.discard();
  const mine = core.refreshing;
  // 뒤에 온 최신화가 슬롯을 이어받았다.
  const successor = Promise.resolve();
  core.refreshing = successor;
  first.release();
  await running;

  assert.notEqual(mine, successor, "두 슬롯은 다른 것이다");
  assert.equal(core.refreshing, successor, "남의 슬롯을 내리지 않는다");
});
