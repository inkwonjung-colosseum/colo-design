import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

// 재클론은 준비(bootstrap)를 다시 돌고, 준비는 Claude 의 신뢰 목록(.claude.json)에
// 새 클론을 적는다 — 시험이 사용자의 설정을 건드리지 않게 이 프로세스의 것을
// 임시 폴더로 돌린다. 차선 밖의 git 쓰기는 던지게 한다: 재클론의 모든 git 이
// 감독자의 차선 칸 안에서 도는지를 이 파일이 함께 본다(PLAN L1).
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "colo-reclone-claude-"));
process.env.COLO_DESIGN_LANE_STRICT = "1";

// `../dist` 임포트인 이유: 형제를 `.js` 지정자로 부르는 모듈은 src 직접 로드가
// 그 지정을 못 고친다(cycle-observe.test.ts 와 같은 길).
import {
  corruptionSignal,
  probeCorruption,
  restoreSalvage,
  salvageStamp,
} from "../dist/clone-salvage.js";
import { type CycleLedger, emptyLedger, readLedger, writeLedger } from "../dist/cycle-ledger.js";
import { RepoCore } from "../dist/repo-core.js";
import { makeScene, makeSupervisedScene, type SupervisedScene } from "./helpers/cycle-harness.ts";

const BRANCH = "colo-design/20260924-1";
const exec = promisify(execFile);

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

/** 재클론은 틱 밖(준비의 끝)에서 이어진다 — 원장이 절차를 닫을 때까지 기다린다. */
async function recloneSettled(scene: SupervisedScene): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ledger = readLedger(scene.ledgerPath);
    if (ledger.reclone === null && ledger.corrupt === null) {
      await scene.supervisor.settled();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("재클론이 30초 안에 끝나지 않았다");
}

/** 프로젝트 폴더(클론의 부모)의 이름들 — 옮긴 클론 · 구해 둔 폴더를 찾는다. */
function projectEntries(scene: SupervisedScene): string[] {
  return readdirSync(dirname(scene.clone.path));
}

// ————— 순수 —————

test("salvageStamp — 콜론 없는 UTC 도장", () => {
  assert.equal(salvageStamp(Date.parse("2026-09-25T10:15:30.123Z")), "20260925T101530Z");
});

test("corruptionSignal — 인덱스 · HEAD 를 읽지 못하는 말만 손상이다", () => {
  for (const said of [
    "git status에 실패했습니다 (128) — fatal: index file corrupt",
    "fatal: .git/index: index file smaller than expected",
    "fatal: not a git repository (or any of the parent directories): .git",
    "fatal: bad object HEAD",
    "error: bad tree object HEAD",
  ]) {
    assert.equal(corruptionSignal(said), true, said);
  }
  for (const said of [
    "fatal: Needed a single revision",
    "fatal: your current branch 'main' does not have any commits yet",
    "git diff에 실패했습니다 (1) — ",
    "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host",
  ]) {
    assert.equal(corruptionSignal(said), false, said);
  }
});

