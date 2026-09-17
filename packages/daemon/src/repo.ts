import { rmSync } from "node:fs";
import type {
  DiffFile,
  DiffStatus,
  HandoffShot,
  HandoffStatus,
  HandoffStatusReport,
  RepoCheckpoint,
  RepoCheckpointRestore,
  RepoCheckpoints,
  RepoDiscard,
  RepoHandoffDraft,
  RepoHistory,
  RepoShelf,
  RepoShelfRestore,
  RepoStatus,
} from "@colo-design/protocol";

// 셋 다 이 모듈이 쓰면서 동시에 이 모듈의 표면이다 — 검사와 온보딩이
// `dist/repo.js` 에서 이 이름들을 가져간다.
export {
  extraPathPrefix,
  repoSettingsWarning,
  sanitizeRepoAgentSettings,
  trustWorkspace,
} from "./claude-trust.js";
export { buildCommentsSection } from "./handoff-body.js";
// 상수와 URL 게이트는 repo-core.ts 로 옮겼다 — 표면은 여기서 다시보낸다.
export { assertClonableRepoUrl, PUSH_AUTH_FAILURE, REPO_URL_MISSING_DETAIL } from "./repo-core.js";
export { parseUnifiedDiff } from "./repo-diff.js";
export { restorePlan, safeRepoPath } from "./repo-paths.js";

import { BringUp } from "./repo-bringup.js";
import { CheckpointStore } from "./repo-checkpoints.js";
import type { RepoRegistry } from "./repo-config.js";
import {
  detailOf,
  REPO_URL_MISSING_DETAIL,
  RepoCore,
  type RepoWorkspaceOptions,
} from "./repo-core.js";
import { safeRepoPath } from "./repo-paths.js";
import { PublishCycle } from "./repo-publish.js";
import { ShelfStore } from "./repo-shelf.js";
import { RepoSummarizer } from "./repo-summary.js";

/**
 * The connected repo workspace: a clone of the repo the planner pointed the
 * daemon at, driven by what that repo already says — its lockfile, its
 * `package.json` scripts, its `.npmrc` (repo-config.ts).
 * The daemon clones and pulls it, runs its commands, and frames its preview
 * server — what the preview renders is entirely the repo's business.
 *
 * Facade over five parts: `repo-core.ts` holds the shared state and the
 * git/capture/emit plumbing; `repo-checkpoints.ts`, `repo-shelf.ts`,
 * `repo-publish.ts`, `repo-summary.ts` and `repo-bringup.ts` own the
 * domains. This class keeps the wire-facing methods — the guards that
 * decide which collaborator runs — and delegates the rest.
 */
export class RepoWorkspace {
  readonly root: string;
  /**
   * The branch a handoff PR will target (PLAN D5[넘기기]). Nothing reads it in M1; it
   * lives beside the url because the same project decision fixes both.
   */
  readonly baseBranch: string;

  private readonly core: RepoCore;
  private readonly checkpointStore: CheckpointStore;
  private readonly shelfStore: ShelfStore;
  private readonly summarizer: RepoSummarizer;
  private readonly bringup: BringUp;
  private readonly publish: PublishCycle;

  constructor(options: RepoWorkspaceOptions) {
    this.core = new RepoCore(options);
    this.checkpointStore = new CheckpointStore(this.core);
    this.shelfStore = new ShelfStore(this.core);
    this.summarizer = new RepoSummarizer(this.core);
    this.bringup = new BringUp(this.core);
    this.publish = new PublishCycle(this.core, {
      claudeMemo: (files) => this.summarizer.claudeMemo(files),
      clearCheckpoints: () => this.checkpointStore.clearCheckpoints(),
      onCycleEvent: options.onCycleEvent,
    });
    this.root = options.root;
    this.baseBranch = options.baseBranch ?? "main";
  }

  /**
   * Whether this project is the one on screen. Only the active project may
   * START a preview (the bring-up gates below); an inactive one keeps the
   * server it already has warm, so coming back is a repaint, not a bring-up
   * — the server stops only for a port fence or the warm cap.
   */
  setActive(active: boolean): void {
    this.core.setActive(active);
  }

