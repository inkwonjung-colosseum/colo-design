import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { RepoWorkspace } from "../dist/repo.js";
// RepoCore · RepoWorkspace 는 형제를 `.js` 지정자로 부르는 모듈이다 — src 를
// 곧장 싣지 못하므로 dist 에서 가져온다(shelf-recover 와 같은 길).
import { RepoCore } from "../dist/repo-core.js";
import { GitLane, isGitWrite } from "../src/git-lane.ts";

const exec = promisify(execFile);

/** 완료를 조종하는 작업 — 줄의 순서를 재는 시계로 쓴다. */
function gatedJob(kind: "a" | "b" | "c") {
  const gate = Promise.withResolvers<void>();
  return {
    gate,
    job: async () => {
      order.push(kind);
      await gate.promise;
      return kind;
    },
  };
}
const order: string[] = [];

test("FIFO — 부른 순서대로 하나씩 돈다", async () => {
  const lane = new GitLane();
  order.length = 0;
  const a = gatedJob("a");
  const b = gatedJob("b");
  const c = gatedJob("c");
  const pa = lane.run("save", a.job);
  const pb = lane.run("submit", b.job);
  const pc = lane.run("diff", c.job);
  await sleep(20);
  // 앞선 작업이 게이트를 잡고 있으므로 나머지는 시작하지 못한다.
  assert.deepEqual(order, ["a"]);
  a.gate.resolve();
  await sleep(20);
  assert.deepEqual(order, ["a", "b"]);
  b.gate.resolve();
  await sleep(20);
  assert.deepEqual(order, ["a", "b", "c"]);
  c.gate.resolve();
  assert.deepEqual(await Promise.all([pa, pb, pc]), ["a", "b", "c"]);
});

test("재진입 — 작업 안의 run 은 줄에 서지 않고 곧바로 돈다 (교착 없음)", async () => {
  const lane = new GitLane();
  order.length = 0;
  const gate = Promise.withResolvers<void>();
  // 바깥 작업(save)이 줄을 잡은 채 안에서 land 작업을 부른다 — runSave 안의
  // refreshHandoff → landCycle 와 같은 모양. 안쪽이 바깥의 return 을 가로막고
  // 있으므로, 줄에 섰다면 바깥 작업이 끝나기를 기다리는 자기 자신과 마주 앉는다.
  const running = lane.run("save", async () => {
    const nested = lane.run("land", async () => {
      order.push("b");
      await gate.promise;
      return "land-결과";
    });
    order.push("a");
    return nested;
  });
  await sleep(10);
  // 바깥이 아직 도는 동안 안쪽도 이미 돌았다 — 줄에 섰다면 시작조차 못 했다.
  // 줄의 주인은 끝까지 바깥(save)이다.
  assert.deepEqual(order, ["a", "b"]);
  assert.equal(lane.current, "save");
  gate.resolve();
  assert.equal(await running, "land-결과");
  assert.equal(lane.holding, false);
});

test("합류 — 시작하지 않은 같은 종류에 합류하고, 도는 작업에는 합류하지 않는다", async () => {
  const lane = new GitLane();
  order.length = 0;
  const first = gatedJob("a");
  // first 가 줄을 잡고 도는 사이, 같은 종류 두 번째는 줄에 선다.
  const p1 = lane.run("save", first.job);
  const second = gatedJob("b");
  const p2 = lane.run("save", second.job);
  // 세 번째는 줄에 있는(second, 아직 시작 전) save 에 합류한다 — 몸통은 한 번.
  const p3 = lane.run("save", second.job, { join: true });
  await sleep(10);
  assert.deepEqual(order, ["a"]);
  first.gate.resolve();
  await p1;
  await sleep(10);
  // second 의 몸통이 한 번만 돌고 p2 · p3 가 같은 값을 받는다.
  assert.deepEqual(order, ["a", "b"]);
  second.gate.resolve();
  assert.equal(await p2, "b");
  assert.equal(await p3, "b");
  // 도는 작업에는 합류하지 않는다: 아래 save 는 first 옆에 새로 줄을 선다.
  order.length = 0;
  const third = gatedJob("c");
  const running = gatedJob("r");
  const pr = lane.run("save", running.job);
  const pj = lane.run("save", third.job, { join: true });
  await sleep(10);
  assert.deepEqual(order, ["r"]); // join 이었지만 도는 작업 곁에 새로 줄을 섰다
  running.gate.resolve();
  await pr;
  third.gate.resolve();
  await pj;
});

