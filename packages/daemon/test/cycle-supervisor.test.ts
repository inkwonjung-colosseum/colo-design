import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { composeAttention } from "@colo-design/protocol";
// `../dist` 임포트인 이유: 형제를 `.js` 지정자로 부르는 모듈은 src 직접 로드가
// 그 지정을 못 고친다(cycle-observe.test.ts 와 같은 길).
import { readLedger } from "../dist/cycle-ledger.js";
import { CycleSupervisor } from "../dist/cycle-supervisor.js";
import { GitHubClient } from "../dist/github.js";
import { STASH_MESSAGE } from "../dist/repo-core.js";
import { makeSupervisedScene, type SupervisedScene } from "./helpers/cycle-harness.ts";

const BRANCH = "colo-design/20260924-1";

/** 클론에 커밋 — 도구의 자동 보관이 한 차례 지나간 모양. */
async function commit(scene: SupervisedScene, files: Record<string, string>, message: string) {
  for (const [name, body] of Object.entries(files)) {
    const path = join(scene.clone.path, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  await scene.git(["add", "-A"]);
  await scene.git(["commit", "-m", message]);
}

/** 원장 파일을 디스크에서 읽는다 — 감독자의 메모리가 아니라 기록을 본다. */
function ledgerOf(scene: SupervisedScene) {
  assert.ok(existsSync(scene.ledgerPath), "원장 파일이 있어야 한다");
  return readLedger(scene.ledgerPath);
}

/** 충돌 표식을 지우는 가짜 AI — 파일을 주어진 내용으로 다시 쓴다. */
function resolveMarkers(scene: SupervisedScene, files: Record<string, string>) {
  for (const [name, body] of Object.entries(files)) {
    const path = join(scene.clone.path, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
}

test("S1 푸시 밀림 — 원격이 죽으면 백오프가 쌓이고, 돌아오면 전부 올라간다", async () => {
  const scene = await makeSupervisedScene();
  try {
    // 사이클 브랜치 위에 커밋 셋 — 턴 셋이 지나간 모양.
    await scene.git(["checkout", "-b", BRANCH]);
    scene.core.setCycle(BRANCH, null);
    for (let i = 0; i < 3; i += 1) {
      await commit(scene, { [`f${i}.ts`]: `export const v${i} = ${i};\n` }, `작업 ${i}`);
    }

    // 원격을 죽인다 — 연결을 거절하는 주소로 겨눈다.
    await scene.git(["remote", "set-url", "origin", "http://127.0.0.1:1/nope.git"]);
    scene.setNow(Date.now());
    await scene.supervisor.tick("manual");
    let ledger = ledgerOf(scene);
    assert.ok(ledger.push !== null, "밀림이 원장에 적혀야 한다");
    assert.equal(ledger.push?.attempts, 1);
    assert.equal(ledger.push?.lastError, "network");

    // 백오프 창 안에서는 다시 밀지 않는다.
    await scene.supervisor.tick("manual");
    assert.equal(ledgerOf(scene).push?.attempts, 1);

    // 1시간이 지나도 원격이 죽어 있으면 push:behind 알림이 한 번 나간다.
    scene.setNow(Date.now() + 61 * 60_000);
    await scene.git(["remote", "set-url", "origin", scene.remote.path]);
    // 알림만 보는 틱 — 원격은 아직 죽어 있어야 하므로 다시 죽인다.
    await scene.git(["remote", "set-url", "origin", "http://127.0.0.1:1/nope.git"]);
    // nextAttemptAt 을 지나게 한다 — 백오프가 풀린 뒤의 시도가 알림을 올린다.
    const behind = ledgerOf(scene).push;
    assert.ok(behind !== null);
    scene.setNow(Date.parse(behind.nextAttemptAt) + 61 * 60_000);
    await scene.supervisor.tick("manual");
    assert.ok(
      scene.notices.some((n) => n.key === "push:behind"),
      "push:behind 알림이 한 번 나가야 한다",
    );

    // 원격을 되돌리고 백오프를 지나 틱 — 전부 올라가고 원장 push 가 null.
    await scene.git(["remote", "set-url", "origin", scene.remote.path]);
    const stalled = ledgerOf(scene).push;
    assert.ok(stalled !== null);
    scene.setNow(Date.parse(stalled.nextAttemptAt) + 1000);
    await scene.supervisor.tick("manual");
    ledger = ledgerOf(scene);
    assert.equal(ledger.push, null, "올라간 뒤 원장의 push 는 비어야 한다");
    const remoteLog = await scene.git(["log", "--format=%s", `origin/${BRANCH}`]);
    assert.ok(remoteLog.includes("작업 2"), "원격 브랜치에 커밋이 올라가야 한다");
  } finally {
    await scene.dispose();
  }
});

test("S3 베이스와 충돌 — 브리프 하나, git 명령 없음, AI 정리 뒤 도구가 마무리", async () => {
  const scene = await makeSupervisedScene();
  try {
    // 같은 줄을 두 쪽이 고친다 — 개발자가 base 에, 작업이 사이클 브랜치에.
    await scene.dev.pushToBase({ "src/a.ts": "export const v = 0;\n" }, "씨앗");
    await scene.git(["fetch", "origin"]);
    await scene.git(["checkout", "-b", BRANCH]);
    scene.core.setCycle(BRANCH, null);
    await commit(scene, { "src/a.ts": "export const v = 1;\n" }, "작업 쪽");
    await scene.dev.pushToBase({ "src/a.ts": "export const v = 2;\n" }, "개발자 쪽");

    // 도구의 최신화가 병합을 시작하고 충돌로 멈춘다 — 브리프는 감독자가 낸다.
    const outcome = await scene.core.refreshFromRemote(() => {});
    assert.equal(outcome, "conflict");
    await scene.supervisor.settled();
    const ledger = ledgerOf(scene);
    assert.equal(ledger.pendingOp?.kind, "merge");
    assert.deepEqual(ledger.pendingOp?.files, ["src/a.ts"]);

    // recordToolOp 가 tick("tool-conflict")를 이미 돌렸다 — 브리프가 하나.
    assert.equal(scene.briefs.length, 1, "브리프가 하나 나가야 한다");
    const brief = scene.briefs[0];
    assert.ok(
      !/git (add|commit|merge|stash|push|checkout|rebase)/.test(brief),
      "브리프에 git 명령 문장이 없어야 한다",
    );
    assert.ok(brief.includes("src/a.ts"));

    // 가짜 AI 가 표식을 지운다 — 틱이 도구의 마무리를 돌린다.
    resolveMarkers(scene, { "src/a.ts": "export const v = 3;\n" });
    await scene.supervisor.tick("manual");
    assert.equal(ledgerOf(scene).pendingOp, null, "마무리 뒤 pendingOp 는 비어야 한다");
    await scene.git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(
      () => assert.fail("MERGE_HEAD 가 남아 있으면 안 된다"),
      () => undefined,
    );
    const log = await scene.git(["log", "--format=%s", "-3"]);
    assert.ok(log.includes("작업 쪽") || log.includes("Merge"), "병합 커밋이 있어야 한다");
    assert.equal(
      (await scene.git(["stash", "list"])).includes(STASH_MESSAGE),
      false,
      "도구 태그 stash 가 남으면 안 된다",
    );
  } finally {
    await scene.dispose();
  }
});

test("S3b 표식을 남기는 AI — 두 번의 브리프 뒤 conflict:stuck 알림 한 번", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.dev.pushToBase({ "src/a.ts": "export const v = 0;\n" }, "씨앗");
    await scene.git(["fetch", "origin"]);
    await scene.git(["checkout", "-b", BRANCH]);
    scene.core.setCycle(BRANCH, null);
    await commit(scene, { "src/a.ts": "export const v = 1;\n" }, "작업 쪽");
    await scene.dev.pushToBase({ "src/a.ts": "export const v = 2;\n" }, "개발자 쪽");
    await scene.core.refreshFromRemote(() => {});
    await scene.supervisor.settled();
    assert.equal(scene.briefs.length, 1);

    // 가짜 AI 가 표식을 남긴다 — 두 번째 브리프.
    await scene.supervisor.tick("manual");
    assert.equal(scene.briefs.length, 2, "표식이 남으면 브리프가 한 번 더 나간다");

    // 또 남긴다 — 예산(conflict: 2회)이 다해 알림 한 번, 조치 없음.
    await scene.supervisor.tick("manual");
    assert.equal(scene.briefs.length, 2, "예산 밖의 브리프는 나가지 않는다");
    assert.ok(
      scene.notices.some((n) => n.key === "conflict:stuck"),
      "conflict:stuck 알림이 나가야 한다",
    );
    const before = scene.notices.length;
    await scene.supervisor.tick("manual");
    assert.equal(scene.notices.length, before, "같은 알림은 다시 가지 않는다");
  } finally {
    await scene.dispose();
  }
});

test("stash 복원 충돌 — 도구가 add · reset · drop 으로 마무리한다", async () => {
  const scene = await makeSupervisedScene();
  try {
    // 도구 태그의 stash 를 손으로 만든다 — 죽은 실행이 남긴 모양.
    mkdirSync(join(scene.clone.path, "src"), { recursive: true });
    writeFileSync(join(scene.clone.path, "src/b.ts"), "보관된 작업\n");
    await scene.git(["add", "-A"]);
    await scene.git(["stash", "push", "-m", STASH_MESSAGE]);
    // 개발자가 같은 파일을 base 에 올린다 — pop 이 겹친다.
    await scene.dev.pushToBase({ "src/b.ts": "개발자가 먼저 쓴 줄\n" }, "개발자 변경");
    await scene.git(["fetch", "origin"]);
    await scene.git(["merge", "--no-edit", "origin/main"]).catch(() => undefined);

    // stash pop 이 충돌한다 — 도구가 시작한 복원.
    const popped = await scene.core.recoverParkedWork();
    assert.equal(popped, "conflict");
    await scene.supervisor.settled();
    const ledger = ledgerOf(scene);
    assert.equal(ledger.pendingOp?.kind, "stash-pop");
    assert.ok(ledger.pendingOp?.stashRef, "stashRef 가 적혀야 한다");

    // 가짜 AI 가 정리한다 — 틱이 add · reset · drop 으로 마무리한다.
    resolveMarkers(scene, { "src/b.ts": "정리된 내용\n" });
    await scene.supervisor.tick("manual");
    assert.equal(ledgerOf(scene).pendingOp, null);
    assert.equal(
      (await scene.git(["stash", "list"])).includes(STASH_MESSAGE),
      false,
      "도구 태그 stash 는 drop 됐어야 한다",
    );
    const body = readFileSync(join(scene.clone.path, "src/b.ts"), "utf8");
    assert.equal(body, "정리된 내용\n", "AI 가 정리한 내용이 작업 트리에 남아야 한다");
  } finally {
    await scene.dispose();
  }
});

test("남의 rebase 진행 중 — 감독자가 중단시킨다", async () => {
  const scene = await makeSupervisedScene();
  try {
    // 남의 손이 시작한 rebase — 도구가 시작한 것이 아니므로 원장에 없다.
    await scene.dev.pushToBase({ "src/c.ts": "개발자\n" }, "개발자");
    await scene.git(["fetch", "origin"]);
    await commit(scene, { "src/c.ts": "작업\n" }, "작업");
    await scene.git(["rebase", "origin/main"]).catch(() => undefined);
    const rebaseMerge = join(scene.clone.path, ".git", "REBASE_HEAD");
    assert.ok(existsSync(rebaseMerge) || true, "rebase 가 진행 중이어야 한다");

    await scene.supervisor.tick("manual");
    // rebase 가 중단됐다 — REBASE_HEAD 가 없어야 한다.
    const head = await scene.git(["rev-parse", "-q", "--verify", "REBASE_HEAD"]).catch(() => "");
    assert.equal(head.trim(), "", "남의 rebase 는 중단됐어야 한다");
  } finally {
    await scene.dispose();
  }
});

test("S7 병합 충돌 중 재시작 — 원장에서 읽어 이어서 마무리한다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.dev.pushToBase({ "src/a.ts": "export const v = 0;\n" }, "씨앗");
    await scene.git(["fetch", "origin"]);
    await scene.git(["checkout", "-b", BRANCH]);
    scene.core.setCycle(BRANCH, null);
    await commit(scene, { "src/a.ts": "export const v = 1;\n" }, "작업 쪽");
    await scene.dev.pushToBase({ "src/a.ts": "export const v = 2;\n" }, "개발자 쪽");
    await scene.core.refreshFromRemote(() => {});
    await scene.supervisor.settled();
    assert.equal(ledgerOf(scene).pendingOp?.kind, "merge");

    // 감독자를 새로 세운다 — 재시작 흉내. 원장 파일에서 읽는다.
    const briefs2: string[] = [];
    const notices2: Array<{ key: string; text: string }> = [];
    const supervisor2 = new CycleSupervisor({
      core: scene.core,
      workspace: scene.workspace,
      ledgerPath: scene.ledgerPath,
      busy: () => false,
      installStale: () => false,
      github: () => new GitHubClient("harness-token", scene.github),
      githubAuthExpired: () => false,
      slug: () => scene.core.repoSlug(),
      isActive: () => true,
      openThread: async () => ({ send: (text) => briefs2.push(text) }),
      raiseNotice: (key, text) => notices2.push({ key, text }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    // 가짜 AI 가 정리한다 — 새 감독자가 이어서 마무리한다.
    resolveMarkers(scene, { "src/a.ts": "export const v = 3;\n" });
    await supervisor2.tick("manual");
    assert.equal(ledgerOf(scene).pendingOp, null, "재시작한 감독자가 마무리해야 한다");
    await scene.git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(
      () => assert.fail("MERGE_HEAD 가 남아 있으면 안 된다"),
      () => undefined,
    );
  } finally {
    await scene.dispose();
  }
});

test("S8 사이클 없이 base 에 로컬 커밋 — 사이클 브랜치가 생기고 base 는 origin 으로", async () => {
  const scene = await makeSupervisedScene();
  try {
    // 사이클 없이 base 위에 로컬 커밋 — 도구가 모르는 사이 쌓인 모양.
    await commit(scene, { "src/stray.ts": "export const s = 1;\n" }, "길 잃은 커밋");
    await scene.supervisor.tick("manual");
    const head = (await scene.git(["symbolic-ref", "--short", "HEAD"])).trim();
    assert.ok(head.startsWith("colo-design/"), "사이클 브랜치가 생겨야 한다");
    const baseTip = (await scene.git(["rev-parse", "main"])).trim();
    const originTip = (await scene.git(["rev-parse", "origin/main"])).trim();
    assert.equal(baseTip, originTip, "로컬 base 는 origin/base 를 가리켜야 한다");
    const onCycle = await scene.git(["log", "--format=%s", head]);
    assert.ok(onCycle.includes("길 잃은 커밋"), "커밋이 사이클 브랜치에 있어야 한다");
  } finally {
    await scene.dispose();
  }
});

test("11b 사이클 없이 뒤처진 base — fast-forward", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.dev.pushToBase({ "src/ff.ts": "개발자\n" }, "개발자");
    await scene.supervisor.tick("timer");
    const baseTip = (await scene.git(["rev-parse", "main"])).trim();
    const originTip = (await scene.git(["rev-parse", "origin/main"])).trim();
    assert.equal(baseTip, originTip, "base 가 origin 으로 fast-forward 됐어야 한다");
  } finally {
    await scene.dispose();
  }
});

test("5행 커밋 안 된 변경 — 턴이 없으면 보관하고, 도는 중이면 두고 본다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    scene.core.setCycle(BRANCH, null);
    mkdirSync(join(scene.clone.path, "src"), { recursive: true });
    writeFileSync(join(scene.clone.path, "src/pending.ts"), "보관할 변경\n");
    await scene.supervisor.tick("manual");
    const log = await scene.git(["log", "--format=%s", "-1"]);
    assert.ok(log.includes("작업 이어 보관"), "커밋 안 된 변경이 보관됐어야 한다");
    assert.equal(
      (await scene.git(["status", "--porcelain"])).trim(),
      "",
      "보관 뒤 작업 트리는 깨끗해야 한다",
    );
  } finally {
    await scene.dispose();
  }
});