  /** A preview process this workspace owns right now, warm or on screen. */
  get previewRunning(): boolean {
    return this.core.previewRunning;
  }

  /**
   * Ready AND served by its own process: a return to this project needs no
   * bring-up, only the quiet refresh (`pull`) that never touches the server.
   */
  get previewLive(): boolean {
    return this.core.previewLive;
  }

  get remoteUrl(): string | null {
    return this.core.remoteUrl;
  }

  /**
   * The machine-wide GitHub token, injected by the server: the workspace is
   * built synchronously, while reading the store is not. This is a load, not
   * a change — nothing is persisted here; the token lives in exactly one
   * credential item and the server is what points every workspace at it.
   */
  setPat(pat: string | null): void {
    this.core.setPat(pat);
  }

  /** The error card's 실행 허용 button lands here (project.update). */
  setCommandsApproved(approved: boolean): void {
    this.core.setCommandsApproved(approved);
  }

  /** The repo's private registry, once the clone's config was resolved. */
  registry(): RepoRegistry | null {
    return this.core.registry();
  }

  /**
   * Disk state only; safe to call from any client at any time.
   *
   * The shelf is read from the REF the first time a status is asked on a
   * clone, not left at the memory field's `null`. Without this probe the
   * first status after a daemon restart says "no shelf": the menu offers
   * 잠깐 치워두기 (which the ref-checking `shelve` then refuses) and hides
   * 꺼내기 — 치워둔 작업이 분실로 읽히는 그 자리다. `refreshPendingChanges`
   * keeps it current afterwards, so this costs one `for-each-ref` per
   * daemon lifetime rather than one per poll.
   */
  status(): Promise<RepoStatus> {
    return this.core.status();
  }

  sync(force = false): Promise<RepoStatus> {
    // A 다시 시작 pressed while a bootstrap crawls waits that run out instead
    // of riding it. The port itself needs no mandate any more: every bring-up
    // reclaims the declared port for the active project (startPreview).
    if (this.core.inFlight && force) return this.core.inFlight.then(() => this.sync(true));
    if (this.core.inFlight) return this.core.inFlight;
    this.core.inFlight = this.bringup.bootstrap().finally(() => {
      this.core.inFlight = null;
    });
    return this.core.inFlight;
  }

  /**
   * Set the url and bring the workspace to the resulting state: a moved url
   * means a different repository, so the old clone is discarded and
   * re-cloned. Persistence is the owner's: a moved url is handed to
   * `onUrlChange` — the project registry is the only place it is written.
   */
  async update(changes: { url?: string | null }): Promise<RepoStatus> {
    // Absent keys stay unchanged; `null` clears.
    const urlChanged = changes.url !== undefined && changes.url !== this.core.url;
    if (changes.url !== undefined) this.core.url = changes.url;
    // Only a real move is announced: a re-submitted identical url must not
    // make the registry rewrite (and broadcast) a project that did not change.
    if (urlChanged) this.core.onUrlChange?.(this.core.url);

    if (!this.core.url) {
      await this.stop();
      this.core.setPhase("missing", REPO_URL_MISSING_DETAIL);
      return this.core.snapshot();
    }

    if (urlChanged) {
      // 클론을 지우기 전에 그 클론을 쓰는 모든 손을 기다린다 — 저장·최신화·
      // 부팅 도중의 rmSync 는 반쯤 지워진 클론과 날아간 약속을 남긴다.
      await this.settle();
      await this.stop();
      rmSync(this.root, { recursive: true, force: true });
    } else if (this.core.isCloned()) {
      // Auth rides the environment now, but a clone made before that still
      // carries the PAT inside its remote url — the one place the keychain
      // promise must never leak. Idempotent; a clean origin is a no-op read.
      await this.core.scrubOriginCredential();
    }
    // A moved url means a different repository: force re-reads the disk state
    // (the old clone's in-flight bootstrap must not pose as this one's).
    return await this.sync(urlChanged);
  }

  async stop(): Promise<void> {
    await this.bringup.killPreview();
  }

