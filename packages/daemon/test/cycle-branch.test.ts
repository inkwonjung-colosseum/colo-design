import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
// `../dist` 임포트인 이유: repo-publish 의 src 는 `.js` 지정자로 형제를
// 부른다 — src 직접 로드는 그 지정을 못 고친다(shelf-recover 와 같은 길).
import { alignCycleBranch, cycleBranchName } from "../dist/repo-publish.js";

const exec = promisify(execFile);

/** GitRun 의 몫 — alignCycleBranch 가 받는 최소 계약 그대로. */
function gitOf(root: string) {
  return (args: string[]) => exec("git", args, { cwd: root }).then((done) => done.stdout as string);
}

test("자정 직후의 이름은 그날 로컬 날짜로 짓는다 — UTC 가 아니다", () => {
  // 로컬 시간 생성자: 어느 시간대에서 돌아도 2026-03-05 00:05 이다. UTC 였다면
  // 시간대에 따라 어제(2026-03-04) 이름이 나왔다 — 하루의 경계는 사용자의 것이다.
  assert.equal(cycleBranchName(new Date(2026, 2, 5, 0, 5), 3), "colo-design/20260305-3");
});

test("한 자리 월 · 일은 0으로 채운다", () => {
  assert.equal(cycleBranchName(new Date(2026, 1, 9, 23, 59), 12), "colo-design/20260209-12");
});

test("이미 있는 사이클 브랜치로 HEAD 가 옮겨지고 커밋 안 된 변경이 따라온다", async () => {
  const root = mkdtempSync(join(tmpdir(), "colo-cycle-branch-"));
  try {
    const git = gitOf(root);
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "test@colo-design"]);
    await git(["config", "user.name", "테스트"]);
    writeFileSync(join(root, "screen.txt"), "첫 줄\n");
    await git(["add", "-A"]);
    await git(["commit", "-m", "첫 커밋"]);
    // 레지스트리가 기억하는 사이클 브랜치가 로컬에 있고 HEAD 는 main —
    // 재시작 뒤의 모습. 작업 트리에는 커밋 안 된 수정이 남아 있다.
    const name = "colo-design/20260301-1";
    await git(["branch", name]);
    writeFileSync(join(root, "screen.txt"), "고친 줄\n");
    await alignCycleBranch(git, name);
    assert.equal((await git(["symbolic-ref", "--short", "HEAD"])).trim(), name);
    // checkout 은 커밋 안 된 변경을 버리지 않는다 — 저장이 이어지려면 이것이
    // 사이클 브랜치 위에 그대로 남아 있어야 한다.
    assert.equal(readFileSync(join(root, "screen.txt"), "utf8"), "고친 줄\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("맞춤이 실패하면 한국어 문장으로 던진다 — 호출자는 failGate 로 받는다", async () => {
  const failing: (args: string[]) => Promise<string> = async (args) => {
    if (args[0] === "checkout") throw new Error("git checkout에 실패했습니다 (1)");
    return "";
  };
  await assert.rejects(alignCycleBranch(failing, "colo-design/20260301-1"), /작업 브랜치/);
});