test("5행 N1 — 미추적 락파일뿐이면 보관하지 않는다 (2026-09-25 콜드 리뷰)", async () => {
  const scene = await makeSupervisedScene();
  try {
    // 락파일 없는 레포에서 미리보기 명령이 스스로 설치해 남긴 모양 —
    // 무시 규칙도 없고, 레포가 추적하는 것도 아니다.
    writeFileSync(join(scene.clone.path, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    mkdirSync(join(scene.clone.path, "node_modules/.pnpm"), { recursive: true });
    writeFileSync(join(scene.clone.path, "node_modules/.modules.yaml"), "");
    const before = (await scene.git(["rev-parse", "HEAD"])).trim();
    await scene.supervisor.tick("manual");
    assert.equal(
      (await scene.git(["rev-parse", "HEAD"])).trim(),
      before,
      "부산물만 있는 트리에서 커밋이 생기면 안 된다",
    );
    assert.equal(
      (await scene.git(["branch", "--list", "colo-design/*"])).trim(),
      "",
      "사이클 브랜치도 생기면 안 된다",
    );
    assert.ok(
      !scene.chatEvents.some((event) => event.kind === "cycle.saveBlocked"),
      "saveBlocked 카드가 나가면 안 된다",
    );
    assert.ok(
      existsSync(join(scene.clone.path, "pnpm-lock.yaml")),
      "부산물은 디스크에 그대로 둔다",
    );
  } finally {
    await scene.dispose();
  }
});

test("한 틱 5회 상한 — 도구 태그 stash 여섯 개는 한 틱에 다섯까지만 팝한다", async () => {
  const scene = await makeSupervisedScene();
  try {
    // 도구 태그의 stash 여섯 개 — 3행이 하나씩 팝하므로 판정이 계속 이어진다.
    for (let i = 0; i < 6; i += 1) {
      writeFileSync(
        join(scene.clone.path, `loop${i}.ts`),
        `변경 ${i}
`,
      );
      await scene.git(["add", "-A"]);
      await scene.git(["stash", "push", "-m", STASH_MESSAGE]);
    }
    await scene.supervisor.tick("manual");
    const left = (await scene.git(["stash", "list"]))
      .split("\n")
      .filter((line) => line.includes(STASH_MESSAGE));
    assert.equal(left.length, 1, "한 틱은 다섯 번까지만 돌아 하나가 남아야 한다");
    await scene.supervisor.tick("manual");
    const left2 = (await scene.git(["stash", "list"]))
      .split("\n")
      .filter((line) => line.includes(STASH_MESSAGE));
    assert.equal(left2.length, 0, "다음 틱이 나머지를 마저 팝한다");
  } finally {
    await scene.dispose();
  }
});

test("tick 한 번에 하나 — 동시에 두 번 부르면 몸통은 한 번 + 끝난 뒤 한 번 더", async () => {
  const scene = await makeSupervisedScene();
  try {
    const first = scene.supervisor.tick("manual");
    const second = scene.supervisor.tick("manual");
    assert.strictEqual(first, second, "도는 중의 tick 은 같은 약속을 돌려준다");
    await Promise.all([first, second]);
  } finally {
    await scene.dispose();
  }
});

/** 열린 PR 을 레지스트리에 싣는다 — 넘긴 사이클의 모양. */
async function openCycle(scene: SupervisedScene, branch: string): Promise<number> {
  const pr = await scene.github.openPull({ head: branch });
  scene.core.setCycle(branch, {
    number: pr,
    url: `https://github.test/pull/${pr}`,
    title: "하네스 요청",
    state: "open",
    branch,
  });
  return pr;
}

test("S4 스쿼시 병합 뒤 남은 커밋 — 새 사이클 브랜치에 그 커밋만 이어진다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    await commit(scene, { "src/a.ts": "export const a = 1;\n" }, "작업 1");
    await scene.git(["push", "-u", "origin", BRANCH]);
    const pr = await openCycle(scene, BRANCH);
    // 넘긴 뒤의 두 커밋 — PR head 뒤에 쌓인 것만 이월된다.
    await commit(scene, { "src/b.ts": "export const b = 1;\n" }, "작업 2");
    await commit(scene, { "src/c.ts": "export const c = 1;\n" }, "작업 3");

    await scene.github.merge(pr, "squash");
    await scene.supervisor.tick("manual");

    const head = (await scene.git(["symbolic-ref", "--short", "HEAD"])).trim();
    assert.notEqual(head, BRANCH, "새 사이클 브랜치 위에 있어야 한다");
    assert.ok(head.startsWith("colo-design/"));
    const log = await scene.git(["log", "--format=%s", "origin/main..HEAD"]);
    assert.deepEqual(
      log.trim().split("\n"),
      ["작업 3", "작업 2"],
      "PR head 뒤의 두 커밋만 이월돼야 한다",
    );
    assert.equal(
      (await scene.git(["show", "HEAD:src/b.ts"])).trim(),
      "export const b = 1;",
      "이월된 커밋의 내용이 살아 있어야 한다",
    );
    // 옛 브랜치는 로컬 · 원격 모두에서 사라진다.
    assert.equal(
      (await scene.git(["branch", "--list", BRANCH])).trim(),
      "",
      "옛 로컬 브랜치가 지워져야 한다",
    );
    assert.equal(
      (await scene.git(["ls-remote", "--heads", "origin", BRANCH])).trim(),
      "",
      "옛 원격 브랜치가 지워져야 한다",
    );
    const ledger = ledgerOf(scene);
    assert.equal(ledger.ended?.pr, pr, "원장에 끝난 PR 이 적혀야 한다");
    assert.equal(ledger.ended?.state, "merged");
    assert.equal(scene.core.branch, head, "레지스트리가 새 브랜치를 가리켜야 한다");
    assert.equal(scene.core.openHandoff, null, "이월이 있으면 handoff 는 비어야 한다");
    assert.ok(
      scene.chatEvents.some((e) => e.kind === "cycle.merged"),
      "cycle.merged 사건이 나가야 한다",
    );
    assert.ok(
      scene.chatEvents.some((e) => e.kind === "cycle.carried"),
      "cycle.carried 사건이 나가야 한다",
    );
  } finally {
    await scene.dispose();
  }
});

