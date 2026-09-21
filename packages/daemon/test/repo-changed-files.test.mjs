/**
 * 재검수가 세는 수와, 그것을 읽는 파서의 계약.
 *
 * P2-1 에서 파일 **목록**(`RepoStatus.changedFiles`)은 선로를 떠났다 — 그것을
 * 그리던 변경 점 스트립이 사라져 읽는 화면이 하나도 없다. 남는 계약은 둘:
 * 칩이 읽는 `pendingChanges` 가 정확하다는 것과, 그 수를 만드는 porcelain ·
 * numstat 파서가 git 의 글자를 제대로 읽는다는 것(`api.diff()` 의 버리기
 * 확인이 같은 파서를 쓴다).
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

test("재검수의 수는 워크트리 그대로 — 수정·추가·삭제 셋", async () => {
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
    assert.equal(
      status.changedFiles,
      undefined,
      "파일 목록은 선로를 떠났다 — 읽는 화면이 없는 값을 매 방송마다 나르지 않는다",
    );

    await workspace.stop().catch(() => undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("깨끗한 워크트리의 수는 0", async () => {
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
