import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import {
  type ClientMessage,
  type GitHubRepoList,
  type HandoffShot,
  markTurn,
  type PlanUsage,
  type PlanWindow,
  PROTOCOL_VERSION,
  type ProjectSummary,
  parseClientMessage,
  type ServerMessage,
  type SessionCommand,
  type SessionModelInfo,
  type SessionState,
} from "@colo-design/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { BOOTSTRAP_BRIEF, BOOTSTRAP_TITLE } from "./bootstrap-brief.js";
import { readComments, recordComments } from "./comments.js";
import {
  type CredentialStore,
  createCredentialStore,
  loadRepoPat,
  mergeNpmrc,
  migratePlaintextSecrets,
  migrateProjectPats,
  npmrcPath,
  REPO_PAT_ITEM,
} from "./credentials.js";
import {
  browseFiles,
  buildStatus,
  CONFIG_DIR,
  listFiles,
  resolveClaudeExecutable,
} from "./environment.js";
import { createGitHubTransport, GitHubClient } from "./github.js";
import { createFileLogger, type DaemonLogger } from "./log.js";
import {
  gitInstallGuidance,
  runOnboardingChecks,
  runPnpmInstall,
  startClaudeInstall,
  startClaudeLogin,
} from "./onboarding.js";
import { realpathBestEffort } from "./paths.js";
import {
  createPreviewTools,
  type PreviewDriver,
  type PreviewDriverFactory,
  type PreviewScreenDeclaration,
  type PreviewTools,
} from "./preview-tools.js";
import { type ProjectPaths, ProjectRegistry } from "./projects.js";
import { QueueStore } from "./queue-store.js";
import {
  assertClonableRepoUrl,
  RepoWorkspace,
  repoSettingsWarning,
  trustWorkspace,
  validateBootstrapConfig,
} from "./repo.js";
import {
  asPlannerFacingError,
  NEW_SESSION_TITLE,
  probeCommands,
  probePlanUsage,
  type Session,
} from "./session.js";
import { SessionManager } from "./session-manager.js";
import { repoWritePolicy } from "./workspaces.js";

// The desktop builds its driver against these (PLAN D61) — exported here so
// `@colo-design/daemon/server` stays the one import a host needs.
export type { PreviewDriver, PreviewDriverFactory } from "./preview-tools.js";

interface ProjectWorkspaces {
  slug: string;
  paths: ProjectPaths;
  repo: RepoWorkspace;
  /** When this project was last put on screen — the warm cap keeps the newest. */
  shownAt: number;
}

/**
 * Inactive projects whose preview server stays up beside the active one, so
 * a return is a repaint and not a bring-up. Each is a dev server of its own
 * (hundreds of MB): the cap bounds what clicking through the sidebar costs.
 */
const WARM_PREVIEWS = 2;

/** Where the last plan-limit reading waits for the next start. */
const PLAN_USAGE_FILE = join(CONFIG_DIR, "plan-usage.json");
/** Where the model picker's rows wait for the next start. */
const MODEL_CATALOG_FILE = join(CONFIG_DIR, "model-catalog.json");

/** Whether a window's own reset moment has already gone by. */
function hasReset(window: PlanWindow | null | undefined, now: number): boolean {
  if (!window?.resetsAt) return false;
  const at = Date.parse(window.resetsAt);
  return !Number.isNaN(at) && at <= now;
}

/**
 * The window as it stands now. A reset that has passed does not make the
 * window unknown — it makes it empty, so it comes back refilled instead of
 * disappearing: the row a planner watches is exactly the one that must not
 * vanish the moment its news turns good. The next reading names the new
 * reset time; until then there is none to promise.
 */
function refilled<T extends PlanWindow>(window: T, now: number): T {
  return hasReset(window, now) ? { ...window, utilization: 0, resetsAt: null } : window;
}

// Session permission policy lives in Session itself: it pins the CLI to
// `default` mode (so a user's own global defaultMode cannot widen hub
// sessions) and answers edit-class tools in-process. See session.ts.

/** Static types for the built web UI. */
const WEB_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/**
 * The daemon's one opinion about when a planner should be called back. The
 * shape is semantic on purpose — a thread's own name, never a session id or
 * a git word — so the receiver can paint it without re-deriving anything.
 */
export type DaemonNotice =
  | { kind: "done"; sessionId: string; title: string; durationMs?: number }
  | { kind: "crashed"; sessionId: string; title: string }
  | {
      kind: "ask";
      sessionId: string;
      title: string;
      what: "permission" | "question";
    }
  | {
      kind: "gate";
      sessionId: string;
      title: string;
      stage: "save" | "handoff" | "refresh";
    };

/**
 * 상태 전환 중 부르는 값이 되는 것: Claude 가 멈췄거나(idle), 중단됐거나
 * (error), 기획자의 답을 기다리거나(waiting_*). starting 과 running 은
 * 기획자가 방금 본 것이고 closed 는 스스로 닫은 것이다.
 */