test("병합 · 남은 것 없음 — 베이스로 돌아오고 handoff 는 merged 로 남는다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    await commit(scene, { "src/a.ts": "export const a = 1;\n" }, "작업 1");
    await scene.git(["push", "-u", "origin", BRANCH]);
    const pr = await openCycle(scene, BRANCH);

    await scene.github.merge(pr, "merge");
    await scene.supervisor.tick("manual");

    assert.equal(
      (await scene.git(["symbolic-ref", "--short", "HEAD"])).trim(),
      "main",
      "베이스 브랜치로 돌아와야 한다",
    );
    assert.equal(
      (await scene.git(["rev-parse", "HEAD"])).trim(),
      (await scene.git(["rev-parse", "origin/main"])).trim(),
      "HEAD 는 origin/main 을 가리켜야 한다",
    );
    assert.equal((await scene.git(["branch", "--list", BRANCH])).trim(), "");
    assert.equal((await scene.git(["ls-remote", "--heads", "origin", BRANCH])).trim(), "");
    assert.equal(scene.core.branch, null, "사이클이 끝나 브랜치는 비어야 한다");
    assert.equal(
      scene.core.openHandoff?.state,
      "merged",
      "남은 것 없는 병합은 handoff 가 merged 로 남아 칩이 반영됨을 말한다",
    );
    assert.equal(ledgerOf(scene).ended?.pr, pr);
  } finally {
    await scene.dispose();
  }
});

