// 잠깐 치워두기: one parked-work ref per clone, written and popped through
// the same conflict vocabulary the refresh path uses.
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { markTurn, type RepoShelf, type RepoShelfRestore } from "@colo-design/protocol";
import {
  type RepoCore,
  SHELF_ALREADY_DETAIL,
  SHELF_COMMIT_MESSAGE,
  SHELF_CONFLICT_DETAIL,
  SHELF_CONFLICT_OPEN_DETAIL,
  SHELF_DIRTY_DETAIL,
  SHELF_EMPTY_DETAIL,
  SHELF_NONE_DETAIL,
  SHELF_REF,
} from "./repo-core.js";

export class ShelfStore {
  constructor(private readonly core: RepoCore) {}

  // -----------------------------------------------------------------------
  // 잠깐 치워두기 (보관함 토론 2026-09-15) — the third door between 저장 and
  // 버리기: one slot, the checkpoint's own snapshot mechanism, and a 3-way
  // 꺼내기 that re-applies instead of rewinding. Never `git stash`.
  // -----------------------------------------------------------------------

  /**
   * 잠깐 치워두기: snapshot the unsaved worktree into SHELF_REF — the
   * checkpoint's own mechanism (a throwaway index, a tree, a parented
   * commit; untracked screens included), so the slot survives the daemon's
   * death like any ref — then clear the worktree through 버리기's one path
   * rule. One slot: filling it twice must name the door out first.
   */
  async shelve(): Promise<RepoShelf> {
    if (!this.core.isCloned()) {
      throw new Error("연결 레포가 준비되지 않았습니다 — 잠시 후 다시 시도해 주세요.");
    }
    await this.core.publishing?.catch(() => undefined);
    await this.core.refreshing?.catch(() => undefined);
    await this.core.shelving?.catch(() => undefined);
    const run = (async () => {
      if (await this.core.shelfExists()) throw new Error(SHELF_ALREADY_DETAIL);
      if ((await this.core.mergeInProgress()) || (await this.core.conflictedFiles()).length > 0) {
        throw new Error(SHELF_CONFLICT_OPEN_DETAIL);
      }
      if ((await this.core.git(["status", "--porcelain"])).trim() === "") {
        throw new Error(SHELF_EMPTY_DETAIL);
      }
      // The snapshot: never HEAD, never the real index — the checkpoint's
      // throwaway-index trick, one ref of its own at the end.
      const temporaryIndex = join(this.core.root, ".git", `colo-design-shelf-${randomUUID()}`);
      const indexEnv = { GIT_INDEX_FILE: temporaryIndex };
      try {
        await this.core.git(["add", "-A"], this.core.root, indexEnv);
        const tree = (await this.core.git(["write-tree"], this.core.root, indexEnv)).trim();
        const head = (await this.core.git(["rev-parse", "HEAD"])).trim();
        const commit = (
          await this.core.git(
            [
              ...(await this.core.identityArgs()),
              "commit-tree",
              tree,
              "-p",
              head,
              "-m",
              `${SHELF_COMMIT_MESSAGE} · 브랜치 ${this.core.branch ?? this.core.baseBranch}`,
            ],
            this.core.root,
            indexEnv,
          )
        ).trim();
        await this.core.git(["update-ref", SHELF_REF, commit]);
      } finally {
        rmSync(temporaryIndex, { force: true });
      }
      // The desk is cleared through 버리기's own rule — the snapshot went
      // first, so what the rule refuses to touch stays honestly in view.
      await this.core.clearUnsavedWork();
      this.core.shelfAt = new Date().toISOString();
      await this.core.refreshPendingChanges();
      this.core.emit();
      return { at: this.core.shelfAt };
    })();
    this.core.shelving = run;
    try {
      return await run;
    } finally {
      this.core.shelving = null;
    }
  }