test("탐침 — 클론 경로의 철자가 디스크와 대소문자만 달라도 손상이 아니다", {
  skip: process.platform === "linux",
}, async () => {
  // git 은 폴더를 디스크의 철자로 답한다 — 받은 철자와 견주면 멀쩡한 클론이
  // "다른 git 폴더" 로 읽혀 날마다 다시 받게 된다(macOS 실측).
  const root = mkdtempSync(join(tmpdir(), "colo-probe-"));
  try {
    const real = join(root, "CaseClone");
    await exec("git", ["init", "-q", "-b", "main", real]);
    writeFileSync(join(real, "a.txt"), "a\n");
    const git = (args: string[]) =>
      exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: real });
    await git(["add", "-A"]);
    await git(["commit", "-qm", "첫 커밋"]);
    const core = new RepoCore({ root: join(root, "caseclone"), url: null, onStatus: () => {} });
    assert.equal(await probeCorruption(core), null);
    // 진짜 손상은 그 철자로도 잡는다.
    writeFileSync(join(real, ".git", "index"), "garbage");
    assert.match((await probeCorruption(core)) ?? "", /index file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ————— 하네스 —————

test("손상된 인덱스 — 구해 두기 → 재클론 → 커밋 안 된 변경과 올라가지 않은 커밋이 새 클론에 살아 있다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await scene.git(["checkout", "-b", BRANCH]);
    scene.core.setCycle(BRANCH, null);
    await commit(scene, { "src/pushed.ts": "올라간 작업\n" }, "올라간 커밋");
    await scene.git(["push", "-u", "origin", BRANCH]);
    await commit(scene, { "src/local.ts": "아직 안 올라간 작업\n" }, "안 올라간 커밋");
    // 커밋 안 된 변경 — 추적 파일 고침 · 추적 파일 지움 · 새 파일.
    writeFileSync(join(scene.clone.path, "README.md"), "# 하네스\n고친 줄\n");
    rmSync(join(scene.clone.path, "src/pushed.ts"));
    writeFileSync(join(scene.clone.path, "src/new.ts"), "새 파일\n");
    writeFileSync(join(scene.clone.path, ".git", "old-canary"), "옛 클론");
    // 인덱스를 깨뜨린다 — git 은 "bad signature … index file corrupt" 라고 말한다.
    writeFileSync(join(scene.clone.path, ".git", "index"), randomBytes(4096));

    await scene.supervisor.tick("manual");
    await recloneSettled(scene);

    const parent = dirname(scene.clone.path);
    // 옛 클론은 지우지 않고 옮겼다 — 이름에 콜론이 없다.
    const moved = projectEntries(scene).filter((name) => name.startsWith("repo.corrupt-"));
    assert.equal(moved.length, 1);
    assert.equal(moved[0]?.includes(":"), false);
    assert.equal(existsSync(join(parent, moved[0] ?? "", ".git", "old-canary")), true);
    assert.equal(existsSync(join(scene.clone.path, ".git", "old-canary")), false, "새 클론이다");
    // 구해 둔 폴더 — 패치와 묶음과 목록.
    const salvage = readdirSync(join(parent, "salvage"));
    assert.equal(salvage.length, 1);
    for (const file of ["changes.patch", "unpushed.bundle", "salvage.json"]) {
      assert.equal(existsSync(join(parent, "salvage", salvage[0] ?? "", file)), true, file);
    }
    // 새 클론 — 사이클 브랜치 위에 두 커밋, 변경 셋이 그대로.
    assert.equal((await scene.git(["symbolic-ref", "--short", "HEAD"])).trim(), BRANCH);
    const log = await scene.git(["log", "--format=%s"]);
    assert.ok(log.includes("안 올라간 커밋"), "올라가지 않은 커밋이 살아 있어야 한다");
    assert.ok(log.includes("올라간 커밋"));
    assert.equal(readFileSync(join(scene.clone.path, "README.md"), "utf8"), "# 하네스\n고친 줄\n");
    assert.equal(existsSync(join(scene.clone.path, "src/pushed.ts")), false);
    assert.equal(readFileSync(join(scene.clone.path, "src/new.ts"), "utf8"), "새 파일\n");
    // 새 클론의 인덱스는 멀쩡하다.
    await scene.git(["status", "--porcelain"]);
    assert.deepEqual(scene.notices, [], "개발자 알림 없이 끝난다");
  } finally {
    await scene.dispose();
  }
});

test("구해 두기가 실패하면 — 옛 클론을 그대로 두고 clone:corrupt 알림 한 번", async () => {
  const scene = await makeSupervisedScene();
  try {
    // HEAD 가 없는 커밋을 가리킨다 — 탐침은 "bad object HEAD", 구해 두기는 HEAD 를 읽지 못한다.
    await commit(scene, { "src/a.ts": "로컬 작업\n" }, "로컬 커밋");
    const head = (await scene.git(["rev-parse", "HEAD"])).trim();
    rmSync(join(scene.clone.path, ".git", "objects", head.slice(0, 2), head.slice(2)));

    await scene.supervisor.tick("manual");
    assert.deepEqual(
      scene.notices.map((notice) => notice.key),
      ["clone:corrupt"],
    );
    assert.equal(existsSync(join(scene.clone.path, ".git")), true, "옛 클론을 옮기지 않는다");
    assert.equal(
      projectEntries(scene).some((name) => name.startsWith("repo.corrupt-")),
      false,
    );
    const ledger = readLedger(scene.ledgerPath);
    assert.equal(ledger.reclone, null);
    assert.ok(ledger.corrupt?.detail.includes("bad object"));

    // 같은 날 다시 틱 — 알림은 한 번뿐이다.
    await scene.supervisor.tick("manual");
    assert.equal(scene.notices.length, 1);
  } finally {
    await scene.dispose();
  }
});