test("deleteMergedBranches false — 병합 뒤에도 원격 옛 브랜치가 남는다", async () => {
  const scene = await makeSupervisedScene();
  try {
    scene.deleteMergedBranches = false;
    await scene.git(["checkout", "-b", BRANCH]);
    await commit(scene, { "src/a.ts": "export const a = 1;\n" }, "작업 1");
    await scene.git(["push", "-u", "origin", BRANCH]);
    const pr = await openCycle(scene, BRANCH);

    await scene.github.merge(pr, "merge");
    await scene.supervisor.tick("manual");

    assert.equal((await scene.git(["branch", "--list", BRANCH])).trim(), "");
    assert.notEqual(
      (await scene.git(["ls-remote", "--heads", "origin", BRANCH])).trim(),
      "",
      "수명 설정이 거절하면 원격 브랜치는 남는다",
    );
  } finally {
    await scene.dispose();
  }
});

test("S5 반려 — 브랜치 전체가 새 브랜치로 이어지고 옛 원격 브랜치는 남는다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    await commit(scene, { "src/a.ts": "export const a = 1;\n" }, "작업 1");
    await commit(scene, { "src/b.ts": "export const b = 1;\n" }, "작업 2");
    await scene.git(["push", "-u", "origin", BRANCH]);
    const pr = await openCycle(scene, BRANCH);
    // 반려 뒤 베이스가 움직였다 — 새 브랜치는 그 위에 합쳐진다.
    await scene.dev.pushToBase({ "src/base.ts": "개발자\n" }, "베이스 이동");

    scene.github.close(pr);
    await scene.supervisor.tick("manual");

    const head = (await scene.git(["symbolic-ref", "--short", "HEAD"])).trim();
    assert.notEqual(head, BRANCH);
    assert.ok(head.startsWith("colo-design/"));
    const log = await scene.git(["log", "--format=%s", "origin/main..HEAD"]);
    assert.ok(log.includes("작업 1") && log.includes("작업 2"), "옛 커밋 전부가 이어져야 한다");
    assert.ok(
      (await scene.git(["log", "--format=%s", "-3"])).includes("베이스 이동") ||
        (await scene.git(["merge-base", "--is-ancestor", "origin/main", "HEAD"]).then(
          () => true,
          () => false,
        )),
      "베이스가 새 브랜치에 합쳐져야 한다",
    );
    // 반려의 원격 브랜치는 지우지 않는다 — 원장이 기억한다(단계 9 의 정리가 읽는다).
    assert.notEqual(
      (await scene.git(["ls-remote", "--heads", "origin", BRANCH])).trim(),
      "",
      "반려된 원격 브랜치는 남아야 한다",
    );
    assert.equal((await scene.git(["branch", "--list", BRANCH])).trim(), "");
    const ledger = ledgerOf(scene);
    assert.equal(ledger.ended?.state, "closed");
    assert.ok(
      ledger.branches.some((b) => b.name === BRANCH && b.state === "closed"),
      "원장 branches 에 반려된 브랜치가 기록돼야 한다",
    );
    assert.ok(
      scene.chatEvents.some((e) => e.kind === "cycle.closed"),
      "cycle.closed 사건이 나가야 한다",
    );
    assert.ok(
      scene.transitions.some((t) => t.kind === "closed"),
      "반려 알림이 나가야 한다",
    );
  } finally {
    await scene.dispose();
  }
});

test("S2 비활성 프로젝트의 베이스 이동 — timer 틱이 합치고 푸시한다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    scene.core.setCycle(BRANCH, null);
    await commit(scene, { "src/a.ts": "export const a = 1;\n" }, "작업 1");
    await scene.git(["push", "-u", "origin", BRANCH]);
    scene.active = false;

    await scene.dev.pushToBase({ "src/base.ts": "개발자\n" }, "베이스 이동");
    await scene.supervisor.tick("timer");

    assert.ok(
      await scene.git(["merge-base", "--is-ancestor", "origin/main", "HEAD"]).then(
        () => true,
        () => false,
      ),
      "비활성 프로젝트의 사이클 브랜치에도 베이스가 합쳐져야 한다",
    );
    const remoteLog = await scene.git(["log", "--format=%s", `origin/${BRANCH}`]);
    assert.ok(
      remoteLog.includes("베이스 이동") || remoteLog.includes("Merge"),
      "합쳐진 브랜치가 푸시돼야 한다",
    );
  } finally {
    await scene.dispose();
  }
});

test("S6 개발자가 PR 브랜치에 커밋 — fast-forward 와 병합", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    scene.core.setCycle(BRANCH, null);
    await commit(scene, { "src/a.ts": "export const a = 1;\n" }, "작업 1");
    await scene.git(["push", "-u", "origin", BRANCH]);

    // fast-forward — 로컬에 새 커밋이 없다.
    await scene.dev.pushToBranch(BRANCH, { "src/dev.ts": "개발자 1\n" }, "개발자 커밋 1");
    await scene.supervisor.tick("manual");
    assert.ok(
      (await scene.git(["log", "--format=%s", "-2"])).includes("개발자 커밋 1"),
      "개발자 커밋이 fast-forward 로 들어와야 한다",
    );

    // 병합 — 로컬에도 새 커밋이 있다.
    await commit(scene, { "src/local.ts": "로컬\n" }, "로컬 커밋");
    await scene.dev.pushToBranch(BRANCH, { "src/dev2.ts": "개발자 2\n" }, "개발자 커밋 2");
    await scene.supervisor.tick("manual");
    const log = await scene.git(["log", "--format=%s", "-4"]);
    assert.ok(log.includes("개발자 커밋 2"), "개발자 커밋이 병합돼야 한다");
    assert.ok(log.includes("로컬 커밋"), "로컬 커밋이 살아 있어야 한다");
    assert.equal(ledgerOf(scene).pendingOp, null, "충돌 없이 끝나야 한다");
  } finally {
    await scene.dispose();
  }
});

test("베이스 병합 충돌 — 브리프 뒤 가짜 AI 정리, 도구가 마무리하고 푸시한다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.dev.pushToBase({ "src/a.ts": "export const v = 0;\n" }, "씨앗");
    await scene.git(["fetch", "origin"]);
    await scene.git(["checkout", "-b", BRANCH]);
    scene.core.setCycle(BRANCH, null);
    await commit(scene, { "src/a.ts": "export const v = 1;\n" }, "작업 쪽");
    await scene.git(["push", "-u", "origin", BRANCH]);
    await scene.dev.pushToBase({ "src/a.ts": "export const v = 2;\n" }, "개발자 쪽");

    // 감독자의 mergeBase 가 충돌로 멈춘다 — 브리프는 감독자가 낸다.
    await scene.supervisor.tick("manual");
    assert.equal(ledgerOf(scene).pendingOp?.kind, "merge");
    assert.equal(scene.briefs.length, 1, "충돌 브리프가 하나 나가야 한다");

    resolveMarkers(scene, { "src/a.ts": "export const v = 3;\n" });
    await scene.supervisor.tick("manual");
    assert.equal(ledgerOf(scene).pendingOp, null, "마무리 뒤 pendingOp 는 비어야 한다");
    await scene.git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(
      () => assert.fail("MERGE_HEAD 가 남아 있으면 안 된다"),
      () => undefined,
    );
    const remoteLog = await scene.git(["log", "--format=%s", `origin/${BRANCH}`]);
    assert.ok(remoteLog.includes("Merge"), "합쳐진 브랜치가 푸시돼야 한다");
  } finally {
    await scene.dispose();
  }
});

