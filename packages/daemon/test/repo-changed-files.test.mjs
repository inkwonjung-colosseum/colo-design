/**
 * 변경 점 스트립의 데이터 절반 — the recount that moves the chip's number now
 * also lists the files (`RepoStatus.changedFiles`). These tests pin the
 * contract the strip renders: the list always equals the count, sizes come
 * from numstat only where git can count, and a same-count content edit still
 * moves the rows (the old count-only guard would have frozen the strip).
 *
 * Prerequisites: `pnpm --filter @colo-design/daemon build`
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { numstatCounts, parseStatusRows, sameChangedFiles } from "../dist/repo-diff.js";
import { createFixtureRepo, freePort } from "./fixture-repo.mjs";
import { bringUp, promisifiedRun, workdir } from "./repo-test-kit.mjs";

const git = (root, ...args) => promisifiedRun("git", ["-C", root, ...args]);

test("재검수는 칩이 세는 파일을 그대로 나른다 — 수정·추가·삭제와 ±수", async () => {
  const dir = workdir("hub-changed-files-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
    const workspace = await bringUp(dir, fixture);
    const root = join(dir, "work");

    // Modified: one existing line out, two lines in. Deleted: a tracked file
    // gone. Added: a brand-new untracked screen.
    const claude = await git(root, "show", "HEAD:CLAUDE.md");
    writeFileSync(
      join(root, "CLAUDE.md"),
      claude.replace(
        "- 만들거나 바꾼 화면을 이름과 경로로 답변에 남긴다.",
        "- 만들거나 바꾼 화면을 이름과 경로로 답변에 남깁니다.\n- 답변의 경로는 저장 전 그대로다.",
      ),
    );
    await git(root, "rm", "-q", "index.html");
    mkdirSync(join(root, "src", "screens", "new"), { recursive: true });
    writeFileSync(join(root, "src", "screens", "new", "New.screen.tsx"), "export {};\n");

    await workspace.refreshPendingChanges();
    const status = await workspace.status();
    assert.equal(status.pendingChanges, 3);
    assert.equal(status.changedFiles.length, status.pendingChanges, "list equals the count");

    const modified = status.changedFiles.find((row) => row.path === "CLAUDE.md");
    assert.equal(modified?.status, "modified");
    assert.equal(modified?.added, 2);
    assert.equal(modified?.removed, 1);

    const deleted = status.changedFiles.find((row) => row.path === "index.html");
    assert.equal(deleted?.status, "deleted");
    assert.ok((deleted?.removed ?? 0) > 0, "a deletion names its size");

    const added = status.changedFiles.find((row) => row.path === "src/screens/new/New.screen.tsx");
    assert.equal(added?.status, "added");
    assert.equal(added?.added, null, "untracked has no numstat row — no guessed size");
    assert.equal(added?.removed, null);

    await workspace.stop().catch(() => undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("개수가 같은 내용 편집도 행을 다시 움직인다 — ±가 먼저 늙으면 안 된다", async () => {
  const dir = workdir("hub-changed-same-count-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
    const workspace = await bringUp(dir, fixture);
    const root = join(dir, "work");

    const claude = await git(root, "show", "HEAD:CLAUDE.md");
    writeFileSync(join(root, "CLAUDE.md"), `${claude}첫 편집\n`);
    await workspace.refreshPendingChanges();
    const first = (await workspace.status()).changedFiles.find((row) => row.path === "CLAUDE.md");
    assert.equal(first?.added, 1);

    // Same file, same count (1) — only the ± moved.
    writeFileSync(join(root, "CLAUDE.md"), `${claude}첫 편집\n둘째 편집\n셋째 편집\n`);
    await workspace.refreshPendingChanges();
    const second = (await workspace.status()).changedFiles.find((row) => row.path === "CLAUDE.md");
    assert.equal((await workspace.status()).pendingChanges, 1, "the count did not move");
    assert.equal(second?.added, 3, "but the strip's sizes did");
    assert.equal(sameChangedFiles([first], [second]), false);

    await workspace.stop().catch(() => undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("개명 행은 새 경로로, ±는 조용히 — git 이 셀 수 없는 크기는 비워 둔다", async () => {
  const dir = workdir("hub-changed-rename-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
    const workspace = await bringUp(dir, fixture);
    const root = join(dir, "work");

    writeFileSync(join(root, "notes.txt"), "메모\n");
    await git(root, "add", "notes.txt");
    await git(
      root,
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=test",
      "commit",
      "-m",
      "memo",
    );
    await git(root, "mv", "notes.txt", "memos.txt");

    await workspace.refreshPendingChanges();
    const renamed = (await workspace.status()).changedFiles.find((row) => row.path === "memos.txt");
    assert.equal(renamed?.status, "renamed", "the row names the path that exists now");
    assert.equal(renamed?.added, null);
    assert.equal(renamed?.removed, null);

    await workspace.stop().catch(() => undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("깨끗한 워크트리의 목록은 비어 있다", async () => {
  const dir = workdir("hub-changed-clean-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
    const workspace = await bringUp(dir, fixture);
    await workspace.refreshPendingChanges();
    const status = await workspace.status();
    assert.equal(status.pendingChanges, 0);
    assert.deepEqual(status.changedFiles, []);
    await workspace.stop().catch(() => undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("porcelain 과 numstat 의 글자 — 파서의 계약", () => {
  const rows = parseStatusRows(
    [
      " M src/a.ts", // edited in the worktree
      "M  src/b.ts", // staged
      "?? src/new.tsx", // untracked
      " D old.txt", // deleted in the worktree
      "R  old-name.ts -> new-name.ts", // staged rename
      "AD both.txt", // staged add, worktree delete — the net word wins
      "AM fresh.ts", // staged add, re-edited — still one added row
      "",
    ].join("\n"),
  );
  assert.deepEqual(rows, [
    { path: "src/a.ts", status: "modified" },
    { path: "src/b.ts", status: "modified" },
    { path: "src/new.tsx", status: "added" },
    { path: "old.txt", status: "deleted" },
    { path: "new-name.ts", status: "renamed" },
    { path: "both.txt", status: "deleted" },
    { path: "fresh.ts", status: "added" },
  ]);

  const counts = numstatCounts(
    [
      "2\t1\tsrc/a.ts",
      "-\t-\tsrc/blob.bin", // binary — no size to tell
      "4\t0\told.ts => new.ts", // rename — the new path never matches
      "1\t2\tsrc/{old => new}/c.ts", // rename with a shared dir
      "not-a-numstat-line",
    ].join("\n"),
  );
  assert.deepEqual(counts, { "src/a.ts": { added: 2, removed: 1 } });

  assert.equal(sameChangedFiles(rows.slice(0, 2), rows.slice(0, 2)), true);
  assert.equal(sameChangedFiles(rows.slice(0, 2), rows.slice(0, 1)), false);
  assert.equal(
    sameChangedFiles(
      [{ path: "a", status: "modified", added: 1, removed: null }],
      [{ path: "a", status: "modified", added: 1, removed: null }],
    ),
    true,
  );
  assert.equal(
    sameChangedFiles(
      [{ path: "a", status: "modified", added: 1, removed: null }],
      [{ path: "a", status: "modified", added: 2, removed: null }],
    ),
    false,
  );
});
