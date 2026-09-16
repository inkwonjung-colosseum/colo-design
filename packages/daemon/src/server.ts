import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import {
  PROTOCOL_VERSION,
  type ProjectSummary,
  parseClientMessage,
  type ServerMessage,
} from "@colo-design/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { AcpDriver } from "./agent/drivers/acp/driver.js";
import { OPENCODE_ACP } from "./agent/drivers/acp/opencode.js";
import { ClaudeDriver } from "./agent/drivers/claude/driver.js";
import { CodexDriver } from "./agent/drivers/codex/driver.js";
import { OmpDriver } from "./agent/drivers/omp/omp.js";
import { DriverRegistry } from "./agent/registry.js";
import {
  type CredentialStore,
  createCredentialStore,
  migratePlaintextSecrets,
  migrateProjectPats,
} from "./credentials.js";
import { RequestRouter } from "./dispatch.js";
import { buildStatus, resolveClaudeExecutable } from "./environment.js";
import { GitHubBridge } from "./github-bridge.js";
import { createFileLogger, type DaemonLogger } from "./log.js";
import { type DaemonNotice, noticeForState } from "./notices.js";
import { realpathBestEffort } from "./paths.js";
import { PlanTracker } from "./plan-tracker.js";
import { PreviewDrivers } from "./preview-drivers.js";
import type { PreviewDriverFactory, PreviewScreenDeclaration } from "./preview-tools.js";
import { ProjectFleet, type ProjectWorkspaces } from "./project-fleet.js";
import { ProjectRegistry } from "./projects.js";
import { QueueStore } from "./queue-store.js";
import { type RepoWorkspace, repoSettingsWarning, trustWorkspace } from "./repo.js";
import { asPlannerFacingError, NEW_SESSION_TITLE } from "./session.js";
import { SessionManager } from "./session-manager.js";
import { serveWeb } from "./web-static.js";

// The host's notice type (notices.ts) — re-exported so
// `@colo-design/daemon/server` stays the one import a host needs.
export type { DaemonNotice } from "./notices.js";
// The desktop builds its driver against these (PLAN D61) — exported here so
// `@colo-design/daemon/server` stays the one import a host needs.
export type {
  PreviewAxNode,
  PreviewCapture,
  PreviewConsoleLine,
  PreviewDriver,
  PreviewDriverFactory,
  PreviewOpenOptions,
  PreviewOpenResult,
  PreviewScreenDeclaration,
  PreviewViewport,
} from "./preview-tools.js";

/**
 * 커미티 B1 (2026-09-15): 열린 넘김 폴링 주기. 10분 = 프로젝트당 GitHub 읽기
 * 6회/시간(PR 1 + 리뷰 1) — "한 사람·한 대·한 구독"의 개인 규모 안이다.
 */
const HANDOFF_POLL_MS = 10 * 60_000;