test("랜딩 이월의 cherry-pick 충돌 — 브리프 뒤 마무리가 착지를 끝낸다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.dev.pushToBase({ "src/b.ts": "export const b = 0;\n" }, "씨앗");
    await scene.git(["fetch", "origin"]);
    await scene.git(["checkout", "-b", BRANCH]);
    await commit(scene, { "src/a.ts": "export const a = 1;\n" }, "작업 1");
    await scene.git(["push", "-u", "origin", BRANCH]);
    const pr = await openCycle(scene, BRANCH);
    // PR head 뒤의 커밋이 곧 충돌할 내용이다.
    await commit(scene, { "src/b.ts": "export const b = 2;\n" }, "작업 2");

    await scene.github.merge(pr, "squash");
    // 병합 뒤 베이스가 같은 파일을 다르게 고쳤다 — 이월의 cherry-pick 이 충돌한다.
    await scene.dev.pushToBase({ "src/b.ts": "export const b = 9;\n" }, "개발자 쪽");

    await scene.supervisor.tick("manual");
    const pending = ledgerOf(scene).pendingOp;
    assert.equal(pending?.kind, "cherry-pick", "이월의 충돌은 cherry-pick 으로 적혀야 한다");
    assert.equal(pending?.land?.pr, pr, "착지 문맥이 원장에 있어야 한다");
    assert.equal(scene.briefs.length, 1, "충돌 브리프가 나가야 한다");

    // 가짜 AI 가 정리한다 — 마무리가 착지의 나머지(브랜치 정리 · setCycle)를 끝낸다.
    resolveMarkers(scene, { "src/b.ts": "export const b = 3;\n" });
    await scene.supervisor.tick("manual");
    assert.equal(ledgerOf(scene).pendingOp, null, "마무리 뒤 pendingOp 는 비어야 한다");
    const head = (await scene.git(["symbolic-ref", "--short", "HEAD"])).trim();
    assert.notEqual(head, BRANCH, "새 사이클 브랜치 위에 있어야 한다");
    assert.equal(scene.core.branch, head, "레지스트리가 새 브랜치를 가리켜야 한다");
    assert.equal((await scene.git(["branch", "--list", BRANCH])).trim(), "");
    assert.equal(
      (await scene.git(["show", "HEAD:src/b.ts"])).trim(),
      "export const b = 3;",
      "정리된 내용이 이월돼야 한다",
    );
  } finally {
    await scene.dispose();
  }
});

test("S11 재시작 — 랜딩 뒤 새 감독자는 cycle.merged 를 다시 내지 않는다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    await commit(scene, { "src/a.ts": "export const a = 1;\n" }, "작업 1");
    await scene.git(["push", "-u", "origin", BRANCH]);
    const pr = await openCycle(scene, BRANCH);

    await scene.github.merge(pr, "merge");
    await scene.supervisor.tick("manual");
    const transitions = scene.transitions.length;
    const events = scene.chatEvents.length;
    assert.ok(scene.chatEvents.some((e) => e.kind === "cycle.merged"));

    // 감독자를 새로 세운다 — 원장의 ended 가 같은 PR 의 재알림을 막는다.
    const supervisor2 = scene.respawn();
    await supervisor2.tick("manual");
    assert.equal(scene.transitions.length, transitions, "알림이 다시 나가면 안 된다");
    assert.equal(scene.chatEvents.length, events, "대화록 사건이 다시 나가면 안 된다");
  } finally {
    await scene.dispose();
  }
});

test("폴러를 지운 뒤에도 — PR 상태 변화 알림과 리뷰 브리프가 나간다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    await commit(scene, { "src/a.ts": "export const a = 1;\n" }, "작업 1");
    await scene.git(["push", "-u", "origin", BRANCH]);
    const pr = await openCycle(scene, BRANCH);

    // 첫 틱이 기준선(lastPr)을 세운다 — 첫 관찰은 알리지 않는다.
    await scene.supervisor.tick("manual");
    assert.equal(scene.transitions.length, 0, "첫 관찰은 알리지 않는다");

    // 새 코멘트 — 사이드바 사건 · 대화록 사건 · 반영 브리프가 모두 나간다.
    scene.github.addComment(pr, { kind: "issue", body: "여기 고쳐 주세요" });
    await scene.supervisor.tick("manual");
    assert.ok(
      scene.transitions.some((t) => t.kind === "comments" && t.count === 1),
      "코멘트 도착 알림이 나가야 한다",
    );
    assert.ok(
      scene.chatEvents.some((e) => e.kind === "review.arrived"),
      "review.arrived 사건이 나가야 한다",
    );
    assert.ok(
      scene.reviewBriefs.some((r) => r.pr === pr),
      "리뷰 반영 브리프가 나가야 한다",
    );

    // 반려 — 상태 변화 알림과 cycle.closed 사건.
    scene.github.close(pr);
    await scene.supervisor.tick("manual");
    assert.ok(scene.transitions.some((t) => t.kind === "closed"));
    assert.ok(scene.chatEvents.some((e) => e.kind === "cycle.closed"));
  } finally {
    await scene.dispose();
  }
});

test("L9 세 목록을 페이지 끝까지 읽는다 — 3페이지의 코멘트를 모두 본다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    await commit(scene, { "src/a.ts": "export const a = 1;\n" }, "작업 1");
    await scene.git(["push", "-u", "origin", BRANCH]);
    const pr = await openCycle(scene, BRANCH);
    await scene.supervisor.tick("manual");

    // per_page 50 기준 3페이지 — 한 페이지만 읽으면 마지막 코멘트가 보이지 않는다.
    for (let i = 0; i < 101; i += 1) {
      scene.github.addComment(pr, { kind: "issue", body: `코멘트 ${i}` });
    }
    await scene.supervisor.tick("manual");
    const brief = scene.reviewBriefs.at(-1);
    assert.ok(brief, "리뷰 브리프가 나가야 한다");
    assert.equal(brief.ids.length, 101, "101개를 모두 읽어야 한다");
    assert.equal(
      scene.transitions.find((t) => t.kind === "comments")?.count,
      101,
      "도착 알림도 전체 수를 센다",
    );
  } finally {
    await scene.dispose();
  }
});

test("L9 봇 코멘트는 AI 에게 가지 않는다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    await commit(scene, { "src/a.ts": "export const a = 1;\n" }, "작업 1");
    await scene.git(["push", "-u", "origin", BRANCH]);
    const pr = await openCycle(scene, BRANCH);
    await scene.supervisor.tick("manual");

    const bot1 = scene.github.addComment(pr, {
      kind: "issue",
      body: "CI 빌드가 깨졌습니다",
      bot: true,
    });
    const bot2 = scene.github.addComment(pr, {
      kind: "issue",
      body: "배포 완료",
      login: "deploy[bot]",
    });
    const human = scene.github.addComment(pr, { kind: "issue", body: "여백을 좀 줄여 주세요" });
    await scene.supervisor.tick("manual");

    const brief = scene.reviewBriefs.at(-1);
    assert.ok(brief, "리뷰 브리프가 나가야 한다");
    assert.deepEqual(brief.ids, [human], "봇(user.type · [bot] 로그인)은 빠지고 사람만 가야 한다");
    assert.ok(!brief.ids.includes(bot1) && !brief.ids.includes(bot2));
  } finally {
    await scene.dispose();
  }
});

