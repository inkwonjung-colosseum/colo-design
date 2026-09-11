import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { realpathBestEffort } from "./paths.js";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  type ClientMessage,
  type GitHubRepoList,
  type HandoffShot,
  type PlanUsage,
  type ProjectSummary,
  type SessionModelInfo,
  type ServerMessage,
  type SessionState,
} from "@cds-design/protocol";
import { SessionManager } from "./session-manager.js";
import { NEW_SESSION_TITLE } from "./session.js";
import { repoWritePolicy } from "./workspaces.js";
import { RepoWorkspace, trustWorkspace } from "./repo.js";
import { readComments, recordComments, resolveComment } from "./comments.js";
import { GitHubClient, createGitHubTransport } from "./github.js";
import { ProjectRegistry, type ProjectPaths } from "./projects.js";
import {
  createCredentialStore,
  loadRepoPat,
  migratePlaintextSecrets,
  migrateProjectPats,
  mergeNpmrc,
  npmrcPath,
  REPO_PAT_ITEM,
  type CredentialStore,
} from "./credentials.js";
import {
  gitInstallGuidance,
  runOnboardingChecks,
  runPnpmInstall,
  startClaudeInstall,
  startClaudeLogin,
} from "./onboarding.js";
import {
  buildStatus,
  browseFiles,
  resolveClaudeExecutable,
  listFiles,
  migrateHomeDir,
  CONFIG_DIR,
} from "./environment.js";
import {
  createPreviewTools,
  type PreviewDriver,
  type PreviewDriverFactory,
  type PreviewScreenDeclaration,
  type PreviewTools,
} from "./preview-tools.js";

// The desktop builds its driver against these (PLAN D61) — exported here so
// `@cds-design/daemon/server` stays the one import a host needs.
export type { PreviewDriver, PreviewDriverFactory } from "./preview-tools.js";

interface ProjectWorkspaces {
  slug: string;
  paths: ProjectPaths;
  repo: RepoWorkspace;
}

/** Where the last plan-limit reading waits for the next start. */
const PLAN_USAGE_FILE = join(CONFIG_DIR, "plan-usage.json");
/** Where the model picker's rows wait for the next start. */
const MODEL_CATALOG_FILE = join(CONFIG_DIR, "model-catalog.json");

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
  | { kind: "done"; sessionId: string; title: string }
  | { kind: "crashed"; sessionId: string; title: string }
  | { kind: "ask"; sessionId: string; title: string; what: "permission" | "question" }
  | { kind: "gate"; sessionId: string; title: string; stage: "save" | "handoff" | "refresh" };

/**
 * 상태 전환 중 부르는 값이 되는 것: Claude 가 멈췄거나(idle), 중단됐거나
 * (error), 기획자의 답을 기다리거나(waiting_*). starting 과 running 은
 * 기획자가 방금 본 것이고 closed 는 스스로 닫은 것이다.
 */
