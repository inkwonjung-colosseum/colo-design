import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import { containsPath, realpathBestEffort } from "./paths.js";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  type ClientMessage,
  type PlanUsage,
  type ProjectSummary,
  type SessionModelInfo,
  type SessionSummary,
  type ServerMessage,
  type Workspace,
  type DocSummary,
  type ConfluenceStatus,
} from "@drafthouse/protocol";
import { SessionManager } from "./session-manager.js";
import { SessionPages } from "./session-pages.js";
import type { WritePolicy } from "./session.js";
import { planningRules, writePolicyFor } from "./workspaces.js";
import { RepoWorkspace } from "./repo.js";
import { GitHubClient, createGitHubTransport } from "./github.js";
import {
  ProjectRegistry,
  repoPatItem,
  type ProjectPaths,
  type ProjectRoot,
} from "./projects.js";
import { ConfluenceClient } from "./sync/confluence-client.js";
import {
  loadConfluenceSettings,
  saveConfluenceSettings,
  confluenceConfigured,
  confluenceCredentials,
} from "./sync/confluence-settings.js";
import { createConfluenceTransport, FetchTransport } from "./sync/fixture-transport.js";
import {
  SyncEngine,
  bodyOf,
  resolveConfluenceRoot,
  sanitizeAttachmentFilename,
  spaceKeyForDir,
  type Deferral,
} from "./sync/sync-engine.js";
import {
  CONFLUENCE_TOKEN_ITEM,
  createCredentialStore,
  loadConfluenceToken,
  loadRepoPat,
  migratePlaintextSecrets,
  mergeNpmrc,
  npmrcPath,
  type CredentialStore,
} from "./credentials.js";
import {
  gitInstallGuidance,
  runOnboardingChecks,
  startClaudeInstall,
  startClaudeLogin,
  type OnboardingStep,
} from "./onboarding.js";
import { markdownToStorage, parseFrontmatter, storageToMarkdown } from "./sync/storage-markdown.js";
import {
  buildStatus,
  browseFiles,
  filterFiles,
  listFiles,
  resolveClaudeExecutable,
  CONFIG_DIR,
} from "./environment.js";

/**
 * One project's live machinery. Built on demand and kept: a project the
 * planner switches away from and back to must not re-clone, and its sessions
 * (which the SDK stores under the cwd) have to keep resolving.
 */
interface ProjectWorkspaces {
  slug: string;
  paths: ProjectPaths;
  repo: RepoWorkspace;
  mirror: SyncEngine;
  /** Which 기획서 each of this project's threads is about (PLAN D2). */
  sessionPages: SessionPages;
}

/**
 * The space folders a pre-projects mirror holds, read straight off disk.
 *
 * Migration needs this before any `SyncEngine` exists — the engine is built
 * per project, and the project being migrated INTO is what this decides. A
 * folder counts only when it carries the sync sidecar, the same test the
 * engine's own `spaces()` uses.
 */
function legacyMirroredSpaces(env: NodeJS.ProcessEnv = process.env): string[] {
  const root = resolveConfluenceRoot(env);
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && existsSync(join(root, entry.name, ".confluence-sync.json")),
      )
      .map((entry) => spaceKeyForDir(entry.name));
  } catch {
    return [];
  }
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

function mediaTypeFor(filename: string): string {
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  const types: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };
  return types[extension] ?? "application/octet-stream";
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
}

export class DaemonServer {
  private readonly clients = new Set<WebSocket>();
  private readonly manager: SessionManager;
  private readonly credentials: CredentialStore;
  /**
   * The project registry and one live workspace set per project the daemon
   * has touched this run. Only the ACTIVE project runs a preview server —
   * two repos may declare the same `preview.port` — but a project the planner
   * switched away from keeps its clone and its mirror.
   */
  private registry!: ProjectRegistry;
  private readonly workspaces = new Map<string, ProjectWorkspaces>();
  /** The Confluence token, loaded once at start (store or env). */
  private confluenceToken: string | null = null;
  private readonly confluenceTransport = createConfluenceTransport();
  /**
   * One GitHub transport for the whole daemon: the fixture one when a test
   * points at recorded pairs, `api.github.com` otherwise. The token is not
   * here — it is per project, and rides on each client.
   */
  private readonly gitHubTransport = createGitHubTransport().transport;
  private http: Server | null = null;
  /** The CLI's model rows, cached so the picker works before any thread. */
  private models: SessionModelInfo[] = this.loadModels();
  private wss: WebSocketServer | null = null;
  private claudeExecutable: string | null = null;
  /** Account-wide plan limits: last reading, restored across restarts. */
  private planUsage: PlanUsage | null = this.loadPlanUsage();
  private mirrorWatcher: FSWatcher | null = null;
  private mirrorWatchTimer: NodeJS.Timeout | undefined;
  /** Page paths whose change is still waiting out the watcher's debounce. */
  private readonly mirrorPending = new Set<string>();
  /** Manual external lock (doc.lock) — the session lock is computed live. */
  private manualLock: { reason: string } | null = null;
  /** Deferral held while any session is between starting and idle/closed. */
  private sessionDeferral: Deferral | null = null;
  /** Deferrals for pages whose editor holds unsaved work. */
  private readonly editingDeferrals = new Map<string, Deferral>();

  constructor(private readonly config: DaemonConfig) {
    this.credentials = config.credentialStore ?? createCredentialStore();
    this.manager = new SessionManager({
      onEvent: (sessionId, event) => this.broadcast({ type: "session.event", sessionId, event }),
      onState: (sessionId, state, detail) => {
        this.broadcast({ type: "session.state", sessionId, state, ...(detail ? { detail } : {}) });
        this.refreshSessionLock();
        // A 화면 turn that just finished is the one moment the clone can have
        // gained files nobody has saved (PLAN D8). Counting here — rather than
        // on a timer — is what lets the stepper say 저장 the instant Claude
        // stops, and say nothing at all while it is still writing.
        if (state !== "running" && this.manager.get(sessionId)?.workspace === "design") {
          void this.repo.refreshPendingChanges();
        }
      },
      onPermissionRequest: (payload) =>
        this.broadcast({ type: "permission.request", ...payload }),
      onQuestionRequest: (payload) => this.broadcast({ type: "question.request", ...payload }),
    });
  }