  /**
   * Everything that may still be writing to this clone, settled. A stop that
   * only killed the preview could kill a 최신화 between its stash and its
   * pop — the planner's unsaved work parks in `git stash` with nothing left
   * running to bring it back. Shutdown waits the writers out first;
   * `recoverParkedWork` is the net for the kills no wait survives.
   */
  async settle(): Promise<void> {
    await this.core.publishing?.catch(() => undefined);
    await this.core.refreshing?.catch(() => undefined);
    await this.core.shelving?.catch(() => undefined);
    await this.core.inFlight?.catch(() => undefined);
  }

  /**
   * Session start · 레포 최신화: bring the clone current without tearing its
   * preview down, and without asking the planner to read git. Off-cycle that
   * is a fast-forward of the base branch; mid-cycle it is a merge of the
   * developer's base into this cycle's work. Unsaved work rides along (see
   * refreshFromRemote), a conflict becomes the session's first task, and a
   * plain failure stays a `detail`: hiding a live preview mid-conversation
   * is worse than being a commit behind until the next sync() reports the
   * failure properly.
   */
  async pull(
    onSessionTurn?: (brief: string) => void,
    opts?: { report?: boolean },
  ): Promise<"clean" | "conflict" | undefined> {
    if (!this.core.isCloned()) return;
    // 준비가 충돌로 멈춘 상태(phase error)에서도 문은 열려 있어야 한다(D96):
    // 오류 카드의 AI 요청이 읽을 것은 바로 그 상태고, 새 대화가 태어날 때의
    // 이 pull 이 충돌을 첫 과제로 넣는다. error 이후의 상태는 어차피 없고,
    // clone 이 없는 실패(내려받기 실패)는 위에서 걸린다.
    if (this.core.phase !== "ready" && this.core.phase !== "error") return;
    // One worktree, two writers: a save or handoff in flight owns it, so
    // the refresh waits — and a save below waits for a refresh the same
    // way. Without this, the stash-move-replay window races `git diff` and
    // the planner's save can read a worktree that is momentarily parked.
    if (this.core.publishing) await this.core.publishing.catch(() => undefined);
    if (this.core.shelving) await this.core.shelving.catch(() => undefined);
    // A refresh already in flight owns the worktree the same way — a second
    // pull queues behind it instead of racing its stash-move-replay window.
    if (this.core.refreshing) await this.core.refreshing.catch(() => undefined);
    console.error("[pull] start");
    const run = this.core
      .refreshFromRemote(onSessionTurn)
      .then(async (outcome) => {
        console.error("[pull] refreshFromRemote done:", outcome);
        // A conflict brief leaves the worktree mid-resolution: the delivery chip's
        // count must show it (the unmerged files are changes awaiting 저장),
        // and an install or preview restart would only bury the brief in
        // noise — so no sync runs on that path. A clean refresh ends with
        // the worktree exactly the planner's edits on the new HEAD:
        // recount, or let the dependency-driven sync recount at its end.
        if (outcome === "conflict") await this.core.refreshPendingChanges();
        else if (this.bringup.dependenciesMoved()) await this.sync();
        else await this.core.refreshPendingChanges();
        return outcome;
      })
      .catch((error) => {
        this.core.setDetail(detailOf(error, this.core.pat));
        // The 최신화 button's caller reports: a failure the planner asked for
        // by pressing a button must land as words on the screen, not only in
        // the status detail no card renders while phase stays ready.
        if (opts?.report) throw error;
        return undefined;
      })
      .finally(() => {
        this.core.refreshing = null;
      });
    this.core.refreshing = run;
    // The outcome is the caller's answer: the 최신화 button's "N건을 받아
    // 왔습니다" record and the tests both read it. A bare `await run` dropped
    // it on the floor, leaving that record dead code.
    return await run;
  }