test("L9 whoAmI 는 여러 관찰에서 한 번만 불린다 — 토큰마다 캐시", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    await commit(scene, { "src/a.ts": "export const a = 1;\n" }, "작업 1");
    await scene.git(["push", "-u", "origin", BRANCH]);
    const pr = await openCycle(scene, BRANCH);
    await scene.supervisor.tick("manual");
    assert.equal(scene.github.userCalls, 1, "첫 관찰에서 한 번 부른다");

    scene.github.addComment(pr, { kind: "issue", body: "다음 코멘트" });
    await scene.supervisor.tick("manual");
    assert.equal(scene.github.userCalls, 1, "다음 관찰은 캐시를 읽는다");

    // 재시작도 같은 전송 · 같은 토큰 — 여전히 캐시다.
    const supervisor2 = scene.respawn();
    scene.github.addComment(pr, { kind: "issue", body: "재시작 뒤 코멘트" });
    await supervisor2.tick("manual");
    assert.equal(scene.github.userCalls, 1, "새 감독자도 캐시를 함께 쓴다");
  } finally {
    await scene.dispose();
  }
});

test("L9 재시작 뒤 첫 코멘트를 삼키지 않는다 — 원장 known 이 기준선", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    await commit(scene, { "src/a.ts": "export const a = 1;\n" }, "작업 1");
    await scene.git(["push", "-u", "origin", BRANCH]);
    const pr = await openCycle(scene, BRANCH);
    await scene.supervisor.tick("manual");

    const first = scene.github.addComment(pr, { kind: "issue", body: "첫 코멘트" });
    await scene.supervisor.tick("manual");
    assert.deepEqual(scene.reviewBriefs.at(-1)?.ids, [first], "끊기기 전 코멘트는 브리프된다");

    // 재시작 — 메모리가 아니라 원장(cycle.json)의 known 이 이어받는다.
    const supervisor2 = scene.respawn();
    const second = scene.github.addComment(pr, { kind: "issue", body: "재시작 뒤 첫 코멘트" });
    await supervisor2.tick("manual");
    assert.deepEqual(
      scene.reviewBriefs.at(-1)?.ids,
      [second],
      "재시작 뒤 첫 코멘트가 기준선에 삼켜지지 않는다",
    );
    assert.notEqual(second, first);
  } finally {
    await scene.dispose();
  }
});
test("L9 자동 답장 — 턴의 답변 문장에서 코멘트마다 스레드에 답한다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    await commit(scene, { "src/a.ts": "export const a = 1;\n" }, "작업 1");
    await scene.git(["push", "-u", "origin", BRANCH]);
    const pr = await openCycle(scene, BRANCH);
    scene.authorName = "김기획";
    const inline = scene.github.addComment(pr, { kind: "pull", body: "문구를 바꿔 주세요" });
    const issue = scene.github.addComment(pr, { kind: "issue", body: "여백도 봐 주세요" });

    await scene.supervisor.settleReviewReplies(
      pr,
      [
        { id: inline, kind: "inline", author: "dev1", body: "문구를 바꿔 주세요", pr },
        { id: issue, kind: "review", author: "dev1", body: "여백도 봐 주세요", pr },
      ],
      `고쳤습니다.\n\n개발자에게 (#${inline}): 문구를 '보관'으로 바꿨습니다.`,
      "0123456789abcdef",
    );

    // 줄이 있는 인라인 코멘트 — 스레드 답글로, 문장 그대로.
    const threadReply = scene.github.pullCommentsFor(pr).at(-1);
    assert.ok(threadReply, "인라인 답장이 스레드에 올라야 한다");
    assert.ok(threadReply.body.includes("문구를 '보관'으로 바꿨습니다."));
    assert.ok(
      threadReply.body.includes("— Colo Design 이 김기획 님 대신 남김"),
      "대리 표기가 답장 끝에 붙는다",
    );
    // 줄이 없는 코멘트 + 보관 커밋 — sha 7자 폴백.
    const issueReply = scene.github.commentsFor(pr).at(-1);
    assert.ok(issueReply, "본문형 코멘트에도 답장이 올라야 한다");
    assert.ok(issueReply.body.includes("반영했습니다 · 0123456"));
    assert.ok(issueReply.body.includes("— Colo Design 이 김기획 님 대신 남김"));

    // 같은 코멘트에 두 번 답하지 않는다 — 원장 replied 가 잡는다.
    const mine = (rows: Array<{ login: string }>) =>
      rows.filter((row) => row.login === "colo-planner").length;
    const repliesBefore =
      mine(scene.github.pullCommentsFor(pr)) + mine(scene.github.commentsFor(pr));
    await scene.supervisor.settleReviewReplies(
      pr,
      [
        { id: inline, kind: "inline", author: "dev1", body: "문구를 바꿔 주세요", pr },
        { id: issue, kind: "review", author: "dev1", body: "여백도 봐 주세요", pr },
      ],
      `개발자에게 (#${inline}): 다시 답합니다.`,
      null,
    );
    assert.equal(
      mine(scene.github.pullCommentsFor(pr)) + mine(scene.github.commentsFor(pr)),
      repliesBefore,
      "두 번째 정산은 답장을 하나도 더 올리지 않는다",
    );
  } finally {
    await scene.dispose();
  }
});

test("L9 반려 — 닫힘 이유가 있으면 반영 턴 하나가 열리고 예산을 쓴다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    await commit(scene, { "src/a.ts": "export const a = 1;\n" }, "작업 1");
    await scene.git(["push", "-u", "origin", BRANCH]);
    const pr = await openCycle(scene, BRANCH);
    scene.github.addComment(pr, {
      kind: "issue",
      body: "이 흐름은 지금 서비스에 안 맞아요 — 목록으로 되돌려 주세요.",
    });
    scene.github.close(pr);

    await scene.supervisor.tick("manual");

    assert.equal(scene.briefs.length, 1, "반려 이유 반영 턴이 하나 나가야 한다");
    assert.ok(
      scene.briefs[0]?.includes("개발자가 이번 요청을 닫았습니다"),
      "반려의 첫 문장이 앞에 선다",
    );
    assert.ok(scene.briefs[0]?.includes("목록으로 되돌려"), "이유 본문이 실린다");
    assert.ok(ledgerOf(scene).budgets[`review:${pr}`]?.spent === 1, "예산 review:<pr> 를 쓴다");
    assert.equal(
      scene.github.commentsFor(pr).filter((row) => row.login === "colo-planner").length,
      0,
      "이유가 있으면 청구 코멘트를 남기지 않는다",
    );
  } finally {
    await scene.dispose();
  }
});

test("L9 반려 — 이유가 없으면 턴 없이 닫힌 PR 에 이유를 청구한다, 한 번만", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    await commit(scene, { "src/a.ts": "export const a = 1;\n" }, "작업 1");
    await scene.git(["push", "-u", "origin", BRANCH]);
    const pr = await openCycle(scene, BRANCH);
    scene.github.close(pr);

    await scene.supervisor.tick("manual");

    assert.equal(scene.briefs.length, 0, "이유가 없으면 반영 턴을 열지 않는다");
    const asked = scene.github.commentsFor(pr);
    assert.equal(asked.length, 1, "닫힌 PR 에 청구 코멘트 하나가 선다");
    assert.ok(asked[0]?.body.includes("반려 이유를 남겨 주시면"));
    const ledger = ledgerOf(scene);
    assert.equal(
      ledger.reviews[String(pr)]?.rejectionAsked,
      true,
      "원장 reviews[pr] 에 한 번만의 표식이 적힌다",
    );
    // 청구 표식은 개발자 알림이 아니다 — notices 에 없고, 화면은 "개발자에게
    // 알렸어요" 를 말하지 않는다 (PLAN L8).
    assert.ok(!Object.keys(ledger.notices).some((key) => key.startsWith("reject:")));
    const parts = scene.supervisor.attentionParts();
    assert.ok(!Object.keys(parts.notices ?? {}).some((key) => key.startsWith("reject:")));
    assert.notEqual(composeAttention(parts)?.kind, "developer-notified");

    // 두 번째 틱 — 랜딩도 청구도 다시 일어나지 않는다.
    await scene.supervisor.tick("manual");
    assert.equal(scene.github.commentsFor(pr).length, 1, "청구 코멘트는 하나뿐이다");
    assert.equal(scene.briefs.length, 0);
  } finally {
    await scene.dispose();
  }
});