test("실패 격리 — 한 작업의 실패는 그 호출자에게만 간다", async () => {
  const lane = new GitLane();
  order.length = 0;
  const broken = gatedJob("a");
  const p1 = lane.run("save", async () => {
    await broken.gate.promise;
    throw new Error("첫 저장 실패");
  });
  const after = gatedJob("b");
  const p2 = lane.run("save", after.job);
  broken.gate.resolve();
  await assert.rejects(p1, /첫 저장 실패/);
  after.gate.resolve();
  assert.equal(await p2, "b");
  // 실패한 뒤에도 idle 은 풀린다.
  await lane.idle();
});

test("current · holding · idle", async () => {
  const lane = new GitLane();
  assert.equal(lane.current, null);
  assert.equal(lane.holding, false);
  const gate = Promise.withResolvers<void>();
  let seenInside: { current: string | null; holding: boolean } | null = null;
  const p = lane.run("refresh", async () => {
    seenInside = { current: lane.current, holding: lane.holding };
    await gate.promise;
  });
  const idleDone: boolean[] = [];
  void lane.idle().then(() => idleDone.push(true));
  await sleep(10);
  assert.equal(lane.current, "refresh");
  assert.equal(lane.holding, false); // 줄 밖에서 묻는 질문은 거짓
  assert.deepEqual(idleDone, []); // 도는 동안 idle 은 풀리지 않는다
  gate.resolve();
  await p;
  assert.deepEqual(seenInside, { current: "refresh", holding: true });
  assert.equal(lane.current, null);
  await lane.idle();
  // 대기자의 불은 확정적으로 켜지지만 그 관찰(then)은 마이크로태스크 하나
  // 뒤에 온다 — 틱 하나를 흘려 확실히 본다.
  await sleep(10);
  assert.deepEqual(idleDone, [true]);
});

test("outside — 작업 안에서 띄운 뒷일은 차선 문맥을 벗어나 다시 줄에 선다", async () => {
  const lane = new GitLane();
  order.length = 0;
  const attempt = gatedJob("push");
  const save = await lane.run("save", async () => {
    // 저장의 배경 푸시(D6): void 로 띄우되 차선 밖으로 내보낸다.
    void lane.outside(() => lane.run("push", attempt.job));
    return "saved";
  });
  assert.equal(save, "saved");
  // 저장 작업은 끝났지만 push 시도는 자기 몫으로 줄에 서 있다.
  await sleep(10);
  assert.deepEqual(order, ["push"]);
  attempt.gate.resolve();
  await lane.idle();
});

// ---------------------------------------------------------------------------
// isGitWrite 표 — 이 클론을 바꾸는 동사는 전부 쓰기로 읽힌다
// ---------------------------------------------------------------------------