  async start(): Promise<void> {
    this.claudeExecutable = await resolveClaudeExecutable(this.config.claudeExecutable);

    // Secrets move into the OS store on the way in; settings files keep only
    // what is not secret. A platform without its store yet keeps its plaintext.
    await migratePlaintextSecrets(this.credentials);
    this.confluenceToken = await loadConfluenceToken(this.credentials);

    // A pre-projects installation becomes one project here, folders and all.
    // The legacy mirror's space folders are what its roots are made of, so the
    // registry is told about them rather than reaching into the sync engine.
    this.registry = ProjectRegistry.load(process.env, legacyMirroredSpaces());

    // Warm restart: bring the active project up the same way a switch does —
    // in particular, load its PAT. A start that only built the workspace left
    // the credential unarmed until the planner happened to switch projects,
    // so a private repo could neither pull nor hand over after a restart.
    // `activateProject` sees nothing moving and stops after arming it.
    const activeSlug = this.registry.activeSlug();
    if (activeSlug) {
      const active = await this.activateProject(activeSlug);
      if (active.repo.remoteUrl) void active.repo.sync().catch(() => undefined);
    }

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

    // A design session mounts the mirror read-only; the link is what makes
    // `@confluence/<space>/<page>.md` resolve inside the clone.
    this.ensureMirrorLink();
    this.startMirrorWatcher();
    this.refreshBackgroundPull();
    this.broadcast({ type: "doc.locked", lock: this.currentLock() });
  }

  /** Where the HTTP server actually bound (port 0 = ephemeral in desktop). */
  address(): { address: string; port: number } {
    const bound = this.http!.address() as { address: string; port: number };
    return bound;
  }

