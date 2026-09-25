import { rmSync } from "node:fs";
import type {
  DiffFile,
  DiffStatus,
  HandoffShot,
  HandoffStatus,
  HandoffStatusReport,
  RepoHandoffDraft,
  RepoHistory,
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
export { safeRepoPath } from "./repo-paths.js";

import type { LaneKind } from "./git-lane.js";
import { NO_MACHINE_TURN } from "./machine-provider.js";
import { BringUp } from "./repo-bringup.js";
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
 * git/capture/emit plumbing; `repo-shelf.ts`,
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
  private readonly shelfStore: ShelfStore;
  private readonly summarizer: RepoSummarizer;
  private readonly bringup: BringUp;
  private publish: PublishCycle;
  /** 사이클 사건의 손잡이 — 레포가 바뀌면 사이클의 기억도 새 것으로 세운다. */
  private readonly onCycleEvent: RepoWorkspaceOptions["onCycleEvent"];
  private readonly notice: RepoWorkspaceOptions["notice"];
  private readonly resolveNotice: RepoWorkspaceOptions["resolveNotice"];

  constructor(options: RepoWorkspaceOptions) {
    this.onCycleEvent = options.onCycleEvent;
    this.notice = options.notice;
    this.resolveNotice = options.resolveNotice;
    this.core = new RepoCore(options);
    this.shelfStore = new ShelfStore(this.core);
    this.summarizer = new RepoSummarizer(this.core, options.machineTurn ?? NO_MACHINE_TURN);
    this.bringup = new BringUp(this.core);
    this.publish = this.makePublish();
    this.root = options.root;
    this.baseBranch = options.baseBranch ?? "main";
  }

  private makePublish(): PublishCycle {
    return new PublishCycle(this.core, {
      machineMemo: (files) => this.summarizer.machineMemo(files),
      onCycleEvent: this.onCycleEvent,
      notice: this.notice,
      resolveNotice: this.resolveNotice,
    });
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
  /**
   * The URL the preview answers on while this workspace is ready — the
   * project hover card's 미리보기 row. Null the moment the server is gone:
   * a stale address is worse than no row.
   */
  get previewUrl(): string | null {
    return this.core.phase === "ready" ? this.core.previewUrl : null;
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
      // 옛 클론의 사이클은 새 레포로 따라오지 않는다 — 남겨 두면
      // ensureCycleBranch 가 새 클론에서 옛 브랜치를 체크아웃하고 상태
      // 확인 · 넘기기가 옛 PR 번호를 새 레포에 묻는다. 코어와 레지스트리를
      // 함께 지우고(setCycle 이 onCycleChange 로 나른다), 핀 앵커는 새
      // 사이클의 태생으로 돌린다. 사이클의 기억(세워 둔 끝 · 읽은 코멘트)도
      // 옛 레포의 것이니 함께 새로 세운다.
      this.core.setCycle(null, null);
      this.core.rotateCommentsCycle();
      this.publish = this.makePublish();
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
   * 차선이 옛 슬롯 셋의 몫을 받았다(PLAN L1) — 줄이 빌 때까지 기다린다.
   */
  async settle(): Promise<void> {
    await this.core.lane.idle();
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
  async pull(onSessionTurn?: (brief: string) => void): Promise<"clean" | "conflict" | undefined> {
    if (!this.core.isCloned()) return;
    // 준비가 충돌로 멈춘 상태(phase error)에서도 문은 열려 있어야 한다(D96):
    // 오류 카드의 AI 요청이 읽을 것은 바로 그 상태고, 새 대화가 태어날 때의
    // 이 pull 이 충돌을 첫 과제로 넣는다. error 이후의 상태는 어차피 없고,
    // clone 이 없는 실패(내려받기 실패)는 위에서 걸린다.
    if (this.core.phase !== "ready" && this.core.phase !== "error") return;
    // One worktree, one lane (PLAN L1): refreshFromRemote 이 차선(refresh,
    // join)에 스스로 서므로 저장·치워두기·앞선 최신화와의 손 기다림은 차선이
    // 대신한다 — stash-move-replay 창이 `git diff` 와 겹치지 않는다는 보장은
    // 같고, 읽는 자리는 없다.
    const run = this.core
      .refreshFromRemote(onSessionTurn)
      .then(async (outcome) => {
        // A conflict brief leaves the worktree mid-resolution: the delivery chip's
        // count must show it (the unmerged files are changes awaiting 저장),
        // and an install or preview restart would only bury the brief in
        // noise — so no sync runs on that path. A clean refresh ends with
        // the worktree exactly the planner's edits on the new HEAD:
        // recount, or let the dependency-driven sync recount at its end.
        if (outcome === "conflict") await this.core.refreshPendingChanges();
        // 의존성이 움직였으면 전체 동기화 — 차선 작업이 끝난 뒤 줄 밖에서
        // 부른다(PLAN L1): bootstrap 안의 git 단계들이 제 몫의 작업으로 다시
        // 줄에 선다.
        else if (this.bringup.dependenciesMoved()) await this.sync();
        else await this.core.refreshPendingChanges();
        return outcome;
      })
      .catch((error) => {
        this.core.setDetail(detailOf(error, this.core.pat));
        // A failure stays a `detail`: no card renders it while phase is
        // ready, and the next sync() reports it properly — the callers left
        // (the automatic pre-send pull, the fleet) all run quietly.
        return undefined;
      });
    // The outcome is the caller's answer: the 최신화 button's "N건을 받아
    // 왔습니다" record and the tests both read it. A bare `await run` dropped
    // it on the floor, leaving that record dead code.
    return await run;
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
      /** P2-1 자동 저장 — 푸시를 백그라운드로(실패 무시). */
      backgroundPush?: boolean;
    } = {},
  ): Promise<DiffStatus> {
    // PLAN L1: 던지던 "저장이 진행 중입니다" 는 사라진다 — 줄에 있는 저장에
    // 합류하고(join), 도는 저장 뒤에 생긴 변경은 다음 저장이 담는다.
    return this.core.lane.run("save", () => this.publish.runSave(options), { join: true });
  }

  /** 마지막 재검사가 센, 커밋되지 않은 변경 파일 수 — 자동 저장의 출발 판정. */
  get pendingChanges(): number {
    return this.core.pendingChanges;
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
    // PLAN L1: 넘기기도 던지지 않고 줄에 선다(submit) — 이미 열린 요청의
    // 갱신은 멱등하므로 두 번 눌러도 안전하다.
    return this.core.lane.run("submit", () => this.publish.runHandoff(options));
  }

  /**
   * 상태 확인의 읽기 — 감독자가 착지를 소유하므로 여기서는 읽기만 한다
   * (PLAN L2 흡수표). 읽은 뒤의 감독자 틱은 호출자(dispatch)가 부른다.
   */
  peekHandoff(): Promise<HandoffStatusReport | null> {
    return this.publish.peekHandoff();
  }

  handoffShot(route: string): Promise<{ mediaType: string; data: string } | null> {
    return this.publish.handoffShot(route);
  }

  /**
   * PR 본문의 도구 구간 (PLAN L6) — 감독자의 제출 단계가 조립하는 한 덩어리.
   * 구간 밖의 개발자 글은 병합(mergeToolBlock) 쪽이 지킨다.
   */
  handoffToolBlock(
    options: { shots?: HandoffShot[]; commentsFile?: string } = {},
  ): Promise<string> {
    return this.publish.handoffToolBlock(options);
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
    // The same worktree contract as a save: 되돌리기도 차선의 restore 칸에 서서
    // 앞선 작성자 뒤에 선다(PLAN L1) — `pull()` 이 세션 시작에 스스로 깔던
    // stash-move-replay 가 반쯤 되감힌 트리 위에 겹치지 않는다.
    return this.core.lane.run("restore", () => this.runRestore(sha));
  }

  private async runRestore(sha: string): Promise<DiffStatus> {
    const dirty = await this.core.git(["-c", "core.quotepath=false", "status", "--porcelain"]);
    if (dirty.trim() !== "") {
      return this.core.setDiff({
        stage: "failed",
        gate: "diff",
        detail: "보관하지 않은 변경이 있습니다 — 먼저 제출하거나 되돌려 주세요.",
      });
    }
    if (!this.core.branch) {
      return this.core.setDiff({
        stage: "failed",
        gate: "diff",
        detail: "되돌릴 작업 기록이 없습니다 — 먼저 화면을 만들어 주세요.",
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
        detail: "되돌릴 기록을 찾지 못했습니다 — 작업 기록을 다시 열어 확인해 주세요.",
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

  // -------------------------------------------------------------------------
  // 치워둔 작업 — the parked-work slot's automatic recovery
  // -------------------------------------------------------------------------

  recoverShelf(): Promise<"none" | "restored" | "kept"> {
    return this.shelfStore.recoverShelf();
  }

  /** 방금 선 커밋의 sha 와 파일 — 라우트↔파일 지도의 재료(2026-09-22). */
  headCommitFiles(): Promise<{ sha: string; files: string[] } | null> {
    return this.core.headCommitFiles();
  }

  /**
   * 같은 .git 을 쓰는 다른 손(보낸 시점 빌드의 워크트리, handoff-preview)을
   * 차선에 세우는 공개된 길 (PLAN L1) — `worktree add/remove/prune` 이 클론의
   * refs 와 메타데이터를 쓰므로 저장·최신화와 한 줄에 서야 한다.
   */
  laneRun<T>(kind: LaneKind, job: () => Promise<T>): Promise<T> {
    return this.core.lane.run(kind, job);
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

  /**
   * 사이클 브랜치를 보장한다 — 감독자(cycle-supervisor)의 4행·6행이 부른다.
   * 이름이 있으면 그 브랜치로 HEAD 를 맞추고, 없으면 HEAD 에서 새 사이클
   * 브랜치를 연다(PLAN L4). 차선 안에서 불리면 재진입으로 곧바로 돈다.
   */
  ensureCycleBranch(): Promise<string> {
    return this.publish.ensureCycleBranch();
  }

  /**
   * 감독자(cycle-supervisor)가 차선 · git · 원장 읽기를 겨누는 내부 손잡이.
   * 패키지 밖으로는 열지 않는다 — fleet 과 시험 하네스만이 같은 뿌리를
   * 공유할 때 쓴다.
   */
  repoCore(): RepoCore {
    return this.core;
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
