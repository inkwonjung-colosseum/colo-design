import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

// 요약 대화 기록은 Claude 의 설정 폴더에 산다 — 시험이 사용자의 ~/.claude 를
// 건드리지 않게 이 프로세스의 것을 임시 폴더로 돌린다(시험 파일마다 프로세스가
// 따로 돈다).
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "colo-hygiene-claude-"));

// `../dist` 임포트인 이유: 형제를 `.js` 지정자로 부르는 모듈은 src 직접 로드가
// 그 지정을 못 고친다(cycle-observe.test.ts 와 같은 길).
import {
  claudeTranscriptDir,
  dueHygiene,
  endedBranchesDue,
  HYGIENE_ORDER,
  hygieneDue,
} from "../dist/cycle-hygiene.js";
import { type CycleLedger, emptyLedger, readLedger, writeLedger } from "../dist/cycle-ledger.js";
import { summaryDirOf } from "../dist/repo-summary.js";
import { makeSupervisedScene, type SupervisedScene } from "./helpers/cycle-harness.ts";

const exec = promisify(execFile);
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-09-01T09:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** 모든 항목을 t 에 한 것으로 적은 위생 기록. */
function stampedAt(t: number): CycleLedger["hygiene"] {
  return Object.fromEntries(HYGIENE_ORDER.map((item) => [`${item}At`, iso(t)]));
}

/** 원장을 디스크에 적고 감독자를 새로 세운다 — 원장은 세울 때 읽힌다. */
function seedLedger(scene: SupervisedScene, over: Partial<CycleLedger>) {
  writeLedger(scene.ledgerPath, { ...emptyLedger(), ...over });
  return scene.respawn();
}

async function refExists(scene: SupervisedScene, ref: string): Promise<boolean> {
  return (await scene.git(["rev-parse", "--verify", "-q", ref]).catch(() => "")).trim() !== "";
}

async function remoteHas(scene: SupervisedScene, branch: string): Promise<boolean> {
  const out = await exec("git", ["ls-remote", "--heads", scene.remote.path, branch]);
  return String(out.stdout).trim() !== "";
}

// ————— 순수 판정 —————

test("dueHygiene — 시각이 없으면 전부, gc · fsck 는 7일 · prune 은 하루", () => {
  assert.deepEqual(dueHygiene({}, T0), [...HYGIENE_ORDER]);
  assert.equal(hygieneDue(emptyLedger(), T0), true);
  const fresh = stampedAt(T0);
  assert.deepEqual(dueHygiene(fresh, T0 + 60_000), []);
  assert.equal(hygieneDue({ ...emptyLedger(), hygiene: fresh }, T0 + 60_000), false);
  // 하루 — prune · move · disk 가 돌아온다. gc · fsck · assets 는 아직.
  assert.deepEqual(dueHygiene(fresh, T0 + DAY), ["disk", "prune", "move"]);
  assert.deepEqual(dueHygiene(fresh, T0 + DAY - 1), []);
  // 이레 — 전부.
  assert.deepEqual(dueHygiene(fresh, T0 + 7 * DAY), [...HYGIENE_ORDER]);
  assert.deepEqual(dueHygiene(fresh, T0 + 7 * DAY - 1), ["disk", "prune", "move"]);
});

test("dueHygiene — 미래의 시각(시계가 뒤로 갔다)과 깨진 시각은 지난 것으로 친다", () => {
  assert.deepEqual(dueHygiene({ ...stampedAt(T0), gcAt: iso(T0 + 30 * DAY) }, T0 + 60_000), ["gc"]);
  assert.deepEqual(dueHygiene({ ...stampedAt(T0), fsckAt: "어제" }, T0 + 60_000), ["fsck"]);
});