  /**
   * 최신화 버튼이 열린 대화 없이 눌렸을 때의 사전 확인 (실사 P0 — 조용한
   * no-op). 사이클 브랜치에 올라탄 클론의 병합은 충돌 시 AI 의 첫 과제가
   * 되야 하므로 혼자 하지 않는다 — 대신 fetch 로 원격을 확인해 무엇이 기다리는
   * 지 알려준다. null 이면 막을 이유가 없다: 베이스 브랜치 위의 fast-forward 는
   * 혼자서도 안전하고, 새 커밋이 없으면 할 일 자체가 없다.
   */
  refreshNeedsThread(): Promise<number | null> {
    return this.core.refreshNeedsThread();
  }

  // -------------------------------------------------------------------------
  // The handoff cycle (PLAN D5[넘기기]): 저장 → 개발자에게 넘기기 → 반영됨
  // -------------------------------------------------------------------------

  diff(): Promise<DiffFile[]> {
    return this.core.diff();
  }

  /** The branch this cycle's saves land on, or null before the first 저장. */
  get currentBranch(): string | null {
    return this.core.currentBranch;
  }

  get currentHandoff(): HandoffStatus | null {
    return this.core.currentHandoff;
  }

  /**
   * 커미티 2026-09-15 판정 1·2: 폴링이 **읽어서 본** 사이클의 끝(반영됨·반려).
   * 칩에는 아직 반영하지 않는다 — 끝을 칩에만 적고 착지를 미루면 `this.branch`
   * 가 살아 있어 다음 저장이 이미 닫힌 브랜치로 푸시된다(ensureCycleBranch 가
   * 이름이 있으면 그대로 쓴다). 그래서 끝은 여기 따로 세워 두고, 사람이 있는
   * 자리(상태 확인 · 프로젝트 활성화 · 다음 저장의 머리)에서만 내려앉힌다.
   */
  get handoffLandingDue(): boolean {
    return this.publish.landingDue;
  }

  /**
   * 커미티 B1 (2026-09-15): 최신화(pull)가 돌고 있는가 — handoff 폴링이 이
   * 사이에 refreshHandoff 를 겹치지 않게 하는 수단. 저장·넘기기의 판정은
   * 서버가 diffStage 로 이미 알고, 이쪽은 레포 자체의 손길만 센다.
   */
  get busyRefreshing(): boolean {
    return this.core.refreshing !== null;
  }

  /** Last counted unsaved-change files — the sidebar badge's number (PLAN D16). */
  get pendingChangeCount(): number {
    return this.core.pendingChanges;
  }

  /**
   * 저장: review → commit → push, onto this cycle's own branch.
   *
   * The base branch is never written to. A developer receives this work as a
   * pull request they can read, run and refuse — pushing past them was what
   * the old `push origin HEAD` did, and it is the one thing a tool driven by
   * someone who does not read diffs must not do.
   *
   * The repo's own `check` does not gate this anymore (실사: a save stuck at
   * 레포 검사 left work the planner could not put up). Problems are the
   * developer's to catch in the pull request 넘기기 opens; the agent can still
   * run the check inside a turn when it wants one.
   */
  save(
    options: {
      message?: string;
      onSessionTurn?: (brief: string) => void;
      /** hero-synthesis D1: the conversation this save belongs to. */
      sessionId?: string;
    } = {},
  ): Promise<DiffStatus> {
    // 날아가는 저장을 돌려주면 새로 온 메시지는 조용히 증발한다 — 거절이 답이다.
    if (this.core.publishing) {
      throw new Error("저장이 진행 중입니다 — 끝나면 다시 눌러 주세요.");
    }
    this.core.publishing = this.publish.runSave(options).finally(() => {
      this.core.publishing = null;
    });
    return this.core.publishing;
  }

  handoff(
    options: {
      title?: string;
      body?: string;
      /** The server's preview-driver captures (PLAN D56), already taken. */
      shots?: HandoffShot[];
      onSessionTurn?: (brief: string) => void;
      /** hero-synthesis D1: the conversation this handoff belongs to. */
      sessionId?: string;
      /** D93: the project's comment store, for the PR body. */
      commentsFile?: string;
    } = {},
  ): Promise<DiffStatus> {
    if (this.core.publishing) {
      throw new Error("넘기기가 진행 중입니다 — 끝나면 다시 눌러 주세요.");
    }
    this.core.publishing = this.publish.runHandoff(options).finally(() => {
      this.core.publishing = null;
    });
    return this.core.publishing;
  }