/** 올라간 커밋의 블롭 하나를 잃은 클론 — HEAD · 인덱스는 멀쩡해 탐침은 조용하다. */
async function loseCommittedBlob(scene: SupervisedScene): Promise<void> {
  await commit(scene, { "data.txt": "잃어버릴 내용\n" }, "데이터");
  await scene.git(["push", "origin", "main"]);
  const blob = (await scene.git(["rev-parse", "HEAD:data.txt"])).trim();
  rmSync(join(scene.clone.path, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
}

test("fsck 가 본 손상 — 탐침에는 안 보여도 위생의 fsck 가 적고 재클론으로 이어진다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await loseCommittedBlob(scene);
    const observed = await scene.observe();
    assert.equal(observed.corruption, null, "탐침은 블롭까지 읽지 않는다");

    await scene.supervisor.tick("manual");
    await recloneSettled(scene);

    assert.equal(
      projectEntries(scene).filter((name) => name.startsWith("repo.corrupt-")).length,
      1,
    );
    // 새 클론은 원격에서 그 블롭을 다시 받았다.
    assert.ok((await scene.git(["show", "HEAD:data.txt"])).includes("잃어버릴 내용"));
    assert.deepEqual(scene.notices, []);
  } finally {
    await scene.dispose();
  }
});

test("보관이 없는 객체에 막히면(Error building trees) — 손상으로 적고 재클론한다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await loseCommittedBlob(scene);
    // 커밋 안 된 변경 — 5행의 보관이 먼저 서고, git 은 없는 블롭으로 트리를 짓지
    // 못한다. 막힌 보관이 판정의 앞자리를 차지해 위생의 fsck 는 오지 않는다.
    writeFileSync(join(scene.clone.path, "README.md"), "# 하네스\n오늘 고침\n");

    await scene.supervisor.tick("manual");
    await recloneSettled(scene);

    assert.equal(
      projectEntries(scene).filter((name) => name.startsWith("repo.corrupt-")).length,
      1,
    );
    assert.ok((await scene.git(["show", "HEAD:data.txt"])).includes("잃어버릴 내용"));
    // 고친 파일의 변경은 새 클론에 되살아나 보관됐다.
    assert.equal(
      readFileSync(join(scene.clone.path, "README.md"), "utf8"),
      "# 하네스\n오늘 고침\n",
    );
    assert.deepEqual(scene.notices, []);
  } finally {
    await scene.dispose();
  }
});

test("되살리기 실패 — 표식을 남기지 않고 이유를 돌려준다, 추적되지 않은 파일은 제자리로", async () => {
  const scene = await makeScene();
  try {
    const dir = mkdtempSync(join(tmpdir(), "colo-salvage-"));
    // 얹힐 자리가 없는 패치 — 가짜 블롭 id 라 3-way 로도 못 얹는다.
    writeFileSync(
      join(dir, "changes.patch"),
      [
        "diff --git a/README.md b/README.md",
        "index 1234567..89abcde 100644",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1 +1 @@",
        "-이런 줄은 없다",
        "+바뀐 줄",
        "",
      ].join("\n"),
    );
    mkdirSync(join(dir, "untracked", "src"), { recursive: true });
    writeFileSync(join(dir, "untracked", "src", "kept.ts"), "살아남는 파일\n");

    const failure = await scene.core.lane.run("supervise", () =>
      restoreSalvage(scene.core, { dir, branch: null, bundleRef: null, patch: true }),
    );
    assert.ok(failure?.includes("커밋 안 된 변경을 다시 얹지 못했습니다"), String(failure));
    // 추적 파일은 깨끗하다 — 반쯤 얹힌 변경도 충돌 표식도 없다.
    assert.equal((await scene.git(["diff", "HEAD", "--stat"])).trim(), "");
    assert.equal(readFileSync(join(scene.clone.path, "README.md"), "utf8"), "# 하네스\n");
    assert.equal(readFileSync(join(scene.clone.path, "src", "kept.ts"), "utf8"), "살아남는 파일\n");
    rmSync(dir, { recursive: true, force: true });
  } finally {
    scene.dispose();
  }
});

test("되살리기 — 새 클론에 이미 고친 것이 있으면 아무것도 얹지 않는다(그 사이의 변경을 지킨다)", async () => {
  const scene = await makeScene();
  try {
    const dir = mkdtempSync(join(tmpdir(), "colo-salvage-"));
    writeFileSync(join(dir, "changes.patch"), "쓰지 않을 패치\n");
    mkdirSync(join(dir, "untracked"), { recursive: true });
    writeFileSync(join(dir, "untracked", "README.md"), "덮으면 안 되는 쪽\n");
    // 재클론의 틈에 새 클론에서 고친 파일.
    writeFileSync(join(scene.clone.path, "README.md"), "# 하네스\n그 사이에 고침\n");

    const failure = await scene.core.lane.run("supervise", () =>
      restoreSalvage(scene.core, { dir, branch: null, bundleRef: null, patch: true }),
    );
    assert.ok(failure?.includes("이미 고친 것이 있어"), String(failure));
    assert.equal(
      readFileSync(join(scene.clone.path, "README.md"), "utf8"),
      "# 하네스\n그 사이에 고침\n",
    );
    rmSync(dir, { recursive: true, force: true });
  } finally {
    scene.dispose();
  }
});