test("isGitWrite — 데몬이 부르는 동사의 표", () => {
  const writes: string[][] = [
    ["add", "--", "src/a.ts"],
    ["commit", "-m", "보관"],
    ["checkout", "-b", "colo-design/20260924-1"],
    ["checkout", "main"],
    ["switch", "main"],
    ["reset", "--hard", "origin/main"],
    ["merge", "--no-edit", "origin/main"],
    ["merge", "--ff-only", "origin/main"],
    ["rebase", "origin/main"],
    ["cherry-pick", "abc123"],
    ["revert", "abc123"],
    ["pull", "--ff-only"],
    ["push", "--set-upstream", "origin", "x"],
    ["fetch", "origin", "main"],
    ["clone", "https://github.com/o/r", "/tmp/r"],
    ["init", "-b", "main"],
    ["clean", "-fd"],
    ["restore", "a.ts"],
    ["rm", "--force", "--", "a.ts"],
    ["mv", "a.ts", "b.ts"],
    ["apply", "p.patch"],
    ["am", "m.mbox"],
    ["update-ref", "refs/x", "sha"],
    ["gc"],
    ["prune"],
    ["notes", "add", "-m", "x"],
    ["tag", "v1"],
    ["tag", "-a", "v1"],
    ["tag", "-d", "v1"],
    ["branch", "colo-design/x"],
    ["branch", "-D", "x"],
    ["branch", "-m", "a", "b"],
    ["stash"], // 맨 stash 는 push 다
    ["stash", "push", "-m", "x"],
    ["stash", "pop"],
    ["stash", "drop", "stash@{0}"],
    ["worktree", "add", "--detach", "/tmp/w", "sha"],
    ["worktree", "remove", "--force", "/tmp/w"],
    ["worktree", "prune"],
    ["remote", "set-url", "origin", "https://x"],
    ["remote", "add", "up", "https://x"],
    ["remote", "prune", "origin"],
    ["config", "user.name", "x"],
    ["config", "user.email"], // 키만 있어도 보수적으로 쓰기(session.ts 와 같은 눈)
    ["config", "--unset", "user.name"],
    ["symbolic-ref", "HEAD", "refs/heads/x"],
    ["hash-object", "-w", "a.ts"],
    ["mktree"], // 모르는 동사 — 쓰기로 둔다
    // 전역 옵션을 건너뛰고 동사를 본다
    ["-c", "core.quotepath=false", "commit", "-m", "x"],
    ["-C", "/tmp/other", "checkout", "main"],
    ["--git-dir", "/tmp/x/.git", "reset", "--hard"],
  ];
  for (const args of writes)
    assert.equal(isGitWrite(args), true, `쓰기여야 한다: ${args.join(" ")}`);

  const reads: string[][] = [
    ["status", "--porcelain"],
    ["diff", "HEAD", "--no-color"],
    ["diff", "--name-only", "--diff-filter=U"],
    ["diff", "--cached", "--name-only"],
    ["diff", "--numstat", "HEAD"],
    ["diff-tree", "--numstat", "-r", "HEAD"],
    ["log", "-1", "--pretty=%s"],
    ["log", "--reverse", "--format=%cI", "a..b"],
    ["show", "main:.colo-design/shots/a.png"],
    ["rev-parse", "--verify", "HEAD"],
    ["rev-parse", "-q", "--verify", "MERGE_HEAD"],
    ["rev-list", "--left-right", "--count", "a...b"],
    ["ls-remote", "--heads", "origin", "x"],
    ["ls-files", "--others", "--exclude-standard"],
    ["ls-tree", "-r", "--name-only", "stash@{0}^3"],
    ["merge-base", "a", "b"],
    ["cat-file", "-p", "sha"],
    ["for-each-ref", "refs/colo-design"],
    ["symbolic-ref", "--short", "-q", "HEAD"],
    ["describe", "--tags"],
    ["blame", "a.ts"],
    ["grep", "pattern"],
    ["hash-object", "a.ts"],
    ["tag"],
    ["tag", "-l"],
    ["tag", "--list"],
    ["tag", "-n5"],
    ["branch"],
    ["branch", "-a"],
    ["branch", "-av"],
    ["branch", "--list"],
    ["branch", "--show-current"],
    ["stash", "list"],
    ["stash", "show"],
    ["worktree", "list"],
    ["remote"],
    ["remote", "-v"],
    ["remote", "get-url", "origin"],
    ["remote", "show", "origin"],
    ["config", "--get", "user.email"],
    ["config", "--list"],
    ["config", "-l"],
    ["commit-tree", "sha"], // 객체만 쓰고 ref 를 안 움직인다
    ["read-tree", "sha"],
    ["update-index", "--add", "a.ts"],
    // 전역 옵션 뒤의 읽기 동사
    ["-c", "core.quotepath=false", "status", "--porcelain", "-uall"],
    ["-C", "/tmp/other", "log", "-1"],
    ["--no-pager", "diff"],
    [], // 동사 없음 — 사용법 출력
    ["--version"],
  ];
  for (const args of reads)
    assert.equal(isGitWrite(args), false, `읽기여야 한다: ${args.join(" ")}`);
});