function noticeForState(
  sessionId: string,
  state: SessionState,
  title: string,
  durationMs?: number,
): DaemonNotice | null {
  switch (state) {
    case "idle":
      return {
        kind: "done",
        sessionId,
        title,
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
    case "error":
      return { kind: "crashed", sessionId, title };
    case "waiting_permission":
      return { kind: "ask", sessionId, title, what: "permission" };
    case "waiting_question":
      return { kind: "ask", sessionId, title, what: "question" };
    default:
      return null;
  }
}

export interface DaemonConfig {
  host: string;
  port: number;
  /** Shared secret a client must present. Generated on first run. */
  token: string;
  claudeExecutable?: string;
  /**
   * Where the web UI's built files live. When set, the daemon serves them
   * itself — the desktop app is one process serving one origin, no pairing
   * screen. The browser dev path (separate vite server + pasted ws url)
   * keeps working when this is unset.
   */
  webDist?: string;
  /** Credential store; the desktop app injects its safeStorage-backed one. */
  credentialStore?: CredentialStore;
  /**
   * 기획자가 돌아와야 하는 순간의 갈고리 — 턴이 끝났을 때, Claude 가 확인을
   * 기다릴 때, 게이트가 실패했을 때. 데몬은 의미만 건넨다; 그것을 OS 알림으로
   * 그릴지는 받는 쪽(데스크톱 앱)의 몫이므로, 브라우저 개발 경로는 이 갈고리
   * 없이도 온전하다.
   */
  onNotice?: (notice: DaemonNotice) => void;
  /**
   * 데몬의 파일 로그 싱크. 지정하지 않으면 `~/.colo-design/logs` 의 하루
   * 파일 로거를 스스로 만든다 — 데스크톱 앱이 in-process 로 데몬을 키우므로
   * console 은 아무에게도 닿지 않고, 흔적은 파일로만 남는다.
   */
  logger?: DaemonLogger;
  /**
   * The desktop's offscreen-window driver (PLAN D61). When a host injects
   * it, sessions of a project whose preview server is up get the
   * `colo-preview` tools; without it — the browser dev path — sessions run
   * exactly as before, with no preview tools at all.
   */
  previewDriverFactory?: PreviewDriverFactory;
}

export class DaemonServer {
  private readonly clients = new Set<WebSocket>();
  private readonly manager: SessionManager;
  private readonly logger: DaemonLogger;
  private readonly credentials: CredentialStore;
  /**
   * The project registry and one live workspace per project the daemon has
   * touched this run. Only the ACTIVE project runs a preview server — two
   * repos may declare the same `preview.port` — but a project the planner
   * switched away from keeps its clone.
   */
  private registry!: ProjectRegistry;
  private readonly workspaces = new Map<string, ProjectWorkspaces>();
  /**
   * One GitHub transport for the whole daemon: the fixture one when a test
   * points at recorded pairs, `api.github.com` otherwise. The token is not
   * here — it is machine-wide, and rides on each client.
   */
  private readonly gitHubTransport = createGitHubTransport().transport;
  /** The machine-wide GitHub token, loaded once per run and on github.token.set. */
  private pat: string | null = null;
  /** The picker's list, cached per token; a token change invalidates it. */
  private repoListCache: { token: string; list: GitHubRepoList } | null = null;
  private http: Server | null = null;
  /** The CLI's model rows, cached so the picker works before any thread. */
  private models: SessionModelInfo[] = this.loadModels();
  private wss: WebSocketServer | null = null;
  private claudeExecutable: string | null = null;
  /**
   * How many 화면 turns each session has started (PLAN D52). The number is
   * the checkpoint ref's `<turn>` — a turn's snapshot is the worktree as it
   * stood the moment that turn was handed over. Daemon memory is the right
   * home: the refs themselves survive in git, and a restart only means the
   * count starts over on an unused number.
   *
   * `session.send` seeds the count (from the transcript, once per process);
   * the DELIVERY bumps it — the `user.echo` the session emits as it hands the
   * words to the CLI. A send waiting for the next turn (PLAN D86) is not a
   * turn yet: snapshotting at send time would freeze the worktree while the
   * previous turn is still editing it, and a send taken back out of the room
   * would leave a numbered checkpoint no prompt ever had.
   */
  private readonly checkpointTurns = new Map<string, number>();
  /** Minimum spacing between re-reads of the plan's limits. */
  private static readonly PLAN_REFRESH_BACKOFF_MS = 120_000;
  /** Last time `refreshPlanUsage` actually asked, epoch ms. */
  private lastPlanRefresh = 0;
  /** Account-wide plan limits: last reading, restored across restarts. */
  private planUsage: PlanUsage | null = this.loadPlanUsage();
  /**
   * One fresh reading is owed per run. The cache on disk is only as complete
   * as the build that wrote it — one from before per-model weeks carries no
   * Fable row at all — and the account's numbers move whether this daemon is
   * running or not, so the chip opens on a reading of its own rather than on
   * whatever the last turn happened to leave behind.
   */
  private planReadingOwed = true;
  /**
   * The preview driver each session received (PLAN D61), so its window can
   * die with the session, the project switch, or the daemon itself.
   */
  private readonly previewDrivers = new Map<string, PreviewDriver>();
  /**
   * The connected repo's declared screens (the `colo-design.screens`
   * envelope's cache, PLAN D7) — the list `screen_list` serves. The web UI
   * holds the same list today; the daemon's copy fills when the overlay
   * bridge lands. Read on every call, never snapshotted into the tools.
   */
  private previewScreens: PreviewScreenDeclaration[] = [];
  /** D94: slugs whose connection Claude prepares (the picker's 선택). */
  private readonly bootstrapSlugs = new Set<string>();
  /**
   * The `/` palette with no thread open: one CLI boot per repo, cached, so an
   * empty workspace still lists every command the terminal would. A live
   * session's own answer always wins over this.
   */
  private readonly cliCommandsCache = new Map<string, SessionCommand[]>();
  private cliCommandsProbe: Promise<SessionCommand[]> | null = null;
  /**
   * 세션별 최근 running 진입 시각 — 완료 알림에 태울 턴의 길이(알림 시점
   * 정책의 "오래 걸린 턴")를 재는 시계. 대기 후 재개는 시계를 다시 놓는다.
   *
   * 화면의 진행 시계(`Session.turnStartedAt`)와 헷갈리지 않게 이름이 다르다:
   * 그쪽은 요청 하나가 시작한 시각을 카드 앞의 기다림까지 포함해 끝까지 든다.
   */
  private readonly notifyClockAt = new Map<string, number>();
  /**
   * 대기 줄의 디스크 절반 (PLAN D86 의 확장): the wait rooms' mirror and the
   * lost room's keeper, keyed by session id under the run dir.
   */
  private readonly queueStore = new QueueStore();
  /** 세션에 하나씩 물려주는 디스크 손잡이 — Session 이 자기 id 로 부른다. */
  private readonly queueDiskFor = (sessionId: string) => this.queueStore.for(sessionId);

  constructor(private readonly config: DaemonConfig) {
    this.credentials = config.credentialStore ?? createCredentialStore();
    this.logger = config.logger ?? createFileLogger();
    this.manager = new SessionManager({
      onEvent: (sessionId, event) => {
        this.broadcast({ type: "session.event", sessionId, event });
        // 한도가 움직였다 (PLAN D100): 요금 칩이 2분 뒤에야 진실을 말하면,
        // 계획자는 이미 막힌 뒤에 그 사실을 안다. 다음 읽기를 앞당긴다.
        if (event.kind === "ratelimit") {
          this.planReadingOwed = true;
          this.lastPlanRefresh = 0;
          this.refreshPlanUsage();
          return;
        }
        // 화면 턴의 시작점 (PLAN D52): the echo IS the hand-over. The snapshot
        // must never hold the turn hostage — a failed checkpoint only means
        // one fewer 되돌리기, so it runs alongside and keeps its failure to
        // itself. A session the planner never sent into has no count, and
        // none of its machine turns starts one.
        if (event.kind !== "user.echo") return;
        const turn = this.checkpointTurns.get(sessionId);
        if (turn === undefined) return;
        this.checkpointTurns.set(sessionId, turn + 1);
        void this.repo.checkpoint(sessionId, turn + 1).catch(() => undefined);
      },
      onState: (sessionId, state, detail) => {
        // 파일 로그의 뼈대: 턴이 언제 시작해 언제 어떤 상태로 내려앉았는지.
        this.logger.info("세션 상태", { sessionId, state, ...(detail ? { detail } : {}) });
        // 완료 알림에 태울 턴의 길이: running 진입에 시계를 놓고 idle 에서 회수한다.
        // 대기 뒤 재개는 시계를 다시 놓는다 — 그때의 일이 그때의 완료를 말한다.
        // (화면의 진행 시계는 다른 질문에 답한다 — 아래 `startedAt` 을 보라.)
        let turnDurationMs: number | undefined;
        if (state === "running") {
          this.notifyClockAt.set(sessionId, Date.now());
        } else if (state === "idle") {
          const startedAt = this.notifyClockAt.get(sessionId);
          this.notifyClockAt.delete(sessionId);
          turnDurationMs = startedAt === undefined ? undefined : Date.now() - startedAt;
        } else if (state === "closed") {
          this.notifyClockAt.delete(sessionId);
        }
        // 진행 시계 (화면의 `n분 n초`): 시작을 창이 아니라 세션이 들고 있으므로
        // 새로고침해도 두 번째 창에서도 같은 초를 센다. 도는 턴이 없는 세션의
        // 시계는 null 이라 그 상태에는 붙지 않는다.
        const startedAt = this.manager.get(sessionId)?.turnStartedAt ?? null;
        this.broadcast({
          type: "session.state",
          sessionId,
          state,
          ...(detail ? { detail } : {}),
          ...(startedAt === null ? {} : { startedAt }),
        });
        // A turn that just finished is the one moment the clone can have
        // gained files nobody has saved (PLAN D8). Counting here — rather
        // than on a timer — is what lets the top bar say 저장 the instant
        // Claude stops, and say nothing at all while it is still writing.
        // The count belongs to the session's OWN project, not the active
        // one: a turn finishing in B while the planner reads A must move
        // B's number (D14).
        if (state !== "running") {
          void this.workspaceOfSession(sessionId)?.repo.refreshPendingChanges();
        }
        // The tree's child row reads this session's state (PLAN D59): the
        // clone's threads are stale the moment it moves.
        const sessionWorkspaces = this.workspaceOfSession(sessionId);
        if (sessionWorkspaces) {
          this.manager.invalidateThreads(realpathBestEffort(sessionWorkspaces.paths.repoRoot));
          this.refreshThreads();
        }
        const notice = noticeForState(
          sessionId,
          state,
          this.manager.get(sessionId)?.title ?? NEW_SESSION_TITLE,
          turnDurationMs,
        );
        if (notice) this.config.onNotice?.(notice);
        // The driver a session received dies with the session (PLAN D61):
        // close, delete, remove, and daemon stop all land here as `closed`.
        if (state === "closed") this.destroyPreviewDriver(sessionId);
      },
      onPermissionRequest: (payload) => this.broadcast({ type: "permission.request", ...payload }),
      onQuestionRequest: (payload) => this.broadcast({ type: "question.request", ...payload }),
    });
  }

  async start(): Promise<void> {
    this.claudeExecutable = await resolveClaudeExecutable(this.config.claudeExecutable);
    // 기동 청소 (PLAN D86 의 확장): rooms the dead process was holding come
    // back as the lost room — the turns they waited for are gone, so the
    // words surface for the planner's hand, never for an automatic send.
    const orphaned = this.queueStore.sweepOrphans();
    if (orphaned > 0) this.logger?.info(`queue: recovered ${orphaned} lost room(s) from disk`);

    // Secrets move into the OS store on the way in; settings files keep only
    // what is not secret. A platform without its store yet keeps its plaintext.
    await migratePlaintextSecrets(this.credentials);

    // A pre-projects installation becomes one project here, folder and all,
    // and its per-project PAT — if the old layout left one — becomes the
    // machine-wide token nobody has to re-enter.
    this.registry = ProjectRegistry.load(process.env);
    await migrateProjectPats(
      this.credentials,
      this.registry.list().map((project) => project.slug),
      this.registry.activeSlug(),
    );
    this.pat = await loadRepoPat(this.credentials);

    // Warm restart: bring the active project up the same way a switch does —
    // in particular, arm its token. A start that only built the workspace
    // left it unarmed until the planner happened to switch projects, so a
    // private repo could neither pull nor hand over after a restart.
    // `activateProject` sees nothing moving and stops after arming it.
    const activeSlug = this.registry.activeSlug();
    if (activeSlug) {
      const active = await this.activateProject(activeSlug);
      if (active.repo.remoteUrl) void active.repo.sync().catch(() => undefined);
    }

    // The sidebar's numbers and badges exist before anyone clicks (PLAN D18):
    // a workspace per project — cheap, synchronous, side-effect free — and
    // one `git status` per cloned project so a restart does not blank the
    // counts. Only the ACTIVE project gets a preview server; that is what
    // activation above already did. Clones re-arm their trust entry too: the
    // ~/.colo-design migration renamed every clone path, and trust is keyed
    // by path.
    const sweeps: Array<Promise<unknown>> = [];
    for (const project of this.registry.list()) {
      const workspaces = this.workspacesFor(project.slug);
      workspaces.repo.setPat(this.pat);
      if (workspaces.repo.isCloned()) {
        trustWorkspace(workspaces.paths.repoRoot);
        // Awaited, not fired-and-forgotten: the first announce and every
        // client's first status read must see the counted clone, or a
        // restart blanks the counts for exactly the moment the tree also
        // starts scanning (PLAN D18/D59).
        sweeps.push(
          workspaces.repo
            .recoverParkedWork()
            .catch(() => undefined)
            .then(() => workspaces.repo.refreshPendingChanges()),
        );
      }
    }
    await Promise.all(sweeps);
    if (this.registry.list().length > 0) this.announceProjects();

    this.http = createServer((req, res) => {
      // Everything this server emits is either per-run (a token'd page) or
      // live state: no store, ever — a disk cache must never hold a url that
      // carries the pairing token (QA generation-1 finding F2).
      res.setHeader("cache-control", "no-store");
      // A tiny health endpoint so `hub doctor` and launchd can probe the daemon.
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION }));
        return;
      }
      if (this.config.webDist) {
        this.serveWeb(req, res);
        return;
      }
      res.writeHead(404).end();
    });

    this.wss = new WebSocketServer({ noServer: true });

    this.http.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const given = Buffer.from(url.searchParams.get("token") ?? "");
      const expected = Buffer.from(this.config.token);
      // Constant-time: this token guards every message the daemon accepts.
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        this.logger.warn("토큰 불일치 연결 거부", {
          remote: req.socket.remoteAddress ?? "unknown",
        });
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.attach(ws));
    });

    await new Promise<void>((resolve, reject) => {
      // A bind failure (the stored port is taken) must reach the caller as a
      // rejection, not crash the process on an unhandled 'error' event — the
      // daemon entry prints its Korean guidance from that rejection.
      this.http!.once("error", reject);
      this.http!.listen(this.config.port, this.config.host, () => resolve());
    });
    const bound = this.address();
    this.logger.info("데몬 시작", {
      host: bound.address,
      port: bound.port,
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  /** Where the HTTP server actually bound (port 0 = ephemeral in desktop). */
  address(): { address: string; port: number } {
    const bound = this.http!.address() as { address: string; port: number };
    return bound;
  }

  /** 리뷰 B3: the desktop's close guard asks before quitting under a turn. */
  anySessionBusy(): boolean {
    return this.manager.anyBusy();
  }

  async stop(): Promise<void> {
    this.logger.info("데몬 종료");
    await this.manager.closeAll();
    // Every project the daemon touched this run, not just the active one: an
    // inactive project may still hold a warm preview server, and every
    // preview process is ours to take down.
    for (const workspaces of this.workspaces.values()) {
      // Writers settle BEFORE the preview dies: a 최신화 killed between its
      // stash and its pop parks the planner's unsaved work in `git stash`.
      await workspaces.repo.settle();
      await workspaces.repo.stop();
    }
    for (const client of this.clients) client.close();
    this.wss?.close();
    // The web/http listener refs the event loop for as long as it listens —
    // the desktop in-process host and the test runner both stay alive until
    // it is closed, so stop() must close it, not just the websocket.
    await new Promise<void>((resolve) => this.http?.close(() => resolve()));
    this.http = null;
  }

  private attach(ws: WebSocket): void {
    this.clients.add(ws);
    this.logger.info("클라이언트 연결", { clients: this.clients.size });
    ws.on("close", () => {
      this.clients.delete(ws);
      this.logger.info("클라이언트 연결 해제", { clients: this.clients.size });
    });
    ws.on("message", (raw) => void this.onMessage(ws, String(raw)));

    void this.status().then((status) => {
      this.send(ws, {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        status,
      });
      // 재접속 복원 (리뷰 B1): the requests the window missed while it was
      // gone — the cards it must answer or the turn waits forever. THIS
      // socket only; a broadcast would double every other window's cards.
      // The client dedupes by requestId, so a flapping socket replays safe.
      for (const message of this.manager.pendingReplays()) this.send(ws, message);
    });
    void this.activeOrNull()
      ?.repo.status()
      .then((status) => this.broadcast({ type: "repo.status", status }));
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  private broadcast(message: ServerMessage): void {
    for (const client of this.clients) this.send(client, message);
  }

  // -------------------------------------------------------------------------
  // Projects (PLAN D2[프로젝트]): what "the repo" currently means
  // -------------------------------------------------------------------------

  /**
   * A project's live workspace, built the first time it is touched.
   *
   * The repo url lives in the registry, not in the workspace, so `update()`
   * hands its moved url back through `onUrlChange` and the registry stays the
   * single place a url is written. The token is machine-wide and arrives by
   * `setPat` after construction, because construction is synchronous.
   */
  private workspacesFor(slug: string): ProjectWorkspaces {
    const existing = this.workspaces.get(slug);
    if (existing) return existing;
    const repo = this.registry.resolvedRepo(slug);
    const paths = this.registry.ensureDirs(slug);
    // The registry owns the planner's word on this repo's commands; `undefined`
    // is a pre-gate project whose commands have already run here.
    const commandsApproved = this.registry.get(slug)?.commandsApproved !== false;
    const workspaces: ProjectWorkspaces = {
      slug,
      paths,
      shownAt: 0,
      repo: new RepoWorkspace({
        root: paths.repoRoot,
        url: repo.url,
        baseBranch: repo.baseBranch,
        cycle: { branch: repo.branch, handoff: repo.handoff },
        // Only the project on screen may START a preview (switch race fence).
        active: slug === this.registry.activeSlug(),
        // The registry owns the planner's word on this repo's commands.
        commandsApproved,
        // D94: 연결 준비 — the picker's Claude-prepare choice rides the
        // workspace, and its callback opens the brief turn here.
        ...(this.bootstrapSlugs.has(slug)
          ? {
              bootstrap: true,
              prepareBootstrap: () => this.runBootstrapPrepare(paths.repoRoot),
            }
          : {}),
        onCycleChange: (cycle) => this.registry.setCycle(slug, cycle),
        gitHubClient: () => this.gitHubClient(),
        // The summarizer's one turn rides the same CLI the sessions do
        // (PLAN D51) — one login, one resolution, no second source of truth.
        claudeExecutable: this.claudeExecutable,
        onUrlChange: (url) => this.registry.update(slug, { repoUrl: url }),
        onStatus: (status) => {
          // ANY workspace's phase or count movement re-announces the whole
          // registry, throttled. The typed `repo.status` stream stays the
          // active project's only — a background clone finishing must not
          // repaint somebody else's preview column.
          this.announceProjectsThrottled();
          if (slug === this.registry.activeSlug()) {
            this.broadcast({ type: "repo.status", status });
          }
        },
        onDiffStatus: (status) => this.broadcastFor(slug, { type: "diff.status", status }),
      }),
    };
    this.workspaces.set(slug, workspaces);
    return workspaces;
  }

  /**
   * Progress from a project the planner is no longer looking at would read as
   * the active one's — a clone finishing in the background must not repaint
   * somebody else's screen. Inactive projects still run to completion; they
   * just do it quietly.
   */
  private broadcastFor(slug: string, message: ServerMessage): void {
    if (slug === this.registry.activeSlug()) this.broadcast(message);
  }

  /** The active project's workspaces, or null before the first one exists. */
  private activeOrNull(): ProjectWorkspaces | null {
    const slug = this.registry?.activeSlug();
    return slug ? this.workspacesFor(slug) : null;
  }

  /**
   * The palette's rows before a session exists: the CLI probed once per repo
   * and cached for the run. A failed probe answers empty and lets the next
   * ask retry — a CLI that was mid-install should not be remembered broken.
   */
  private async cliCommands(): Promise<SessionCommand[]> {
    if (!this.claudeExecutable) return [];
    const active = this.activeOrNull();
    // Project skills ride the clone's cwd; with no clone yet the user-level
    // set is still worth having, and the home dir is a cwd that exists.
    const cwd =
      active && active.repo.isCloned() ? realpathBestEffort(active.paths.repoRoot) : homedir();
    const cached = this.cliCommandsCache.get(cwd);
    if (cached) return cached;
    this.cliCommandsProbe ??= probeCommands({
      cwd,
      executable: this.claudeExecutable,
    })
      .then((commands) => {
        this.cliCommandsCache.set(cwd, commands);
        return commands;
      })
      .catch(() => {
        this.cliCommandsProbe = null;
        return [] as SessionCommand[];
      });
    return await this.cliCommandsProbe;
  }

  /**
   * The active project, refusing in Korean when there is none. Every message
   * that means "the repo" goes through here: without a project that word has
   * no referent, and the wizard is what fixes it.
   */
  private requireActive(): ProjectWorkspaces {
    const active = this.activeOrNull();
    if (!active) throw new Error("프로젝트가 없습니다 — 설정에서 프로젝트를 먼저 만들어 주세요.");
    return active;
  }

  private get repo(): RepoWorkspace {
    return this.requireActive().repo;
  }

  private projectSummaries(): ProjectSummary[] {
    return (this.registry?.list() ?? []).map((project) => {
      const workspaces = this.workspaces.get(project.slug);
      const repo = workspaces?.repo;
      // The tree's children come from the per-clone cache (PLAN D59); a clone
      // the daemon has not scanned yet omits the field rather than claiming
      // an empty conversation list.
      const cwd = workspaces?.repo.isCloned()
        ? realpathBestEffort(workspaces.paths.repoRoot)
        : null;
      const threads = cwd ? this.manager.cachedThreads(cwd) : null;
      return {
        slug: project.slug,
        name: project.name,
        repoUrl: project.repo.url,
        baseBranch: project.repo.baseBranch,
        // No workspace means the daemon never touched this project since its
        // last restart: disk state is all a summary may claim.
        phase: repo ? repo.syncState().phase : "missing",
        pendingChanges: repo?.pendingChangeCount ?? 0,
        working: repo
          ? this.manager.anyRunning(realpathBestEffort(workspaces.paths.repoRoot))
          : false,
        handoff: repo?.currentHandoff ?? project.repo.handoff,
        ...(threads ? { threads } : {}),
        ...(project.instructions ? { instructions: project.instructions } : {}),
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
  private announceTimer: NodeJS.Timeout | null = null;
  private announceProjectsThrottled(): void {
    if (this.announceTimer) return;
    this.announceTimer = setTimeout(() => {
      this.announceTimer = null;
      this.announceProjects();
    }, 200);
    // Keep the Node process from being held open by a pending announce.
    this.announceTimer.unref();
  }
  private announceProjects(): void {
    this.broadcast({
      type: "project.changed",
      projects: this.projectSummaries(),
      activeSlug: this.registry.activeSlug(),
    });
    // The tree rides the same message (PLAN D59); a scan that lands something
    // new announces once more and the key compare below stops the loop.
    this.refreshThreads();
  }

  /** The last threads each project announced with, as JSON — the guard that
   * keeps refreshThreads from announcing unchanged pictures forever. */
  private readonly announcedThreads = new Map<string, string>();
  /**
   * Scan every cloned project's threads off the announce path. A clone whose
   * cache a session event just marked stale rescans here; the rest re-merge
   * live state only. The result goes out through the throttled announce, so
   * bursts land as one `project.changed` (PLAN D17).
   */
  private refreshThreads(): void {
    for (const project of this.registry?.list() ?? []) {
      const workspaces = this.workspaces.get(project.slug);
      if (!workspaces?.repo.isCloned()) continue;
      const cwd = realpathBestEffort(workspaces.paths.repoRoot);
      void this.manager
        .refreshThreads(cwd)
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
  private touchThreadsCwd(cwd: string | null | undefined): void {
    if (!cwd) return;
    this.manager.invalidateThreads(cwd);
    this.refreshThreads();
  }

  // -------------------------------------------------------------------------
  // Preview tools (PLAN D61) — the desktop's driver, one per session
  // -------------------------------------------------------------------------

  /**
   * The session options' preview half: a `colo-preview` tool set bound to the
   * active project's preview url, when a driver is injected, the preview
   * server is up, and the planner has not turned the tools off. Everything
   * else — no desktop, no preview yet, `previewTools: false` — is a session
   * without them.
   */
  private async previewToolsFor(
    enabled: boolean,
    onOpened?: (route: string, state: string | null) => void,
  ): Promise<{ tools: PreviewTools; driver: PreviewDriver } | null> {
    const factory = this.config.previewDriverFactory;
    if (!factory || !enabled) return null;
    const active = this.activeOrNull();
    if (!active?.repo.isCloned()) return null;
    const status = await active.repo.status().catch(() => null);
    if (!status?.previewUrl) return null;
    const driver = factory.for(status.previewUrl);
    const tools = createPreviewTools(driver, () => this.previewScreens, onOpened);
    if (!tools) {
      // A driver that never got tools must not leave a window behind.
      await driver.destroy().catch(() => undefined);
      return null;
    }
    return { tools, driver };
  }

  /** The session's driver dies with the session (PLAN D61). */
  private destroyPreviewDriver(sessionId: string): void {
    const driver = this.previewDrivers.get(sessionId);
    if (!driver) return;
    this.previewDrivers.delete(sessionId);
    void driver.destroy().catch(() => undefined);
  }

  /**
   * D94: 연결 준비 턴 — a daemon-opened conversation (the comment envelope's
   * path, server-side) sends the brief, waits for the turn to settle, then
   * machine-validates what Claude wrote. False means the gate refused; the
   * sync turns into error{errorKind:"bootstrap"} and NOTHING outside the
   * gate ever ran.
   */
  private async runBootstrapPrepare(repoRoot: string): Promise<boolean> {
    if (!this.claudeExecutable) return false;
    const cwd = realpathBestEffort(repoRoot);
    const instructions = this.projectInstructions(cwd);
    const session = this.manager.create({
      cwd,
      claudeExecutable: this.claudeExecutable,
      queueDiskFor: this.queueDiskFor,
      ...(instructions ? { appendSystemPrompt: instructions } : {}),
      title: BOOTSTRAP_TITLE,
    });
    this.announceProjectsThrottled();
    session.send(
      markTurn({ kind: "brief", title: BOOTSTRAP_TITLE, purpose: "bootstrap" }, BOOTSTRAP_BRIEF),
    );
    // The turn ends when the session settles back to idle; a stalled CLI
    // fails the prepare rather than hanging the sync forever.
    const settled = await (async () => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const live = this.manager.get(session.id);
        if (!live) return false;
        if (live.state === "idle" || live.state === "closed") return true;
        if (live.state === "error") return false;
        await new Promise((ok) => setTimeout(ok, 500));
      }
      return false;
    })();
    if (!settled) return false;
    try {
      const config = JSON.parse(readFileSync(join(cwd, "colo-design.json"), "utf8")) as {
        install?: string;
        check?: string;
        build?: string;
        preview?: { command: string; port: number };
      };
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
        scripts?: Record<string, unknown>;
      };
      const lockfile = existsSync(join(cwd, "pnpm-lock.yaml"))
        ? ("pnpm-lock.yaml" as const)
        : existsSync(join(cwd, "package-lock.json"))
          ? ("package-lock.json" as const)
          : existsSync(join(cwd, "yarn.lock"))
            ? ("yarn.lock" as const)
            : null;
      const problem = validateBootstrapConfig({
        config,
        packageScripts: pkg.scripts ?? {},
        lockfile,
      });
      return problem === null;
    } catch {
      return false;
    }
  }

  /**
   * 넘기기의 화면 캡처 (PLAN D56): each declared screen·state, opened in the
   * preview driver and captured. Desktop only — the browser dev path has no
   * driver — and every failure is quiet: a capture that will not come back
   * simply is not in the set, and an empty set means the pull request body
   * carries no `### 화면 미리보기` section at all.
   */
  private async captureHandoffShots(): Promise<HandoffShot[]> {
    const factory = this.config.previewDriverFactory;
    const active = this.activeOrNull();
    if (!factory || !active?.repo.isCloned()) return [];
    // The repo's refusal is also read at commit time (repo.ts); checking here
    // spares the window the drive through every screen.
    if (active.repo.coloDesign()?.shots === false) return [];
    const status = await active.repo.status().catch(() => null);
    if (!status?.previewUrl || this.previewScreens.length === 0) return [];
    const driver = factory.for(status.previewUrl);
    const shots: HandoffShot[] = [];
    try {
      for (const screen of this.previewScreens) {
        // A screen that declares no states still has its default look.
        const states = screen.states.length > 0 ? screen.states : ["default"];
        for (const state of states) {
          try {
            await driver.open(screen.route, state);
            shots.push({
              route: screen.route,
              state,
              png: Buffer.from(await driver.screenshot(), "base64"),
            });
          } catch {
            // One screen failing must not sink the rest of the set.
          }
        }
      }
    } finally {
      await driver.destroy().catch(() => undefined);
    }
    return shots;
  }

  /**
   * Every driver rooted at a clone dies when that clone's preview does — the
   * switch fence or the warm cap stopped the server, and the sessions left
   * behind would otherwise point their windows at a dead port.
   */
  private destroyPreviewDriversWhere(cwd: string): void {
    for (const session of this.manager.all()) {
      if (session.cwd === cwd) this.destroyPreviewDriver(session.id);
    }
  }

  /** The switch in flight — see `activateProject`. */
  private activating: Promise<ProjectWorkspaces> | null = null;

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
  private activateProject(slug: string): Promise<ProjectWorkspaces> {
    const run = this.activating ?? Promise.resolve();
    const next = run.catch(() => undefined).then(() => this.activateProjectInner(slug));
    this.activating = next.finally(() => {
      if (this.activating === next) this.activating = null;
    });
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
      this.registry.setActive(slug);
    }

    // The token was loaded once in `start()`; every workspace gets it armed
    // the same way, switch or no switch.
    const next = this.workspacesFor(slug);
    next.shownAt = Date.now();
    next.repo.setActive(true);
    next.repo.setPat(this.pat);
    // The fence runs BEFORE the incoming bring-up can spawn: a server of ours
    // on the port it declares would be killed by that spawn's port reclaim,
    // and a half-overlapping restart would leave the planner looking at the
    // wrong app on the right port.
    if (switching) await this.fenceWarmPreviews(next);
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
    this.broadcast({ type: "repo.status", status: await next.repo.status() });
    return next;
  }

  /**
   * 전환의 울타리. Of the servers still up in inactive projects, two kinds
   * stop before the incoming project brings itself up: whatever holds the
   * port the incoming repo declares (two repos may declare the same
   * `preview.port`), and the oldest beyond the warm cap. Every other warm
   * server survives the switch — that is what makes a return instant.
   *
   * An incoming port nobody can read yet (a clone still to come, no config)
   * stops every warm server: the single-owner rule of old, kept for the one
   * case the fence cannot decide.
   */
  private async fenceWarmPreviews(next: ProjectWorkspaces): Promise<void> {
    const incoming = next.repo.declaredPreviewPort();
    const warm = [...this.workspaces.values()]
      .filter((workspaces) => workspaces !== next && workspaces.repo.previewRunning)
      .sort((a, b) => b.shownAt - a.shownAt);
    let kept = 0;
    for (const workspaces of warm) {
      const port = workspaces.repo.declaredPreviewPort();
      const collides = incoming === null || port === null || port === incoming;
      if (!collides && kept < WARM_PREVIEWS) {
        kept += 1;
        continue;
      }
      await workspaces.repo.stop();
      // Its sessions' drivers would point their windows at a dead port (PLAN D61).
      this.destroyPreviewDriversWhere(realpathBestEffort(workspaces.paths.repoRoot));
    }
  }

  /**
   * Creates a project and makes it the one on screen. The repo comes up
   * through the normal activation path — the clone is async on purpose, and
   * `repo.status` is how the wizard watches it arrive.
   */
  private async createProject(message: {
    name: string;
    repoUrl: string | null;
    baseBranch?: string;
    bootstrap?: boolean;
    approveCommands?: boolean;
  }): Promise<ProjectSummary> {
    // The url reaches `git clone` — the ext:: family is a command executor
    // wearing a url, so the wire's word passes through the guard first.
    if (message.repoUrl) assertClonableRepoUrl(message.repoUrl);
    const project = this.registry.create({
      name: message.name,
      repoUrl: message.repoUrl,
      ...(message.baseBranch ? { baseBranch: message.baseBranch } : {}),
      // The picker's word: the planner saw the commands this repo declares
      // and said they may run here. Without it the workspace stops after the
      // clone with errorKind `commands` until 실행 허용 is pressed.
      commandsApproved: message.approveCommands === true,
    });
    // The flag must be known before the first sync runs — the workspace reads
    // it the moment workspacesFor builds it (activateProject below).
    if (message.bootstrap) this.bootstrapSlugs.add(project.slug);

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
  private workspaceCwd(): string {
    return realpathBestEffort(this.requireActive().paths.repoRoot);
  }

  /**
   * 이 클론의 주인이 적어 둔 지침(설정 문서 P1#8). 활성 프로젝트가 아니라
   * cwd 로 찾는다 — 크래시 부활과 게이트 스레드는 자기가 살던 클론으로
   * 살아나므로, 그때의 프로젝트 규칙을 그대로 들고 가야 한다.
   */
  private projectInstructions(cwd: string): string | null {
    const home = realpathBestEffort(cwd);
    for (const project of this.registry.list()) {
      const root = realpathBestEffort(this.registry.paths(project.slug).repoRoot);
      if (root === home) return project.instructions ?? null;
    }
    return null;
  }

  /**
   * Which store holds a session's transcript, for the messages that carry an
   * id but no project. A live session answers directly; otherwise the store
   * is the active project's repo clone.
   */
  private async resolveSessionCwd(sessionId: string): Promise<string> {
    const live = this.manager.get(sessionId);
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
  private workspaceOfSession(sessionId: string): ProjectWorkspaces | null {
    const live = this.manager.get(sessionId);
    if (!live) return null;
    for (const workspaces of this.workspaces.values()) {
      if (realpathBestEffort(workspaces.paths.repoRoot) === live.cwd) return workspaces;
    }
    return null;
  }

  /**
   * A GitHub client on the machine-wide token — the same credential that
   * clones and pushes every project's repo, and the one the repo list comes
   * from. Built per call because a token set mid-run must reach the next
   * request without a restart.
   */
  private gitHubClient(): GitHubClient | null {
    if (!this.pat) return null;
    return new GitHubClient(this.pat, this.gitHubTransport);
  }

  /**
   * DESIGN §5: a repo that declares a private registry gets the machine-wide
   * token into the user's ~/.npmrc (merged, never clobbering other lines).
   * Runs after a bring-up, because the declaration lives in the clone that
   * the bring-up just produced.
   */
  private mergeRegistryNpmrc(repo: RepoWorkspace): void {
    const config = repo.coloDesign();
    const pat = this.pat;
    if (!config?.registry || !pat) return;
    const scope = config.registry.scope.startsWith("@")
      ? config.registry.scope
      : `@${config.registry.scope}`;
    mergeNpmrc(npmrcPath(), [
      { key: `${scope}:registry`, value: `https://${config.registry.host}/` },
      { key: `//${config.registry.host}/:_authToken`, value: pat },
    ]);
  }

  private async status() {
    const active = this.activeOrNull();
    const base = await buildStatus({
      executable: this.claudeExecutable,
      liveSessions: this.manager.liveCount,
      pendingPermissions: this.manager.pendingCount,
      // The registry probe only makes sense inside a repo that declares one.
      registryProbeDir: active?.repo.registry() ? active.repo.root : null,
    });
    // A repo that ships its own pre-approved tool rules widens its sessions
    // past the card flow — the planner should hear that it did. It rides its
    // own field, not the env warnings: this is news, not a live problem, and
    // the fingerprint lets a client that has read it stay quiet until the
    // file or the repo changes. The daemon keeps sending it; the client
    // owns "read".
    const repoSettings = active ? repoSettingsWarning(active.repo.root) : null;
    return {
      ...base,
      repoSettingsWarning: repoSettings,
      planUsage: this.currentPlanUsage(),
      models: this.models,
      projects: this.projectSummaries(),
      activeProject: this.registry?.activeSlug() ?? null,
    };
  }

  /**
   * Plan limits belong to the account, not to one thread: whatever reading
   * lands last stands for every client, so the composer can show them with no
   * session open at all. The last reading also survives a restart, and it
   * settles what the run still owes — one reading has now been had.
   */
  private rememberPlanUsage(plan: PlanUsage | null): void {
    if (!plan) return;
    this.planReadingOwed = false;
    if (JSON.stringify(plan) === JSON.stringify(this.planUsage)) return;
    this.planUsage = plan;
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(PLAN_USAGE_FILE, `${JSON.stringify(plan, null, 2)}\n`);
    } catch {
      // A cache that cannot be written just means the next start shows nothing.
    }
    void this.status().then((status) => this.broadcast({ type: "status", status }));
  }

  /**
   * The cached reading as the composer may see it now. A window whose reset
   * has passed is refilled here, not just on load — a daemon that sits for
   * hours would otherwise keep saying 43% about a window that no longer
   * exists — and the row keeps its place either way, because a planner
   * checking whether the weekly Fable cap is near must find it there whatever
   * the answer turns out to be. A reset also asks for a fresh reading: it is
   * exactly when the number matters again, and the next turn is not the only
   * moment one can land.
   */
  private currentPlanUsage(): PlanUsage | null {
    const plan = this.planUsage;
    if (!plan) {
      this.refreshPlanUsage();
      return null;
    }
    const now = Date.now();
    const fiveHour = plan.fiveHour ? refilled(plan.fiveHour, now) : null;
    const sevenDay = plan.sevenDay ? refilled(plan.sevenDay, now) : null;
    const modelWeekly = plan.modelWeekly.map((row) => refilled(row, now));
    // `refilled` hands back the same object when nothing moved, so identity
    // is the whole test for "a window reset since this reading".
    const reset =
      fiveHour !== plan.fiveHour ||
      sevenDay !== plan.sevenDay ||
      modelWeekly.some((row, index) => row !== plan.modelWeekly[index]);
    if (reset || this.planReadingOwed) this.refreshPlanUsage();
    if (!reset) return plan;
    return { ...plan, fiveHour, sevenDay, modelWeekly };
  }

  /**
   * Re-read the plan's limits, through the most recently active idle session
   * when there is one and a probe CLI when there is not — the limits are the
   * account's, so a planner who has opened no thread is exactly the planner
   * most in need of being told. Failures stay silent: the cache keeps serving
   * whatever it still has. Spaced out because status() runs on every
   * broadcast, and a CLI that cannot answer must not turn those broadcasts
   * into a request storm.
   */
  private refreshPlanUsage(): void {
    const now = Date.now();
    if (now - this.lastPlanRefresh < DaemonServer.PLAN_REFRESH_BACKOFF_MS) return;
    const session = [...this.manager.all()]
      .filter((candidate) => candidate.state === "idle")
      .sort((a, b) => b.lastActivity - a.lastActivity)[0];
    // Before `start` has resolved the CLI there is nothing to ask and nothing
    // to record: leave the reading owed rather than spending the window on a
    // question that cannot be put.
    if (!session && !this.claudeExecutable) return;
    this.lastPlanRefresh = now;
    this.planReadingOwed = false;
    if (session) {
      void session
        .contextUsage()
        .then((usage) => this.rememberPlanUsage(usage?.plan ?? null))
        .catch(() => undefined);
      return;
    }
    const active = this.activeOrNull();
    const cwd = active?.repo.isCloned() ? realpathBestEffort(active.paths.repoRoot) : homedir();
    void probePlanUsage({ cwd, executable: this.claudeExecutable })
      .then((plan) => this.rememberPlanUsage(plan))
      .catch(() => undefined);
  }

  /** The last reading from disk, with every window that has since reset refilled. */
  private loadPlanUsage(): PlanUsage | null {
    try {
      const stored = JSON.parse(readFileSync(PLAN_USAGE_FILE, "utf8")) as PlanUsage;
      const now = Date.now();
      const fiveHour = stored.fiveHour ? refilled(stored.fiveHour, now) : null;
      const sevenDay = stored.sevenDay ? refilled(stored.sevenDay, now) : null;
      // A cache written by an older build has no `modelWeekly` at all; the
      // reading this run owes fills the rows in.
      const modelWeekly = (stored.modelWeekly ?? []).map((row) => refilled(row, now));
      if (!fiveHour && !sevenDay) return null;
      return { ...stored, fiveHour, sevenDay, modelWeekly };
    } catch {
      return null;
    }
  }

  /**
   * The model picker's rows come from the CLI through a live session, but the
   * choice itself belongs to the planner before any thread exists — so the
   * list is cached here and kept across restarts.
   */
  private rememberModels(models: SessionModelInfo[]): void {
    if (models.length === 0 || JSON.stringify(models) === JSON.stringify(this.models)) return;
    this.models = models;
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(MODEL_CATALOG_FILE, `${JSON.stringify(models, null, 2)}\n`);
    } catch {
      // Same as the plan cache: a failed write only costs the next start.
    }
    void this.status().then((status) => this.broadcast({ type: "status", status }));
  }

  private loadModels(): SessionModelInfo[] {
    try {
      const stored = JSON.parse(readFileSync(MODEL_CATALOG_FILE, "utf8")) as SessionModelInfo[];
      return Array.isArray(stored) ? stored : [];
    } catch {
      return [];
    }
  }

  /**
   * Static serving of the built web UI (desktop mode): files from webDist,
   * unknown paths fall back to index.html so the SPA routes itself. Path
   * traversal stays inside webDist.
   */
  private serveWeb(req: IncomingMessage, res: ServerResponse): void {
    const root = this.config.webDist!;
    const requested = (req.url ?? "/").split("?")[0]!;
    let candidate = requested === "/" ? "index.html" : requested.slice(1);
    candidate = candidate.split("%2e%2e").join("..");
    const file = join(root, candidate);
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
      // SPA fallback: /anything is the app.
      const index = join(root, "index.html");
      if (!existsSync(index)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(index));
      return;
    }
    const type = WEB_TYPES[extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(readFileSync(file));
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.send(ws, {
        type: "error",
        id: parsed.id,
        message: parsed.error,
        code: "bad_request",
      });
      return;
    }
    const message = parsed.value;
    try {
      const data = await this.dispatch(message);
      this.send(ws, { type: "ok", id: message.id, data });
    } catch (error) {
      // The one Korean boundary every RPC refusal passes (리뷰 C1·C3): the
      // daemon's own guards already answer in Korean and pass through
      // untouched, while a foreign error — the SDK's "Query closed before
      // response received" once rode the wire to the chat banner — is logged
      // here verbatim and replaced by the recovery sentence.
      this.logger.error("요청 실패", { type: message.type, err: error });
      this.send(ws, {
        type: "error",
        id: message.id,
        message: asPlannerFacingError(error).message,
      });
    }
  }

  private async dispatch(message: ClientMessage): Promise<unknown> {
    switch (message.type) {
      case "daemon.status":
        return await this.status();

      case "session.list":
        return await this.manager.list(this.workspaceCwd(), message.limit ?? 50);

      // 리뷰 B7: the notification click names a session, the UI needs its
      // project first — resuming in the wrong project would fork the thread.
      case "session.locate": {
        const workspaces = this.workspaceOfSession(message.sessionId);
        const slug = workspaces
          ? ([...this.workspaces.entries()].find(([, value]) => value === workspaces)?.[0] ?? null)
          : null;
        return { slug };
      }

      case "session.history": {
        const events0 = await this.manager.history(
          message.sessionId,
          await this.resolveSessionCwd(message.sessionId),
        );
        // 대기 줄과 lost room 은 기록이 아니라 지금의 상태 (PLAN D86 의
        // 확장): a window opened — or reloaded — must see both above the
        // field, so they ride at the tail of the replay. The tail is
        // AUTHORITATIVE, empty rooms included — a window that kept rows the
        // daemon no longer holds must lose them here, not keep the ghosts.
        const events = [
          ...events0,
          { kind: "queued", items: this.manager.get(message.sessionId)?.heldItems() ?? [] },
        ];
        const lost = this.queueStore.lostItems(message.sessionId);
        return lost.length > 0 ? [...events, { kind: "queue.lost", items: lost }] : events;
      }

      case "session.create": {
        if (!this.claudeExecutable) {
          throw new Error(
            "Claude Code CLI 를 찾지 못했습니다 — 설치를 마친 뒤 다시 시도해 주세요.",
          );
        }
        if (!existsSync(this.repo.root)) {
          throw new Error("연결 레포가 아직 준비되지 않았습니다 — 잠시 후 다시 시도해 주세요.");
        }
        // A resume onto a thread whose live query already died (the crash
        // card's own state, or a force-aborted stop): tear the dead object
        // down FIRST, under its own id — after the replacement lands, its
        // late `closed` broadcast would take the fresh session's preview
        // driver with it. A healthy live thread is left exactly as it was.
        const dead = message.resume ? this.manager.get(message.resume) : undefined;
        if (dead && (dead.state === "error" || dead.state === "closed")) {
          this.destroyPreviewDriver(dead.id);
          await this.manager.close(dead.id);
        }
        // The preview tools ride the session when a driver is injected and
        // the active preview is up (PLAN D61); `previewTools: false` opts
        // out. The driver is remembered under the session's own id so the
        // lifecycle hooks above can destroy it. D91: the session id only
        // exists after `create`, so the opened-report goes through a sink
        // the code below points at the fresh id.
        const openSink: {
          current: ((route: string, state: string | null) => void) | null;
        } = {
          current: null,
        };
        const preview = await this.previewToolsFor(message.previewTools !== false, (route, state) =>
          openSink.current?.(route, state),
        );
        const sessionCwd = this.workspaceCwd();
        const instructions = this.projectInstructions(sessionCwd);
        const session = this.manager.create({
          cwd: sessionCwd,
          claudeExecutable: this.claudeExecutable,
          queueDiskFor: this.queueDiskFor,
          ...(instructions ? { appendSystemPrompt: instructions } : {}),
          writePolicy: repoWritePolicy(sessionCwd),
          ...(message.title ? { title: message.title } : {}),
          ...(message.resume ? { resume: message.resume } : {}),
          ...(message.model ? { model: message.model } : {}),
          ...(message.effort ? { effort: message.effort } : {}),
          ...(preview ? { previewTools: preview.tools } : {}),
        });
        if (preview) {
          this.previewDrivers.set(session.id, preview.driver);
          openSink.current = (route, state) =>
            this.broadcast({
              type: "session.event",
              sessionId: session.id,
              event: { kind: "preview.opened", route, state },
            });
        }
        // A session start is the moment the 화면 half goes back to the remote.
        // Mid-cycle that is a merge of the developer's base branch, and a
        // conflict lands as this session's first task — which is why it runs
        // after the session exists, and without blocking on it.
        void this.repo.pull((brief) => {
          try {
            this.manager.get(session.id)?.send(brief);
          } catch {
            // The fresh thread's query died mid-pull; the conflict state
            // itself still surfaces through repo.status.
          }
        });
        // The tree gains a child row (PLAN D59).
        this.manager.invalidateThreads(session.cwd);
        this.refreshThreads();
        return { sessionId: session.id, state: session.state };
      }

      case "session.send": {
        // A live session of another project writes into another clone.
        // list() filters them out, but a client that kept an old id (a stale
        // tab) could still reach it — refuse instead of writing across.
        const target = this.manager.require(message.sessionId);
        if (target.cwd !== this.workspaceCwd()) {
          throw new Error("다른 프로젝트의 대화입니다 — 프로젝트를 전환한 뒤 보내 주세요.");
        }
        // 화면 턴의 시작점 (PLAN D52) is the delivery (the echo, see the
        // manager's onEvent); this only seeds the count, before anything can
        // be handed over — so the transcript is read while it still holds
        // exactly the prompts that came before this one.
        if (this.checkpointTurns.get(message.sessionId) === undefined) {
          // 재시작 뒤 첫 턴: 카운터는 프로세스와 함께 사라지지만 대화록은
          // 남는다. 되감기의 k 번째 프롬프트는 대화록 기준이므로 이미 있는
          // 프롬프트 수부터 이어 셀 수밖에 없다 — 1부터 다시 세면 첫 되감기가
          // 전체 기억을 버리고, 두 번째는 남의 턴을 자른 채 memoryKept 를
          // 보고하던 것.
          this.checkpointTurns.set(
            message.sessionId,
            await this.manager.promptCount(message.sessionId, target.cwd),
          );
        }
        // 죽은 질의에 말을 흘리지 않는다: 크래시 카드가 약속한대로, 같은 id 의
        // 재개(resume)가 새 CLI 에서 대화를 이어받아 지금의 말을 전달한다.
        // Refusals answer through the dispatch-wide Korean boundary above.
        const carrier = target.sendable ? target : await this.resurrectSession(target);
        carrier.send(message.text, message.images, message.files);
        return { ok: true };
      }

      case "session.interrupt":
        await this.manager.require(message.sessionId).interrupt();
        return { ok: true };

      // 대기 줄 다루기 (PLAN D86): both act on a live room, and `sendNow`
      // writes into the clone — the same cross-project fence as session.send.
      case "session.queue.remove": {
        const target = this.manager.require(message.sessionId);
        if (target.cwd !== this.workspaceCwd()) {
          throw new Error("다른 프로젝트의 대화입니다 — 프로젝트를 전환한 뒤 시도해 주세요.");
        }
        return target.removeHeld(message.itemId);
      }

      case "session.queue.sendNow": {
        const target = this.manager.require(message.sessionId);
        if (target.cwd !== this.workspaceCwd()) {
          throw new Error("다른 프로젝트의 대화입니다 — 프로젝트를 전환한 뒤 시도해 주세요.");
        }
        await target.sendHeldNow(message.itemId);
        return { ok: true };
      }

      // lost room 다루기 (PLAN D86 의 확장): these touch only the daemon's
      // own store — no clone is written — so they need no project fence, and
      // they work for a thread nobody has reopened since the restart.
      case "session.queue.takeDropped":
        return this.queueStore.takeLost(message.sessionId, message.itemId);

      case "session.queue.dismissDropped": {
        this.queueStore.dismissLost(message.sessionId, message.itemId);
        // The store changed under every window: re-announce the state.
        this.broadcast({
          type: "session.event",
          sessionId: message.sessionId,
          event: { kind: "queue.lost", items: this.queueStore.lostItems(message.sessionId) },
        });
        return { ok: true };
      }

      case "session.close": {
        const cwd = this.manager.get(message.sessionId)?.cwd;
        await this.manager.close(message.sessionId);
        this.touchThreadsCwd(cwd);
        return { ok: true };
      }

      case "session.delete": {
        const cwd = await this.resolveSessionCwd(message.sessionId);
        await this.manager.remove(message.sessionId, cwd);
        // The thread is gone; its wait room and lost room go with it.
        this.queueStore.clear(message.sessionId);
        this.touchThreadsCwd(cwd);
        return { ok: true };
      }
      case "session.contextUsage": {
        const usage = await this.manager.require(message.sessionId).contextUsage();
        this.rememberPlanUsage(usage?.plan ?? null);
        return usage;
      }

      case "repo.files": {
        // @-mention autocomplete draws from the repo clone only.
        const root = this.repo.root;
        const files = existsSync(root) ? await listFiles(root) : [];
        return browseFiles(files, message.query ?? "", message.limit ?? 40);
      }
      case "session.setModel":
        await this.manager.require(message.sessionId).setModel(message.model);
        return { ok: true };

      case "session.setEffort":
        await this.manager.require(message.sessionId).setEffort(message.effort);
        return { ok: true };

      case "session.setPermissionMode":
        await this.manager.require(message.sessionId).setPermissionMode(message.mode);
        return { ok: true };

      case "session.selectors": {
        const selectors = await this.manager.require(message.sessionId).selectors();
        this.rememberModels(selectors.models);
        return selectors;
      }
      case "session.commands":
        return await this.manager.require(message.sessionId).commands();

      case "session.stopTask":
        await this.manager.require(message.sessionId).stopTask(message.taskId);
        return { ok: true };

      case "session.backgroundTask": {
        const moved = await this.manager
          .require(message.sessionId)
          .backgroundTask(message.toolUseId);
        return { moved };
      }

      case "cli.commands":
        return await this.cliCommands();

      case "permission.respond": {
        const session = this.manager.findByRequest(message.requestId);
        if (!session)
          throw new Error("이미 끝난 권한 요청입니다 — 방금 뜬 카드에서 다시 답해 주세요.");
        // 계획 승인은 모드 복귀를 승인보다 먼저 맺는다 — ok 답신이 그 순서를
        // 지나가길 기다린다.
        await session.respondPermission(
          message.requestId,
          message.decision,
          message.message,
          message.updatedInput,
        );
        return { ok: true };
      }

      case "question.respond": {
        const session = this.manager.findByRequest(message.requestId);
        if (!session) throw new Error("이미 끝난 질문입니다 — 방금 뜬 카드에서 다시 답해 주세요.");
        session.respondQuestion(
          message.requestId,
          message.answers,
          message.response,
          message.annotations,
        );
        return { ok: true };
      }

      case "project.list":
        return {
          projects: this.projectSummaries(),
          activeSlug: this.registry.activeSlug(),
        };

      case "project.create":
        return await this.createProject(message);

      case "project.activate": {
        await this.activateProject(message.slug);
        return {
          projects: this.projectSummaries(),
          activeSlug: this.registry.activeSlug(),
        };
      }

      case "project.update": {
        // Same guard as create — a moved url re-clones, so the wire's word
        // passes through the clone-url guard before the registry hears it.
        if (message.repoUrl != null) assertClonableRepoUrl(message.repoUrl);
        // The error card's 실행 허용: the registry remembers, the workspace is
        // told, and the bring-up it was waiting on runs to ready.
        if (message.approveCommands !== undefined) {
          this.registry.update(message.slug, {
            commandsApproved: message.approveCommands,
          });
          const gate = this.workspacesFor(message.slug);
          gate.repo.setCommandsApproved(message.approveCommands);
          if (message.approveCommands) void gate.repo.sync().catch(() => undefined);
        }
        this.registry.update(message.slug, {
          ...(message.name !== undefined ? { name: message.name } : {}),
          ...(message.repoUrl !== undefined ? { repoUrl: message.repoUrl } : {}),
          ...(message.baseBranch !== undefined ? { baseBranch: message.baseBranch } : {}),
          // 지침(P1#8): 다음 대화부터 적용된다 — 돌고 있는 세션의 시스템
          // 프롬프트를 중간에 바꾸지 않는다(SDK 의 스냅샷 계약).
          ...(message.instructions !== undefined ? { instructions: message.instructions } : {}),
        });
        // A url change is a repo change: the workspace re-points (and
        // re-clones when the url moved) through its own update path.
        const workspaces = this.workspacesFor(message.slug);
        if (message.repoUrl !== undefined) {
          await workspaces.repo.update({ url: message.repoUrl });
        }
        this.announceProjects();
        return {
          projects: this.projectSummaries(),
          activeSlug: this.registry.activeSlug(),
        };
      }

      case "project.remove": {
        const paths = this.registry.paths(message.slug);
        // Transcripts are keyed by the clone's realpath (see workspaceCwd) —
        // every lookup below must use that same spelling.
        const repoRoot = realpathBestEffort(paths.repoRoot);
        const workspaces = this.workspaces.get(message.slug);
        if (workspaces) {
          // The clone's live threads die with it (D21): a session left
          // running would keep writing into a folder the planner just
          // disowned — or one `deleteFiles` is about to remove.
          await this.manager.closeWhere(repoRoot);
          await workspaces.repo.stop();
          this.workspaces.delete(message.slug);
        }
        this.registry.remove(message.slug);
        // Files survive a forget: the clone holds screen work that was saved
        // but never merged, and nothing else on the machine has it.
        if (message.deleteFiles) {
          // The conversations go with the folder (PLAN D77): the transcript
          // store lives outside the project folder, keyed by this clone's
          // path — leaving it behind would orphan every thread and let a
          // same-named re-add resurrect them against an empty worktree.
          await this.manager.removeWhere(repoRoot);
          rmSync(paths.root, { recursive: true, force: true });
        }
        const next = this.registry.activeSlug();
        if (next) await this.activateProject(next);
        this.announceProjects();
        return { projects: this.projectSummaries(), activeSlug: next };
      }

      case "repo.status":
        return await this.repo.status();

      case "repo.sync":
        return await this.repo.sync(message.force === true);

      case "repo.refresh": {
        // 레포 최신화: the planner's pull of the developer's side, pressed
        // from the screen bar. Progress is `repo.status` as always; a
        // conflict briefs the named thread like a failing gate does. The
        // button's failures report — the planner pressed it, so the reason
        // lands as words on the screen instead of a silent no-op.
        const { onSessionTurn } = this.briefTo(message.sessionId, "refresh");
        // 사이클 브랜치에서 대화 없이 눌린 최신화는 병합을 하지 않는다(충돌의
        // 첫 과제는 Claude 의 몫) — 대신 fetch 로 원격을 확인해 무엇이 기다리는
        // 지 버튼을 누른 사람에게 말한다.
        const behind = await this.repo.refreshNeedsThread();
        if (behind !== null && !message.sessionId)
          throw new Error(
            `개발자의 최신 변경 ${behind}건이 원격에 있습니다 — 대화를 하나 연 뒤 최신화를 누르면 지금 화면 위로 받아 옵니다.`,
          );
        // 받아올 게 없으면 pull 도 부르지 않는다 — 새 커밋 0건의 병합은
        // 아무도 모른 채 끝나는 일이고, 그것이 정직한 결과다.
        if (behind === 0) return await this.repo.status();
        const outcome = await this.repo.pull(onSessionTurn, { report: true });
        // 실사 결함: 최신화가 사이클 브랜치에 merge 커밋을 묵시적으로 쌓는
        // 사실을 아무도 말하지 않았다. 병합이 실제로 일어났으면 그 기록이
        // 대화에 남는다 — 충돌 브리프와 같은 자리, 같은 어휘로.
        if (behind !== null && behind > 0 && outcome === "clean" && message.sessionId) {
          // The record is news, not cargo: a thread that died mid-refresh
          // must not turn the report into an error reply.
          try {
            this.manager.get(message.sessionId)?.send(
              markTurn(
                {
                  kind: "brief",
                  title: `원격의 최신 변경 ${behind}건을 받아 왔습니다`,
                  purpose: "refresh",
                },
                "개발자의 최신 변경을 이번 작업 브랜치에 병합했습니다 — 미리보기를 새로 고침하면 반영됩니다. 저장하면 이 병합이 함께 담깁니다.",
              ),
            );
          } catch {
            // The thread's query died; the merge itself is already done.
          }
        }
        return await this.repo.status();
      }

      case "repo.update":
        if (message.url) assertClonableRepoUrl(message.url);
        return await this.repo.update({
          ...(message.url !== undefined ? { url: message.url } : {}),
        });

      case "onboarding.check":
        return await runOnboardingChecks({
          claudeExecutableOverride: this.config.claudeExecutable,
          gitHubClient: () => this.gitHubClient(),
        });

      case "onboarding.fix":
        switch (message.kind) {
          case "install-claude":
            return startClaudeInstall();
          case "login-claude":
            return startClaudeLogin();
          case "install-git":
            return gitInstallGuidance();
          case "install-pnpm":
            return await runPnpmInstall();
        }
        return { started: false, guidance: "알 수 없는 수정 요청입니다." };

      case "github.token.set": {
        this.pat = message.token;
        if (this.pat) await this.credentials.save(REPO_PAT_ITEM, this.pat);
        else await this.credentials.delete(REPO_PAT_ITEM).catch(() => undefined);
        this.repoListCache = null;
        // Every live workspace re-arms at once; a project the planner has not
        // touched this run gets the token when it is next activated.
        for (const workspaces of this.workspaces.values()) workspaces.repo.setPat(this.pat);
        // The reply is the recomputed `github` gate alone — the form turns
        // its card green (or shows the refusal) without touching the rest.
        const steps = await runOnboardingChecks({
          claudeExecutableOverride: this.config.claudeExecutable,
          gitHubClient: () => this.gitHubClient(),
        });
        return steps.find((step) => step.id === "github") ?? null;
      }

      case "github.repos.list": {
        if (!this.pat) {
          throw new Error("GitHub 토큰이 없습니다 — 먼저 토큰을 연결해 주세요.");
        }
        if (message.refresh || this.repoListCache?.token !== this.pat) {
          const client = this.gitHubClient();
          if (!client) {
            throw new Error("GitHub 토큰이 없습니다 — 먼저 토큰을 연결해 주세요.");
          }
          const { repos, truncated } = await client.listRepos();
          this.repoListCache = { token: this.pat, list: { repos, truncated } };
        }
        return this.repoListCache.list;
      }

      case "github.repo.inspect": {
        const client = this.gitHubClient();
        if (!client) {
          throw new Error("GitHub 토큰이 없습니다 — 먼저 토큰을 연결해 주세요.");
        }
        return await client.inspectRepo({
          owner: message.owner,
          repo: message.repo,
        });
      }

      case "diff.get":
        return await this.repo.diff();

      case "repo.save":
        return await this.repo.save({
          ...(message.message ? { message: message.message } : {}),
          ...this.briefTo(message.sessionId, "save"),
        });

      case "repo.handoff": {
        const active = this.requireActive();
        // The captures come first, while the preview server is still the one
        // serving — the build gate inside the handoff may not leave it up.
        const shots = await this.captureHandoffShots();
        return await active.repo.handoff({
          title: message.title ?? this.registry.get(active.slug)?.name ?? undefined,
          body: message.body ?? DEFAULT_HANDOFF_BODY,
          ...(shots.length > 0 ? { shots } : {}),
          // D93: the comment store and the declared titles — the PR body's
          // ### 수정 요청 section is the daemon's to build.
          commentsFile: join(active.paths.root, "comments.json"),
          screenTitles: this.previewScreens.map((screen) => ({
            route: screen.route,
            title: screen.title,
          })),
          ...this.briefTo(message.sessionId, "handoff"),
        });
      }

      case "repo.handoffStatus":
        return await this.repo.refreshHandoff();

      // 답하기 (PLAN D88): the planner's words to one developer comment —
      // the daemon picks the endpoint by the id's kind.
      // 되감기 (PLAN D95): files (the turn's checkpoint) go back first, then
      // the daemon forks the conversation's memory before that answer and
      // sends the words again. A refused fork falls back inside the manager.
      case "session.rewind": {
        const target = this.manager.require(message.sessionId);
        if (target.cwd !== this.workspaceCwd()) {
          throw new Error("다른 프로젝트의 대화입니다 — 프로젝트를 전환한 뒤 시도해 주세요.");
        }
        const checkpoints = await this.repo.checkpoints();
        const entry = checkpoints.entries.find(
          (candidate) =>
            candidate.sessionId === message.sessionId && candidate.turn === message.turn,
        );
        if (entry) await this.repo.checkpointRestore(entry.id);
        const openSink: {
          current: ((route: string, state: string | null) => void) | null;
        } = {
          current: null,
        };
        const preview = await this.previewToolsFor(true, (route, state) =>
          openSink.current?.(route, state),
        );
        const result = await this.manager.rewind({
          sessionId: message.sessionId,
          cwd: this.workspaceCwd(),
          turn: message.turn,
          text: message.text,
          images: message.images,
          base: {
            cwd: this.workspaceCwd(),
            claudeExecutable: this.claudeExecutable ?? "",
            queueDiskFor: this.queueDiskFor,
            writePolicy: repoWritePolicy(this.workspaceCwd()),
            ...(preview ? { previewTools: preview.tools } : {}),
          },
        });
        if (preview) {
          this.previewDrivers.set(result.sessionId, preview.driver);
          openSink.current = (route, state) =>
            this.broadcast({
              type: "session.event",
              sessionId: result.sessionId,
              event: { kind: "preview.opened", route, state },
            });
        }
        this.manager.invalidateThreads(target.cwd);
        this.refreshThreads();
        return result;
      }

      case "comments.reply": {
        const activeWs = this.requireActive();
        await activeWs.repo.replyToReview(message.reviewId, message.body);
        return { ok: true as const };
      }

      // --- 되돌리기와 요약 (PLAN D51 · D52 · D53) --------------------------
      case "repo.summarize":
        return await this.repo.summarize();

      case "repo.handoffDraft":
        return await this.repo.handoffDraft();

      case "repo.history":
        return await this.repo.history();

      case "repo.restore":
        return await this.repo.restore(message.sha);

      case "repo.discard":
        return await this.repo.discard();

      case "repo.checkpoints":
        return await this.repo.checkpoints();

      case "repo.checkpoint.restore":
        return await this.repo.checkpointRestore(message.checkpoint);

      // --- 코멘트 저장소 (PLAN D57) ----------------------------------------
      // The pins belong to the ACTIVE project: the messages carry no slug,
      // exactly because the planner is looking at one project's preview.
      case "comments.record": {
        recordComments(
          join(this.requireActive().paths.root, "comments.json"),
          message.screen,
          message.state,
          message.items,
        );
        return { recorded: message.items.length };
      }

      case "comments.list":
        return {
          items: readComments(join(this.requireActive().paths.root, "comments.json")),
        };
    }
  }

  /**
   * The thread a send must land in when its own query died (crash · a
   * force-aborted stop · a CLI that ended on its own): same id, fresh CLI,
   * the stored transcript resumed — the planner's words ride the
   * conversation they belong to, which is the promise the crash card made
   * ("다시 보내면 이어집니다"). The dead object is torn down FIRST, under
   * its own id, so its late `closed` broadcast cannot take the
   * replacement's preview driver with it.
   */
  private async resurrectSession(dead: Session): Promise<Session> {
    this.destroyPreviewDriver(dead.id);
    await this.manager.close(dead.id);
    if (!this.claudeExecutable) return dead;
    const chosen = dead.chosen;
    const openSink: {
      current: ((route: string, state: string | null) => void) | null;
    } = {
      current: null,
    };
    const preview = await this.previewToolsFor(true, (route, state) =>
      openSink.current?.(route, state),
    );
    const instructions = this.projectInstructions(dead.cwd);
    const session = this.manager.create({
      cwd: dead.cwd,
      claudeExecutable: this.claudeExecutable,
      queueDiskFor: this.queueDiskFor,
      ...(instructions ? { appendSystemPrompt: instructions } : {}),
      writePolicy: repoWritePolicy(dead.cwd),
      resume: dead.id,
      title: dead.title,
      ...(chosen.model ? { model: chosen.model } : {}),
      ...(chosen.effort ? { effort: chosen.effort } : {}),
      ...(preview ? { previewTools: preview.tools } : {}),
    });
    if (preview) {
      this.previewDrivers.set(session.id, preview.driver);
      openSink.current = (route, state) =>
        this.broadcast({
          type: "session.event",
          sessionId: session.id,
          event: { kind: "preview.opened", route, state },
        });
    }
    // The tree's child row points at the same id; a rescan picks the new life up.
    this.manager.invalidateThreads(session.cwd);
    this.refreshThreads();
    return session;
  }

  /**
   * Routes a failing gate's output to a live session as a user turn — the same
   * path a typed message takes, so Claude sees the planner asking for a fix.
   * The failure itself is news the planner clicked for — the step never
   * reached the developer and Claude is now on the fix — so it also fires a
   * notice before the turn starts.
   *
   * 게이트 실패는 Claude 의 과제다(README) — 열린 대화가 없어도 과제는 태어나야
   * 한다: 저장·넘기기는 도구가 대화를 열고 브리프를 내려놓는다(준비 턴
   * runBootstrapPrepare 와 같은 길). 최신화 충돌만 예외다 — 대화가 없을 때의 그
   * 상태는 오류 카드가 자기 버튼(Claude 에게 해결 요청)으로 대화를 고르는 자리다.
   */
  private briefTo(sessionId: string | undefined, stage: "save" | "handoff" | "refresh") {
    if (!sessionId && stage === "refresh") return { onSessionTurn: undefined };
    return {
      onSessionTurn: (brief: string) => {
        // A named thread whose query already died cannot take the brief — and
        // since the crash guard it would refuse the send. The gate thread is
        // the fallback either way: no open thread, or a dead one.
        const named = sessionId ? this.manager.get(sessionId) : undefined;
        const session =
          named && named.state !== "error" && named.state !== "closed"
            ? named
            : this.gateThreadFor(stage);
        if (!session) return;
        this.logger.warn("게이트 실패", { sessionId: session.id, stage });
        this.config.onNotice?.({
          kind: "gate",
          sessionId: session.id,
          title: session.title,
          stage,
        });
        try {
          session.send(brief);
        } catch {
          // Lost the race with the query's death — the failed DiffStatus
          // still tells the planner why the step stopped.
        }
      },
    };
  }

  /** The last thread a failing gate briefed, when it had to open one itself. */
  private gateThreadId: string | null = null;

  /**
   * The thread a failing gate briefs when none is (or none living one is)
   * open. One per run: a planner who presses 저장 twice with no thread open
   * must not grow a garden of failure threads. Reused while it lives in this
   * clone and its query is healthy; a dead one is replaced on the next brief.
   */
  private gateThreadFor(stage: "save" | "handoff" | "refresh") {
    const cwd = this.workspaceCwd();
    const remembered = this.gateThreadId ? this.manager.get(this.gateThreadId) : undefined;
    if (
      remembered &&
      remembered.cwd === cwd &&
      remembered.state !== "error" &&
      remembered.state !== "closed"
    ) {
      return remembered;
    }
    if (!this.claudeExecutable) return null;
    const instructions = this.projectInstructions(cwd);
    const session = this.manager.create({
      cwd,
      claudeExecutable: this.claudeExecutable,
      queueDiskFor: this.queueDiskFor,
      ...(instructions ? { appendSystemPrompt: instructions } : {}),
      writePolicy: repoWritePolicy(cwd),
      title:
        stage === "save"
          ? "저장 문제 해결"
          : stage === "handoff"
            ? "넘기기 문제 해결"
            : "최신화 문제 해결",
    });
    this.gateThreadId = session.id;
    // The tree gains a child row (PLAN D59), same as any daemon-opened thread.
    this.manager.invalidateThreads(cwd);
    this.refreshThreads();
    return session;
  }
}

/** The PR body when the planner did not bring one. The screens a handoff
 * carries live in the repo — the client composes the per-screen list — so the
 * daemon's fallback says what the work is rather than inventing links. */
const DEFAULT_HANDOFF_BODY = "Colo Design에서 만든 화면입니다. 로직만 붙이면 됩니다.";
