import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Attention,
  ChatEvent,
  DeveloperReview,
  DiffStatus,
  ProjectDefaults,
  ProjectLifecycle,
  ProjectSummary,
  RepoStatus,
  ServerMessage,
  SessionCommand,
} from "@colo-design/protocol";
import {
  composeAttention,
  errorKindOf,
  guidanceFor,
  markTurn,
  reviewToTurn,
} from "@colo-design/protocol";
import { probeCommands } from "./agent/drivers/claude/session.js";
import { type BringUpEpisode, nextBringUpBrief } from "./bring-up-briefs.js";
import { captureTargets, readComments } from "./comments.js";
import { COMMON_INSTRUCTIONS, turnSubjectOf } from "./common-instructions.js";
import { mergeNpmrc, npmrcPath } from "./credentials.js";
import { cycleLedgerFile } from "./cycle-ledger.js";
import { CycleSupervisor } from "./cycle-supervisor.js";
import { type DeveloperNotice, describeProblem } from "./developer-notice.js";
import type { GitHubClient } from "./github.js";
import type { DaemonLogger } from "./log.js";
import type { MachineTurn } from "./machine-provider.js";
import type { DaemonNotice } from "./notices.js";
import { realpathBestEffort } from "./paths.js";
import type { PreviewDrivers } from "./preview-drivers.js";
import type { ProjectPaths, ProjectRegistry } from "./projects.js";
import type { QueueDisk } from "./queue-store.js";
import { assertClonableRepoUrl, RepoWorkspace } from "./repo.js";
import { scopeOf } from "./repo-config.js";
import { appendScreenMap } from "./screen-map.js";
import type { SessionManager } from "./session-manager.js";
import { appendTape } from "./session-tape.js";
import { repoWritePolicy } from "./workspaces.js";

/**
 * Inactive projects whose preview server stays up beside the active one, so
 * a return is a repaint and not a bring-up. Each is a dev server of its own
 * (hundreds of MB): the cap bounds what clicking through the sidebar costs.
 */
const WARM_PREVIEWS = 2;

export interface ProjectWorkspaces {
  slug: string;
  paths: ProjectPaths;
  repo: RepoWorkspace;
  /** When this project was last put on screen — the warm cap keeps the newest. */
  shownAt: number;
  /**
   * 커미티 B1 (2026-09-15): the workspace's last diff stage, recorded off the
   * same callback the bar listens to.
   */
  diffStage: DiffStatus["stage"] | null;
  /** 마지막 diff 상태 — 주의의 재료(failGate 의 reconnect · developer-notified). */
  lastDiff: DiffStatus | null;
  /** 마지막 diff 상태가 선 시각(ISO) — 주의의 since. */
  diffAt: string | null;
  /** 준비 복구가 AI 에게 넘어가 있는 동안의 시각(ISO) — 주의의 ai-fixing. */
  bringUpFixing: string | null;
  /** 사이클 감독자 (PLAN L2) — 이 프로젝트의 사이클을 스스로 제자리로. */
  supervisor: CycleSupervisor;
}

/**
 * 서버가 주는 것 — 플릿은 이 경계 너머를 모른다. 레지스트리와 세션 관리자는
 * 참조로 공유하고, 토큰·실행 파일처럼 실행 중 바뀌는 값은 콜백으로 읽는다.
 */
export interface FleetDeps {
  registry: ProjectRegistry;
  manager: SessionManager;
  previewDrivers: PreviewDrivers;
  broadcast(message: ServerMessage): void;
  notice(notice: DaemonNotice): void;
  logger: DaemonLogger;
  claudeExecutable(): string | null;
  /** 기계 잔일(저장 메모 · 넘기기 초안)의 턴 — machine-provider 가 담당을 골라 서버가 넣는다. */
  machineTurn: MachineTurn;
  /** 넘긴 요청에 적을 작성자 이름 — machine.json 이 기억한다(P1-3). */
  authorName(): string | null;
  closingSignal: AbortSignal;
  pat(): string | null;
  /** 개발자 알림 (PLAN L11) — GitHub 우선, Slack 보조의 배달기. */
  developerNotice: DeveloperNotice;
  gitHubClient(): GitHubClient | null;
  /** GitHubBridge.authExpired — 토큰 만료는 관찰의 reconnect 판정이 읽는다. */
  githubAuthExpired(): boolean;
  queueDiskFor(sessionId: string): QueueDisk;
}

/**
 * "The repo" 가 지금 무엇을 뜻하는가 (PLAN D2): 프로젝트별 워크스페이스의
 * 수명 — 첫 터치에 만들고, 전환에 따뜻하게 두며, 레지스트리·사이드바
 * 발표·핸드오프 폴링까지. 서버에는 transport 와 위임만 남는다.
 */
export class ProjectFleet {
  /**
   * One live workspace per project the daemon has touched this run. Only the
   * ACTIVE project runs a preview server — two repos may declare the same
   * `preview.port` — but a project the planner switched away from keeps its
   * clone.
   */
  readonly workspaces = new Map<string, ProjectWorkspaces>();
  /** The switch in flight — see `activateProject`. */
  private activating: Promise<ProjectWorkspaces> | null = null;
  /** The announce coalescer's pending send — see announceProjectsThrottled. */
  private announceTimer: NodeJS.Timeout | null = null;
  /** The last threads each project announced with, as JSON — the guard that
   * keeps refreshThreads from announcing unchanged pictures forever. */
  private readonly announcedThreads = new Map<string, string>();
  /**
   * 커미티 P3-2: slug → 감독자가 마지막으로 감지한 개발자 쪽 사건과 그 발견
   * 시각. `projectSummaries()`가 그대로보낸다 — 비활성 프로젝트도 이
   * 값으로 홈의 요약 행을 그린다(크로스 프로젝트 인박스).
   */
  private readonly lastHandoffEvent = new Map<
    string,
    { kind: "merged" | "closed" | "changes_requested" | "comments" | "replied"; at: string }
  >();
  /**
   * 슬라이스 2: sessionId → 자동 브리프가 연 턴이 끝나면 치러야 할 자동 저장.
   * 사람의 턴에는 붙지 않는다 — 오직 폴링이 내려놓은 리뷰 반영 턴만이
   * 저장까지 스스로 마무리한다. pr · reviews 는 저장이 선 뒤의 자동 답장
   * (PLAN L9)이 그 턴의 브리프 대상을 아는 재료다.
   */
  private readonly autoSaveAfter = new Map<
    string,
    { slug: string; count: number; pr: number; reviews: DeveloperReview[] }
  >();
  /**
   * The `/` palette with no thread open: one CLI boot per repo, cached, so an
   * empty workspace still lists every command the terminal would. A live
   * session's own answer always wins over this.
   */