// Session permission policy lives in Session itself: it pins the CLI to
// `default` mode (so a user's own global defaultMode cannot widen hub
// sessions) and answers edit-class tools in-process. See session.ts.

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
   * 사용자가 돌아와야 하는 순간의 갈고리 — 턴이 끝났을 때, Claude 가 확인을
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
  /**
   * What "the repo" currently means — one live workspace per project, the
   * switch, the announces, the handoff poll (project-fleet.ts). Built in
   * `start()` once the registry exists.
   */
  private fleet!: ProjectFleet;
  /** The wire's request table (dispatch.ts) — built in `start()` beside the fleet. */
  private router!: RequestRouter;
  /** 커미티 B1 (2026-09-15): 열린 넘김 폴링 타이머 — stop() 이 끊는다. */
  private handoffTimer: NodeJS.Timeout | null = null;
  /**
   * The machine-wide GitHub credential: token lifecycle, picker cache, one
   * transport (github-bridge.ts). The fixture env var is read inside.
   */
  private readonly github: GitHubBridge;
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly agentDrivers = new DriverRegistry();
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
  /**
   * Aborted the moment `stop()` begins. Unattended CLI probes ride it: a CLI
   * that never answers must not hold the process open for the probe's full
   * grace after the daemon is down — the offline suites each paid that grace
   * at exit, and the desktop's quit waited on it too.
   */
  private readonly closing = new AbortController();
  /** The one shutdown, shared by every caller that asks for it. */
  private stopping: Promise<void> | null = null;
  /**
   * The account's plan limits and the CLI's model catalog (plan-tracker.ts) —
   * account-wide, cached on disk across restarts, rebroadcast on change.
   */
  private readonly plans: PlanTracker;
  /**
   * The preview driver each session received, the declared screens, and the
   * screen-gate's verdict state (preview-drivers.ts, PLAN D61·D56·D7).
   */
  private readonly drivers: PreviewDrivers;
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
    this.github = new GitHubBridge({
      credentials: this.credentials,
      claudeExecutableOverride: () => this.config.claudeExecutable,
      // Every live workspace re-arms at once; a project the planner has not
      // touched this run gets the token when it is next activated.
      onToken: (pat) => {
        for (const workspaces of this.fleet.workspaces.values()) workspaces.repo.setPat(pat);
      },
    });
    this.agentDrivers.register(new ClaudeDriver(() => this.claudeExecutable));
    this.agentDrivers.register(new CodexDriver());
    this.agentDrivers.register(new AcpDriver(OPENCODE_ACP));
    this.agentDrivers.register(new OmpDriver());
    this.manager = new SessionManager(
      {
        onEvent: (sessionId, event) => {
          this.broadcast({ type: "session.event", sessionId, event });
          // 한도가 움직였다 (PLAN D100): 요금 칩이 2분 뒤에야 진실을 말하면,
          // 계획자는 이미 막힌 뒤에 그 사실을 안다. 다음 읽기를 앞당긴다.
          if (event.kind === "ratelimit") {
            this.plans.noteRateLimit();
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
            // 새 턴의 화면 목록은 이 턴의 것이다 — 지난 턴이 연 화면을 다시
            // 판정하면 고치지도 않은 화면을 Claude 에게 떠넘기게 된다.
            this.drivers.openedThisTurn.delete(sessionId);
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
          // 턴이 화면을 열어 봤다면 완료 알림은 게이트의 판정 뒤로 미룬다
          // (runScreenGate 가 둘 중 하나를 내보낸다). 여기서 먼저 부르면
          // 사용자는 `작업이 끝났습니다` 를 읽은 직후 다시 도는 대화를 본다.
          if (state === "idle" && this.drivers.gatePossible(sessionId)) {
            void this.drivers.runGate(sessionId, turnDurationMs);
          } else {
            const notice = noticeForState(
              sessionId,
              state,
              this.manager.get(sessionId)?.title ?? NEW_SESSION_TITLE,
              turnDurationMs,
            );
            if (notice) this.config.onNotice?.(notice);
          }
          // The driver a session received dies with the session (PLAN D61):
          // close, delete, remove, and daemon stop all land here as `closed`.
          if (state === "closed") {
            this.drivers.destroy(sessionId);
            this.drivers.openedThisTurn.delete(sessionId);
            this.drivers.gatedSessions.delete(sessionId);
          }
        },
        onPermissionRequest: (payload) =>
          this.broadcast({ type: "permission.request", ...payload }),
        onQuestionRequest: (payload) => this.broadcast({ type: "question.request", ...payload }),
      },
      this.agentDrivers,
    );
    this.plans = new PlanTracker({
      idleSession: () =>
        [...this.manager.all()]
          .filter((candidate) => candidate.state === "idle")
          .sort((a, b) => b.lastActivity - a.lastActivity)[0] ?? null,
      claudeExecutable: () => this.claudeExecutable,
      probeCwd: () => {
        const active = this.activeOrNull();
        return active?.repo.isCloned() ? realpathBestEffort(active.paths.repoRoot) : homedir();
      },
      signal: this.closing.signal,
      onChanged: () =>
        void this.status().then((status) => this.broadcast({ type: "status", status })),
    });
    this.drivers = new PreviewDrivers({
      factory: () => this.config.previewDriverFactory,
      activeRepo: () => this.activeOrNull()?.repo ?? null,
      session: (id) => this.manager.get(id),
      sessions: () => this.manager.all(),
      notice: (n) => this.config.onNotice?.(n),
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
    this.fleet = new ProjectFleet({
      registry: this.registry,
      manager: this.manager,
      previewDrivers: this.drivers,
      broadcast: (m) => this.broadcast(m),
      notice: (n) => this.config.onNotice?.(n),
      claudeExecutable: () => this.claudeExecutable,
      closingSignal: this.closing.signal,
      pat: () => this.github.token,
      gitHubClient: () => this.github.client(),
      queueDiskFor: this.queueDiskFor,
    });
    await migrateProjectPats(
      this.credentials,
      this.registry.list().map((project) => project.slug),
      this.registry.activeSlug(),
    );
    await this.github.load();
    this.router = new RequestRouter({
      manager: this.manager,
      fleet: this.fleet,
      previewDrivers: this.drivers,
      agentDrivers: this.agentDrivers,
      plans: this.plans,
      github: this.github,
      queueStore: this.queueStore,
      registry: this.registry,
      logger: this.logger,
      broadcast: (m) => this.broadcast(m),
      notice: (n) => this.config.onNotice?.(n),
      claudeExecutable: () => this.claudeExecutable,
      claudeExecutableOverride: () => this.config.claudeExecutable,
      queueDiskFor: this.queueDiskFor,
      checkpointTurns: this.checkpointTurns,
      status: () => this.status(),
    });

    // 커미티 B1 감동판 (2026-09-15): 열린 넘김이 있는 프로젝트를 주기적으로
    // 다시 읽는다 — 반영됨·변경 요청이 기획자를 찾아온다. unref: 테스트 러너와
    // 데스크톱 in-process 호스트를 타이머가 붙잡지 않게.
    this.handoffTimer = setInterval(() => void this.pollOpenHandoffs(), HANDOFF_POLL_MS);
    this.handoffTimer.unref?.();

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
      workspaces.repo.setPat(this.github.token);
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
        serveWeb(this.config.webDist, req, res);
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

  /**
   * Shutdown, asked for as many times as anyone likes. A second call joins
   * the first instead of running the sequence again: the old one re-entered
   * `http.close()` on a listener already closed (and already nulled), whose
   * callback never fires — the caller's promise hung forever, which is how
   * projects-e2e finished green while its `main()` never returned.
   */
  async stop(): Promise<void> {
    this.stopping ??= this.runStop();
    return this.stopping;
  }

  private async runStop(): Promise<void> {
    // First, before any await: the probes this run left unattended must stop
    // waiting on a CLI nobody is listening to any more.
    this.closing.abort();
    clearInterval(this.handoffTimer ?? undefined);
    this.handoffTimer = null;
    this.logger.info("데몬 종료");
    await this.manager.closeAll();
    // Every project the daemon touched this run, not just the active one: an
    // inactive project may still hold a warm preview server, and every
    // preview process is ours to take down.
    for (const workspaces of this.fleet.workspaces.values()) {
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
    const http = this.http;
    this.http = null;
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
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
   * A project's live workspace — the fleet (project-fleet.ts) owns the map,
   * the switch, the announces, and the handoff poll; the delegates below
   * keep the dispatch table and session wiring readable.
   */
  private workspacesFor(slug: string): ProjectWorkspaces {
    return this.fleet.workspacesFor(slug);
  }

  private activeOrNull(): ProjectWorkspaces | null {
    return this.fleet.activeOrNull();
  }

  private get repo(): RepoWorkspace {
    return this.fleet.requireActive().repo;
  }

  private projectSummaries(): ProjectSummary[] {
    return this.fleet.projectSummaries();
  }

  private announceProjects(): void {
    this.fleet.announceProjects();
  }

  private async pollOpenHandoffs(): Promise<void> {
    return this.fleet.pollOpenHandoffs();
  }

  private refreshThreads(): void {
    this.fleet.refreshThreads();
  }

  private activateProject(slug: string): Promise<ProjectWorkspaces> {
    return this.fleet.activateProject(slug);
  }

  private workspaceOfSession(sessionId: string): ProjectWorkspaces | null {
    return this.fleet.workspaceOfSession(sessionId);
  }

  // -------------------------------------------------------------------------
  // Preview tools (PLAN D61) — the desktop's driver, one per session.
  // Ownership lives in preview-drivers.ts; what remains here is the host's
  // entry point and the call sites wiring a fresh driver into session
  // create / rewind / fork.
  // -------------------------------------------------------------------------

  /**
   * The connected repo said which screens it has (`colo-design.screens`,
   * PLAN D7). The host hands the envelope's contents here: the daemon has no
   * page of its own to hear it from, and without this `screen_list` answers
   * "아직 선언된 화면이 없습니다" for a repo that declared everything. Read
   * live by the tools, so a list that arrives mid-session counts.
   */
  setPreviewScreens(screens: PreviewScreenDeclaration[]): void {
    this.drivers.setScreens(screens);
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
    const repoSettings = active ? repoSettingsWarning(active.repo.root) : null;
    const providers = await Promise.all(
      this.agentDrivers.all().map(async (driver) => {
        const descriptor = driver.describe();
        const diagnostic = await driver.isAvailable().catch(() => ({ ok: false }));
        return {
          id: descriptor.id,
          label: descriptor.label,
          available: diagnostic.ok,
          modes: descriptor.modes,
          defaultModeId: descriptor.defaultModeId,
          capabilities: { ...descriptor.capabilities } as Record<string, unknown>,
        };
      }),
    );
    return {
      ...base,
      repoSettingsWarning: repoSettings,
      planUsage: this.plans.current(),
      models: this.plans.models,
      projects: this.projectSummaries(),
      activeProject: this.registry?.activeSlug() ?? null,
      providers,
    };
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
      const data = await this.router.dispatch(message);
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
}