  refreshHandoff(): Promise<HandoffStatusReport | null> {
    return this.publish.refreshHandoff();
  }

  /**
   * 보낸 화면 동결: the committed capture for one
   * screen·state, read off the handoff branch — the frozen stage's picture.
   */
  handoffShot(
    route: string,
    state: string | null,
  ): Promise<{ mediaType: string; data: string } | null> {
    return this.publish.handoffShot(route, state);
  }

  peekHandoff(): Promise<HandoffStatusReport | null> {
    return this.publish.peekHandoff();
  }

  landHandoffIfDue(): Promise<void> {
    return this.publish.landHandoffIfDue();
  }

  replyToReview(id: number, body: string): Promise<void> {
    return this.publish.replyToReview(id, body);
  }

  cycleAnchor(): Promise<string | null> {
    return this.core.cycleAnchor();
  }

  handoffDraft(
    options: { commentsFile?: string; shotCount?: number } = {},
  ): Promise<RepoHandoffDraft> {
    return this.summarizer.handoffDraft(options);
  }

  history(): Promise<RepoHistory> {
    return this.core.history();
  }

  /**
   * 되돌리기 (PLAN D53): bring the worktree back to a saved point as a NEW
   * commit on the cycle branch, pushed like any save. A developer may be
   * reading that branch right now, so reset · revert · force-push do not
   * exist here — the history only grows, and the commit says 되돌리기.
   */
  async restore(sha: string): Promise<DiffStatus> {
    if (!this.core.isCloned()) {
      return this.core.setDiff({
        stage: "failed",
        gate: "diff",
        detail: "연결 레포가 준비되지 않았습니다 — 잠시 후 다시 시도해 주세요.",
      });
    }
    // The same worktree contract as a save: a refresh settling underneath a
    // restore would half-undo two different moments at once.
    while (this.core.publishing) await this.core.publishing.catch(() => undefined);
    await this.core.refreshing?.catch(() => undefined);
    await this.core.shelving?.catch(() => undefined);
    const dirty = await this.core.git(["-c", "core.quotepath=false", "status", "--porcelain"]);
    if (dirty.trim() !== "") {
      return this.core.setDiff({
        stage: "failed",
        gate: "diff",
        detail:
          "저장하지 않은 변경이 있습니다 — 먼저 저장하거나 되돌려 주세요. 저장은 저장 검토의 저장으로, 버리는 것은 더 보기 메뉴의 변경 버리기로 할 수 있습니다.",
      });
    }
    if (!this.core.branch) {
      return this.core.setDiff({
        stage: "failed",
        gate: "diff",
        detail: "되돌릴 저장 기록이 없습니다 — 먼저 저장해 주세요.",
      });
    }
    let subject: string;
    try {
      // The sha comes over the wire: only a hex object name may reach
      // `git log`/`checkout` — anything else is a flag or a ref expression.
      if (!/^[0-9a-f]{4,64}$/i.test(sha)) throw new Error("not a commit sha");
      subject = (await this.core.git(["log", "-1", "--pretty=%s", sha])).trim();
    } catch {
      return this.core.setDiff({
        stage: "failed",
        gate: "diff",
        detail: "되돌릴 기록을 찾지 못했습니다 — 저장 기록을 다시 열어 확인해 주세요.",
      });
    }
    this.core.setDiff({ stage: "pushing" });
    try {
      // The branch name lives in the registry; git's HEAD may have been left
      // anywhere by a restart. ensureCycleBranch checks it out when named.
      const branch = await this.publish.ensureCycleBranch();
      await this.core.git(["checkout", sha, "--", "."]);
      // `checkout sha -- .` 는 sha 가 아는 경로만 돌려놓는다 — 그 뒤에 태어난
      // 파일이 살아 남아 되돌리기 커밋에 그대로 실린다. 체크포인트 복원의
      // born-after 규칙과 같은 바닥을 쓴다: sha 이후 생긴 경로는 지운다.
      const bornAfter = (
        await this.core.git([
          "-c",
          "core.quotepath=false",
          "diff",
          "--name-only",
          "--diff-filter=A",
          sha,
          "HEAD",
        ])
      )
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((path) => path !== "" && safeRepoPath(path) !== null);
      if (bornAfter.length > 0) await this.core.git(["rm", "--force", "--", ...bornAfter]);
      await this.core.git([
        ...(await this.core.identityArgs()),
        "commit",
        "-m",
        `되돌리기: ${subject}`,
      ]);
      await this.core.git(["push", "--set-upstream", "origin", branch]);
    } catch (error) {
      return this.core.setDiff({
        stage: "failed",
        gate: "commit",
        detail: detailOf(error, this.core.pat),
      });
    }
    const commit = (await this.core.git(["rev-parse", "HEAD"])).trim();
    await this.core.refreshPendingChanges();
    return this.core.setDiff({ stage: "published", commit });
  }