test("endedBranchesDue — 반려는 keepDays 뒤, 표식 없는 병합 기록은 원장에서만, 표식 있는 병합은 그대로", () => {
  const branches: CycleLedger["branches"] = [
    { name: "rejected-old", endedAt: iso(T0), state: "closed" },
    { name: "rejected-new", endedAt: iso(T0 + 10 * DAY), state: "closed" },
    { name: "merged-old", endedAt: iso(T0), state: "merged" },
    {
      name: "merged-deferred",
      endedAt: iso(T0),
      state: "merged",
      deleteRemoteAfterPush: "colo-design/20260902-1",
    },
  ];
  const at13 = endedBranchesDue(branches, 14, T0 + 13 * DAY);
  assert.deepEqual(at13, { rejected: [], staleMerged: [] });
  const at14 = endedBranchesDue(branches, 14, T0 + 14 * DAY);
  assert.deepEqual(
    at14.rejected.map((entry) => entry.name),
    ["rejected-old"],
  );
  assert.deepEqual(
    at14.staleMerged.map((entry) => entry.name),
    ["merged-old"],
  );
  // keepDays 는 수명 설정이 정한다.
  assert.deepEqual(
    endedBranchesDue(branches, 3, T0 + 13 * DAY).rejected.map((entry) => entry.name),
    ["rejected-old", "rejected-new"],
  );
});

// ————— 하네스 —————

test("반려 브랜치 — keepRejectedDays 전에는 남고, 뒤에는 로컬 · 원격 · 원장에서 사라진다", async () => {
  const scene = await makeSupervisedScene();
  try {
    const name = "colo-design/20260901-1";
    await scene.dev.pushToBranch(name, { "src/rejected.ts": "반려된 작업\n" }, "반려된 작업");
    await scene.git(["fetch", "origin"]);
    // 랜딩은 로컬을 이미 지운다 — 남아 있는 세계도 치우는지 보려고 되살린다.
    await scene.git(["branch", name, `origin/${name}`]);
    const deferred = {
      name: "colo-design/20260901-2",
      endedAt: iso(T0),
      state: "merged" as const,
      deleteRemoteAfterPush: "colo-design/20260901-3",
    };
    const supervisor = seedLedger(scene, {
      branches: [
        { name, endedAt: iso(T0), state: "closed" },
        { name: "colo-design/20260831-1", endedAt: iso(T0), state: "merged" },
        deferred,
      ],
    });

    scene.setNow(T0 + 13 * DAY);
    await supervisor.tick("manual");
    assert.equal(await refExists(scene, `refs/heads/${name}`), true, "13일째 로컬은 남는다");
    assert.equal(await remoteHas(scene, name), true, "13일째 원격은 남는다");
    assert.equal(readLedger(scene.ledgerPath).branches.length, 3);

    scene.setNow(T0 + 15 * DAY);
    await supervisor.tick("manual");
    assert.equal(await refExists(scene, `refs/heads/${name}`), false, "로컬이 지워져야 한다");
    assert.equal(await remoteHas(scene, name), false, "원격이 지워져야 한다");
    // 반려 기록과 표식 없는 병합 기록은 빠지고, 지연 삭제 표식은 12행의 몫으로 남는다.
    assert.deepEqual(readLedger(scene.ledgerPath).branches, [deferred]);
  } finally {
    await scene.dispose();
  }
});

test("반려 브랜치 — 원격에 닿지 못하면 원장에 남기고 다음 날 다시 지운다", async () => {
  const scene = await makeSupervisedScene();
  try {
    const name = "colo-design/20260901-1";
    await scene.dev.pushToBranch(name, { "src/rejected.ts": "반려된 작업\n" }, "반려된 작업");
    const supervisor = seedLedger(scene, {
      branches: [{ name, endedAt: iso(T0), state: "closed" }],
    });
    await scene.git(["remote", "set-url", "origin", "http://127.0.0.1:1/nope.git"]);
    scene.setNow(T0 + 15 * DAY);
    await supervisor.tick("manual");
    assert.equal(readLedger(scene.ledgerPath).branches.length, 1, "네트워크 실패는 원장에 남는다");
    assert.equal(await remoteHas(scene, name), true);

    await scene.git(["remote", "set-url", "origin", scene.remote.path]);
    scene.setNow(T0 + 16 * DAY);
    await supervisor.tick("manual");
    assert.deepEqual(readLedger(scene.ledgerPath).branches, []);
    assert.equal(await remoteHas(scene, name), false);
  } finally {
    await scene.dispose();
  }
});