function noticeForState(
  sessionId: string,
  state: SessionState,
  title: string,
): DaemonNotice | null {
  switch (state) {
    case "idle":
      return { kind: "done", sessionId, title };
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
   * The ~/.cds-design migration's warning line, when the desktop host wants
   * to surface it (the CLI prints it itself). Optional — the daemon logs it
   * either way.
   */
  onMigrationWarning?: (warning: string) => void;
  /**
   * The desktop's offscreen-window driver (PLAN D61). When a host injects
   * it, sessions of a project whose preview server is up get the
   * `cds-preview` tools; without it — the browser dev path — sessions run
   * exactly as before, with no preview tools at all.
   */
  previewDriverFactory?: PreviewDriverFactory;
}

export class DaemonServer {
  private readonly clients = new Set<WebSocket>();
  private readonly manager: SessionManager;
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
   */
  private readonly checkpointTurns = new Map<string, number>();
  /** Account-wide plan limits: last reading, restored across restarts. */
  private planUsage: PlanUsage | null = this.loadPlanUsage();
  /**
   * The preview driver each session received (PLAN D61), so its window can
   * die with the session, the project switch, or the daemon itself.
   */
  private readonly previewDrivers = new Map<string, PreviewDriver>();
  /**
   * The connected repo's declared screens (the `cds-design.screens`
   * envelope's cache, PLAN D7) — the list `screen_list` serves. The web UI
   * holds the same list today; the daemon's copy fills when the overlay
   * bridge lands. Read on every call, never snapshotted into the tools.
   */
  private previewScreens: PreviewScreenDeclaration[] = [];

  constructor(private readonly config: DaemonConfig) {
    this.credentials = config.credentialStore ?? createCredentialStore();
    this.manager = new SessionManager({
      onEvent: (sessionId, event) => this.broadcast({ type: "session.event", sessionId, event }),
      onState: (sessionId, state, detail) => {
        this.broadcast({ type: "session.state", sessionId, state, ...(detail ? { detail } : {}) });
        // A turn that just finished is the one moment the clone can have
        // gained files nobody has saved (PLAN D8). Counting here — rather
        // than on a timer — is what lets the stepper say 저장 the instant
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
        );
        if (notice) this.config.onNotice?.(notice);
        // The driver a session received dies with the session (PLAN D61):
        // close, delete, remove, and daemon stop all land here as `closed`.
        if (state === "closed") this.destroyPreviewDriver(sessionId);
      },
      onPermissionRequest: (payload) =>
        this.broadcast({ type: "permission.request", ...payload }),
      onQuestionRequest: (payload) => this.broadcast({ type: "question.request", ...payload }),
    });
  }

  async start(): Promise<void> {
    // The dot-prefixed root (PLAN D1), before the registry reads any path.
    // The CLI entry does this too, before daemon.json; the desktop app's
    // in-process host comes straight here, so this is its only choke point.
    // Idempotent: a migrated home makes the second call a no-op.
    const homeWarning = migrateHomeDir();
    if (homeWarning) this.config.onMigrationWarning?.(homeWarning);

    this.claudeExecutable = await resolveClaudeExecutable(this.config.claudeExecutable);

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
    // ~/.cds-design migration renamed every clone path, and trust is keyed
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
        sweeps.push(workspaces.repo.refreshPendingChanges().catch(() => undefined));
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
      if (url.searchParams.get("token") !== this.config.token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.attach(ws));
    });

    await new Promise<void>((resolve) =>
      this.http!.listen(this.config.port, this.config.host, resolve),
    );
  }

  /** Where the HTTP server actually bound (port 0 = ephemeral in desktop). */
  address(): { address: string; port: number } {
    const bound = this.http!.address() as { address: string; port: number };
    return bound;
  }

  async stop(): Promise<void> {
    await this.manager.closeAll();
    // Every project the daemon touched this run, not just the active one: an
    // inactive project holds no preview server, but its preview process is
    // ours to take down.
    for (const workspaces of this.workspaces.values()) {
      await workspaces.repo.stop();
    }
    for (const client of this.clients) client.close();
    this.wss?.close();
  }

  private attach(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    ws.on("message", (raw) => void this.onMessage(ws, String(raw)));

    void this.status().then((status) =>
      this.send(ws, { type: "hello", protocolVersion: PROTOCOL_VERSION, status }),
    );
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
    const workspaces: ProjectWorkspaces = {
      slug,
      paths,
      repo: new RepoWorkspace({
        root: paths.repoRoot,
        url: repo.url,
        baseBranch: repo.baseBranch,
        cycle: { branch: repo.branch, handoff: repo.handoff },
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
    const activeSlug = this.registry?.activeSlug() ?? null;
    return (this.registry?.list() ?? []).map((project) => {
      const workspaces = this.workspaces.get(project.slug);
      const repo = workspaces?.repo;
      // The tree's children come from the per-clone cache (PLAN D59); a clone
      // the daemon has not scanned yet omits the field rather than claiming
      // an empty conversation list.
      const cwd = workspaces?.repo.isCloned() ? realpathBestEffort(workspaces.paths.repoRoot) : null;
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
        working: repo ? this.manager.anyRunning(realpathBestEffort(workspaces.paths.repoRoot)) : false,
        handoff: repo?.currentHandoff ?? project.repo.handoff,
        ...(threads ? { threads } : {}),
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
   * The session options' preview half: a `cds-preview` tool set bound to the
   * active project's preview url, when a driver is injected, the preview
   * server is up, and the planner has not turned the tools off. Everything
   * else — no desktop, no preview yet, `previewTools: false` — is a session
   * without them.
   */
  private async previewToolsFor(
    enabled: boolean,
  ): Promise<{ tools: PreviewTools; driver: PreviewDriver } | null> {
    const factory = this.config.previewDriverFactory;
    if (!factory || !enabled) return null;
    const active = this.activeOrNull();
    if (!active?.repo.isCloned()) return null;
    const status = await active.repo.status().catch(() => null);
    if (!status?.previewUrl) return null;
    const driver = factory.for(status.previewUrl);
    const tools = createPreviewTools(driver, () => this.previewScreens);
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
    if (active.repo.cdsDesign()?.shots === false) return [];
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
   * Every driver rooted at a clone dies when that clone's preview does — a
   * project switch stops the outgoing server, and the sessions left behind
   * would otherwise point their windows at a dead port.
   */
  private destroyPreviewDriversWhere(cwd: string): void {
    for (const session of this.manager.all()) {
      if (session.cwd === cwd) this.destroyPreviewDriver(session.id);
    }
  }

  /**
   * Switches which project everything means.
   *
   * The outgoing preview server stops BEFORE the incoming one starts: two
   * repos may declare the same `preview.port`, and a half-overlapping restart
   * would leave the planner looking at the wrong app on the right port.
   */
  private activating: Promise<ProjectWorkspaces> | null = null;

  /**
   * Switches which project everything means.
   *
   * The outgoing preview server stops BEFORE the incoming one starts: two
   * repos may declare the same `preview.port`, and a half-overlapping restart
   * would leave the planner looking at the wrong app on the right port.
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
      if (current) {
        await current.repo.stop();
        // The outgoing clone's preview just went down — its sessions'
        // drivers would point their windows at a dead port (PLAN D61).
        this.destroyPreviewDriversWhere(realpathBestEffort(current.paths.repoRoot));
      }
      // Before the workspaces are built: `paths()` resolves the environment
      // overrides against the ACTIVE project, so a workspace built a moment
      // too early would cache the wrong roots for the rest of the run.
      this.registry.setActive(slug);
    }

    // The token was loaded once in `start()`; every workspace gets it armed
    // the same way, switch or no switch.
    const next = this.workspacesFor(slug);
    next.repo.setPat(this.pat);

    // Bringing the repo up is NOT conditional on a switch. `create` registers
    // the first project as active before calling here, so a shortcut that
    // skipped this left a brand-new project with no clone at all — the
    // picker promises "레포를 내려받아 설치까지" and nothing happened.
    // The npmrc merge rides along: a repo that declares a private registry
    // only says so in the clone this sync produces.
    if (next.repo.remoteUrl) {
      void next.repo
        .sync()
        .then(() => this.mergeRegistryNpmrc(next.repo))
        .catch(() => undefined);
    }
    if (!switching) return next;

    this.announceProjects();
    return next;
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
  }): Promise<ProjectSummary> {
    const project = this.registry.create({
      name: message.name,
      repoUrl: message.repoUrl,
      ...(message.baseBranch ? { baseBranch: message.baseBranch } : {}),
    });

    await this.activateProject(project.slug);
    // The first project becomes active inside registry.create, so
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
    const config = repo.cdsDesign();
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
    // D55: the repo's own rows ride hello·status; the tool's built-in five
    // are the web's, so an undeclaring repo sends nothing at all — not an
    // empty list the composer would have to know means "ignore me".
    const quickActions = active?.repo.cdsDesign()?.quickActions;
    return {
      ...(await buildStatus({
        executable: this.claudeExecutable,
        liveSessions: this.manager.liveCount,
        pendingPermissions: this.manager.pendingCount,
        // The registry probe only makes sense inside a repo that declares one.
        registryProbeDir: active?.repo.registry() ? active.repo.root : null,
      })),
      planUsage: this.planUsage,
      models: this.models,
      ...(quickActions && quickActions.length > 0 ? { quickActions } : {}),
      projects: this.projectSummaries(),
      activeProject: this.registry?.activeSlug() ?? null,
    };
  }

  /**
   * Plan limits belong to the account, not to one thread: whatever session
   * reports them last stands for every client, so the composer can show them
   * with no session open at all. The last reading also survives a restart —
   * the numbers only move when a turn runs, and a window whose reset has
   * passed is dropped rather than shown stale.
   */
  private rememberPlanUsage(plan: PlanUsage | null): void {
    if (!plan || JSON.stringify(plan) === JSON.stringify(this.planUsage)) return;
    this.planUsage = plan;
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(PLAN_USAGE_FILE, `${JSON.stringify(plan, null, 2)}\n`);
    } catch {
      // A cache that cannot be written just means the next start shows nothing.
    }
    void this.status().then((status) => this.broadcast({ type: "status", status }));
  }

  /** The last reading from disk, with every window that has since reset dropped. */
  private loadPlanUsage(): PlanUsage | null {
    try {
      const stored = JSON.parse(readFileSync(PLAN_USAGE_FILE, "utf8")) as PlanUsage;
      const now = Date.now();
      const fiveHour =
        stored.fiveHour && (!stored.fiveHour.resetsAt || Date.parse(stored.fiveHour.resetsAt) > now)
          ? stored.fiveHour
          : null;
      const sevenDay =
        stored.sevenDay && (!stored.sevenDay.resetsAt || Date.parse(stored.sevenDay.resetsAt) > now)
          ? stored.sevenDay
          : null;
      if (!fiveHour && !sevenDay) return null;
      return { ...stored, fiveHour, sevenDay };
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
      this.send(ws, { type: "error", id: parsed.id, message: parsed.error, code: "bad_request" });
      return;
    }
    const message = parsed.value;
    try {
      const data = await this.dispatch(message);
      this.send(ws, { type: "ok", id: message.id, data });
    } catch (error) {
      this.send(ws, {
        type: "error",
        id: message.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async dispatch(message: ClientMessage): Promise<unknown> {
    switch (message.type) {
      case "daemon.status":
        return await this.status();

      case "session.list":
        return await this.manager.list(this.workspaceCwd(), message.limit ?? 50);

      case "session.history":
        return await this.manager.history(
          message.sessionId,
          await this.resolveSessionCwd(message.sessionId),
        );

      case "session.create": {
        if (!this.claudeExecutable) {
          throw new Error("Claude Code CLI not found on this machine");
        }
        if (!existsSync(this.repo.root)) {
          throw new Error("연결 레포가 아직 준비되지 않았습니다 — 잠시 후 다시 시도해 주세요.");
        }
        // The preview tools ride the session when a driver is injected and
        // the active preview is up (PLAN D61); `previewTools: false` opts
        // out. The driver is remembered under the session's own id so the
        // lifecycle hooks above can destroy it.
        const preview = await this.previewToolsFor(message.previewTools !== false);
        const session = this.manager.create({
          cwd: this.workspaceCwd(),
          claudeExecutable: this.claudeExecutable,
          writePolicy: repoWritePolicy(this.workspaceCwd()),
          ...(message.title ? { title: message.title } : {}),
          ...(message.resume ? { resume: message.resume } : {}),
          ...(message.model ? { model: message.model } : {}),
          ...(message.effort ? { effort: message.effort } : {}),
          ...(preview ? { previewTools: preview.tools } : {}),
        });
        if (preview) this.previewDrivers.set(session.id, preview.driver);
        // A session start is the moment the 화면 half goes back to the remote.
        // Mid-cycle that is a merge of the developer's base branch, and a
        // conflict lands as this session's first task — which is why it runs
        // after the session exists, and without blocking on it.
        void this.repo.pull((brief) => this.manager.get(session.id)?.send(brief));
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
        // 화면 턴의 시작점 (PLAN D52): the turn is what a planner may want
        // to step back from, so the worktree is snapshotted the moment this
        // turn is handed over. The snapshot must never hold the turn
        // hostage — a failed checkpoint only means one fewer 되돌리기, so
        // it runs alongside and keeps its failure to itself.
        const turn = (this.checkpointTurns.get(message.sessionId) ?? 0) + 1;
        this.checkpointTurns.set(message.sessionId, turn);
        void this.repo.checkpoint(message.sessionId, turn).catch(() => undefined);
        target.send(message.text, message.images, message.files);
        return { ok: true };
      }

      case "session.interrupt":
        await this.manager.require(message.sessionId).interrupt();
        return { ok: true };

      case "session.close": {
        const cwd = this.manager.get(message.sessionId)?.cwd;
        await this.manager.close(message.sessionId);
        this.touchThreadsCwd(cwd);
        return { ok: true };
      }
      case "session.delete": {
        const cwd = await this.resolveSessionCwd(message.sessionId);
        await this.manager.remove(message.sessionId, cwd);
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

      case "permission.respond": {
        const session = this.manager.findByRequest(message.requestId);
        if (!session) throw new Error("permission request is no longer pending");
        session.respondPermission(
          message.requestId,
          message.decision,
          message.message,
          message.updatedInput,
        );
        return { ok: true };
      }

      case "question.respond": {
        const session = this.manager.findByRequest(message.requestId);
        if (!session) throw new Error("question is no longer pending");
        session.respondQuestion(message.requestId, message.answers, message.response);
        return { ok: true };
      }

      case "project.list":
        return { projects: this.projectSummaries(), activeSlug: this.registry.activeSlug() };

      case "project.create":
        return await this.createProject(message);

      case "project.activate": {
        await this.activateProject(message.slug);
        return { projects: this.projectSummaries(), activeSlug: this.registry.activeSlug() };
      }

      case "project.update": {
        this.registry.update(message.slug, {
          ...(message.name !== undefined ? { name: message.name } : {}),
          ...(message.repoUrl !== undefined ? { repoUrl: message.repoUrl } : {}),
          ...(message.baseBranch !== undefined ? { baseBranch: message.baseBranch } : {}),
        });
        // A url change is a repo change: the workspace re-points (and
        // re-clones when the url moved) through its own update path.
        const workspaces = this.workspacesFor(message.slug);
        if (message.repoUrl !== undefined) {
          await workspaces.repo.update({ url: message.repoUrl });
        }
        this.announceProjects();
        return { projects: this.projectSummaries(), activeSlug: this.registry.activeSlug() };
      }

      case "project.remove": {
        const workspaces = this.workspaces.get(message.slug);
        if (workspaces) {
          // The clone's live threads die with it (D21): a session left
          // running would keep writing into a folder the planner just
          // disowned — or one `deleteFiles` is about to remove.
          await this.manager.closeWhere(realpathBestEffort(workspaces.paths.repoRoot));
          await workspaces.repo.stop();
          this.workspaces.delete(message.slug);
        }
        const paths = this.registry.paths(message.slug);
        this.registry.remove(message.slug);
        // Files survive a forget: the clone holds screen work that was saved
        // but never merged, and nothing else on the machine has it.
        if (message.deleteFiles) rmSync(paths.root, { recursive: true, force: true });
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
        // conflict briefs the named thread like a failing gate does.
        const { onSessionTurn } = this.briefTo(message.sessionId, "refresh");
        await this.repo.pull(onSessionTurn);
        return await this.repo.status();
      }

      case "repo.update":
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
        return await client.inspectRepo({ owner: message.owner, repo: message.repo });
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
          ...this.briefTo(message.sessionId, "handoff"),
        });
      }

      case "repo.handoffStatus":
        return await this.repo.refreshHandoff();

      // --- 되돌리기와 요약 (PLAN D51 · D52 · D53) --------------------------
      case "repo.summarize":
        return await this.repo.summarize();

      case "repo.history":
        return await this.repo.history();

      case "repo.restore":
        return await this.repo.restore(message.sha);

      case "repo.discard":
        return await this.repo.discard();

      case "repo.checkpoints":
        return await this.repo.checkpoints();

      case "repo.checkpoint.restore":
        return await this.repo.checkpointRestore(message.id);

      // --- 코멘트 저장소 (PLAN D57) ----------------------------------------
      // The pins belong to the ACTIVE project: the messages carry no slug,
      // exactly because the planner is looking at one project's preview.
      case "comments.record":
        return {
          recorded: recordComments(
            join(this.requireActive().paths.root, "comments.json"),
            message.screen,
            message.state,
            message.items,
          ),
        };

      case "comments.list":
        return { items: readComments(join(this.requireActive().paths.root, "comments.json")) };

      case "comments.resolve": {
        const resolved = resolveComment(
          join(this.requireActive().paths.root, "comments.json"),
          message.id,
          message.resolved,
        );
        if (!resolved) {
          throw new Error("이미 없어진 코멘트입니다 — 코멘트 목록을 다시 열어 주세요.");
        }
        return { ok: true };
      }
    }
  }

  /**
   * Routes a failing gate's output to a live session as a user turn — the same
   * path a typed message takes, so Claude sees the planner asking for a fix.
   * The failure itself is news the planner clicked for — the step never
   * reached the developer and Claude is now on the fix — so it also fires a
   * notice before the turn starts.
   */
  private briefTo(sessionId: string | undefined, stage: "save" | "handoff" | "refresh") {
    if (!sessionId) return { onSessionTurn: undefined };
    return {
      onSessionTurn: (brief: string) => {
        const session = this.manager.get(sessionId);
        if (session) {
          this.config.onNotice?.({ kind: "gate", sessionId, title: session.title, stage });
          session.send(brief);
        }
      },
    };
  }
}

/** The PR body when the planner did not bring one. The screens a handoff
 * carries live in the repo — the client composes the per-screen list — so the
 * daemon's fallback says what the work is rather than inventing links. */
const DEFAULT_HANDOFF_BODY = "CDS Design에서 만든 화면입니다. 로직만 붙이면 됩니다.";
