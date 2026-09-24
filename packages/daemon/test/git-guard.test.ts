import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
// `../dist` 임포트인 이유: 형제를 `.js` 지정자로 부르는 모듈은 src 직접 로드가
// 그 지정을 못 고친다(cycle-observe.test.ts 와 같은 길).
import {
  ensureGitGuardHooks,
  GIT_WRITE_REFUSAL,
  gitGuardEnv,
  gitGuardHookDecision,
} from "../dist/git-guard.js";

const exec = promisify(execFile);

/** 임시 저장소 + 가드 훅 폴더 — 시험이 끝나면 함께 지운다. */
async function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "git-guard-"));
  const hooksDir = join(dir, "hooks");
  ensureGitGuardHooks(hooksDir);
  const repo = join(dir, "repo");
  const bare = join(dir, "remote.git");
  const git = (args: string[], env?: NodeJS.ProcessEnv) =>
    exec("git", args, { cwd: repo, env: env ?? process.env }).then((r) => r.stdout as string);
  await exec("git", ["init", "--bare", bare]);
  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", ["-C", repo, "config", "user.email", "t@t"]);
  await exec("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "a.ts"), "export const a = 0;\n");
  await git(["add", "-A"]);
  await git(["commit", "-m", "seed"]);
  await git(["remote", "add", "origin", bare]);
  await git(["push", "-u", "origin", "main"]);
  return {
    repo,
    git,
    guardEnv: gitGuardEnv({ ...process.env }, hooksDir),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const fails = (p: Promise<string>) =>
  p.then(
    () => assert.fail("가드가 막아야 한다"),
    () => undefined,
  );

test("가드 환경에서 참조를 바꾸는 git 은 전부 거절된다", async () => {
  const scene = await makeRepo();
  try {
    writeFileSync(join(scene.repo, "a.ts"), "export const a = 1;\n");
    await fails(scene.git(["commit", "-am", "x"], scene.guardEnv));
    await fails(scene.git(["reset", "--hard", "HEAD~0"], scene.guardEnv));
    await fails(scene.git(["checkout", "-b", "x"], scene.guardEnv));
    // stash · push 도 실제 참조 쓰기를 시도하게 만든다 — 깨끗한 트리의
    // stash 와 최신 상태의 push 는 훅을 부르지 않고 0 으로 끝난다.
    writeFileSync(join(scene.repo, "a.ts"), "export const a = 2;\n");
    await fails(scene.git(["stash"], scene.guardEnv));
    await scene.git(["commit", "-am", "ahead"]); // 가드 없이 로컬 커밋
    await fails(scene.git(["push"], scene.guardEnv));
  } finally {
    scene.dispose();
  }
});

test("가드 없는 환경(RepoCore.git 과 같은 환경)에서는 같은 명령이 성공한다", async () => {
  const scene = await makeRepo();
  try {
    writeFileSync(join(scene.repo, "a.ts"), "export const a = 1;\n");
    await scene.git(["commit", "-am", "x"]);
    await scene.git(["reset", "--hard", "HEAD~0"]);
    await scene.git(["checkout", "-b", "x"]);
    writeFileSync(join(scene.repo, "a.ts"), "export const a = 2;\n");
    await scene.git(["stash"]);
    await scene.git(["checkout", "main"]);
    await scene.git(["commit", "--allow-empty", "-m", "ahead"]);
    await scene.git(["push"]);
  } finally {
    scene.dispose();
  }
});

test("가드 환경에서도 읽기와 인덱스 쓰기는 된다 — status · log · diff · add", async () => {
  const scene = await makeRepo();
  try {
    writeFileSync(join(scene.repo, "b.ts"), "변경\n");
    await scene.git(["status", "--porcelain"], scene.guardEnv);
    await scene.git(["log", "--oneline", "-1"], scene.guardEnv);
    await scene.git(["diff"], scene.guardEnv);
    await scene.git(["add", "b.ts"], scene.guardEnv);
  } finally {
    scene.dispose();
  }
});

test("기존 GIT_CONFIG_COUNT 가 있는 환경에 뒤로 이어 붙는다", () => {
  const base = {
    PATH: "/usr/bin",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.example.com/.extraheader",
    GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic abc",
  };
  const env = gitGuardEnv(base, "/guard/hooks");
  assert.equal(env.GIT_CONFIG_COUNT, "2");
  assert.equal(env.GIT_CONFIG_KEY_0, "http.example.com/.extraheader");
  assert.equal(env.GIT_CONFIG_VALUE_0, "AUTHORIZATION: basic abc");
  assert.equal(env.GIT_CONFIG_KEY_1, "core.hooksPath");
  assert.equal(env.GIT_CONFIG_VALUE_1, "/guard/hooks");
});

test("ensureGitGuardHooks 는 멱등이다 — 내용이 같으면 다시 쓰지 않는다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "git-guard-hooks-"));
  try {
    ensureGitGuardHooks(dir);
    const hook = join(dir, "reference-transaction");
    const first = await exec("stat", ["-f", "%m", hook]).then((r) => r.stdout);
    ensureGitGuardHooks(dir);
    const second = await exec("stat", ["-f", "%m", hook]).then((r) => r.stdout);
    assert.equal(first, second, "같은 내용이면 다시 쓰지 않아 mtime 이 그대로다");
    // 실행 권한 — 0755
    const mode = await exec("stat", ["-f", "%Lp", hook]).then((r) => r.stdout);
    assert.equal(mode.trim(), "755", "훅은 실행 가능해야 한다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PreToolUse 훅 판정 — Bash 의 git 쓰기만 deny, 나머지는 통과", () => {
  const denied = gitGuardHookDecision("Bash", { command: "git commit -m x" });
  assert.equal(denied.hookSpecificOutput?.permissionDecision, "deny");
  assert.equal(denied.hookSpecificOutput?.permissionDecisionReason, GIT_WRITE_REFUSAL);
  assert.deepEqual(gitGuardHookDecision("Bash", { command: "git status" }), {});
  assert.deepEqual(gitGuardHookDecision("Bash", { command: "ls -la" }), {});
  assert.deepEqual(gitGuardHookDecision("Read", { file_path: "/x" }), {});
  assert.deepEqual(gitGuardHookDecision("Bash", {}), {});
});
