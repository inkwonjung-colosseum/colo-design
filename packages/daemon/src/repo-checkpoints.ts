// PLAN D52 checkpoints: snapshot refs under refs/colo-design/checkpoints,
// kept out of the worktree so a snapshot can never dirty the diff it saves.
import { randomUUID } from "node:crypto";
import { rmdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RepoCheckpoint, RepoCheckpointRestore, RepoCheckpoints } from "@colo-design/protocol";
import { CHECKPOINT_REF_PREFIX, CHECKPOINTS_PER_SESSION, type RepoCore } from "./repo-core.js";
import { restorePlan, safeRepoPath } from "./repo-paths.js";

export class CheckpointStore {
  constructor(private readonly core: RepoCore) {}

  /**
   * One 화면 turn's snapshot (PLAN D52), taken by the server the moment the
   * turn is handed to the session: the whole worktree — untracked screens
   * included — into a throwaway index, a tree, a parented commit, and a ref
   * under `refs/colo-design/checkpoints/<sessionId>/<turn>`. HEAD, the real
   * index and the worktree itself are never touched, which is exactly why
   * this is not a stash: a stash cannot carry untracked files and a first
   * screen is untracked by definition.
   */
  async checkpoint(sessionId: string, turn: number): Promise<RepoCheckpoint> {
    const ref = `${CHECKPOINT_REF_PREFIX}/${sessionId}/${turn}`;
    // Inside `.git/` so it can never surface as an untracked file of its own.
    const temporaryIndex = join(this.core.root, ".git", `colo-design-checkpoint-${randomUUID()}`);
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
            `Colo Design 체크포인트 · 대화 ${sessionId} · 턴 ${turn}`,
          ],
          this.core.root,
          indexEnv,
        )
      ).trim();
      await this.core.git(["update-ref", ref, commit]);
    } finally {
      rmSync(temporaryIndex, { force: true });
    }
    await this.pruneCheckpoints(sessionId);
    return {
      id: `${sessionId}/${turn}`,
      sessionId,
      turn,
      at: new Date().toISOString(),
    };
  }

  /** D52: a session keeps its newest snapshots; older refs are deleted. */
  private async pruneCheckpoints(sessionId: string): Promise<void> {
    const refs = await this.checkpointRefs(`${CHECKPOINT_REF_PREFIX}/${sessionId}`);
    for (const ref of refs.slice(0, Math.max(0, refs.length - CHECKPOINTS_PER_SESSION))) {
      await this.core.git(["update-ref", "-d", ref]).catch(() => undefined);
    }
  }

  /** 반영됨 (PLAN D52): a merged cycle's snapshots are history, not exits. */
  async clearCheckpoints(): Promise<void> {
    for (const ref of await this.checkpointRefs(CHECKPOINT_REF_PREFIX)) {
      await this.core.git(["update-ref", "-d", ref]).catch(() => undefined);
    }
  }

  /** Snapshot refs under `prefix`, oldest first. */
  private async checkpointRefs(prefix: string): Promise<string[]> {
    if (!this.core.isCloned()) return [];
    return (
      await this.core.git(["for-each-ref", "--sort=committerdate", "--format=%(refname)", prefix])
    )
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /** Every snapshot the planner can still step back to (PLAN D52). */
  async checkpoints(): Promise<RepoCheckpoints> {
    const prefix = `${CHECKPOINT_REF_PREFIX}/`;
    const out = await this.core
      .git([
        "for-each-ref",
        "--sort=committerdate",
        "--format=%(refname)%09%(committerdate:iso8601-strict)",
        CHECKPOINT_REF_PREFIX,
      ])
      .catch(() => "");
    const entries: RepoCheckpoint[] = [];
    for (const line of out.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      const [refname = "", at = ""] = line.split("\t");
      const id = refname.startsWith(prefix) ? refname.slice(prefix.length) : "";
      const slash = id.lastIndexOf("/");
      if (id === "" || slash <= 0) continue;
      entries.push({
        id,
        sessionId: id.slice(0, slash),
        turn: Number(id.slice(slash + 1)) || 0,
        at,
      });
    }
    return { entries };
  }

  /**
   * Put the worktree back the way it stood when a turn started (PLAN D52).
   * The move list is `git diff --name-status <tree>` filtered through the
   * one path rule: allowed paths that the snapshot has are checked out,
   * allowed paths it never had are deleted. Merge-conflicted paths (U) are
   * left for the agent, exactly like a refresh leaves them.
   */
  async checkpointRestore(id: string): Promise<RepoCheckpointRestore> {
    if (!this.core.isCloned()) return { restored: [] };
    // `id` is `<sessionId>/<turn>`, handed back verbatim from checkpoints().
    const ref = `${CHECKPOINT_REF_PREFIX}/${id}`;
    const tree = (await this.core.git(["rev-parse", `${ref}^{tree}`]).catch(() => "")).trim();
    if (tree === "") {
      throw new Error("되돌릴 체크포인트를 찾지 못했습니다 — 목록을 다시 불러와 주세요.");
    }
    const raw = await this.core.git([
      "-c",
      "core.quotepath=false",
      "diff",
      "--name-status",
      "--no-renames",
      tree,
    ]);
    const plan = restorePlan(raw);
    // Untracked files the snapshot predates never appear in `git diff` —
    // and they are exactly what "스냅샷에 없던 파일은 삭제" is about: the
    // first screen a turn just made existed nowhere when the turn began.
    const inSnapshot = new Set(
      (await this.core.git(["ls-tree", "-r", "--name-only", tree]))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const bornAfter = (
      await this.core.git([
        "-c",
        "core.quotepath=false",
        "ls-files",
        "--others",
        "--exclude-standard",
      ])
    )
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((path) => path !== "" && !inSnapshot.has(path) && safeRepoPath(path) !== null);
    if (plan.checkout.length > 0) await this.core.git(["checkout", tree, "--", ...plan.checkout]);
    for (const path of [...plan.remove, ...bornAfter]) {
      rmSync(join(this.core.root, path), { force: true });
      // Folders the snapshot predates close behind it, quietly.
      let dir = dirname(join(this.core.root, path));
      while (dir.startsWith(this.core.root) && dir !== this.core.root) {
        try {
          rmdirSync(dir);
        } catch {
          break; // not empty — the snapshot era had company here
        }
        dir = dirname(dir);
      }
    }
    await this.core.refreshPendingChanges();
    return {
      restored: [...plan.checkout, ...plan.remove, ...bornAfter].sort(),
    };
  }
}
