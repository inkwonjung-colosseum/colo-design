import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { SHELF_REF } from "../dist/repo-core.js";
// `../dist` 임포트인 이유: repo-shelf 의 src 는 `.js` 지정자(`./repo-core.js`)로
// 형제를 부르는데, node 의 타입 지우기는 그 지정을 `.ts` 로 고쳐 주지 않는다.
// `pnpm test` 가 빌드를 먼저 돌리는 이유다(turn-stats-measure.test 와 같은 길).
import { recoverShelfPatch } from "../dist/repo-shelf.js";

const exec = promisify(execFile);

/** GitRun 의 몫 — recoverShelfPatch 가 받는 최소 계약 그대로. */
function gitOf(root: string) {
  return (args: string[]) => exec("git", args, { cwd: root }).then((done) => done.stdout as string);
}

async function makeRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "colo-shelf-recover-"));
  const git = gitOf(root);
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "test@colo-design"]);
  await git(["config", "user.name", "테스트"]);
  writeFileSync(join(root, "screen.txt"), "첫 줄\n");
  await git(["add", "-A"]);
  await git(["commit", "-m", "첫 커밋"]);
  return root;
}

/**
 * 옛 shelve(v0.3.8~v0.3.10)가 만들던 슬롯 — 부모가 HEAD인 커밋에 작업 폴더
 * 스냅샷을 실은 뒤 refs/colo-design/shelf 로 가리킨다. throwaway index 는
 * 그 명령이 쓰던 GIT_INDEX_FILE 트릭 그대로.
 */
async function makeSlot(root: string): Promise<void> {
  const indexPath = join(root, ".git", "colo-design-shelf-test-index");
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  await exec("git", ["add", "-A"], { cwd: root, env });
  const tree = (await exec("git", ["write-tree"], { cwd: root, env })).stdout.trim();
  const git = gitOf(root);
  const head = (await git(["rev-parse", "HEAD"])).trim();
  const commit = (
    await exec("git", ["commit-tree", tree, "-p", head, "-m", "Colo Design 잠깐 치워두기"], {
      cwd: root,
      env,
    })
  ).stdout.trim();
  await git(["update-ref", SHELF_REF, commit]);
  rmSync(indexPath, { force: true });
}

/** shelve 가 워크트리를 비운 뒤의 모양 — 슬롯만 남고 바닥은 깨끗하다. */
async function clearWorktree(root: string): Promise<void> {
  const git = gitOf(root);
  await git(["checkout", "HEAD", "--", "."]);
  await exec("git", ["clean", "-fd"], { cwd: root });
}

test("슬롯이 없으면 none 이다", async () => {
  const root = await makeRepo();
  try {
    assert.equal(await recoverShelfPatch(gitOf(root), root), "none");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("파일 수정 + 새 파일 슬롯을 깨끗한 바닥에 restored — 두 파일이 돌아오고 ref 가 사라진다", async () => {
  const root = await makeRepo();
  try {
    const git = gitOf(root);
    writeFileSync(join(root, "screen.txt"), "첫 줄\n고친 줄\n");
    writeFileSync(join(root, "new-screen.txt"), "새 화면\n");
    await makeSlot(root);
    await clearWorktree(root);
    assert.equal((await git(["status", "--porcelain"])).trim(), "");

    assert.equal(await recoverShelfPatch(gitOf(root), root), "restored");
    assert.equal(readFileSync(join(root, "screen.txt"), "utf8"), "첫 줄\n고친 줄\n");
    assert.equal(readFileSync(join(root, "new-screen.txt"), "utf8"), "새 화면\n");
    await assert.rejects(git(["rev-parse", "-q", "--verify", SHELF_REF]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("작업 폴더가 더러우면 kept — ref 와 바닥이 그대로다", async () => {
  const root = await makeRepo();
  try {
    const git = gitOf(root);
    writeFileSync(join(root, "screen.txt"), "첫 줄\n고친 줄\n");
    writeFileSync(join(root, "new-screen.txt"), "새 화면\n");
    await makeSlot(root);
    await clearWorktree(root);
    writeFileSync(join(root, "지금-작업.txt"), "진행 중\n");

    assert.equal(await recoverShelfPatch(gitOf(root), root), "kept");
    await git(["rev-parse", "-q", "--verify", SHELF_REF]); // 슬롯은 살아 있다
    assert.equal(readFileSync(join(root, "지금-작업.txt"), "utf8"), "진행 중\n");
    assert.equal(readFileSync(join(root, "screen.txt"), "utf8"), "첫 줄\n");
    assert.equal(existsSync(join(root, "new-screen.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("패치가 깨끗하게 안 얹히면 kept — ref 는 남고 바닥은 깨끗하고 표식도 없다", async () => {
  const root = await makeRepo();
  try {
    const git = gitOf(root);
    writeFileSync(join(root, "screen.txt"), "첫 줄\n고친 줄\n");
    await makeSlot(root);
    await clearWorktree(root);
    // 슬롯 이후 HEAD 가 같은 줄을 다르게 바꿨다 — 3way 도 얹지 못한다.
    writeFileSync(join(root, "screen.txt"), "첫 줄\nHEAD 가 바꾼 줄\n");
    await git(["add", "-A"]);
    await git(["commit", "-m", "슬롯 뒤 커밋"]);

    assert.equal(await recoverShelfPatch(gitOf(root), root), "kept");
    await git(["rev-parse", "-q", "--verify", SHELF_REF]); // 슬롯은 살아 있다
    assert.equal((await git(["status", "--porcelain"])).trim(), "");
    assert.equal((await git(["diff", "--name-only", "--diff-filter=U"])).trim(), "");
    assert.equal(readFileSync(join(root, "screen.txt"), "utf8"), "첫 줄\nHEAD 가 바꾼 줄\n");
    assert.equal(readFileSync(join(root, "screen.txt"), "utf8").includes("<<<<<<<"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