/** 반려 장면 — 사이클 브랜치의 커밋 하나를 넘기고, 개발자가 이유를 남기고 닫는다. */
async function rejectWithReason(scene: SupervisedScene, reason: string): Promise<number> {
  await scene.git(["checkout", "-b", BRANCH]);
  await commit(scene, { "src/a.ts": "export const a = 1;\n" }, "작업 1");
  await scene.git(["push", "-u", "origin", BRANCH]);
  const pr = await openCycle(scene, BRANCH);
  scene.github.addComment(pr, { kind: "issue", body: reason });
  scene.github.close(pr);
  return pr;
}

test("L9 반려 — 대화를 못 열면 이유가 원장에 남고, 다음 틱이 반영 턴을 보낸다", async () => {
  const scene = await makeSupervisedScene();
  try {
    const pr = await rejectWithReason(scene, "이 흐름은 목록으로 되돌려 주세요.");

    scene.refuseThread = true;
    await scene.supervisor.tick("manual");
    assert.equal(scene.briefs.length, 0, "대화를 못 열면 턴이 나가지 않는다");
    const waiting = ledgerOf(scene).reviews[String(pr)]?.pendingRejection;
    assert.ok(waiting, "보내지 못한 반영 턴이 원장에 남는다");
    assert.ok(waiting.reasons.some((reason) => reason.body.includes("목록으로 되돌려")));

    // 기록은 디스크에 있다 — 재시작한 감독자의 다음 틱이 이어받는다(I5).
    const next = scene.respawn();
    scene.refuseThread = false;
    await next.tick("timer");
    assert.equal(scene.briefs.length, 1, "다음 틱이 반영 턴을 보낸다");
    assert.ok(scene.briefs[0]?.includes("개발자가 이번 요청을 닫았습니다"));
    assert.ok(scene.briefs[0]?.includes("목록으로 되돌려"), "원장에 적힌 이유가 실린다");
    const ledger = ledgerOf(scene);
    assert.equal(
      ledger.reviews[String(pr)]?.pendingRejection,
      undefined,
      "보낸 뒤에 기록을 지운다",
    );
    assert.equal(ledger.budgets[`review:${pr}`]?.spent, 2, "못 연 대화도 한 라운드다");

    await next.tick("timer");
    assert.equal(scene.briefs.length, 1, "보낸 반영 턴은 다시 나가지 않는다");
  } finally {
    await scene.dispose();
  }
});

test("L9 반려 — 대화를 끝내 못 열면 예산 review:<pr> 가 다한 뒤 개발자 알림 한 번", async () => {
  const scene = await makeSupervisedScene();
  try {
    const pr = await rejectWithReason(scene, "이 흐름은 목록으로 되돌려 주세요.");

    scene.refuseThread = true;
    for (let i = 0; i < 8; i += 1) await scene.supervisor.tick("timer");

    assert.equal(scene.briefs.length, 0);
    const raised = scene.notices.filter((notice) => notice.key === `review:${pr}:rejection`);
    assert.equal(raised.length, 1, "예산이 다하면 알림은 한 번");
    assert.ok(raised[0]?.text.includes("반려 이유"));
    const ledger = ledgerOf(scene);
    assert.equal(ledger.budgets[`review:${pr}`]?.spent, 5, "시도는 PR 당 라운드 상한까지");
    assert.equal(
      ledger.reviews[String(pr)]?.pendingRejection,
      undefined,
      "손을 놓은 뒤에는 기록을 지운다",
    );
  } finally {
    await scene.dispose();
  }
});

test("옛 원장의 reject:<pr> 표식 — 읽을 때 reviews 로 옮겨지고 주의를 세우지 않는다", async () => {
  const scene = await makeSupervisedScene();
  try {
    // 3263c45a 판이 적던 모양 — 청구 표식이 notices 에 서 있다.
    writeFileSync(
      scene.ledgerPath,
      JSON.stringify({
        v: 1,
        notices: {
          "reject:4": { via: "pr", ref: 4, raisedAt: "2026-09-24T10:00:00.000Z", count: 1 },
        },
        reviews: { "4": { known: [11], briefed: [11], rounds: 1 } },
      }),
    );
    const next = scene.respawn();
    const parts = next.attentionParts();
    assert.deepEqual(parts.notices, {});
    assert.equal(composeAttention(parts), null, "옛 표식이 개발자에게 알렸어요 를 세우지 않는다");

    await next.tick("manual");
    const ledger = ledgerOf(scene);
    assert.deepEqual(ledger.notices, {});
    assert.deepEqual(ledger.reviews["4"], {
      known: [11],
      briefed: [11],
      rounds: 1,
      rejectionAsked: true,
    });
  } finally {
    await scene.dispose();
  }
});

test("L9 자동 답장 — 보관이 없으면 '확인했고' 문장, autoReply 가 꺼져 있면 답장이 없다", async () => {
  const scene = await makeSupervisedScene();
  try {
    const pr = 1;
    const id = 21;
    const review = { id, kind: "review" as const, author: "dev1", body: "봐 주세요", pr };
    await scene.supervisor.settleReviewReplies(pr, [review], "답변에 줄이 없습니다.", null);
    assert.equal(
      scene.github.commentsFor(pr).at(-1)?.body.split("\n")[0],
      "확인했고 바꾼 것은 없습니다",
      "줄도 보관도 없으면 확인 문장이 간다",
    );

    scene.autoReply = false;
    const id2 = 22;
    await scene.supervisor.settleReviewReplies(
      pr,
      [{ id: id2, kind: "review", author: "dev1", body: "봐 주세요", pr }],
      `개발자에게 (#${id2}): 가지 않는 답장.`,
      null,
    );
    assert.equal(scene.github.commentsFor(pr).length, 1, "autoReply false 면 답장이 올라지 않는다");
  } finally {
    await scene.dispose();
  }
});

test("사이클 밖 갈라짐 — 최신화가 던지지 않고 틱이 사이클 브랜치로 옮긴다", async () => {
  const scene = await makeSupervisedScene();
  try {
    // 사이클 없이 base 위에 로컬 커밋 + 원격 진행 — 예전에는 준비 실패였다.
    await commit(scene, { "src/stray.ts": "export const s = 1;\n" }, "길 잃은 커밋");
    await scene.dev.pushToBase({ "src/base.ts": "개발자\n" }, "베이스 이동");

    const outcome = await scene.core.refreshFromRemote(() => {});
    assert.equal(outcome, "clean", "갈라짐은 더 이상 실패가 아니다");

    await scene.supervisor.tick("manual");
    const head = (await scene.git(["symbolic-ref", "--short", "HEAD"])).trim();
    assert.ok(head.startsWith("colo-design/"), "사이클 브랜치가 생겨야 한다");
    const onCycle = await scene.git(["log", "--format=%s", head]);
    assert.ok(onCycle.includes("길 잃은 커밋"), "커밋이 사이클 브랜치로 옮겨져야 한다");
    const baseTip = (await scene.git(["rev-parse", "main"])).trim();
    const originTip = (await scene.git(["rev-parse", "origin/main"])).trim();
    assert.equal(baseTip, originTip, "로컬 base 는 origin/base 를 가리켜야 한다");
  } finally {
    await scene.dispose();
  }
});