// ————— clone:restore 알림의 풀림 (남은 항목) —————

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

/** 원장을 디스크에 적고 감독자를 새로 세운다 — 원장은 세울 때 읽힌다.
 *  아래 세 시험이 같은 세팅으로 서므로 도우미로 둔다(cycle-hygiene 와 같은 모양). */
function seedLedger(scene: SupervisedScene, over: Partial<CycleLedger>) {
  writeLedger(scene.ledgerPath, { ...emptyLedger(), ...over });
  return scene.respawn();
}

/** 얹힐 자리가 없는 패치 — 가짜 블롭 id 라 3-way 로도 못 얹는다. */
const BAD_PATCH = [
  "diff --git a/README.md b/README.md",
  "index 1234567..89abcde 100644",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1 @@",
  "-이런 줄은 없다",
  "+바뀐 줄",
  "",
].join("\n");

test("되살리기 실패 — clone:restore 알림의 자세히에 구해 둔 폴더 경로가 실린다", async () => {
  const scene = await makeSupervisedScene();
  try {
    const now = Date.now();
    const parent = dirname(scene.clone.path);
    const dir = join(parent, "salvage", "20260925T000000Z");
    mkdirSync(join(dir, "untracked"), { recursive: true });
    writeFileSync(join(dir, "changes.patch"), BAD_PATCH);
    const movedTo = join(parent, "repo.corrupt-20260925T000000Z");
    mkdirSync(movedTo);

    const supervisor = seedLedger(scene, {
      reclone: {
        at: iso(now),
        salvage: { dir, branch: null, bundleRef: null, patch: true },
        movedTo,
      },
    });
    scene.setNow(now);
    await supervisor.tick("manual");

    assert.deepEqual(
      scene.notices.map((notice) => notice.key),
      ["clone:restore"],
    );
    // fleet 은 reason 을 describeProblem 의 detail 로 싣는다 — 경로가 없으면
    // 개발자가 무엇을 꺼내야 할지 모른다.
    assert.ok(
      scene.notices[0]?.reason?.includes(dir),
      `자세히에 구해 둔 폴더 경로가 실려야 한다: ${scene.notices[0]?.reason}`,
    );
    assert.equal(readLedger(scene.ledgerPath).reclone, null, "절차는 닫힌다");
  } finally {
    await scene.dispose();
  }
});

test("clone:restore 알림은 7일이 지나면 틱에서 저절로 풀린다", async () => {
  const scene = await makeSupervisedScene();
  try {
    const now = Date.now();

    // 6일째 — 아직 풀리지 않는다.
    let supervisor = seedLedger(scene, {
      notices: {
        "clone:restore": { via: "slack" as const, raisedAt: iso(now - 6 * DAY_MS), count: 1 },
      },
    });
    scene.setNow(now);
    await supervisor.tick("manual");
    assert.ok(readLedger(scene.ledgerPath).notices["clone:restore"], "7일 전에는 그대로");

    // 8일째 — 풀린다.
    supervisor = seedLedger(scene, {
      notices: {
        "clone:restore": { via: "slack" as const, raisedAt: iso(now - 8 * DAY_MS), count: 1 },
      },
    });
    await supervisor.tick("manual");
    assert.equal(
      readLedger(scene.ledgerPath).notices["clone:restore"],
      undefined,
      "7일이 지나면 원장에서 사라진다",
    );
  } finally {
    await scene.dispose();
  }
});

test("clone:restore 알림은 제출이 한 번 성공하면 풀린다 — 작업이 정상으로 흐른다", async () => {
  const scene = await makeSupervisedScene();
  try {
    const now = Date.now();
    const supervisor = seedLedger(scene, {
      notices: {
        "clone:restore": { via: "slack" as const, raisedAt: iso(now - DAY_MS), count: 1 },
      },
    });
    scene.setNow(now);
    // 표준 사이클 시작(제출 흐름 시험과 같은 모양) — 오늘 만든 작업.
    await scene.git(["checkout", "-b", BRANCH]);
    await commit(scene, { "screen.tsx": "export default () => null;\n" }, "회원 목록 화면");
    scene.core.setCycle(BRANCH, null);

    supervisor.submit("button");
    await supervisor.settled();

    assert.equal(
      readLedger(scene.ledgerPath).notices["clone:restore"],
      undefined,
      "제출 성공이 알림을 푼다",
    );
    assert.ok(scene.core.openHandoff, "제출은 실제로 성공했다");
  } finally {
    await scene.dispose();
  }
});