  async stop(): Promise<void> {
    this.stopMirrorWatcher();
    this.manualLock = null;
    this.editingDeferrals.forEach((deferral) => deferral.release());
    this.editingDeferrals.clear();
    this.sessionDeferral?.release();
    this.sessionDeferral = null;
    await this.manager.closeAll();
    // Every project the daemon touched this run, not just the active one: an
    // inactive project holds no preview server, but its timers are ours.
    for (const workspaces of this.workspaces.values()) {
      workspaces.mirror.stopBackgroundPull();
      await workspaces.repo.stop();
    }
    for (const client of this.clients) client.close();
    this.wss?.close();
    await new Promise<void>((resolve) => this.http?.close(() => resolve()));
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
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  // -------------------------------------------------------------------------
  // Projects (PLAN D3): what "the repo" and "the mirror" currently mean
  // -------------------------------------------------------------------------

  /**
   * A project's live workspaces, built the first time it is touched.
   *
   * The repo url lives in the registry, not in the workspace, so `update()`
   * hands its moved url back through `onUrlChange` and the registry stays the
   * single place a url is written. The PAT is per project: two projects on two
   * private repos must not share one credential item.
   */
  private workspacesFor(slug: string): ProjectWorkspaces {
    const existing = this.workspaces.get(slug);
    if (existing) return existing;
    const repo = this.registry.resolvedRepo(slug);
    const paths = this.registry.ensureDirs(slug);
    const sessionPages = SessionPages.load(join(paths.root, "sessions.json"));
    const workspaces: ProjectWorkspaces = {
      slug,
      paths,
      sessionPages,
      repo: new RepoWorkspace({
        root: paths.repoRoot,
        url: repo.url,
        patItem: repoPatItem(slug),
        baseBranch: repo.baseBranch,
        store: this.credentials,
        cycle: { branch: repo.branch, handoff: repo.handoff },
        onCycleChange: (cycle) => this.registry.setCycle(slug, cycle),
        gitHubClient: () => this.gitHubClientFor(slug),
        onUrlChange: (url) => this.registry.update(slug, { repoUrl: url }),
        onStatus: (status) => this.broadcastFor(slug, { type: "repo.status", status }),
        onDiffStatus: (status) => this.broadcastFor(slug, { type: "diff.status", status }),
      }),
      mirror: new SyncEngine({
        root: paths.mirrorRoot,
        // The fixture transport (offline e2e) wins when the env points at one;
        // otherwise each client gets a fetch transport for the configured site.
        clientFactory: () => this.confluenceClientFactory(),
        onStatus: (status) => this.broadcastFor(slug, { type: "confluence.status", status: this.withSpaceTitle(status) }),
        // 게시 turns a page's local `new-…` id into its real one. The threads
        // about that page have to move with it, in the same step that rewrites
        // the file — otherwise a page's first publish scatters its own tabs.
        onPageIdentified: (previousPageId, pageId) => sessionPages.repoint(previousPageId, pageId),
      }),
    };
    this.workspaces.set(slug, workspaces);
    return workspaces;
  }

  /**
   * Progress from a project the planner is no longer looking at would read as
   * the active one's — a clone finishing in the background must not repaint
   * somebody else's tree. Inactive projects still run to completion; they just
   * do it quietly.
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
   * Attaches the project root's Confluence space name ("결제 서비스") to a
   * mirror status, so the tree can lead with a name a planner recognises and
   * keep the raw key (`~63DCB…`) for tooltips and wire identity.
   */
  private withSpaceTitle(status: ConfluenceStatus): ConfluenceStatus {
    if (!status.space) return status;
    const slug = this.registry?.activeSlug();
    const title = slug
      ? this.registry.get(slug)?.roots.find((root) => root.space === status.space)?.title ?? null
      : null;
    return { ...status, spaceTitle: title };
  }

  /**
   * The active project, refusing in Korean when there is none. Every message
   * that means "the repo" or "the mirror" goes through here: without a project
   * those words have no referent, and the wizard is what fixes it.
   */
  private requireActive(): ProjectWorkspaces {
    const active = this.activeOrNull();
    if (!active) throw new Error("프로젝트가 없습니다 — 설정에서 프로젝트를 먼저 만들어 주세요.");
    return active;
  }

  private get repo(): RepoWorkspace {
    return this.requireActive().repo;
  }

  private get confluence(): SyncEngine {
    return this.requireActive().mirror;
  }

  private get confluenceRoot(): string {
    return this.requireActive().paths.mirrorRoot;
  }

  private projectSummaries(): ProjectSummary[] {
    return (this.registry?.list() ?? []).map((project) => ({
      slug: project.slug,
      name: project.name,
      roots: project.roots.map(({ space, rootPageId, title }) => ({ space, rootPageId, title })),
      repoUrl: project.repo.url,
      repoPatConfigured: this.workspaces.get(project.slug)?.repo.patConfigured ?? false,
      baseBranch: project.repo.baseBranch,
    }));
  }

  private announceProjects(): void {
    this.broadcast({
      type: "project.changed",
      projects: this.projectSummaries(),
      activeSlug: this.registry.activeSlug(),
    });
  }

  /**
   * Switches which project everything means.
   *
   * The outgoing preview server stops BEFORE the incoming one starts: two
   * repos may declare the same `preview.port`, and a half-overlapping restart
   * would leave the planner looking at the wrong app on the right port. The
   * mirror watcher and the background pull follow the same move, so the tree
   * and the 수정됨 markers can never describe the project that just left.
   */
  private async activateProject(slug: string): Promise<ProjectWorkspaces> {
    const current = this.activeOrNull();
    const switching = current?.slug !== slug;

    if (switching) {
      this.stopMirrorWatcher();
      if (current) {
        current.mirror.stopBackgroundPull();
        await current.repo.stop();
      }
      // Before the workspaces are built: `paths()` resolves the environment
      // overrides against the ACTIVE project, so a workspace built a moment
      // too early would cache the wrong roots for the rest of the run.
      this.registry.setActive(slug);
    }

    // The store is the only place a PAT lives, and the workspace is built
    // without one because its construction is synchronous.
    const next = this.workspacesFor(slug);
    next.repo.setPat(await loadRepoPat(this.credentials, slug));

    // Bringing the repo up is NOT conditional on a switch. `create` registers
    // the first project as active before calling here, so a shortcut that
    // skipped this left a brand-new project with no clone at all — the wizard
    // promises "레포를 내려받아 설치까지" and the planner got a warn instead.
    if (next.repo.remoteUrl) void next.repo.sync().catch(() => undefined);
    if (!switching) return next;

    this.ensureMirrorLink();
    this.startMirrorWatcher();
    // Cheap and only on a switch: transcripts deleted outside the app since
    // this project was last open would otherwise keep phantom tabs on a page.
    void this.pruneSessionPages(next).catch(() => undefined);
    this.refreshBackgroundPull();
    this.announceProjects();
    return next;
  }

  /**
   * Creates a project and makes it the one on screen.
   *
   * Ancestors are resolved remotely before anything is written: the overlap
   * rule (PLAN D4) decides from ancestor chains, and a project that would
   * share pages with another must be refused before a folder, a credential or
   * a clone exists. The mirror is cloned here; the repo comes up through the
   * normal activation path.
   */
  private async createProject(message: {
    name: string;
    roots: Array<{ space: string; rootPageId: string | null }>;
    repoUrl: string | null;
    repoPat?: string | null;
    baseBranch?: string;
  }): Promise<ProjectSummary> {
    const client = this.confluenceClientFactory();
    if (!client) throw new Error("Confluence 연결 정보가 설정되지 않았습니다 — 설정에서 먼저 연결해 주세요.");

    const roots: ProjectRoot[] = [];
    for (const root of message.roots) {
      if (root.rootPageId === null) {
        const space = await client.findSpace(root.space);
        roots.push({ space: root.space, rootPageId: null, title: space.name, ancestorIds: [] });
        continue;
      }
      const [page, ancestorIds] = await Promise.all([
        client.getPage(root.rootPageId),
        client.pageAncestors(root.rootPageId),
      ]);
      roots.push({ space: root.space, rootPageId: root.rootPageId, title: page.title, ancestorIds });
    }

    // Throws on overlap; nothing has been created at this point.
    const project = this.registry.create({
      name: message.name,
      roots,
      repoUrl: message.repoUrl,
      ...(message.baseBranch ? { baseBranch: message.baseBranch } : {}),
    });

    if (message.repoPat) await this.credentials.save(repoPatItem(project.slug), message.repoPat);
    await this.activateProject(project.slug);

    const workspaces = this.workspacesFor(project.slug);
    for (const root of roots) await workspaces.mirror.clone(root.space, root.rootPageId);
    // The mirror folder only exists now, so the watcher could not have been
    // started before this point — and for the very first project nothing has
    // ever started one.
    this.startMirrorWatcher();
    this.refreshBackgroundPull();
    this.ensureMirrorLink();
    this.announceProjects();

    const summary = this.projectSummaries().find((entry) => entry.slug === project.slug);
    if (!summary) throw new Error("프로젝트를 만들지 못했습니다");
    return summary;
  }

  /**
   * The directory a workspace's sessions run in, resolved through the
   * filesystem. Sessions realpath their cwd (so containment sees through the
   * /private spelling); every transcript lookup must use the same spelling or
   * live sessions and stored transcripts stop matching.
   */
  private workspaceCwd(workspace: Workspace): string {
    return realpathBestEffort(workspace === "planning" ? this.confluenceRoot : this.repo.root);
  }

  /**
   * Stamps each thread with the 기획서 it is about and, when a page is named,
   * keeps only that page's.
   */
  private withPages(sessions: SessionSummary[], pageId: string | null): SessionSummary[] {
    const active = this.activeOrNull();
    const pages = active?.sessionPages ?? null;
    const stamped = sessions.map((session) => ({
      ...session,
      pageId: pages?.pageOf(session.sessionId) ?? null,
    }));
    return pageId === null ? stamped : stamped.filter((session) => session.pageId === pageId);
  }

  /**
   * Drops page attachments for transcripts that no longer exist — they can be
   * deleted from a terminal, and a stale entry keeps a page's tab count wrong
   * forever.
   *
   * BOTH stores are listed first. A prune against one workspace's listing
   * would delete every attachment belonging to the other, which is the whole
   * of 기획 or the whole of 화면 in one go.
   */
  private async pruneSessionPages(workspaces: ProjectWorkspaces): Promise<void> {
    const known = new Set<string>();
    for (const workspace of ["planning", "design"] as const) {
      const stored = await listSessions({
        dir: this.workspaceCwd(workspace),
        limit: 500,
      }).catch(() => []);
      for (const session of stored) known.add(session.sessionId);
    }
    for (const session of this.manager.all()) known.add(session.id);
    workspaces.sessionPages.prune(known);
  }

  /**
   * Which store holds a session's transcript, for the messages that carry an
   * id but no workspace. A live session answers directly; a stored one is
   * found by asking each store in turn.
   */
  private async resolveSessionCwd(sessionId: string): Promise<string> {
    const live = this.manager.get(sessionId);
    if (live) return live.cwd;
    for (const workspace of ["design", "planning"] as const) {
      const cwd = this.workspaceCwd(workspace);
      const stored = await listSessions({ dir: cwd, limit: 200 }).catch(() => []);
      if (stored.some((session) => session.sessionId === sessionId)) return cwd;
    }
    // Nothing found: the design store is where a delete would have looked
    // before workspaces existed, and its own "already forgotten" path turns
    // this into the no-op it is.
    return this.workspaceCwd("design");
  }

  /** This daemon's two workspace roots, as the write policy needs them. */
  private sessionPolicy(workspace: Workspace): WritePolicy {
    return writePolicyFor(workspace, {
      repoRoot: this.workspaceCwd("design"),
      mirrorRoot: this.workspaceCwd("planning"),
    });
  }

  /**
   * `<repo>/confluence` → the mirror root, so a design session can mention a
   * 기획서 the way the repo's CLAUDE.md documents it (`@confluence/<space>/
   * <page>.md`) instead of an absolute machine path. Reads through it are
   * still gated by `additionalDirectories`; writes still surface as a card,
   * because containment resolves the link and lands outside the clone.
   *
   * The link is local-only: it goes into `.git/info/exclude`, which is not
   * committed, so a publish never sees it and the remote never gets it.
   */
  private ensureMirrorLink(): void {
    const active = this.activeOrNull();
    if (!active) return;
    const link = join(active.paths.repoRoot, "confluence");
    if (!existsSync(active.paths.repoRoot) || !existsSync(active.paths.mirrorRoot)) return;
    try {
      if (!existsSync(link)) symlinkSync(active.paths.mirrorRoot, link, "dir");
      const exclude = join(active.paths.repoRoot, ".git", "info", "exclude");
      if (!existsSync(exclude)) return;
      const current = readFileSync(exclude, "utf8");
      if (!current.split("\n").includes("/confluence")) {
        writeFileSync(exclude, `${current.replace(/\n*$/, "\n")}/confluence\n`);
      }
    } catch {
      // A platform that refuses symlinks (Windows without privileges) loses
      // the short mention path only; absolute reads still work.
    }
  }

  /** One Confluence client over whatever credentials are current. */
  private confluenceClientFactory(): ConfluenceClient | null {
    const stored = confluenceCredentials(loadConfluenceSettings(), process.env, this.confluenceToken);
    if (!confluenceConfigured(stored)) return null;
    return new ConfluenceClient(
      {
        siteUrl: stored.siteUrl!,
        email: stored.email!,
        apiToken: stored.apiToken!,
      },
      this.confluenceTransport.transport ?? new FetchTransport(stored.siteUrl!),
    );
  }

  /**
   * A GitHub client on the project's OWN repo PAT — the same credential that
   * clones and pushes it, so a planner who can save can also hand over. Built
   * per call because a PAT edited mid-run must reach the next request.
   */
  private gitHubClientFor(slug: string): GitHubClient | null {
    const token = this.workspaces.get(slug)?.repo.currentPat();
    if (!token) return null;
    return new GitHubClient(token, this.gitHubTransport);
  }

  /**
   * DESIGN §5: a repo that declares a private registry gets its token into
   * the user's ~/.npmrc (merged, never clobbering other lines) when its
   * onboarding fix runs.
   */
  private async mergeRegistryNpmrc(): Promise<void> {
    const config = this.repo.drafthouse();
    const pat = this.repo.currentPat();
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

  // -------------------------------------------------------------------------
  // Planning documents (mirror pages)
  // -------------------------------------------------------------------------

  /**
   * DESIGN §3 기획 탭: 자동 백그라운드 pull — every mirrored space gets a
   * periodic pull that defers to unsaved editor work and running turns
   * (DESIGN §4.4). Re-run after a clone adds a space; stop() tears them down.
   */
  private refreshBackgroundPull(): void {
    const active = this.activeOrNull();
    if (!active) return;
    const interval = Number(process.env.DRAFTHOUSE_BACKGROUND_PULL_MS) || 60_000;
    const mirrored = active.mirror.spaces();
    for (const space of active.mirror.backgroundPullSpaces()) {
      if (!mirrored.includes(space)) active.mirror.stopBackgroundPull(space);
    }
    for (const space of mirrored) active.mirror.startBackgroundPull(space, interval);
  }

  /**
   * Watches every space mirror. A page file that changed is normalized
   * through the same markdown → storage → markdown path `doc.save` uses, then
   * broadcast as `doc.changed`.
   *
   * Normalizing here is what makes a planning session's writes first-class:
   * Claude edits the file with its own tools, and the mirror still holds one
   * canonical shape, so the editor, the hash-based modified marker, and the
   * push body all agree. Already-canonical content is not rewritten, so the
   * daemon's own pull/save writes do not feed the watcher back into itself.
   */
  private startMirrorWatcher(): void {
    // Idempotent: every caller that re-points the mirror (activation, the
    // clone a new project just finished) would otherwise leak the previous
    // watcher and keep broadcasting a folder nobody is looking at.
    this.stopMirrorWatcher();
    const active = this.activeOrNull();
    if (!active) return;
    const root = active.paths.mirrorRoot;
    mkdirSync(root, { recursive: true });
    try {
      this.mirrorWatcher = watch(root, { recursive: true }, (_event, filename) =>
        this.scheduleMirrorEvent(filename === undefined ? null : String(filename)),
      );
    } catch {
      // Recursive watching is unsupported on some filesystems; the tree
      // refreshes on doc.open/doc.list anyway.
    }
  }

  private stopMirrorWatcher(): void {
    this.mirrorWatcher?.close();
    this.mirrorWatcher = null;
    clearTimeout(this.mirrorWatchTimer);
    this.mirrorPending.clear();
  }

  private scheduleMirrorEvent(filename: string | null): void {
    if (!filename || !filename.endsWith(".md")) return; // sidecar/attachments are not pages
    const path = filename.split("\\").join("/");
    // The generated rules file lives at the mirror root, not inside a space.
    if (!path.includes("/")) return;
    this.mirrorPending.add(path);
    clearTimeout(this.mirrorWatchTimer);
    this.mirrorWatchTimer = setTimeout(() => {
      const paths = [...this.mirrorPending];
      this.mirrorPending.clear();
      for (const changed of paths) {
        this.normalizeMirrorFile(changed);
        this.broadcast({ type: "doc.changed", path: changed });
      }
    }, 250);
  }

  /**
   * Rewrites a page file in canonical form when it is not already in one.
   * Anything unparseable is left exactly as written — a half-typed file is
   * the planner's or Claude's to finish, not ours to mangle.
   */
  private normalizeMirrorFile(path: string): void {
    let absolute: string;
    try {
      absolute = this.docPath(path);
    } catch {
      return;
    }
    if (!existsSync(absolute)) return;
    try {
      const markdown = readFileSync(absolute, "utf8");
      const { meta } = parseFrontmatter(markdown);
      if (!meta.pageId) return;
      const attachmentsDir = `attachments/${meta.pageId}`;
      const normalized = storageToMarkdown(
        markdownToStorage(markdown, attachmentsDir).storage,
        {
          pageId: meta.pageId,
          version: meta.version ?? 0,
          space: meta.space ?? this.spaceOf(path),
          title: meta.title ?? "제목 없음",
          parentPageId: meta.parentPageId ?? null,
        },
        attachmentsDir,
      );
      if (normalized !== markdown) writeFileSync(absolute, normalized);
    } catch {
      // Unparseable frontmatter or body: leave it alone.
    }
  }

  /**
   * A page file inside the mirror, or a refusal for anything else. Resolved
   * through the filesystem: the /private spelling of the mirror root works,
   * and a symlink planted inside the mirror pointing outside is refused.
   */
  private docPath(path: string): string {
    const absolute = resolve(this.confluenceRoot, path);
    if (!containsPath(this.confluenceRoot, absolute)) {
      throw new Error("문서 경로가 미러 폴더를 벗어납니다");
    }
    return absolute;
  }

  /** The mirror folder a doc path lives in - a real name on disk. */
  private spaceDirOf(path: string): string {
    const dir = path.split("/")[0] ?? "";
    if (!dir) throw new Error("문서 경로에 스페이스가 없습니다");
    return dir;
  }

  /**
   * The Confluence space a doc path belongs to. Not always its folder's name:
   * a personal space is keyed `~<accountId>` and mirrors under `_<accountId>`.
   */
  private spaceOf(path: string): string {
    return spaceKeyForDir(this.spaceDirOf(path));
  }

  private currentLock() {
    if (this.planningSessionsRunning() > 0) {
      return { locked: true, reason: "Claude가 작업 중입니다 — 잠시 후 다시 편집할 수 있습니다" };
    }
    if (this.manualLock) return { locked: true, reason: this.manualLock.reason };
    return { locked: false, reason: null };
  }

  /**
   * Only the 기획 half can be mid-write in the mirror, so only it locks the
   * editor and defers the background pull. A design turn writes screens in
   * the repo clone and must not freeze the planner's document.
   */
  private planningSessionsRunning(): number {
    let count = 0;
    for (const state of ["starting", "running", "waiting_permission", "waiting_question"] as const) {
      count += this.manager.countState(state, "planning");
    }
    return count;
  }

  private refreshSessionLock(): void {
    const busy = this.planningSessionsRunning() > 0;
    if (busy && !this.sessionDeferral) {
      this.sessionDeferral = this.confluence.acquireDeferral("기획 턴 실행 중");
    } else if (!busy && this.sessionDeferral) {
      this.sessionDeferral.release();
      this.sessionDeferral = null;
    }
    this.broadcast({ type: "doc.locked", lock: this.currentLock() });
  }

  private async openDoc(path: string) {
    const absolute = this.docPath(path);
    if (!existsSync(absolute)) throw new Error(`문서를 찾을 수 없습니다: ${path}`);
    const markdown = readFileSync(absolute, "utf8");
    const { meta } = parseFrontmatter(markdown);
    const pageId = meta.pageId ?? "";
    const conflict =
      (pageId && this.confluence.conflicts(this.spaceOf(path)).find((entry) => entry.pageId === pageId)) ||
      null;

    const attachments: Array<{ filename: string; mediaType: string; data: string }> = [];
    const dir = join(this.confluenceRoot, this.spaceDirOf(path), "attachments", pageId);
    if (pageId && existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        attachments.push({
          filename: file,
          mediaType: mediaTypeFor(file),
          data: readFileSync(join(dir, file)).toString("base64"),
        });
      }
    }
    return { frontmatter: meta, markdown, attachments, conflict };
  }

  /** The single save path: markdown → storage → canonical markdown. */
  private async saveDoc(path: string, markdown: string) {
    const absolute = this.docPath(path);
    if (!existsSync(absolute)) throw new Error(`문서를 찾을 수 없습니다: ${path}`);
    const existing = parseFrontmatter(readFileSync(absolute, "utf8")).meta;
    const incoming = parseFrontmatter(markdown).meta;
    const meta = {
      pageId: incoming.pageId ?? existing.pageId ?? "",
      version: incoming.version ?? existing.version ?? 1,
      space: incoming.space ?? existing.space ?? this.spaceOf(path),
      title: incoming.title ?? existing.title ?? "제목 없음",
      parentPageId: incoming.parentPageId ?? existing.parentPageId ?? null,
    };
    if (!meta.pageId) throw new Error("frontmatter에 pageId가 없습니다");

    const attachmentsDir = `attachments/${meta.pageId}`;
    const storage = markdownToStorage(markdown, attachmentsDir).storage;
    const normalized = storageToMarkdown(storage, meta, attachmentsDir);

    writeFileSync(absolute, normalized);
    this.broadcast({ type: "doc.changed", path });
    return { markdown: normalized, version: meta.version };
  }

  private async resolveDoc(path: string, choice: "mine" | "theirs") {
    const absolute = this.docPath(path);
    const pageId = parseFrontmatter(readFileSync(absolute, "utf8")).meta.pageId;
    if (!pageId) throw new Error("frontmatter에 pageId가 없습니다");
    return await this.confluence.resolveConflict(this.spaceOf(path), pageId, choice);
  }

  private async saveAttachment(path: string, filename: string, mediaType: string, data: string) {
    const absolute = this.docPath(path);
    const pageId = parseFrontmatter(readFileSync(absolute, "utf8")).meta.pageId;
    if (!pageId) throw new Error("frontmatter에 pageId가 없습니다");
    const dir = join(this.confluenceRoot, this.spaceDirOf(path), "attachments", pageId);
    mkdirSync(dir, { recursive: true });
    // The filename crosses the wire from a client: keep the basename only, so
    // no traversal, drive, or separator can steer the write out of this dir.
    const clean = sanitizeAttachmentFilename(filename);
    let name = clean;
    for (let n = 2; existsSync(join(dir, name)); n += 1) name = `${n}-${clean}`;
    writeFileSync(join(dir, name), Buffer.from(data, "base64"));
    return { filename: name, reference: `attachments/${pageId}/${name}`, mediaType };
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

      case "session.list": {
        const sessions = await this.manager.list(
          this.workspaceCwd(message.workspace),
          message.workspace,
          message.limit ?? 50,
        );
        return this.withPages(sessions, message.pageId ?? null);
      }

      case "session.history":
        return await this.manager.history(
          message.sessionId,
          await this.resolveSessionCwd(message.sessionId),
        );

      case "session.create": {
        if (!this.claudeExecutable) {
          throw new Error("Claude Code CLI not found on this machine");
        }
        const workspace = message.workspace;
        if (workspace === "design") {
          if (!existsSync(this.repo.root)) {
            throw new Error("연결 레포가 아직 준비되지 않았습니다 — 잠시 후 다시 시도해 주세요.");
          }
          // A repo cloned after the daemon started has no mirror view yet.
          this.ensureMirrorLink();
        } else if (this.confluence.spaces().length === 0) {
          throw new Error(
            "이 프로젝트의 기획서를 아직 가져오지 않았습니다 — 문서 트리에서 다시 가져와 주세요.",
          );
        }
        const session = this.manager.create({
          workspace,
          cwd: this.workspaceCwd(workspace),
          claudeExecutable: this.claudeExecutable,
          writePolicy: this.sessionPolicy(workspace),
          ...(workspace === "planning"
            ? // The mirror is a folder of markdown until something says what
              // it is; the repo contributes its own 기획 conventions on top.
              { systemPromptAppend: planningRules(this.repo.drafthouse()?.planning?.rules ?? null) }
            : // The design half reads the 기획서 it is building from; it may
              // not write there without the planner seeing a card.
              { additionalDirectories: [this.confluenceRoot] }),
          ...(message.title ? { title: message.title } : {}),
          ...(message.resume ? { resume: message.resume } : {}),
          ...(message.model ? { model: message.model } : {}),
          ...(message.effort ? { effort: message.effort } : {}),
        });
        if (workspace === "design") {
          // A session start is the moment the 화면 half goes back to the
          // remote. Mid-cycle that is a merge of the developer's base branch,
          // and a conflict lands as this session's first task — which is why
          // it runs after the session exists, and without blocking on it.
          void this.repo.pull((brief) => this.manager.get(session.id)?.send(brief));
        }
        // A thread that names its 기획서 is attached before it can be listed,
        // so the page it was created under is the page it shows up on.
        if (message.pageId) this.requireActive().sessionPages.attach(session.id, message.pageId);
        return { sessionId: session.id, state: session.state, pageId: message.pageId ?? null };
      }

      case "session.send":
        this.manager.require(message.sessionId).send(message.text, message.images, message.files);
        return { ok: true };

      case "session.interrupt":
        await this.manager.require(message.sessionId).interrupt();
        return { ok: true };

      case "session.close":
        await this.manager.close(message.sessionId);
        return { ok: true };

      case "session.delete":
        await this.manager.remove(message.sessionId, await this.resolveSessionCwd(message.sessionId));
        this.activeOrNull()?.sessionPages.detach(message.sessionId);
        return { ok: true };

      case "session.contextUsage": {
        const usage = await this.manager.require(message.sessionId).contextUsage();
        this.rememberPlanUsage(usage?.plan ?? null);
        return usage;
      }

      case "repo.files": {
        const roots =
          message.workspace === "planning"
            ? [this.confluenceRoot]
            : [this.repo.root, this.confluenceRoot];
        const files: string[] = [];
        for (const root of roots) {
          if (!existsSync(root)) continue;
          const prefix = root === this.confluenceRoot && roots.length > 1 ? "confluence/" : "";
          for (const file of await listFiles(root)) files.push(prefix + file);
        }
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
        // A url or PAT change is a repo change: the workspace re-points (and
        // re-clones when the url moved) through its own update path, which is
        // also what persists the PAT under this project's credential item.
        const workspaces = this.workspacesFor(message.slug);
        if (message.repoUrl !== undefined || message.repoPat !== undefined) {
          await workspaces.repo.update({
            ...(message.repoUrl !== undefined ? { url: message.repoUrl } : {}),
            ...(message.repoPat !== undefined ? { pat: message.repoPat } : {}),
          });
        }
        this.announceProjects();
        return { projects: this.projectSummaries(), activeSlug: this.registry.activeSlug() };
      }

      case "project.remove": {
        const workspaces = this.workspaces.get(message.slug);
        if (workspaces) {
          workspaces.mirror.stopBackgroundPull();
          await workspaces.repo.stop();
          this.workspaces.delete(message.slug);
        }
        const paths = this.registry.paths(message.slug);
        this.registry.remove(message.slug);
        await this.credentials.delete(repoPatItem(message.slug)).catch(() => undefined);
        // Files survive a forget: a mirror can hold 기획서 that were written
        // but never pushed, and nothing else on the machine has them.
        if (message.deleteFiles) rmSync(paths.root, { recursive: true, force: true });
        const next = this.registry.activeSlug();
        if (next) await this.activateProject(next);
        else this.stopMirrorWatcher();
        this.announceProjects();
        return { projects: this.projectSummaries(), activeSlug: next };
      }

      case "repo.status":
        return await this.repo.status();

      case "repo.sync": {
        const status = await this.repo.sync();
        // A fresh clone has no mirror link yet.
        this.ensureMirrorLink();
        return status;
      }

      case "repo.update":
        return await this.repo.update({
          ...(message.url !== undefined ? { url: message.url } : {}),
          ...(message.pat !== undefined ? { pat: message.pat } : {}),
        });

      case "confluence.update": {
        const stored = loadConfluenceSettings();
        // An explicitly empty site/email is a client bug, not a setting: an
        // empty siteUrl reaching the transport turns every Confluence request
        // into a relative-URL fetch failure (dogfood finding).
        if (typeof message.siteUrl === "string" && message.siteUrl.trim() === "") {
          throw new Error("Confluence 사이트 주소를 입력해 주세요.");
        }
        if (typeof message.email === "string" && message.email.trim() === "") {
          throw new Error("Confluence 이메일을 입력해 주세요.");
        }
        const next = {
          siteUrl: message.siteUrl !== undefined ? message.siteUrl : stored.siteUrl,
          email: message.email !== undefined ? message.email : stored.email,
          apiToken: message.apiToken !== undefined ? message.apiToken : this.confluenceToken,
        };
        // The token goes to the OS store; the settings file keeps site/email.
        if (message.apiToken !== undefined) {
          if (message.apiToken === null) await this.credentials.delete(CONFLUENCE_TOKEN_ITEM);
          else await this.credentials.save(CONFLUENCE_TOKEN_ITEM, message.apiToken);
          this.confluenceToken = message.apiToken;
        }
        saveConfluenceSettings({ siteUrl: next.siteUrl, email: next.email, apiToken: null });
        return {
          siteUrl: next.siteUrl,
          email: next.email,
          // The token never crosses the wire back; presence only.
          apiTokenConfigured: next.apiToken !== null,
        };
      }

      case "confluence.sync": {
        const active = this.requireActive();
        // The project decides how much of the space it owns; a re-sync must
        // never widen a subtree mirror into a whole-space one.
        const root = this.registry.get(active.slug)?.roots.find((entry) => entry.space === message.space);
        const status = await active.mirror.clone(message.space, root?.rootPageId ?? null);
        this.refreshBackgroundPull();
        // The first cloned space is what makes the link worth having.
        this.ensureMirrorLink();
        return status;
      }

      case "confluence.pull":
        return await this.confluence.pull(message.space);

      case "confluence.push":
        return await this.confluence.push(message.space);

      case "confluence.review":
        return this.confluence.review(message.space);

      case "confluence.status": {
        const stored = confluenceCredentials(loadConfluenceSettings(), process.env, this.confluenceToken);
        return {
          settings: {
            siteUrl: stored.siteUrl,
            email: stored.email,
            apiTokenConfigured: stored.apiToken !== null,
          },
          spaces: (this.activeOrNull()?.mirror.allStatuses() ?? []).map((status) => this.withSpaceTitle(status)),
        };
      }

      case "confluence.spaces": {
        const client = this.confluenceClientFactory();
        if (!client) {
          throw new Error(
            "Confluence 연결 정보가 설정되지 않았습니다 — 설정에서 사이트 주소·이메일·API 토큰을 넣어 주세요.",
          );
        }
        // Runs before any project exists (the wizard's space step), so the
        // mirrored list is whatever the active project has, or nothing.
        return { spaces: await client.listSpaces(), mirrored: this.activeOrNull()?.mirror.spaces() ?? [] };
      }

      case "confluence.pageTree": {
        const client = this.confluenceClientFactory();
        if (!client) {
          throw new Error(
            "Confluence 연결 정보가 설정되지 않았습니다 — 설정에서 사이트 주소·이메일·API 토큰을 넣어 주세요.",
          );
        }
        const space = await client.findSpace(message.space);
        const pages = await client.listSpacePages(space.id);
        // What the picker must refuse: a page already inside somebody's
        // subtree, and every ancestor of one (picking it would swallow them).
        const taken = (this.registry?.list() ?? []).flatMap((project) =>
          project.roots
            .filter((root) => root.space === message.space)
            .flatMap((root) => (root.rootPageId ? [root.rootPageId, ...root.ancestorIds] : [])),
        );
        return {
          space: message.space,
          pages: pages.map(({ id, title, parentId }) => ({ id, title, parentId })),
          taken,
        };
      }

      case "doc.list":
        return this.confluence.pageList(message.space);

      case "doc.open":
        return await this.openDoc(message.path);

      case "doc.save":
        return await this.saveDoc(message.path, message.markdown);

      case "doc.lock": {
        this.manualLock = message.locked
          ? { reason: message.reason ?? "다른 창에서 편집 중입니다" }
          : null;
        const lock = this.currentLock();
        this.broadcast({ type: "doc.locked", lock });
        return lock;
      }

      case "doc.resolve":
        return await this.resolveDoc(message.path, message.choice);

      case "doc.attachment.save":
        return await this.saveAttachment(message.path, message.filename, message.mediaType, message.data);

      case "doc.editing": {
        if (message.editing && !this.editingDeferrals.has(message.path)) {
          this.editingDeferrals.set(
            message.path,
            this.confluence.acquireDeferral(`편집 중: ${message.path}`),
          );
        } else if (!message.editing) {
          this.editingDeferrals.get(message.path)?.release();
          this.editingDeferrals.delete(message.path);
        }
        return { ok: true };
      }

      case "onboarding.check": {
        const active = this.activeOrNull();
        return await runOnboardingChecks({
          claudeExecutableOverride: this.config.claudeExecutable,
          repo: active?.repo ?? null,
          confluence: active?.mirror ?? null,
          projectName: active ? (this.registry.get(active.slug)?.name ?? null) : null,
          confluenceClient: () => this.confluenceClientFactory(),
          gitHubClient: () => (active ? this.gitHubClientFor(active.slug) : null),
        });
      }

      case "onboarding.fix": {
        switch (message.kind) {
          case "install-claude":
            return startClaudeInstall();
          case "login-claude":
            return startClaudeLogin();
          case "install-git":
            return gitInstallGuidance();
          case "repo-install": {
            const status = await this.repo.sync();
            await this.mergeRegistryNpmrc();
            this.ensureMirrorLink();
            return status;
          }
          case "confluence-sync": {
            const active = this.requireActive();
            // Without a space the fix means "clone what this project owns",
            // which is the only thing the wizard can ask for now that a
            // project declares its own Confluence locations.
            const roots = (this.registry.get(active.slug)?.roots ?? []).filter(
              (root) => !message.space || root.space === message.space,
            );
            if (roots.length === 0) throw new Error("이 프로젝트에 복제할 Confluence 위치가 없습니다");
            let cloned;
            for (const root of roots) cloned = await active.mirror.clone(root.space, root.rootPageId);
            // The wizard's clone is a clone like any other: the space gets
            // its background-pull timer here too (the timer map is idempotent
            // per space, so a re-run only replaces the timer).
            this.refreshBackgroundPull();
            this.ensureMirrorLink();
            return cloned;
          }
        }
      }

      case "diff.get":
        return await this.repo.diff();

      case "repo.save":
        return await this.repo.save({
          ...(message.message ? { message: message.message } : {}),
          ...this.briefTo(message.sessionId),
        });

      case "repo.handoff": {
        const active = this.requireActive();
        return await active.repo.handoff({
          title: message.title ?? this.registry.get(active.slug)?.name ?? undefined,
          body: message.body ?? (await this.handoffBody(active)),
          ...this.briefTo(message.sessionId),
        });
      }

      case "repo.handoffStatus":
        return await this.repo.refreshHandoff();
    }
  }