  private readonly cliCommandsCache = new Map<string, SessionCommand[]>();
  private readonly cliCommandsProbe = new Map<string, Promise<SessionCommand[]>>();

  /**
   * hero-synthesis D1: cycle events serialize through this tail so a save →
   * handoff chain writes its tape rows in the order they happened — the
   * anchor read (`promptCount`) is async and would otherwise race.
   */
  private cycleTail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: FleetDeps) {}

  /**
   * A project's live workspace, built the first time it is touched.
   *
   * The repo url lives in the registry, not in the workspace, so `update()`
   * hands its moved url back through `onUrlChange` and the registry stays the
   * single place a url is written. The token is machine-wide and arrives by
   * `setPat` after construction, because construction is synchronous.
   */
  workspacesFor(slug: string): ProjectWorkspaces {
    const existing = this.workspaces.get(slug);
    if (existing) return existing;
    const repo = this.deps.registry.resolvedRepo(slug);
    const paths = this.deps.registry.ensureDirs(slug);
    // The registry owns the planner's word on this repo's commands; `undefined`
    // is a pre-gate project whose commands have already run here.
    const commandsApproved = this.deps.registry.get(slug)?.commandsApproved !== false;
    const workspaces: ProjectWorkspaces = {
      slug,
      paths,
      shownAt: 0,
      diffStage: null,
      lastDiff: null,
      diffAt: null,
      bringUpFixing: null,
      repo: new RepoWorkspace({
        root: paths.repoRoot,
        url: repo.url,
        baseBranch: repo.baseBranch,
        cycle: { branch: repo.branch, handoff: repo.handoff, commentsSince: repo.commentsSince },
        // Only the project on screen may START a preview (switch race fence).
        active: slug === this.deps.registry.activeSlug(),
        // The registry owns the planner's word on this repo's commands.
        commandsApproved,
        onCycleChange: (cycle) => this.deps.registry.setCycle(slug, cycle),
        gitHubClient: () => this.deps.gitHubClient(),
        // The machine turn rides whichever driver the daemon picked
        // (machine-provider.ts) — the workspace stays provider-blind.
        machineTurn: this.deps.machineTurn,
        // PR 본문의 `> 작성:` 줄과 커밋 fallback 이름이 읽는다(P1-3).
        authorName: () => this.deps.authorName(),
        // E4(초대 v2): 리뷰를 부탁할 개발자들 — 레지스트리가 기억한 목록.
        reviewers: () => this.deps.registry.get(slug)?.reviewers ?? [],
        onUrlChange: (url) => this.deps.registry.update(slug, { repoUrl: url }),
        onStatus: (status) => {
          // repaint somebody else's preview column.
          this.announceProjectsThrottled();
          if (slug === this.deps.registry.activeSlug()) {
            this.deps.broadcast({ type: "repo.status", status });
          }
          // D4: 준비가 끝내 멈춘 실패는 사람의 버튼을 기다리지 않는다.
          this.autoBriefBringUpFailure(workspaces, status);
        },
        onDiffStatus: (status) => {
          workspaces.diffStage = status.stage;
          // 주의의 재료 (PLAN L8): failGate 의 실패 단계·이유와 선 시각.
          workspaces.lastDiff = status;
          workspaces.diffAt = new Date().toISOString();
          this.broadcastFor(slug, { type: "diff.status", status });
          // diff 가 바뀌면 주의도 바뀐다 — 스냅샷을 다시 방송한다.
          workspaces.repo.repoCore().emit();
        },
        // hero-synthesis D1: 저장 · 넘김 · 반영 · 코멘트 도착 — 세션 채널 +
        // 테이프. The cycle names its session when the call carried one.
        onCycleEvent: (event, sessionId) => this.emitCycleEvent(workspaces, event, sessionId),
        // 개발자 알림 (PLAN L11): failGate 의 인증·권한 실패가 여기로 온다.
        notice: (key, detail) =>
          void this.deps.developerNotice.raise({
            key,
            slug,
            ...describeProblem(key, detail),
          }),
        // 넘기기 성공이 서 있던 submit:pr 알림을 거둔다 (PLAN L11).
        resolveNotice: (key) => void this.deps.developerNotice.resolve(key, slug),
        // 주의 (PLAN L8): 감독자 · 게이트 · 준비 복구의 재료를 한 곳에서 모은다.
        attention: () => this.attentionFor(workspaces),
      }),
      supervisor: null as unknown as CycleSupervisor,
    };
    // 감독자 (PLAN L2 · 단계 2c) — 워크스페이스와 같은 뿌리(core)를 공유하고,
    // 도구가 시작한 조작의 충돌은 core.onToolConflict 로 여기 도착한다.
    const projectName = this.deps.registry.get(slug)?.name ?? slug;
    workspaces.supervisor = new CycleSupervisor({
      core: workspaces.repo.repoCore(),
      workspace: workspaces.repo,
      ledgerPath: cycleLedgerFile(paths.root),
      busy: () => this.deps.manager.busyIn(paths.repoRoot),
      installStale: () => !workspaces.repo.installUpToDate(),
      github: () => this.deps.gitHubClient(),
      githubAuthExpired: () => this.deps.githubAuthExpired(),
      slug: () => workspaces.repo.repoCore().repoSlug(),
      isActive: () => slug === this.deps.registry.activeSlug(),
      openThread: (title) => this.autoFixThreadFor(workspaces, title),
      raiseNotice: (key, text, reason) =>
        void this.deps.developerNotice.raise({
          key,
          slug,
          ...describeProblem(key, reason ?? text),
        }),
      resolveNotice: (key) => void this.deps.developerNotice.resolve(key, slug),
      onChange: () => workspaces.repo.repoCore().emit(),
      // PLAN L2 흡수표 — 폴러가 하던 사람에게 보이는 일은 감독자가 이
      // 콜백으로 옮겨 부른다. PR 상태 변화는 사이드바의 마지막 사건과
      // 알림으로, 새 리뷰는 자동 반영 턴으로.
      onPrTransition: (kind, at, count) => {
        this.lastHandoffEvent.set(slug, { kind, at });
        this.deps.notice({
          kind: "handoff",
          slug,
          projectName,
          event: kind,
          ...(count === undefined ? {} : { count }),
        });
      },
      onNewReviews: (pr, reviews) => this.briefReviewsFor(workspaces, pr, reviews),
      onRetargetBase: (to) => {
        this.deps.registry.update(slug, { baseBranch: to });
        workspaces.repo.repoCore().baseBranch = to;
      },
      // 대화록 사건 — 옛 폴러의 emitCycleEvent 와 같은 길(세션 채널 + 테이프).
      // 제출 완료 사건은 누른 대화에 귀속된다(PLAN L6).
      cycleEvent: (event, sessionId) => this.emitCycleEvent(workspaces, event, sessionId),
      // 수명 설정 — 병합된 원격 브랜치를 지울지(기본 true) · 코멘트 자동
      // 답장을 할지(기본 true, PLAN L9 · O5). 답장의 대리 표기가 읽을 작성자
      // 이름은 machine.json 이 기억한다(P1-3).
      deleteMergedBranches: () =>
        this.deps.registry.get(slug)?.lifecycle?.deleteMergedBranches ?? true,
      autoReply: () => this.deps.registry.get(slug)?.lifecycle?.autoReply ?? true,
      authorName: () => this.deps.authorName(),
      // L6 제출 — PR 본문의 재료와 이름.
      projectName: () => this.deps.registry.get(slug)?.name ?? slug,
      commentsFile: () => join(paths.root, "comments.json"),
      captureShots: async () => {
        const commentsFile = join(paths.root, "comments.json");
        const anchor = await workspaces.repo.cycleAnchor().catch(() => null);
        return await this.deps.previewDrivers.captureHandoffShots(
          captureTargets(readComments(commentsFile), anchor),
        );
      },
      logger: this.deps.logger,
    });
    this.workspaces.set(slug, workspaces);
    return workspaces;
  }

  /**
   * 사이클 사건의 발송 (hero-synthesis D1): the daemon already knows the
   * moment — 저장 완료 · 넘김 완료 · 병합 감지 · 새 코멘트 — so the event
   * goes to the session channel AND the session tape in one step.
   *
   * 귀속: the sessionId the call carried (api.save / api.handoff), else the
   * most recently active live session in this clone, else the newest stored
   * thread — a save with no open conversation still lands in a real one.
   * The tape write precedes the broadcast: a window that reloads on the
   * event replays the row instead of missing it.
   */
  private emitCycleEvent(
    workspaces: ProjectWorkspaces,
    event: ChatEvent,
    sessionId?: string,
  ): void {
    const cwd = realpathBestEffort(workspaces.paths.repoRoot);
    const named = sessionId ? this.deps.manager.get(sessionId) : undefined;
    const live = [...this.deps.manager.all()]
      .filter((session) => session.cwd === cwd)
      .sort((a, b) => b.lastActivity - a.lastActivity)[0];
    this.cycleTail = this.cycleTail
      .then(async () => {
        const target =
          (named && named.cwd === cwd ? named.id : undefined) ??
          live?.id ??
          (await this.deps.manager.list(cwd, 1).catch(() => []))[0]?.sessionId;
        if (!target) return;
        const afterTurn = await this.deps.manager.promptCount(target, cwd).catch(() => 0);
        try {
          appendTape(workspaces.paths.root, { sessionId: target, afterTurn, event });
        } catch {
          // The broadcast still goes out — a lost row is a missing card on
          // reload, not a reason to hide the moment from the open window.
        }
        // P3-1: the leaf dot reads the tape's last row per session — a cycle
        // event just moved it, so the tree's picture is stale until re-stamped.
        this.refreshThreads();
        this.deps.broadcast({ type: "session.event", sessionId: target, event });
      })
      // A failed emit must not poison the chain — the next cycle event still ships.
      .catch(() => undefined);
  }

  /**
   * The project a session's cwd names — `session.history` reads its tape
   * here. Null for a session whose clone the daemon has not touched.
   */
  workspacesForCwd(cwd: string): ProjectWorkspaces | null {
    for (const workspaces of this.workspaces.values()) {
      if (realpathBestEffort(workspaces.paths.repoRoot) === cwd) return workspaces;
    }
    return null;
  }

  /**
   * Progress from a project the planner is no longer looking at would read as
   * the active one's — a clone finishing in the background must not repaint
   * somebody else's screen. Inactive projects still run to completion; they
   * just do it quietly.
   */
  private broadcastFor(slug: string, message: ServerMessage): void {
    if (slug === this.deps.registry.activeSlug()) this.deps.broadcast(message);
  }

  /** The active project's workspaces, or null before the first one exists. */
  activeOrNull(): ProjectWorkspaces | null {
    const slug = this.deps.registry?.activeSlug();
    return slug ? this.workspacesFor(slug) : null;
  }

  /**
   * The palette's rows before a session exists: the CLI probed once per repo
   * and cached for the run. A failed probe answers empty and lets the next
   * ask retry — a CLI that was mid-install should not be remembered broken.
   */
  async cliCommands(): Promise<SessionCommand[]> {
    const executable = this.deps.claudeExecutable();
    if (!executable) return [];
    const active = this.activeOrNull();
    // Project skills ride the clone's cwd; with no clone yet the user-level
    // set is still worth having, and the home dir is a cwd that exists.
    const cwd =
      active && active.repo.isCloned() ? realpathBestEffort(active.paths.repoRoot) : homedir();
    const cached = this.cliCommandsCache.get(cwd);
    if (cached) return cached;
    // The single-flight is keyed by cwd like the cache: a probe started for
    // one project's clone must not answer — or pin — another's palette.
    let probe = this.cliCommandsProbe.get(cwd);
    if (!probe) {
      probe = probeCommands({
        cwd,
        executable,
        signal: this.deps.closingSignal,
      })
        .then((commands) => {
          this.cliCommandsCache.set(cwd, commands);
          return commands;
        })
        .catch(() => [] as SessionCommand[])
        .finally(() => {
          this.cliCommandsProbe.delete(cwd);
        });
      this.cliCommandsProbe.set(cwd, probe);
    }
    return await probe;
  }

  /**
   * The active project, refusing in Korean when there is none. Every message
   * that means "the repo" goes through here: without a project that word has
   * no referent, and the wizard is what fixes it.
   */
  requireActive(): ProjectWorkspaces {
    const active = this.activeOrNull();
    if (!active) throw new Error("프로젝트가 없습니다 — 설정에서 프로젝트를 먼저 만들어 주세요.");
    return active;
  }

  projectSummaries(): ProjectSummary[] {
    return (this.deps.registry?.list() ?? []).map((project) => {
      const workspaces = this.workspaces.get(project.slug);
      const repo = workspaces?.repo;
      // The tree's children come from the per-clone cache (PLAN D59); a clone
      // the daemon has not scanned yet omits the field rather than claiming
      // an empty conversation list.
      const cwd = workspaces?.repo.isCloned()
        ? realpathBestEffort(workspaces.paths.repoRoot)
        : null;
      const threads = cwd ? this.deps.manager.cachedThreads(cwd) : null;
      const lastEvent = this.lastHandoffEvent.get(project.slug);
      const attention = workspaces ? this.attentionFor(workspaces) : null;
      return {
        slug: project.slug,
        name: project.name,
        repoUrl: project.repo.url,
        baseBranch: project.repo.baseBranch,
        // The hover card's facts: the cycle branch rides the registry so a
        // never-touched project still names it; the preview url exists only
        // while this workspace's server is actually up.
        branch: repo?.currentBranch ?? project.repo.branch,
        previewUrl: repo?.previewUrl ?? null,
        repoRoot: this.deps.registry.paths(project.slug).repoRoot,
        // No workspace means the daemon never touched this project since its
        // last restart: disk state is all a summary may claim.
        phase: repo ? repo.syncState().phase : "missing",
        pendingChanges: repo?.pendingChangeCount ?? 0,
        working: repo
          ? this.deps.manager.anyRunning(realpathBestEffort(workspaces.paths.repoRoot))
          : false,
        handoff: repo?.currentHandoff ?? project.repo.handoff,
        ...(threads ? { threads } : {}),
        ...(project.instructions ? { instructions: project.instructions } : {}),
        // 초대 v4(PLAN 단계 5): 개발자가 정한 처음 값과 수명 — 웹의 칩 씨앗과
        // 감독자의 브랜치 정리가 읽는다.
        ...(project.defaults ? { defaults: project.defaults } : {}),
        ...(project.lifecycle ? { lifecycle: project.lifecycle } : {}),
        // 홈 크로스 프로젝트 인박스(PLAN P3-2): 질문+권한 모두 스레드를
        // "awaiting" 으로 세우므로, 비활성 프로젝트라도 이 카운트만으로
        // 답을 기다리는 일의 수를 안다 — 세션이 살아 있는 한 값이 있다.
        pendingCount: (threads ?? []).filter((thread) => thread.state === "awaiting").length,
        ...(lastEvent ? { lastEventKind: lastEvent.kind, lastEventAt: lastEvent.at } : {}),
        ...(attention ? { attention } : {}),
      };
    });
  }

  /**
   * The registry moved — or one project's live badge did. Every open client
   * repaints its sidebar from this one message; two windows must never
   * disagree about what a row says. Bursts (an install ticking, a turn's
   * stream of state flips) collapse into one send per 200ms, and a trailing
   * send guarantees the last state always lands (PLAN D17).
   */
  announceProjectsThrottled(): void {
    if (this.announceTimer) return;
    this.announceTimer = setTimeout(() => {
      this.announceTimer = null;
      this.announceProjects();
    }, 200);
    // Keep the Node process from being held open by a pending announce.
    this.announceTimer.unref();
  }

  /**
   * 슬라이스 2: 리뷰 반영 턴이 갈 살아 있는 대화 — 그 프로젝트 클론에서
   * 가장 최근에 움직인 살아 있는 대화. 없으면 도구가 "리뷰 반영" 대화를
   * 연다(게이트 실패 스레드와 같은 길): 사람의 손이 없어도 반영이
   * 시작되는 것이 이 흐름의 계약이다.
   */
  private autoFixThreadFor(workspaces: ProjectWorkspaces, title = "리뷰 반영") {
    const cwd = realpathBestEffort(workspaces.paths.repoRoot);
    const live = [...this.deps.manager.all()]
      .filter((session) => session.cwd === cwd && session.sendable)
      .sort((a, b) => b.lastActivity - a.lastActivity)[0];
    if (live) return live;
    const executable = this.deps.claudeExecutable();
    if (!executable) return null;
    const instructions = this.projectInstructions(cwd);
    const session = this.deps.manager.create({
      cwd,
      queueDiskFor: this.deps.queueDiskFor,
      writePolicy: repoWritePolicy(cwd),
      title,
      launch: {
        executable,
        ...(instructions ? { appendSystemPrompt: instructions } : {}),
      },
    });
    this.deps.manager.invalidateThreads(cwd);
    this.refreshThreads();
    return session;
  }
  /**
   * 조정 표 14행의 실행 (PLAN L2 흡수표): 새 리뷰는 알림으로 끝나지 않는다 —
   * 데몬이 스스로 고치기 턴을 내려놓고, 그 턴이 답을 내면 저장까지
   * 마무리한다(settleAutoSave). 브리프된 id 의 장부는 cycle.json 의
   * reviews[pr].briefed — 감독자가 판정 때 적고, 보내기가 거절되면
   * 되감아(반환 false) 다음 틱이 다시 시도한다.
   */
  private briefReviewsFor(
    workspaces: ProjectWorkspaces,
    pr: number,
    reviews: DeveloperReview[],
  ): boolean {
    const target = this.autoFixThreadFor(workspaces);
    if (!target) return false;
    try {
      target.send(reviewToTurn(reviews));
      this.autoSaveAfter.set(target.id, {
        slug: workspaces.slug,
        count: reviews.length,
        pr,
        reviews,
      });
      this.deps.logger.warn("[cycle] 리뷰 브리프 발송", {
        slug: workspaces.slug,
        pr,
        reviews: reviews.length,
      });
      return true;
    } catch {
      this.autoSaveAfter.delete(target.id);
      return false;
    }
  }

  /** D4: 프로젝트별 준비 실패의 한 바퀴 — 장부의 규칙은 bring-up-briefs.ts 에 있다. */

  private readonly bringUpEpisodes = new Map<string, BringUpEpisode>();

  /**
   * D4: 자동 분기가 연 고침 턴이 끝나면 준비를 다시 돌린다 — 웹의 카드가
   * 하던 재시도 루프를 데몬이 이어받는다. 사람은 결과만 본다.
   */
  private readonly recoveryResync = new Set<string>();

  /**
   * D4: 준비가 끝내 멈추면 사람을 기다리지 않고 도구가 실패를 읽은
   * 표(repo-guidance)로 대화를 열어 넘긴다 — 연결 레포의 오류는 사람에게
   * 올리지 않는다(2026-09-23, 웹의 진행 판은 "AI 가 고치는 중" 만 말한다).
   * 고친 뒤에도 같은 단계에서 또 멈추면 한 번 더 넘기고, 장부의 상한을 넘으면
   * AI 는 멈추고 개발자 채널로 한 번 알린다(nextBringUpBrief). 사람의 결정이
   * 필요한 실패(commands — 첫 실행의 동의)만 버튼에 남는다.
   */
  private autoBriefBringUpFailure(workspaces: ProjectWorkspaces, status: RepoStatus): void {
    const slug = workspaces.slug;
    const { episode, decision } = nextBringUpBrief(this.bringUpEpisodes.get(slug), status);
    if (episode) this.bringUpEpisodes.set(slug, episode);
    else this.bringUpEpisodes.delete(slug);
    // 주의의 재료 (PLAN L8): 준비가 ready 에 닿으면 ai-fixing 을 거두고
    // 서 있던 bring-up 알림을 푼다 — 실패 상태가 사라진 순간이다.
    if (status.phase === "ready") {
      if (workspaces.bringUpFixing !== null) {
        workspaces.bringUpFixing = null;
        workspaces.repo.repoCore().emit();
      }
      for (const key of Object.keys(workspaces.supervisor.notices())) {
        if (key.startsWith("bring-up:")) this.deps.developerNotice.resolve(key, slug);
      }
    }
    if (decision.action === "none") return;
    const guidance = guidanceFor(errorKindOf(status), status.detail ?? null);
    if (decision.action === "escalate") {
      const kind = errorKindOf(status) ?? "unknown";
      // 사람의 화면에는 여전히 오류를 올리지 않는다(대화에 AI 의 설명이
      // 있다) — 개발자 알림(PLAN L11)으로 한 번 간다. 키는 실패 종류를
      // 담아 같은 문제의 반복이 같은 알림을 갱신하게 한다.
      void this.deps.developerNotice.raise({
        key: `bring-up:${kind}`,
        slug,
        ...describeProblem(`bring-up:${kind}`, status.detail ?? undefined),
      });
      if (workspaces.bringUpFixing !== null) {
        workspaces.bringUpFixing = null;
        workspaces.repo.repoCore().emit();
      }
      return;
    }
    const agent = guidance.agent;
    if (!agent) return;
    try {
      const thread = this.autoFixThreadFor(workspaces, agent.thread);
      if (!thread) return;
      // 같은 대화가 앞의 시도를 기억한다 — 되풀이라는 사실만 앞에 얹는다.
      const brief = decision.repeat
        ? `고친 뒤 준비를 다시 돌렸지만 같은 단계에서 또 멈췄습니다 — 앞의 방법과 다른 원인을 찾아 주세요.\n\n${agent.brief}`
        : agent.brief;
      thread.send(markTurn({ kind: "gate", step: agent.step }, brief));
      this.recoveryResync.add(slug);
      // 주의의 재료 (PLAN L8): 준비 복구가 AI 에게 넘어가 있는 동안이다.
      if (workspaces.bringUpFixing === null) {
        workspaces.bringUpFixing = new Date().toISOString();
        workspaces.repo.repoCore().emit();
      }
    } catch {
      // 대화를 못 열었거나 죽은 질의 — 실패 상태는 이미 방송됐다. 다음
      // 시도(다시 시도 · 재동기화)의 실패가 다시 연다.
    }
  }

  /**
   * 이 프로젝트의 주의 (PLAN L8) — 감독자의 판정(충돌 · 밀린 푸시 · 리뷰
   * 라운드 초과), failGate 의 실패(diff), 준비 복구의 진행을 한 재료로
   * 모아 composeAttention 에 건넨다. 재료가 없으면 null 이다.
   */
  private attentionFor(workspaces: ProjectWorkspaces): Attention | null {
    const parts = workspaces.supervisor.attentionParts();
    const failed = workspaces.lastDiff?.stage === "failed" ? workspaces.lastDiff : null;
    return composeAttention({
      reconnect:
        parts.reconnect ??
        (failed?.reason === "push-auth"
          ? { what: "github" as const, since: workspaces.diffAt ?? new Date().toISOString() }
          : null),
      aiFixingSince: parts.aiFixingSince ?? workspaces.bringUpFixing,
      notices: parts.notices,
    });
  }

  /**
   * 슬라이스 2: 자동 브리프가 연 턴의 정산 — 답이 나왔으면 저장까지 스스로.
   * 실패한 턴은 정산하지 않는다: 감독(슬라이스 1)이 다시 시도하고, 그 재시도가
   * 성공한 턴 끝이 여기에 다시 온다. 중지된 턴은 사람의 뜻이므로 저장하지
   * 않고 기다린다 — 칩과 저장 버튼이 여전히 그 자리에 있다.
   *
   * PLAN L9: 저장이 서면(성패와 무관하게 시도가 끝나면) 그 턴의 답변 문장에서
   * 코멘트별 답장을 뽑아 스레드에 올린다(settleReviewReplies). "그 턴이 파일을
   * 바꿨는가"는 저장이 새로 선 커밋으로 잰다 — 깨끗한 트리의 멱등 no-op 저장은
   * 같은 sha 를 돌려주므로.
   */
  async settleAutoSave(sessionId: string): Promise<void> {
    const pending = this.autoSaveAfter.get(sessionId);
    if (!pending) return;
    this.autoSaveAfter.delete(sessionId);
    const workspaces = this.workspacesFor(pending.slug);
    const session = this.deps.manager.get(sessionId);
    if (!workspaces || !session) return;
    const projectName = this.deps.registry.get(pending.slug)?.name ?? pending.slug;
    const headBefore = await workspaces.repo
      .repoCore()
      .git(["rev-parse", "HEAD"])
      .catch(() => "");
    let commit: string | null = null;
    try {
      const status = await workspaces.repo.save({
        message: `개발자 요청 자동 반영 — 리뷰 코멘트 ${pending.count}건`,
        sessionId,
        onSessionTurn: (brief: string) => {
          this.deps.notice({
            kind: "gate",
            sessionId,
            title: session.title,
            stage: "save",
          });
          try {
            session.send(brief);
          } catch {
            // The DiffStatus the save left behind still tells the story.
          }
        },
      });
      if (status.stage === "published") {
        this.lastHandoffEvent.set(pending.slug, {
          kind: "replied",
          at: new Date().toISOString(),
        });
        this.deps.notice({ kind: "handoff", slug: pending.slug, projectName, event: "replied" });
        this.announceProjectsThrottled();
        if (typeof status.commit === "string" && status.commit.trim() !== headBefore.trim()) {
          commit = status.commit.trim();
        }
      }
    } catch {
      // 저장의 실패는 DiffStatus 와 게이트 브리프가 이미 말한다.
    }
    await workspaces.supervisor
      .settleReviewReplies(pending.pr, pending.reviews, session.lastAssistantText ?? "", commit)
      .catch(() => {
        // 답장의 실패는 감독자가 이미 조용히 기록했다.
      });
  }

  /**
   * P2-1 자동 저장: 답을 낸 턴이 쌓은 변경을 로컬 커밋으로. 저장 버튼이 사라진
   * 세계에서 이것이 저장이다 — 사람은 제출만 누른다.
   *
   * 커밋 제목은 그 턴을 연 말의 첫 줄(①): 메모 턴을 돌리면 턴마다 구독이 두
   * 배로 타므로, 여기서 절대 돌리지 않는다. 말이 없으면(기계가 연 턴)
   * runSave 의 폴백(② machineMemo → ③ 기본 문구)에 맡긴다. 푸시는 백그라운드
   * — 오프라인에서도 턴의 끝이 멈추지 않는다(실패는 제출이 기다려서 민다).
   * 커밋 게이트가 열리면 세션에 고침 브리프를 보내 화면 확인 게이트와 같은
   * 루프로 스스로 닫는다.
   */
  async autoSaveTurn(sessionId: string, screenRoutes?: string[]): Promise<void> {
    const workspaces = this.workspaceOfSession(sessionId);
    const session = this.deps.manager.get(sessionId);
    if (!workspaces || !session) return;
    // 충돌 정리 중(pendingOp)에는 자동 보관이 조용히 건너뛴다 — saveBlocked
    // 사건 · 실패 배너를 만들지 않는다. 감독자가 마무리한 뒤 5행이 보관한다.
    if (workspaces.supervisor.pendingOp !== null) return;
    // D4: 이 턴이 준비 실패를 고치던 턴이면 고침이 끝난 지금 준비를 다시
    // 돌린다 — 저장 판정보다 앞선다(고침이 없었어도 재시도는 약속이다).
    if (this.recoveryResync.delete(workspaces.slug)) {
      void workspaces.repo.sync().catch(() => undefined);
    }
    // 출발 판정: 재검사가 최신이다(턴 끝의 refreshPendingChanges 를 다시 돌려
    // 확정한다). 커밋할 것이 없으면 저장조차 돌리지 않는다 — 깨끗한 트리의
    // 저장은 실패 상태를 만들고, 그것이 방금 끝난 턴의 기분을 더럽힌다.
    await workspaces.repo.refreshPendingChanges().catch(() => undefined);
    if (workspaces.repo.pendingChanges === 0) return;
    try {
      await workspaces.repo.save({
        ...turnSubjectOf(session.lastSentText),
        sessionId,
        backgroundPush: true,
        onSessionTurn: (brief: string) => {
          this.deps.notice({
            kind: "gate",
            sessionId,
            title: session.title,
            stage: "save",
          });
          try {
            session.send(brief);
          } catch {
            // The DiffStatus the save left behind still tells the story.
          }
        },
      });
      // 라우트↔파일 지도(2026-09-22): 커밋이 성공했을 때만 한 줄 — sha 와 그
      // 커밋이 건드린 파일, 그리고 이 턴이 가리킨 화면. 정체 검색이 빈손인
      // 핀의 마지막 길이 이 기록이다. 실패는 조용하다(지도는 판정이 아니다).
      if (screenRoutes !== undefined && screenRoutes.length > 0) {
        const head = await workspaces.repo.headCommitFiles().catch(() => null);
        if (head !== null && head.files.length > 0) {
          await appendScreenMap(workspaces.paths.root, {
            at: new Date().toISOString(),
            sha: head.sha,
            routes: screenRoutes,
            files: head.files,
          }).catch(() => undefined);
        }
      }
    } catch {
      // 진행 중 거절(사람의 제출이 먼저 움직인 것)과 실패 모두 조용하다:
      // DiffStatus 와 브리프가 이미 말한다.
    }
  }

  announceProjects(): void {
    this.deps.broadcast({
      type: "project.changed",
      projects: this.projectSummaries(),
      activeSlug: this.deps.registry.activeSlug(),
    });
    // The tree rides the same message (PLAN D59); a scan that lands something
    // new announces once more and the key compare below stops the loop.
    this.refreshThreads();
  }

  /**
   * Scan every cloned project's threads off the announce path. A clone whose
   * cache a session event just marked stale rescans here; the rest re-merge
   * live state only. The result goes out through the throttled announce, so
   * bursts land as one `project.changed` (PLAN D17).
   */
  refreshThreads(): void {
    for (const project of this.deps.registry?.list() ?? []) {
      const workspaces = this.workspaces.get(project.slug);
      if (!workspaces?.repo.isCloned()) continue;
      const cwd = realpathBestEffort(workspaces.paths.repoRoot);
      void this.deps.manager
        .refreshThreads(cwd, 50)
        .then((threads) => {
          const key = JSON.stringify(threads);
          if (this.announcedThreads.get(project.slug) === key) return;
          this.announcedThreads.set(project.slug, key);
          this.announceProjectsThrottled();
        })
        .catch(() => undefined);
    }
  }

  /**
   * A session lifecycle message (close · delete) touched one clone's
   * conversations (PLAN D59). The session is already gone from the live map
   * by the time this runs, so the caller hands the cwd it resolved first.
   */
  touchThreadsCwd(cwd: string | null | undefined): void {
    if (!cwd) return;
    this.deps.manager.invalidateThreads(cwd);
    this.refreshThreads();
  }

  /**
   * Switches which project everything means.
   *
   * The outgoing preview server STAYS UP (warm): coming back is a repaint of
   * a page that never went away, not a bring-up. What stops before the
   * incoming project may start is decided by `fenceWarmPreviews` — the port
   * the incoming repo declares, and the warm cap.
   * Serialized (D34): a double-click is two wire messages, and two overlapping
   * switches would race those ports. The LAST request wins — earlier callers
   * await their own (superseded) run and the wire answer simply names the
   * final state.
   */
  activateProject(slug: string): Promise<ProjectWorkspaces> {
    const run = this.activating ?? Promise.resolve();
    const next = run.catch(() => undefined).then(() => this.activateProjectInner(slug));
    // finally 가 새 Promise 를 만든다 — `next` 를 세워 두면 `activating ===
    // next` 가 영원히 거짓이라 끝나도 지워지지 않았다. 지우는 쪽이 세워진 객체.
    const tracked = next.finally(() => {
      if (this.activating === tracked) this.activating = null;
    });
    this.activating = tracked;
    return next;
  }

  private async activateProjectInner(slug: string): Promise<ProjectWorkspaces> {
    const current = this.activeOrNull();
    const switching = current?.slug !== slug;

    if (switching) {
      // The outgoing project keeps the server it HAS but may not start one:
      // its in-flight bring-up (a clone that takes minutes) would otherwise
      // finish late, take the port it declares, and SIGKILL the listener the
      // project the planner switched TO just started. Inactive workspaces
      // abandon the bring-up at the unattended steps (install, preview).
      current?.repo.setActive(false);
      // Before the workspaces are built: `paths()` resolves the environment
      // overrides against the ACTIVE project, so a workspace built a moment
      // too early would cache the wrong roots for the rest of the run.
      this.deps.registry.setActive(slug);
    }

    // The token was loaded once in `start()`; every workspace gets it armed
    // the same way, switch or no switch.
    const next = this.workspacesFor(slug);
    next.shownAt = Date.now();
    next.repo.setActive(true);
    next.repo.setPat(this.deps.pat());
    // The fence runs BEFORE the incoming bring-up can spawn: a server of ours
    // on the port it declares would be killed by that spawn's port reclaim,
    // and a half-overlapping restart would leave the planner looking at the
    // wrong app on the right port.
    if (switching) await this.fenceWarmPreviews(next);
    // 커미티 2026-09-15 판정 2: 사람이 이 프로젝트 앞에 섰다 — 사이클의 끝
    // (반영됨·반려)의 착지는 감독자의 틱이 한다(PLAN L2 흡수표). 아래의
    // pull·sync 보다 **먼저**여야 한다: 착지의 checkout 과 최신화의 stash 가
    // 같은 워크트리를 동시에 만지면 안 된다.
    await next.supervisor.tick("activate").catch(() => undefined);
    // Bringing the repo up is NOT conditional on a switch. `create` registers
    // the first project as active before calling here, so a shortcut that
    // skipped this left a brand-new project with no clone at all — the
    // picker promises "레포를 내려받아 설치까지" and nothing happened.
    // The npmrc merge rides along: a repo that declares a private registry
    // only says so in the clone this sync produces.
    if (next.repo.remoteUrl) {
      if (next.repo.previewLive) {
        // Warm: the clone is brought current the way a session start does
        // it — the phase never leaves `ready`, the preview never blinks. A
        // dependency move still ends in the full sync (restart included).
        void next.repo.pull().catch(() => undefined);
      } else {
        void next.repo
          .sync()
          .then(() => this.mergeRegistryNpmrc(next.repo))
          .catch(() => undefined);
      }
    }
    if (!switching) return next;

    this.announceProjects();
    // The incoming project's state, now: a cold bring-up announced its first
    // phase above, but a warm return emits nothing on its own (pull keeps
    // the phase), and a client left holding the outgoing project's status
    // would keep painting the wrong preview.
    this.deps.broadcast({ type: "repo.status", status: await next.repo.status() });
    return next;
  }

  /**
   * 전환의 울타리. Of the servers still up in inactive projects, the oldest
   * beyond the warm cap stops before the incoming project brings itself up.
   * Every other warm server survives the switch — that is what makes a
   * return instant. The incoming dev server picks its own free port, so a
   * warm server never collides with it.
   */
  private async fenceWarmPreviews(next: ProjectWorkspaces): Promise<void> {
    const warm = [...this.workspaces.values()]
      .filter((workspaces) => workspaces !== next && workspaces.repo.previewRunning)
      .sort((a, b) => b.shownAt - a.shownAt);
    let kept = 0;
    for (const workspaces of warm) {
      if (kept < WARM_PREVIEWS) {
        kept += 1;
        continue;
      }
      await workspaces.repo.stop();
    }
  }

  /**
   * Creates a project and makes it the one on screen. The repo comes up
   * through the normal activation path — the clone is async on purpose, and
   * `repo.status` is how the wizard watches it arrive.
   */
  async createProject(message: {
    name: string;
    repoUrl: string | null;
    baseBranch?: string;
    approveCommands?: boolean;
    /** E4(초대 v2): 넘긴 요청의 리뷰를 부탁할 개발자들. */
    reviewers?: string[];
    /** 프로젝트별 지침(설정 문서 P1#8) — 세션의 시스템 프롬프트에 붙는다. */
    instructions?: string;
    /** 초대 v4(PLAN 단계 5): 새 대화의 처음 값 — 개발자가 초대 파일에 정한다. */
    defaults?: ProjectDefaults;
    /** 초대 v4(PLAN 단계 5): 사이클 수명 설정 — 개발자가 초대 파일에 정한다. */
    lifecycle?: ProjectLifecycle;
    /**
     * false 면 등록만 한다 — 초대장이 프로젝트 여러 개를 한 번에 실을 때, 첫 번째
     * 외의 등록은 화면을 튀게 하지 않는다(전환도 내려받기도 없음). 활성 프로젝트가
     * 하나도 없었다면 무시하고 연다 — 빈 화면을 지키는 것은 상태가 아니다.
     */
    activate?: boolean;
  }): Promise<ProjectSummary> {
    // The url reaches `git clone` — the ext:: family is a command executor
    // wearing a url, so the wire's word passes through the guard first.
    if (message.repoUrl) assertClonableRepoUrl(message.repoUrl);
    // 등록만 하는 길의 판정 기준 — 생성 전에 이미 활성 프로젝트가 있었는가.
    const hadActive = this.deps.registry.activeSlug() !== null;
    const project = this.deps.registry.create({
      name: message.name,
      repoUrl: message.repoUrl,
      ...(message.baseBranch ? { baseBranch: message.baseBranch } : {}),
      // The picker's word: the planner saw the commands this repo declares
      // and said they may run here. Without it the workspace stops after the
      // clone with errorKind `commands` until 실행 허용 is pressed.
      commandsApproved: message.approveCommands === true,
      ...(message.reviewers ? { reviewers: message.reviewers } : {}),
      ...(message.instructions ? { instructions: message.instructions } : {}),
      ...(message.defaults ? { defaults: message.defaults } : {}),
      ...(message.lifecycle ? { lifecycle: message.lifecycle } : {}),
    });
    if (message.activate === false && hadActive) {
      // 등록만 — 사이드바 행이 늘었다는 소식만 전한다. 전환도 내려받기도 없다.
      this.announceProjects();
    } else {
      await this.activateProject(project.slug);
      // activateProject sees no switch and stays silent — but a wizard waiting
      // on `project.changed` to show the switcher needs the announcement.
      this.announceProjects();
    }

    const summary = this.projectSummaries().find((entry) => entry.slug === project.slug);
    if (!summary) throw new Error("프로젝트를 만들지 못했습니다");
    return summary;
  }

  /**
   * The directory every session runs in: the active project's repo clone,
   * resolved through the filesystem. Sessions realpath their cwd (so
   * containment sees through the /private spelling); every transcript lookup
   * must use the same spelling or live sessions and stored transcripts stop
   * matching.
   */
  workspaceCwd(): string {
    return realpathBestEffort(this.requireActive().paths.repoRoot);
  }

  /**
   * 세션이 늘 달고 다니는 지침: 앱 공통 블록(주인은 앱 릴리스) + 이 클론
   * 주인의 "지켜 줄 것"(설정 문서 P1#8). 활성 프로젝트가 아니라 cwd 로
   * 찾는다 — 크래시 부활과 게이트 스레드는 자기가 살던 클론으로 살아나므로,
   * 그때의 프로젝트 규칙을 그대로 들고 가야 한다. 어느 클론이든 공통
   * 블록은 빠지지 않는다.
   */
  projectInstructions(cwd: string): string {
    const home = realpathBestEffort(cwd);
    for (const project of this.deps.registry.list()) {
      const root = realpathBestEffort(this.deps.registry.paths(project.slug).repoRoot);
      if (root === home) {
        return [COMMON_INSTRUCTIONS, project.instructions].filter(Boolean).join("\n\n");
      }
    }
    return COMMON_INSTRUCTIONS;
  }

  /**
   * Which store holds a session's transcript, for the messages that carry an
   * id but no project. A live session answers directly; otherwise the store
   * is the active project's repo clone.
   */
  async resolveSessionCwd(sessionId: string): Promise<string> {
    const live = this.deps.manager.get(sessionId);
    if (live) return live.cwd;
    // Nothing found: the repo clone is where a delete would have looked
    // anyway, and its own "already forgotten" path turns this into the no-op
    // it is.
    return this.workspaceCwd();
  }

  /**
   * The live machinery of the project a session runs in, by the session's
   * own cwd. A session outlives the planner's attention: its turn ends while
   * another project is on screen, and its file count must land on ITS row,
   * not on whichever project happens to be active (D14). The map is lazily
   * built — a project nobody has touched this run has no workspace and no
   * live session can be in it, so null is the honest answer.
   */
  workspaceOfSession(sessionId: string): ProjectWorkspaces | null {
    const live = this.deps.manager.get(sessionId);
    if (!live) return null;
    for (const workspaces of this.workspaces.values()) {
      if (realpathBestEffort(workspaces.paths.repoRoot) === live.cwd) return workspaces;
    }
    return null;
  }

  /**
   * A repo that declares a private registry gets the machine-wide
   * token into the user's ~/.npmrc (merged, never clobbering other lines).
   * Runs after a bring-up, because the declaration lives in the clone that
   * the bring-up just produced.
   */
  private mergeRegistryNpmrc(repo: RepoWorkspace): void {
    const registry = repo.repoConfig()?.registry;
    const pat = this.deps.pat();
    if (!registry || !pat) return;
    mergeNpmrc(npmrcPath(), [
      { key: `${scopeOf(registry)}:registry`, value: `https://${registry.host}/` },
      { key: `//${registry.host}/:_authToken`, value: pat },
    ]);
  }
}