test("gc · fsck — 원장의 시각으로 7일에 한 번, prune 은 하루에 한 번", async () => {
  const scene = await makeSupervisedScene();
  try {
    scene.setNow(T0);
    await scene.supervisor.tick("manual");
    let hygiene = readLedger(scene.ledgerPath).hygiene;
    assert.equal(hygiene.gcAt, iso(T0));
    assert.equal(hygiene.fsckAt, iso(T0));
    assert.equal(hygiene.pruneAt, iso(T0));

    scene.setNow(T0 + 3 * DAY);
    await scene.supervisor.tick("manual");
    hygiene = readLedger(scene.ledgerPath).hygiene;
    assert.equal(hygiene.gcAt, iso(T0), "사흘 뒤에는 gc 를 다시 돌지 않는다");
    assert.equal(hygiene.fsckAt, iso(T0), "사흘 뒤에는 fsck 를 다시 돌지 않는다");
    assert.equal(hygiene.pruneAt, iso(T0 + 3 * DAY), "prune 은 하루가 지나면 돈다");

    scene.setNow(T0 + 7 * DAY);
    await scene.supervisor.tick("manual");
    hygiene = readLedger(scene.ledgerPath).hygiene;
    assert.equal(hygiene.gcAt, iso(T0 + 7 * DAY));
    assert.equal(hygiene.fsckAt, iso(T0 + 7 * DAY));
    assert.equal(
      readLedger(scene.ledgerPath).corrupt,
      null,
      "멀쩡한 클론의 fsck 는 손상을 적지 않는다",
    );
  } finally {
    await scene.dispose();
  }
});

test("임시 폴더 — 요약 폴더 · 요약 대화 기록 · 첨부 중 7일 넘은 것만 치운다", async () => {
  const scene = await makeSupervisedScene();
  try {
    const now = Date.now();
    const aged = (path: string, body: string, ageMs: number) => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, body);
      const at = (now - ageMs) / 1000;
      utimesSync(path, at, at);
    };
    const summary = summaryDirOf(scene.clone.path);
    // 기록 폴더는 요약 폴더의 실경로로 이름 짓는다(CLI 와 같다) — macOS 의
    // /var → /private/var 처럼 철자가 달라지므로 폴더를 먼저 만든다.
    mkdirSync(summary, { recursive: true });
    const transcripts = claudeTranscriptDir(summary);
    const attachments = join(scene.clone.path, ".git", "colo-design-attachments");
    aged(join(summary, "old.txt"), "지난 요약", 8 * DAY);
    aged(join(summary, "new.txt"), "오늘 요약", DAY);
    aged(join(transcripts, "old.jsonl"), "{}", 8 * DAY);
    aged(join(transcripts, "new.jsonl"), "{}", DAY);
    aged(join(attachments, "1-old.pdf"), "%PDF", 8 * DAY);
    aged(join(attachments, "2-new.pdf"), "%PDF", DAY);

    scene.setNow(now);
    await scene.supervisor.tick("manual");
    assert.equal(existsSync(join(summary, "old.txt")), false);
    assert.equal(existsSync(join(summary, "new.txt")), true);
    assert.equal(existsSync(join(transcripts, "old.jsonl")), false);
    assert.equal(existsSync(join(transcripts, "new.jsonl")), true);
    assert.equal(existsSync(join(attachments, "1-old.pdf")), false);
    assert.equal(existsSync(join(attachments, "2-new.pdf")), true);
  } finally {
    await scene.dispose();
  }
});

test("캡처 브랜치 — 원격에 있으면 파일 수 · 크기를 적고, 사라지면 기록을 거둔다 (O4)", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.dev.pushToBranch(
      "colo-design-assets",
      { "shots/a/x.png": "0123456789", "shots/a/y.png": "01234567890123456789" },
      "캡처",
    );
    scene.setNow(T0);
    await scene.supervisor.tick("manual");
    // 씨앗 커밋의 README 도 그 트리에 있다(하네스의 자산 브랜치는 main 에서 갈라졌다).
    const readme = Buffer.byteLength("# 하네스\n");
    assert.deepEqual(readLedger(scene.ledgerPath).hygiene.assets, {
      files: 3,
      bytes: readme + 10 + 20,
    });
    // 정리는 하지 않는다 — 원격 브랜치는 그대로다.
    assert.equal(await remoteHas(scene, "colo-design-assets"), true);

    await exec("git", ["-C", scene.remote.path, "branch", "-D", "colo-design-assets"]);
    scene.setNow(T0 + 7 * DAY);
    await scene.supervisor.tick("manual");
    assert.equal(readLedger(scene.ledgerPath).hygiene.assets, undefined);
    assert.equal(readLedger(scene.ledgerPath).hygiene.assetsAt, iso(T0 + 7 * DAY));
  } finally {
    await scene.dispose();
  }
});