  /**
   * Routes a failing gate's output to a live session as a user turn — the same
   * path a typed message takes, so Claude sees the planner asking for a fix.
   */
  private briefTo(sessionId: string | undefined) {
    if (!sessionId) return {};
    return {
      onSessionTurn: (brief: string) => {
        const session = this.manager.get(sessionId);
        if (session) session.send(brief);
      },
    };
  }

  /**
   * What a developer reads when the work reaches them. The planner may replace
   * all of it before sending.
   */
  private async handoffBody(active: ProjectWorkspaces): Promise<string> {
    const spaces = this.registry.get(active.slug)?.roots.map((root) => root.space) ?? [];
    return handoffBodyFor(
      spaces.map((space) => ({ space, pages: active.mirror.pageList(space) })),
      loadConfluenceSettings().siteUrl ?? null,
    );
  }
}

/**
 * The pull request body: which 기획서 specify these screens, as links a
 * developer can open, and their pageIds so the tree can badge them ✓ 넘김.
 *
 * `pageId: <id>` stays spelled out beside the url because that is the token
 * the daemon scans a body for; a url is not a substitute for it. A page that
 * was never published has nothing to link to and says so instead — and with
 * no site configured the tool has no address to build, so it links nothing
 * rather than guessing one.
 */
export function handoffBodyFor(
  entries: Array<{ space: string; pages: DocSummary[] }>,
  siteUrl: string | null,
): string {
  const site = siteUrl?.trim().replace(/\/+$/, "") || null;
  const lines = ["Drafthouse에서 만든 화면입니다. 로직만 붙이면 됩니다.", ""];
  for (const { space, pages } of entries) {
    for (const page of pages) {
      const id = `(pageId: ${page.pageId})`;
      if (page.isNew) {
        lines.push(`- ${page.title} — 아직 Confluence에 게시되지 않음 ${id}`);
      } else if (site) {
        const url = `${site}/wiki/spaces/${encodeURIComponent(space)}/pages/${page.pageId}`;
        lines.push(`- [${page.title}](${url}) ${id}`);
      } else {
        lines.push(`- ${page.title} ${id}`);
      }
    }
  }
  if (entries.length === 0) lines.push("- (연결된 기획서 없음)");
  return lines.join("\n");
}