  /**
   * 변경 버리기 (PLAN D53): every unsaved worktree change, gone — the same
   * path set a save would have carried, restored or deleted per file, and
   * only through the one path rule (inside the clone). The confirmation
   * dialog is the UI's half; this half cannot reach outside the repo.
   */
  async discard(): Promise<RepoDiscard> {
    if (!this.core.isCloned()) return { removed: [] };
    while (this.core.publishing) await this.core.publishing.catch(() => undefined);
    await this.core.refreshing?.catch(() => undefined);
    await this.core.shelving?.catch(() => undefined);
    return await this.core.clearUnsavedWork();
  }

  // -------------------------------------------------------------------------
  // 잠깐 치워두기 — the parked-work shelf
  // -------------------------------------------------------------------------

  shelve(): Promise<RepoShelf> {
    return this.shelfStore.shelve();
  }

  unshelve(onSessionTurn?: (brief: string) => void): Promise<RepoShelfRestore> {
    return this.shelfStore.unshelve(onSessionTurn);
  }

  // -------------------------------------------------------------------------
  // Checkpoints — PLAN D52 snapshots
  // -------------------------------------------------------------------------

  checkpoint(sessionId: string, turn: number): Promise<RepoCheckpoint> {
    return this.checkpointStore.checkpoint(sessionId, turn);
  }

  checkpoints(): Promise<RepoCheckpoints> {
    return this.checkpointStore.checkpoints();
  }

  async checkpointRestore(id: string): Promise<RepoCheckpointRestore> {
    // The worktree is the snapshot's subject: a save mid-flight owns it, and
    // restoring under that save would mix two different moments.
    while (this.core.publishing) await this.core.publishing.catch(() => undefined);
    return this.checkpointStore.checkpointRestore(id);
  }

  // -------------------------------------------------------------------------
  // Bring-up and lifecycle
  // -------------------------------------------------------------------------

  /**
   * The stash the last 최신화 left behind when a kill caught it mid-pop —
   * replayed here so the planner's unsaved work is never silently gone.
   */
  recoverParkedWork(
    onSessionTurn?: (brief: string) => void,
  ): Promise<"none" | "restored" | "conflict"> {
    return this.core.recoverParkedWork(onSessionTurn);
  }

  isCloned(): boolean {
    return this.core.isCloned();
  }

  syncState(): { running: boolean; phase: RepoStatus["phase"]; detail: string | null } {
    return this.core.syncState();
  }

  repoConfig(): ReturnType<RepoCore["repoConfig"]> {
    return this.core.repoConfig();
  }

  installUpToDate(): boolean {
    return this.bringup.installUpToDate();
  }

  /**
   * Recount what a 저장 would carry, then tell everyone (PLAN D8).
   *
   * Called where the number can actually have moved: a 화면 turn that finished
   * writing files, and a save that just cleaned the worktree. `git status` on
   * a clone this size is milliseconds, and a failure here must never take down
   * the caller — a stale count is a wrong button, a thrown error is a dead
   * session.
   */
  refreshPendingChanges(): Promise<void> {
    return this.core.refreshPendingChanges();
  }
}