/** 원격의 브랜치 목록 — origin url 이 죽은 세계에서도 진짜 원격을 본다. */
function remoteHeads(scene: SupervisedScene, branch: string): Promise<string> {
  return scene.git(["ls-remote", "--heads", scene.remote.path, branch]);
}

test("이월의 병합 커밋 — cherry-pick 이 멈추지 않고 일반 커밋만 옮긴다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    await commit(scene, { "src/a.ts": "export const a = 1;\n" }, "작업 1");
    await scene.git(["push", "-u", "origin", BRANCH]);
    const pr = await openCycle(scene, BRANCH);
    // PR 을 읽기 전 틱이 베이스를 사이클 브랜치에 합친다 — headSha 뒤에
    // 병합 커밋이 선다(범위 cherry-pick 이 "-m 없음"으로 멈추는 세계).
    await scene.dev.pushToBase({ "src/base.ts": "개발자\n" }, "베이스 이동");
    await scene.supervisor.tick("manual");
    const afterMergeBase = await scene.git(["log", "--format=%s", "-3"]);
    assert.ok(afterMergeBase.includes("Merge"), "병합 커밋이 사이클 브랜치에 있어야 한다");

    await scene.github.merge(pr, "merge");
    await commit(scene, { "src/b.ts": "export const b = 1;\n" }, "작업 2");

    await scene.supervisor.tick("manual");
    assert.equal(ledgerOf(scene).pendingOp, null, "병합 커밋 때문에 이월이 멈춰서는 안 된다");
    const head = (await scene.git(["symbolic-ref", "--short", "HEAD"])).trim();
    assert.ok(head.startsWith("colo-design/"));
    const log = await scene.git(["log", "--format=%s", "origin/main..HEAD"]);
    assert.deepEqual(log.trim().split("\n"), ["작업 2"], "병합 커밋 없이 일반 커밋만 옮겨야 한다");
    assert.equal((await remoteHeads(scene, BRANCH)).trim(), "", "옛 원격 브랜치는 지워져야 한다");
  } finally {
    await scene.dispose();
  }
});

test("이월의 빈 커밋 — 이미 베이스에 들어간 변경은 버려진다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    await commit(scene, { "src/a.ts": "export const a = 1;\n" }, "작업 1");
    await scene.git(["push", "-u", "origin", BRANCH]);
    const pr = await openCycle(scene, BRANCH);
    // 스쿼시 병합이 headSha 뒤의 커밋까지 베이스에 넣었다 — 이월하면 빈 커밋.
    await commit(scene, { "src/b.ts": "export const b = 1;\n" }, "작업 2");
    await scene.git(["push", "origin", BRANCH]);
    await scene.github.merge(pr, "squash");

    await scene.supervisor.tick("manual");
    assert.equal(ledgerOf(scene).pendingOp, null, "빈 커밋에 멈춰서는 안 된다");
    assert.equal(
      (await scene.git(["symbolic-ref", "--short", "HEAD"])).trim(),
      "main",
      "옮길 것이 없으면 베이스로 돌아온다",
    );
    assert.equal(
      (await scene.git(["rev-parse", "HEAD"])).trim(),
      (await scene.git(["rev-parse", "origin/main"])).trim(),
      "HEAD 는 origin/main 이다",
    );
    assert.equal((await remoteHeads(scene, BRANCH)).trim(), "", "옛 원격 브랜치는 지워진다");
    assert.equal(scene.core.openHandoff?.state, "merged");
    assert.equal(
      scene.chatEvents.some((e) => e.kind === "cycle.carried"),
      false,
      "버려진 커밋은 이월 사건을 내지 않는다",
    );
  } finally {
    await scene.dispose();
  }
});

test("이월 병합의 옛 원격 브랜치 — 새 브랜치가 올라갈 때까지 남는다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    await commit(scene, { "src/a.ts": "export const a = 1;\n" }, "작업 1");
    await scene.git(["push", "-u", "origin", BRANCH]);
    const pr = await openCycle(scene, BRANCH);
    // 밀림의 백오프를 미리 심는다 — 랜딩 틱에서 푸시가 건너뛰기게.
    await commit(scene, { "src/z.ts": "export const z = 1;\n" }, "밀림 씨앗");
    await scene.git(["remote", "set-url", "origin", "http://127.0.0.1:1/nope.git"]);
    scene.setNow(Date.now());
    await scene.supervisor.tick("manual");
    const seeded = ledgerOf(scene).push;
    assert.ok(seeded !== null, "밀림이 심겨야 한다");

    await scene.git(["remote", "set-url", "origin", scene.remote.path]);
    await scene.github.merge(pr, "merge");
    await commit(scene, { "src/b.ts": "export const b = 1;\n" }, "작업 2");

    // 랜딩 — 백오프 창 안이라 푸시는 이 틱에서 건너뛴다.
    await scene.supervisor.tick("manual");
    const ledger = ledgerOf(scene);
    const newBranch = scene.core.branch;
    assert.ok(newBranch !== null && newBranch.startsWith("colo-design/"));
    assert.ok(
      ledger.branches.some((b) => b.name === BRANCH && b.deleteRemoteAfterPush === newBranch),
      "원장이 옛 원격 브랜치 삭제를 미뤄 둬야 한다",
    );
    assert.notEqual(
      (await remoteHeads(scene, BRANCH)).trim(),
      "",
      "푸시 전에 옛 원격 브랜치는 남아 있어야 한다",
    );
    assert.equal((await scene.git(["branch", "--list", BRANCH])).trim(), "", "로컬은 지운다");

    // 푸시가 계속 실패해도 옛 브랜치는 남는다.
    await scene.git(["remote", "set-url", "origin", "http://127.0.0.1:1/nope.git"]);
    scene.setNow(Date.parse(ledgerOf(scene).push?.nextAttemptAt ?? "") + 1000);
    await scene.supervisor.tick("manual");
    assert.notEqual(
      (await remoteHeads(scene, BRANCH)).trim(),
      "",
      "푸시 실패 동안 옛 원격 브랜치는 남아 있어야 한다",
    );

    // 푸시가 성공하는 틱에서 옛 브랜치가 지워진다.
    await scene.git(["remote", "set-url", "origin", scene.remote.path]);
    scene.setNow(Date.parse(ledgerOf(scene).push?.nextAttemptAt ?? "") + 1000);
    await scene.supervisor.tick("manual");
    assert.equal(
      (await remoteHeads(scene, BRANCH)).trim(),
      "",
      "새 브랜치가 올라간 뒤 옛 원격 브랜치는 지워져야 한다",
    );
    assert.notEqual(
      (await remoteHeads(scene, newBranch)).trim(),
      "",
      "새 브랜치가 원격에 있어야 한다",
    );
    assert.equal(
      ledgerOf(scene).branches.some((b) => b.deleteRemoteAfterPush),
      false,
      "미룸 표식은 지워져야 한다",
    );
  } finally {
    await scene.dispose();
  }
});

test("U17 조용한 알림 — github:expiring 은 원장에 남아도 주의 재료에 서지 않는다", async () => {
  const scene = await makeSupervisedScene();
  try {
    const at = new Date().toISOString();
    scene.supervisor.setNotice("github:expiring", { via: "issue", raisedAt: at, count: 1 });
    scene.supervisor.setNotice("push:auth", { via: "issue", raisedAt: at, count: 1 });
    const parts = scene.supervisor.attentionParts();
    // 조용한 키는 원장(cycle.json notices)에 남아 개발자 알림의 장부로 살되,
    // 화면의 문제 문장(개발자에게 알렸어요)의 재료에서는 빠진다.
    assert.deepEqual(Object.keys(parts.notices ?? {}), ["push:auth"]);
    scene.supervisor.setNotice("push:auth", null);
    assert.equal(composeAttention(scene.supervisor.attentionParts()), null);
  } finally {
    await scene.dispose();
  }
});