test("COLO_DESIGN_LANE_STRICT=1 — 차선 밖 쓰기는 던지고 차선 안은 지난다", async () => {
  const root = mkdtempSync(join(tmpdir(), "colo-lane-strict-"));
  const previous = process.env.COLO_DESIGN_LANE_STRICT;
  process.env.COLO_DESIGN_LANE_STRICT = "1";
  try {
    const core = new RepoCore({ root, url: null, onStatus: () => {} });
    // 위반 판정은 실행 앞에서 일어난다 — git 이 없어도 같은 결과다.
    await assert.rejects(() => core.git(["checkout", "-b", "x"]), /차선/);
    // 읽기는 차선 밖에서도 된다 — 상태 세기(diff.get)가 턴 끝에 부르는 길이다.
    await core.git(["rev-parse", "--version"]).catch(() => undefined);
    // 차선 안의 쓰기는 지난다 — 실제 git 으로 클론을 만든다.
    await core.lane.run("hygiene", () => core.git(["init", "-b", "main"]));
  } finally {
    if (previous === undefined) delete process.env.COLO_DESIGN_LANE_STRICT;
    else process.env.COLO_DESIGN_LANE_STRICT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 실제 git 픽스처 — PLAN 단계 1: 최신화 도중 보관을 부르면 던지지 않고 뒤에 선다
// ---------------------------------------------------------------------------

/** 빈 bare 원격과 그 클론 — 넘기기 시험(fixture 원격)과 같은 재료. */
async function makeWorkspace(): Promise<{ repo: RepoWorkspace; dir: string }> {
  const execAt = (cwd: string) => (args: string[]) => exec("git", args, { cwd });
  const dir = mkdtempSync(join(tmpdir(), "colo-git-lane-save-"));
  const remote = join(dir, "remote.git");
  const root = join(dir, "repo");
  await execAt(dir)(["init", "--bare", "-b", "main", remote]);
  const git = execAt(root);
  await exec("git", ["clone", remote, root], { cwd: dir });
  await git(["config", "user.email", "test@colo-design"]);
  await git(["config", "user.name", "테스트"]);
  writeFileSync(join(root, "screen.txt"), "첫 줄\n");
  await git(["add", "-A"]);
  await git(["commit", "-m", "첫 커밋"]);
  await git(["push", "-u", "origin", "main"]);
  const repo = new RepoWorkspace({ root, url: remote, onStatus: () => {} });
  return { repo, dir };
}

test("최신화가 줄을 잡은 동안 보관을 부르면 던지지 않고 뒤에 선다", async () => {
  const { repo, dir } = await makeWorkspace();
  try {
    writeFileSync(join(repo.root, "screen.txt"), "고친 줄\n");
    // 최신화(pull)가 차선을 잡고 있는 모양 — laneRun 은 pull 과 같은 줄에 서는
    // 공개된 길(보낸 시점 빌드가 쓴다).
    const gate = Promise.withResolvers<void>();
    const refresh = repo.laneRun("refresh", () => gate.promise.then(() => "clean" as const));
    const saved = repo.save({ message: "테스트 보관" });
    let settled = false;
    void saved.then(() => {
      settled = true;
    });
    await sleep(50);
    assert.equal(settled, false); // 최신화가 끝나지 않았으므로 보관은 뒤에 있다
    gate.resolve();
    assert.equal(await refresh, "clean");
    const status = await saved;
    assert.equal(status.stage, "published");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("보관을 두 번 부르면 던지지 않고 둘 다 내려앉는다", async () => {
  const { repo, dir } = await makeWorkspace();
  try {
    writeFileSync(join(repo.root, "screen.txt"), "고친 줄\n");
    const first = repo.save({ message: "첫 보관" });
    const second = repo.save({ message: "두 번째 보관" });
    const [a, b] = await Promise.all([
      first.then((status) => status.stage),
      second.then((status) => status.stage),
    ]);
    // 두 번째는 깨끗해진 바닥을 읽지만 던지지 않는다 — 이미 저장된 것의 다시
    // 저장은 멱등한 성공이다(runSave 의 규칙 그대로).
    assert.equal(a, "published");
    assert.equal(b, "published");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
