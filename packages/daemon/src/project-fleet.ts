import { homedir } from "node:os";
import type {
  ChatEvent,
  DiffStatus,
  HandoffStatusReport,
  ProjectSummary,
  ServerMessage,
  SessionCommand,
} from "@colo-design/protocol";
import { reviewToTurn } from "@colo-design/protocol";
import { probeCommands } from "./agent/drivers/claude/session.js";
import { COMMON_INSTRUCTIONS } from "./common-instructions.js";
import { mergeNpmrc, npmrcPath } from "./credentials.js";
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
   * same callback the bar listens to. The handoff poll refuses to touch a
   * repo whose 저장·넘기기 is still moving ("not a passive status read").
   */
  diffStage: DiffStatus["stage"] | null;
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
  /** 슬라이스 5: 환경 실패를 개발자 채널(Slack 웹훅)로 흘리는 문. */
  escalate(text: string): void;
  gitHubClient(): GitHubClient | null;
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
  /** 커미티 B1: slug → 마지막 폴링이 본 개발자 코멘트 수. */
  private readonly lastReviewCount = new Map<string, number>();
  /**
   * 커미티 P3-2: slug → 폴러가 마지막으로 감지한 개발자 쪽 사건과 그 발견
   * 시각. `projectSummaries()`가 그대로 내보낸다 — 비활성 프로젝트도 이
   * 값으로 홈의 요약 행을 그린다(크로스 프로젝트 인박스).
   */
  private readonly lastHandoffEvent = new Map<
    string,
    { kind: "merged" | "closed" | "changes_requested" | "comments" | "replied"; at: string }
  >();
  /**
   * 슬라이스 2 (2026-09-19 "무조건 처리"): slug → 데몬이 이미 AI 에 내려준
   * 리뷰 id 들. 자동 브리프의 단일 장부다 — 웹의 고치기 문은 걷혔고, 같은
   * 코멘트가 두 번 턴으로 나가는 일은 이 곳에서만 막는다.
   */
  private readonly briefedReviewIds = new Map<string, Set<number>>();
  /**
   * 슬라이스 2: sessionId → 자동 브리프가 연 턴이 끝나면 치러야 할 자동 저장.
   * 사람의 턴에는 붙지 않는다 — 오직 폴링이 내려놓은 리뷰 반영 턴만이
   * 저장까지 스스로 마무리한다.
   */
  private readonly autoSaveAfter = new Map<string, { slug: string; count: number }>();
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
        onUrlChange: (url) => this.deps.registry.update(slug, { repoUrl: url }),
        onStatus: (status) => {
          // repaint somebody else's preview column.
          this.announceProjectsThrottled();
          if (slug === this.deps.registry.activeSlug()) {
            this.deps.broadcast({ type: "repo.status", status });
          }
        },
        onDiffStatus: (status) => {
          workspaces.diffStage = status.stage;
          this.broadcastFor(slug, { type: "diff.status", status });
        },
        // hero-synthesis D1: 저장 · 넘김 · 반영 · 코멘트 도착 — 세션 채널 +
        // 테이프. The cycle names its session when the call carried one.
        onCycleEvent: (event, sessionId) => this.emitCycleEvent(workspaces, event, sessionId),
        // 슬라이스 5: 환경 실패(토큰 · 권한 · 첫 넘기기)는 개발자 채널로.
        escalate: (text) => this.deps.escalate(text),
      }),
    };
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
        // 홈 크로스 프로젝트 인박스(PLAN P3-2): 질문+권한 모두 스레드를
        // "awaiting" 으로 세우므로, 비활성 프로젝트라도 이 카운트만으로
        // 답을 기다리는 일의 수를 안다 — 세션이 살아 있는 한 값이 있다.
        pendingCount: (threads ?? []).filter((thread) => thread.state === "awaiting").length,
        ...(lastEvent ? { lastEventKind: lastEvent.kind, lastEventAt: lastEvent.at } : {}),
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
   * 커미티 B1 감동판 (2026-09-15): 열린 넘김이 있는 프로젝트를 다시 읽어,
   * 개발자 쪽 사건(반영됨·반려·변경 요청·새 코멘트)을 알림으로 보낸다.
   *
   * 슬라이스 4 (2026-09-19) 가 판정 1·2 의 반쪽을 고쳤다: 끝난 사이클의
   * 착지(fetch·checkout·reset·체크포인트 삭제)는 조건이 안전하면 타이머가
   * 스스로 내려앉힌다 — 변경 없음·최신화 유휴일 때뿐이고(anyBusy 는 폴링의
   * 머리가 지킨다), 하나라도 걸리면 여전히 사람이 있는 자리(상태 확인 ·
   * 활성화 · 다음 저장의 머리)로 미룬다. 알림은 여전히 사람을 부르지만,
   * 돌아왔을 때 정리가 이미 끝나 있어야 비개발자의 한 바퀴가 짧다.
   *
   * 그래도 도는 턴·저장·넘기기·최신화 중에는 읽지 않는다: GitHub 한 번 더
   * 부르는 값보다 그 손길들이 조용한 편이 낫다. 실패는 조용히 넘어간다 —
   * 다음 틱이 다시 본다.
   */
  async pollOpenHandoffs(): Promise<void> {
    if (this.deps.manager.anyBusy()) return;
    for (const workspaces of this.workspaces.values()) {
      const current = workspaces.repo.currentHandoff;
      if (!current || current.state === "merged" || current.state === "closed") continue;
      // 이미 본 끝은 다시 부르지 않는다 — 착지 전까지 열 번 울리지 않게.
      if (workspaces.repo.handoffLandingDue) continue;
      if (
        workspaces.diffStage === "computing" ||
        workspaces.diffStage === "pushing" ||
        workspaces.diffStage === "handing-off" ||
        workspaces.repo.busyRefreshing
      ) {
        continue;
      }
      const before = current.state;
      const beforeReviews = this.lastReviewCount.get(workspaces.slug) ?? null;
      let report: HandoffStatusReport | null = null;
      try {
        report = await workspaces.repo.peekHandoff();
      } catch {
        continue;
      }
      if (!report) continue;
      const reviews = report.reviews?.length ?? 0;
      // 읽기 실패의 빈 목록은 기준이 아니다 — 0 으로 세워 두면 다음 성공 읽기가
      // 옛 코멘트 전부를 '새 코멘트' 로 울린다. 실제 목록이 왔을 때만 옮긴다.
      if (report.reviews !== undefined) this.lastReviewCount.set(workspaces.slug, reviews);
      const projectName = this.deps.registry.get(workspaces.slug)?.name ?? workspaces.slug;
      const handoffNotice = (
        event: "merged" | "closed" | "changes_requested" | "comments",
        count?: number,
      ) => {
        this.lastHandoffEvent.set(workspaces.slug, { kind: event, at: new Date().toISOString() });
        this.deps.notice({
          kind: "handoff",
          slug: workspaces.slug,
          projectName,
          event,
          ...(count === undefined ? {} : { count }),
        });
      };
      if (report.state === "merged") {
        handoffNotice("merged");
      } else if (report.state === "closed") {
        handoffNotice("closed");
      } else if (before === "open" && report.state === "changes_requested") {
        handoffNotice("changes_requested");
      } else if (report.state === "open" && beforeReviews !== null && reviews > beforeReviews) {
        handoffNotice("comments", reviews - beforeReviews);
      }
      // 슬라이스 2 (무조건 처리): 새 리뷰는 알림으로 끝나지 않는다 — 데몬이
      // 스스로 고치기 턴을 내려놓고, 그 턴이 답을 내면 저장까지 마무리한다.
      // 장부(브리프된 id)를 먼저 보고 성공을 확인하며 되돌린다: 보내기가
      // 거절된 리뷰를 먹으면 다음 틱이 다시는 손대지 못한다.
      if (report.reviews !== undefined && report.state !== "merged" && report.state !== "closed") {
        const seen = this.briefedReviewIds.get(workspaces.slug);
        const unseen = report.reviews.filter((review) => !seen?.has(review.id));
        if (unseen.length > 0) {
          const target = this.autoFixThreadFor(workspaces);
          if (target) {
            const ids = seen ?? new Set<number>();
            for (const review of unseen) ids.add(review.id);
            this.briefedReviewIds.set(workspaces.slug, ids);
            try {
              target.send(reviewToTurn(unseen));
              this.autoSaveAfter.set(target.id, { slug: workspaces.slug, count: unseen.length });
            } catch {
              for (const review of unseen) ids.delete(review.id);
              this.autoSaveAfter.delete(target.id);
            }
          }
        }
      }
      // 슬라이스 4: 끝난 사이클의 자동 착지 — 워크트리가 깨끗할 때만. 변경이
      // 남았으면 사람이 있는 자리의 착지가 그 일감과 함께 간다(치워두기가
      // 붙는 것도 그 자리다). anyBusy 는 폴링의 머리에서 이미 지켰다.
      if (
        (report.state === "merged" || report.state === "closed") &&
        workspaces.repo.handoffLandingDue
      ) {
        const status = await workspaces.repo.status().catch(() => null);
        if (status !== null && status.pendingChanges === 0) {
          await workspaces.repo.refreshHandoff().catch(() => undefined);
        }
      }
    }
    // 사이드바 배지와 활성 프로젝트의 칩이 폴링의 결과를 본다 — UI 가 다시
    // 당기기를 기다리지 않게.
    this.announceProjectsThrottled();
    const active = this.activeOrNull();
    if (active) {
      void active.repo
        .status()
        .then((status) => this.deps.broadcast({ type: "repo.status", status }))
        .catch(() => undefined);
    }
  }

  /**
   * 슬라이스 2: 리뷰 반영 턴이 갈 살아 있는 대화 — 그 프로젝트 클론에서
   * 가장 최근에 움직인 살아 있는 대화. 없으면 도구가 "리뷰 반영" 대화를
   * 연다(게이트 실패 스레드와 같은 길): 사람의 손이 없어도 반영이
   * 시작되는 것이 이 흐름의 계약이다.
   */
  private autoFixThreadFor(workspaces: ProjectWorkspaces) {
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
      title: "리뷰 반영",
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
   * 슬라이스 2: 자동 브리프가 연 턴의 정산 — 답이 나왔으면 저장까지 스스로.
   * 실패한 턴은 정산하지 않는다: 감독(슬라이스 1)이 다시 시도하고, 그 재시도가
   * 성공한 턴 끝이 여기에 다시 온다. 중지된 턴은 사람의 뜻이므로 저장하지
   * 않고 기다린다 — 칩과 저장 버튼이 여전히 그 자리에 있다.
   */
  async settleAutoSave(sessionId: string): Promise<void> {
    const pending = this.autoSaveAfter.get(sessionId);
    if (!pending) return;
    this.autoSaveAfter.delete(sessionId);
    const workspaces = this.workspacesFor(pending.slug);
    const session = this.deps.manager.get(sessionId);
    if (!workspaces || !session) return;
    const projectName = this.deps.registry.get(pending.slug)?.name ?? pending.slug;
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
      }
    } catch {
      // 저장의 실패는 DiffStatus 와 게이트 브리프가 이미 말한다.
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
    // 커미티 2026-09-15 판정 2: 사람이 이 프로젝트 앞에 섰다 — 폴링이 세워 둔
    // 사이클의 끝(반영됨·반려)을 여기서 내려앉힌다. 밀린 것이 없으면 네트워크도
    // 타지 않고 즉시 돌아온다. 아래의 pull·sync 보다 **먼저**여야 한다: 착지의
    // checkout 과 최신화의 stash 가 같은 워크트리를 동시에 만지면 안 된다.
    await next.repo.landHandoffIfDue().catch(() => undefined);
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
  }): Promise<ProjectSummary> {
    // The url reaches `git clone` — the ext:: family is a command executor
    // wearing a url, so the wire's word passes through the guard first.
    if (message.repoUrl) assertClonableRepoUrl(message.repoUrl);
    const project = this.deps.registry.create({
      name: message.name,
      repoUrl: message.repoUrl,
      ...(message.baseBranch ? { baseBranch: message.baseBranch } : {}),
      // The picker's word: the planner saw the commands this repo declares
      // and said they may run here. Without it the workspace stops after the
      // clone with errorKind `commands` until 실행 허용 is pressed.
      commandsApproved: message.approveCommands === true,
    });
    await this.activateProject(project.slug);
    // activateProject sees no switch and stays silent — but a wizard waiting
    // on `project.changed` to show the switcher needs the announcement.
    this.announceProjects();

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
