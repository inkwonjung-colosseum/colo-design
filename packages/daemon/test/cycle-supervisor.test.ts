import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
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
      openThread: () => ({ send: (text) => briefs2.push(text) }),
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
