import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
// `../dist` 임포트인 이유: 형제를 `.js` 지정자로 부르는 모듈은 src 직접 로드가
// 그 지정을 못 고친다(cycle-observe.test.ts 와 같은 길).
import { readLedger } from "../dist/cycle-ledger.js";
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