  /**
   * 치워둔 작업 꺼내기: re-APPLY the shelved work on top of whatever HEAD is
   * now — the shelf's own diff, three ways, exactly what a `git stash pop`
   * computes without entering that namespace. A checkpoint restore would
   * REPLACE the worktree with the shelf-era tree and quietly rewind every
   * 저장 · 최신화 since (되감기가 아니라 다시 얹기 — 보관함 토론의 핵심
   * 판정). Refuses onto a dirty desk; a conflict is the agent.s first task like
   * every conflict here, and the slot SURVIVES it — the cleanup's last step
   * drops the ref, not the failure's.
   */
  async unshelve(onSessionTurn?: (brief: string) => void): Promise<RepoShelfRestore> {
    if (!this.core.isCloned()) {
      throw new Error("연결 레포가 준비되지 않았습니다 — 잠시 후 다시 시도해 주세요.");
    }
    await this.core.publishing?.catch(() => undefined);
    await this.core.refreshing?.catch(() => undefined);
    await this.core.shelving?.catch(() => undefined);
    const run = (async () => {
      if (!(await this.core.shelfExists())) throw new Error(SHELF_NONE_DETAIL);
      if ((await this.core.mergeInProgress()) || (await this.core.conflictedFiles()).length > 0) {
        throw new Error(SHELF_CONFLICT_OPEN_DETAIL);
      }
      if ((await this.core.git(["status", "--porcelain"])).trim() !== "") {
        throw new Error(SHELF_DIRTY_DETAIL);
      }
      const names = (
        await this.core.git(["diff", "--no-renames", "--name-only", `${SHELF_REF}^`, SHELF_REF])
      )
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      // The patch rides a file under `.git/` — never an untracked screen of
      // its own. `--full-index` records the blob identities the 3-way needs;
      // `--binary` carries images a screen change may have brought in.
      const patchFile = join(this.core.root, ".git", `colo-design-shelf-${randomUUID()}.patch`);
      try {
        const patch = await this.core.git([
          "diff",
          "--no-renames",
          "--full-index",
          "--binary",
          `${SHELF_REF}^`,
          SHELF_REF,
        ]);
        writeFileSync(patchFile, patch);
        await this.core.git(["apply", "--3way", "--index", patchFile]);
      } catch (error) {
        // `apply --3way` leaves a conflict as unmerged index entries — the
        // same shape a conflicted 최신화 leaves, so the same net catches it.
        const conflicted = await this.core.conflictedFiles();
        if (conflicted.length > 0) {
          await this.core.refreshPendingChanges();
          this.core.emit();
          if (onSessionTurn) onSessionTurn(this.shelfConflictBrief(conflicted));
          throw new Error(SHELF_CONFLICT_DETAIL);
        }
        throw error;
      } finally {
        rmSync(patchFile, { force: true });
      }
      // A clean landing spends the slot. A conflicted one does not — the
      // brief's cleanup drops the ref once the agent finishes.
      await this.core.git(["update-ref", "-d", SHELF_REF]);
      this.core.shelfAt = null;
      await this.core.refreshPendingChanges();
      this.core.emit();
      return { applied: names };
    })();
    this.core.shelving = run;
    try {
      return await run;
    } finally {
      this.core.shelving = null;
    }
  }

  /**
   * 치워둔 작업 꺼내기가 겹쳤을 때 AI 의 첫 과제 — the pop-conflict
   * brief's shape, the shelf ref's own words. The ref is NOT a stash: the
   * cleanup empties the slot with update-ref, never `git stash drop`.
   */
  private shelfConflictBrief(files: string[]): string {
    return markTurn(
      { kind: "gate", step: "치워둔 작업 꺼내기" },
      "치워둔 작업을 화면에 다시 얹다 겹치는 부분이 생겼습니다.\n" +
        `충돌한 파일:\n${files.map((file) => `- ${file}`).join("\n")}\n` +
        "충돌 표식을 정리한 뒤 git add 로 해결을 표시해 주세요. " +
        "정리가 끝나면 git update-ref -d refs/colo-design/shelf 로 치워둔 자리를 비워 주세요 — " +
        "그 전까지 꺼내기는 같은 작업을 다시 얹으려 합니다.",
    );
  }
}
