import { z } from "zod";

/**
 * Wire protocol between the hub daemon (runs on the planner's own machine,
 * drives their own Claude Code login) and the planner UI.
 *
 * Everything is scoped to the ACTIVE PROJECT — a Confluence subtree set plus
 * one connected repo (PLAN D3). No message names a directory: the daemon
 * resolves every path from the project registry itself, which also means a
 * client can never point a session at an arbitrary folder. Messages that used
 * to mean "the repo" or "the mirror" now mean the active project's, and
 * `project.activate` is what moves that target.
 *
 * Client -> daemon messages are validated with zod because they arrive over a
 * socket. Daemon -> client messages are produced by us, so they are plain types.
 */

export const PROTOCOL_VERSION = 5;

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export const permissionModeSchema = z.enum([
  "default",
  "plan",
  "acceptEdits",
  "dontAsk",
  "bypassPermissions",
]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const effortLevelSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof effortLevelSchema>;

/**
 * The two halves of the product, each a real workspace with its own cwd,
 * its own CLAUDE.md, and its own publish path:
 *
 * - `planning` runs in the Confluence mirror root. Claude writes 기획서
 *   pages; 게시 pushes them to Confluence.
 * - `design` runs in the connected repo clone, with the mirror mounted
 *   read-only. Claude writes screens; 게시 runs the gates and pushes git.
 *
 * A session belongs to exactly one of them — the SDK stores transcripts per
 * cwd, so the split also keeps the two session lists apart.
 */
export const workspaceSchema = z.enum(["planning", "design"]);
export type Workspace = z.infer<typeof workspaceSchema>;

export type SessionState =
  | "starting"
  | "idle"
  | "running"
  | "waiting_permission"
  | "waiting_question"
  | "error"
  | "closed";

// ---------------------------------------------------------------------------
// Client -> daemon
// ---------------------------------------------------------------------------

const withId = { id: z.string().min(1) };

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...withId, type: z.literal("daemon.status") }),
  z.object({
    ...withId,
    type: z.literal("session.list"),
    workspace: workspaceSchema,
    /**
     * Only the threads attached to this 기획서 (PLAN D2). Omitted returns the
     * workspace's whole list, which is what a client shows for pages that have
     * none and for the threads that predate page attachment.
     */
    pageId: z.string().min(1).max(64).optional(),
    limit: z.number().int().positive().max(200).optional(),
  }),
  z.object({
    ...withId,
    type: z.literal("session.history"),
    sessionId: z.string().min(1),
  }),
  z.object({
    ...withId,
    type: z.literal("session.create"),
    /** Model the query starts on (SDK alias or id); omitted = CLI default. */
    model: z.string().min(1).optional(),
    /** Reasoning effort the query starts on; omitted = CLI default. */
    effort: effortLevelSchema.optional(),
    workspace: workspaceSchema,
    /**
     * The 기획서 this thread is about — the page's `pageId`, including the
     * local `new-…` placeholder a page carries before 게시 creates it
     * remotely. The daemon re-points the attachment when that placeholder
     * becomes a real id, so a thread survives its page's first publish.
     */
    pageId: z.string().min(1).max(64).optional(),
    /**
     * A name for a thread the tool is opening on the planner's behalf. The
     * first turn names an unnamed thread, so a handoff — whose first turn is
     * a sentence the tool wrote — would otherwise be titled with the file
     * path inside it.
     */
    title: z.string().min(1).max(80).optional(),
    /** Continue an existing thread by id, in the same workspace. */
    resume: z.string().optional(),
  }),
  z.object({
    ...withId,
    type: z.literal("session.send"),
    sessionId: z.string().min(1),
    text: z.string(),
    /** Optional base64 image attachments. */
    images: z
      .array(z.object({ mediaType: z.string().min(1), data: z.string().min(1) }))
      .optional(),
    /**
     * Planning documents. The daemon saves each one under `<cwd>/specs/` and
     * appends an `@specs/<name>` reference to the prompt, so Claude reads it
     * with its own Read tool (which handles PDF page ranges and image
     * downscaling) instead of receiving the bytes inline.
     */
    files: z
      .array(
        z.object({
          name: z.string().min(1),
          mediaType: z.string().min(1),
          data: z.string().min(1),
        }),
      )
      .optional(),
  }),
  z.object({ ...withId, type: z.literal("session.interrupt"), sessionId: z.string().min(1) }),
  z.object({ ...withId, type: z.literal("session.close"), sessionId: z.string().min(1) }),
  z.object({ ...withId, type: z.literal("session.delete"), sessionId: z.string().min(1) }),
  z.object({
    ...withId,
    type: z.literal("session.setModel"),
    sessionId: z.string().min(1),
    /** `null` returns the model to the CLI default. */
    model: z.string().min(1).nullable(),
  }),
  z.object({
    ...withId,
    type: z.literal("session.setEffort"),
    sessionId: z.string().min(1),
    /** `null` clears the override. */
    effort: effortLevelSchema.nullable(),
  }),
  z.object({
    ...withId,
    type: z.literal("session.setPermissionMode"),
    sessionId: z.string().min(1),
    mode: permissionModeSchema,
  }),
  z.object({
    ...withId,
    type: z.literal("session.selectors"),
    sessionId: z.string().min(1),
  }),
  z.object({ ...withId, type: z.literal("session.commands"), sessionId: z.string().min(1) }),
  z.object({ ...withId, type: z.literal("session.contextUsage"), sessionId: z.string().min(1) }),
  z.object({
    ...withId,
    type: z.literal("repo.files"),
    /**
     * Which file set the @-mention autocomplete draws from: the mirror for
     * `planning`, the repo clone plus the mirror (read-only) for `design`.
     */
    workspace: workspaceSchema,
    /** Substring filter for @-mention autocomplete. */
    query: z.string().optional(),
    limit: z.number().int().positive().max(500).optional(),
  }),
  z.object({
    ...withId,
    type: z.literal("permission.respond"),
    requestId: z.string().min(1),
    decision: z.enum(["allow", "allowAlways", "deny"]),
    /** Reason shown to Claude on deny. */
    message: z.string().optional(),
    /** Edited tool input on allow. */
    updatedInput: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    ...withId,
    type: z.literal("question.respond"),
    requestId: z.string().min(1),
    /** question text -> selected label(s) */
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
    /** Freeform reply instead of answering the structured questions. */
    response: z.string().optional(),
  }),
  /**
   * The registry: every project plus which one is active. Cheap and
   * side-effect free — the switcher asks for it on every connect.
   */
  z.object({ ...withId, type: z.literal("project.list") }),
  /**
   * Registers a project and brings it up: validates that no root overlaps an
   * existing project's subtree, resolves each root's ancestors remotely,
   * clones the repo, mirrors the subtrees. Progress arrives as `repo.status`
   * and `confluence.status`; the reply is the created project.
   */
  z.object({
    ...withId,
    type: z.literal("project.create"),
    name: z.string().min(1).max(64),
    /** At least one Confluence subtree. `rootPageId: null` takes a whole space. */
    roots: z
      .array(
        z.object({
          space: z.string().min(1).max(64),
          rootPageId: z.string().min(1).max(64).nullable(),
        }),
      )
      .min(1)
      .max(8),
    repoUrl: z.string().min(1).nullable(),
    /** Stored daemon-side under this project only; never echoed back. */
    repoPat: z.string().min(1).nullable().optional(),
    /** What a handoff PR will target. Defaults to `main`. */
    baseBranch: z.string().min(1).max(128).optional(),
  }),
  /**
   * Switches which project everything else means. The outgoing project's
   * preview server stops before the incoming one starts — two repos may
   * declare the same `preview.port`, so they can never run at once.
   */
  z.object({ ...withId, type: z.literal("project.activate"), slug: z.string().min(1).max(64) }),
  z.object({
    ...withId,
    type: z.literal("project.update"),
    slug: z.string().min(1).max(64),
    name: z.string().min(1).max(64).optional(),
    repoUrl: z.string().min(1).nullable().optional(),
    repoPat: z.string().min(1).nullable().optional(),
    baseBranch: z.string().min(1).max(128).optional(),
  }),
  /**
   * Forgets a project. Its folder survives unless `deleteFiles` — a mirror can
   * hold 기획서 that were never pushed, and a mis-click must not take them.
   */
  z.object({
    ...withId,
    type: z.literal("project.remove"),
    slug: z.string().min(1).max(64),
    deleteFiles: z.boolean().optional(),
  }),
  /** Connected repo state. Reads disk and process state; no side effects. */
  z.object({ ...withId, type: z.literal("repo.status") }),
  /**
   * Idempotent bootstrap of the connected repo: clone when missing, pull,
   * install when the dependency hash moved, start the preview command
   * declared in `drafthouse.json`. Resolves when it settles; progress arrives
   * as `repo.status`.
   */
  z.object({ ...withId, type: z.literal("repo.sync") }),
  /**
   * Change the connected repo's url and/or PAT. The daemon persists both
   * daemon-side and re-clones when the url moved. The PAT is never echoed
   * back: the reply is the resulting `RepoStatus`, which carries presence
   * (`patConfigured`) only.
   */
  z.object({
    ...withId,
    type: z.literal("repo.update"),
    /** Repository url; `null` clears it. */
    url: z.string().min(1).nullable().optional(),
    /** Personal access token, stored daemon-side only; `null` clears it. */
    pat: z.string().min(1).nullable().optional(),
  }),
  /** Uncommitted worktree changes vs HEAD, for the publish review panel. */
  z.object({ ...withId, type: z.literal("diff.get") }),
  z.object({
    ...withId,
    type: z.literal("confluence.update"),
    /** Site url, e.g. https://example.atlassian.net; `null` clears. */
    siteUrl: z.string().min(1).nullable().optional(),
    /** Account email; `null` clears. */
    email: z.string().min(3).nullable().optional(),
    /** API token, stored daemon-side only; `null` clears. Never echoed back. */
    apiToken: z.string().min(1).nullable().optional(),
  }),
  /**
   * Mirror operations, all against the ACTIVE project's mirror. `space` names
   * which of its roots to work on; a project with one root can be driven
   * without the planner ever choosing.
   */
  z.object({ ...withId, type: z.literal("confluence.sync"), space: z.string().min(1).max(64) }),
  z.object({ ...withId, type: z.literal("confluence.pull"), space: z.string().min(1).max(64) }),
  z.object({
    ...withId,
    type: z.literal("confluence.push"),
    space: z.string().min(1).max(64),
  }),
  /** What 게시 would send, computed before anything is written: the confirm dialog's data. */
  z.object({ ...withId, type: z.literal("confluence.review"), space: z.string().min(1).max(64) }),
  z.object({ ...withId, type: z.literal("confluence.status") }),
  /**
   * Spaces the stored credentials can see, plus the keys the active project
   * already mirrors. The project wizard picks a space here before narrowing
   * to a page.
   */
  z.object({ ...withId, type: z.literal("confluence.spaces") }),
  /**
   * The REMOTE page tree of a space, flat with `parentId` — what the wizard
   * shows so a planner can point a project at "결제 서비스" instead of the
   * whole space. Unmirrored by definition: this runs before any clone.
   */
  z.object({ ...withId, type: z.literal("confluence.pageTree"), space: z.string().min(1).max(64) }),
  /** Runs the four onboarding checks; read-only. */
  z.object({ ...withId, type: z.literal("onboarding.check") }),
  z.object({
    ...withId,
    type: z.literal("onboarding.fix"),
    kind: z.enum(["install-claude", "login-claude", "install-git", "repo-install", "confluence-sync"]),
    /** For confluence-sync: the space to clone. */
    space: z.string().min(1).max(64).optional(),
  }),
  /** Page list of a mirrored space, for the tree. */
  z.object({ ...withId, type: z.literal("doc.list"), space: z.string().min(1).max(64) }),
  z.object({ ...withId, type: z.literal("doc.open"), path: z.string().min(1).max(512) }),
  /**
   * Save a page. The daemon normalizes through the single save path
   * (markdown → storage → markdown) and writes; the reply carries the
   * normalized markdown so the editor can resettle on it.
   */
  z.object({ ...withId, type: z.literal("doc.save"), path: z.string().min(1).max(512), markdown: z.string() }),
  /** Hold or release an external read-only lock (tests, later stories). */
  z.object({
    ...withId,
    type: z.literal("doc.lock"),
    locked: z.boolean(),
    reason: z.string().max(200).optional(),
  }),
  /** Resolve a page conflict by keeping ours or taking theirs. */
  z.object({
    ...withId,
    type: z.literal("doc.resolve"),
    path: z.string().min(1).max(512),
    choice: z.enum(["mine", "theirs"]),
  }),
  /** Save a pasted/dropped image into the page's attachments folder. */
  z.object({
    ...withId,
    type: z.literal("doc.attachment.save"),
    path: z.string().min(1).max(512),
    filename: z.string().min(1).max(200),
    mediaType: z.string().min(3).max(100),
    /** base64 */
    data: z.string().min(1),
  }),
  /** The editor is (no longer) holding unsaved work on this page. */
  z.object({
    ...withId,
    type: z.literal("doc.editing"),
    path: z.string().min(1).max(512),
    editing: z.boolean(),
  }),
  /**
   * 저장 (PLAN D5): gate, commit and push the reviewed worktree diff onto the
   * project's own `drafthouse/…` branch, created on the first save of a cycle.
   * The base branch is never written to — a developer receives this work as a
   * pull request, not as a push past them.
   */
  z.object({
    ...withId,
    type: z.literal("repo.save"),
    /** Commit message; the daemon falls back to a Korean default. */
    message: z.string().min(1).max(500).optional(),
    /**
     * Live session that receives the failing gate's output as a user turn,
     * so Claude can fix the repo and the planner can save again.
     */
    sessionId: z.string().min(1).optional(),
  }),
  /**
   * 개발자에게 넘기기: run `build`, then open (or update) the pull request for
   * the current branch. Subsequent saves accumulate on the same PR.
   */
  z.object({
    ...withId,
    type: z.literal("repo.handoff"),
    /** PR title; the daemon proposes one from the branch's commits. */
    title: z.string().min(1).max(200).optional(),
    /** PR body; the daemon proposes one naming the 기획서 behind the work. */
    body: z.string().max(20_000).optional(),
    sessionId: z.string().min(1).optional(),
  }),
  /**
   * Re-read the open pull request from GitHub: merged, closed, or still open.
   * Asked for rather than polled — a timer would hit the API every minute for
   * a state that only moves when a human acts on it.
   */
  z.object({ ...withId, type: z.literal("repo.handoffStatus") }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---------------------------------------------------------------------------
// Normalized chat events (daemon translates SDKMessage into these)
// ---------------------------------------------------------------------------

export type ChatEvent =
  | {
      kind: "init";
      sessionId: string;
      model: string;
      cwd: string;
      tools: string[];
      apiKeySource: string;
      /** Slash commands and agents available, for UI affordances. */
      permissionMode: PermissionMode;
    }
  | { kind: "text.delta"; blockId: string; text: string; agentId: string | null }
  | { kind: "text.done"; blockId: string; text: string; agentId: string | null }
  | { kind: "thinking.delta"; blockId: string; text: string; agentId: string | null }
  | {
      kind: "tool.start";
      toolUseId: string;
      name: string;
      input: unknown;
      agentId: string | null;
    }
  | {
      kind: "tool.end";
      toolUseId: string;
      isError: boolean;
      content: unknown;
      agentId: string | null;
    }
  /** `files` holds `specs/` paths of documents that rode along with the turn. */
  | { kind: "user.echo"; text: string; images: number; files: string[] }
  | {
      kind: "turn.end";
      subtype: string;
      isError: boolean;
      costUsd: number | null;
      numTurns: number | null;
      durationMs: number | null;
      /** Present when the turn ended because the model declined. */
      resultText: string | null;
    }
  | {
      kind: "retry";
      attempt: number;
      maxRetries: number;
      delayMs: number;
      error: string;
    }
  | { kind: "notice"; level: "info" | "warn" | "error"; text: string }
  | { kind: "compact"; trigger: string };

// ---------------------------------------------------------------------------
// Daemon -> client
// ---------------------------------------------------------------------------

/** One Confluence subtree a project owns, as the UI shows it. */
export interface ProjectRootSummary {
  space: string;
  /** `null` when the project owns the whole space. */
  rootPageId: string | null;
  /** The root page's title, or the space key when the root is the space. */
  title: string;
}

/**
 * A project as the client sees it: identity, what it mirrors, what it builds.
 * The repo PAT is presence only, like everywhere else.
 */
export interface ProjectSummary {
  slug: string;
  name: string;
  roots: ProjectRootSummary[];
  repoUrl: string | null;
  repoPatConfigured: boolean;
  /** What a handoff PR targets. */
  baseBranch: string;
}

export interface ProjectList {
  projects: ProjectSummary[];
  activeSlug: string | null;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  lastModified: number;
  /** True when this daemon currently holds a live query() for the session. */
  live: boolean;
  state: SessionState;
  /** Which workspace's transcript store this session came from. */
  workspace: Workspace;
  /**
   * The 기획서 this thread is about, or `null` for a thread that predates
   * page attachment or was started without one.
   */
  pageId: string | null;
}

export interface DaemonStatus {
  /**
   * Every registered project and which one everything else means. Empty on a
   * first run: the wizard's last step is creating one.
   */
  projects: ProjectSummary[];
  activeProject: string | null;
  protocolVersion: number;
  /** node's process.platform, so a bug report says which OS produced it. */
  platform: string;
  claudeVersion: string | null;
  claudeExecutable: string | null;
  /** git powers clone/pull, @-mention listing and Claude Code's Bash tool. */
  gitAvailable: boolean;
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
  email: string | null;
  /** True when ANTHROPIC_API_KEY is present, which would bill the key not the subscription. */
  apiKeyInEnv: boolean;
  liveSessions: number;
  pendingPermissions: number;
  warnings: string[];
  /** pnpm may drive the connected repo's install and preview commands. */
  pnpmAvailable: boolean;
  /**
   * Whether this machine can read @colosseumcoinckr packages from GitHub
   * Packages. Probed only when the connected repo declares a `registry`.
   */
  cdsRegistryAuth: "ok" | "unauthenticated" | "unknown";
  /**
   * The plan's rolling limits as the daemon last saw them. Cached daemon-wide
   * so the composer can show them without a session open; null until some
   * session has reported once (and for API-key sessions, which have no plan).
   */
  planUsage: PlanUsage | null;
  /**
   * The model rows the CLI offers, cached daemon-wide so the composer can
   * offer a choice before any thread exists. Empty until a session reports.
   */
  models: SessionModelInfo[];
}

/** One claude.ai plan-limit window, as the usage endpoint reports it. */
export interface PlanWindow {
  /** Percentage of the window used, 0–100. */
  utilization: number | null;
  /** ISO 8601 timestamp when the window resets. */
  resetsAt: string | null;
}

/**
 * The signed-in plan's rolling limits. Null for API-key and third-party
 * provider sessions, where plan limits do not apply.
 */
export interface PlanUsage {
  /** 'pro' | 'max' | 'team' | 'enterprise' | … */
  subscriptionType: string | null;
  fiveHour: PlanWindow | null;
  sevenDay: PlanWindow | null;
}

export interface ContextUsage {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  model: string;
  plan: PlanUsage | null;
}

/** One row of the CLI's model picker, as `supportedModels` reports it. */
export interface SessionModelInfo {
  /** Alias or id to send back to `setModel` (e.g. 'sonnet'). */
  value: string;
  displayName: string;
  /** Canonical id the alias resolves to, so a stored id still finds its row. */
  resolvedModel: string | null;
  description: string;
  supportsEffort: boolean;
  /** `null` when the row does not say — then offer every level. */
  supportedEffortLevels: EffortLevel[] | null;
}

/** What the composer's model·노력·권한 chips show and switch, per session. */
export interface SessionSelectors {
  /** Currently pinned model, or the CLI's own choice when never pinned. */
  model: string | null;
  effort: EffortLevel | null;
  permissionMode: PermissionMode;
  models: SessionModelInfo[];
}

/** One row of the composer's /command palette. */
export interface SessionCommand {
  /** Command name without the leading slash. */
  name: string;
  description: string;
  /** Argument hint, e.g. "<file>"; empty when the command takes none. */
  argumentHint: string;
  /** Alternate names that resolve to the same command. */
  aliases: string[];
}

// ---------------------------------------------------------------------------
// Connected repo workspace
// ---------------------------------------------------------------------------

/**
 * Lifecycle of the connected repo clone:
 * `missing → cloning → pulling → installing (when needed) → starting → ready`,
 * with `error` reachable from every working phase.
 */
export type RepoPhase =
  | "missing"
  | "cloning"
  | "pulling"
  | "installing"
  | "starting"
  | "ready"
  | "error";

/**
 * A pull request the planner handed to a developer (PLAN D5).
 *
 * The planner never sees the words "브랜치" or "PR": the UI reads `state` as
 * 넘김 / 변경 요청 / 반영됨. The url is here so the developer's link can be
 * copied out, not so the planner has to follow it.
 */
export interface HandoffStatus {
  number: number;
  url: string;
  title: string;
  /** `changes_requested` is a review verdict, not a PR state; GitHub reports both. */
  state: "open" | "changes_requested" | "merged" | "closed";
  /** Branch the PR is from — the same one 저장 pushes to. */
  branch: string;
  /** 기획서 pageIds named in the PR body, so the tree can badge them ✓ 넘김. */
  pageIds: string[];
}

export interface RepoStatus {
  /** Absolute path of the clone on this machine. */
  root: string;
  phase: RepoPhase;
  /** Last progress line while working, or the reason for `error`. */
  detail: string | null;
  /** Preview origin once the declared preview port accepts connections. */
  previewUrl: string | null;
  /** Port declared in the repo's `drafthouse.json`. */
  previewPort: number | null;
  /** Configured remote url, without any embedded credentials. */
  url: string | null;
  /** Whether a PAT is stored daemon-side. The value never crosses the wire. */
  patConfigured: boolean;
  /**
   * The `drafthouse/…` branch this cycle's work lives on, or `null` before the
   * first 저장 of a cycle. The base branch is never checked out for writing.
   */
  branch: string | null;
  /** What a handoff PR would target, from the project's registry entry. */
  baseBranch: string;
  /** The open (or just-merged) pull request, once 넘기기 has run. */
  handoff: HandoffStatus | null;
  /**
   * How many files in the clone differ from the last 저장 (PLAN D8).
   *
   * Counted with one `git status --porcelain` when a 화면 turn settles and when
   * a save finishes — never on a timer. It is what tells the planner's stepper
   * that there is something to save, so a number that only moved on a poll
   * would leave the button lying for up to a minute.
   */
  pendingChanges: number;
}

// ---------------------------------------------------------------------------
// Confluence sync (planning-tab mirror)
// ---------------------------------------------------------------------------

export type ConfluencePhase = "idle" | "cloning" | "pulling" | "pushing" | "error";

/** Three-way choice data for a page both sides moved (DESIGN §4.2). */
export interface ConfluenceConflict {
  pageId: string;
  title: string;
  mine: { file: string; version: number; markdown: string };
  theirs: { version: number; markdown: string };
  base: { version: number; markdown: string } | null;
}

export interface ConfluenceStatus {
  space: string | null;
  /**
   * The space's own name from Confluence ("결제 서비스"), not its raw key
   * (`~63DCB…`) — the tree leads with this and keeps the key in the tooltip.
   * Absent in engine-emitted statuses; the server decorates before sending.
   */
  spaceTitle?: string | null;
  phase: ConfluencePhase;
  pages: number;
  /** Last progress line while working, or the reason for `error`. */
  detail?: string | null;
  /** Epoch ms of the last successful clone/pull; `null` before the first one. */
  pulledAt: number | null;
  conflicts: ConfluenceConflict[];
}

/** One page 게시 would send: what changed since the last sync, as lines. */
export interface ConfluenceReviewPage {
  /** Mirror-relative path, e.g. "_63DCB…/재고 실사 목록.md". */
  path: string;
  title: string;
  pageId: string;
  /** Version Confluence holds now; `0` for a page 게시 will create. */
  version: number;
  /** What the page's version becomes after 게시. */
  nextVersion: number;
  isNew: boolean;
  /** True when 게시 would stop on this page: resolve the 충돌 first. */
  conflict: boolean;
  added: number;
  removed: number;
  /** Line diff of the body, `+`/`-`/space prefixes, capped for display. */
  diff: string;
}

/** Reply to `confluence.review`: everything 게시 would write, before it does. */
export interface ConfluenceReview {
  space: string;
  pages: ConfluenceReviewPage[];
}

/** Confluence credentials as the web may see them: token presence, not value. */
export interface ConfluenceSettings {
  siteUrl: string | null;
  email: string | null;
  apiTokenConfigured: boolean;
}

/** One remote space, as every pick UI shows it. */
export interface ConfluenceSpace {
  id: string;
  key: string;
  name: string;
}

/** Reply to `confluence.spaces`: what can be cloned, and what already is. */
export interface ConfluenceSpaceList {
  spaces: ConfluenceSpace[];
  /** Space keys with a local mirror — the ones a pick UI marks as done. */
  mirrored: string[];
}

/**
 * One REMOTE page, as the project wizard's root picker shows it. Flat with a
 * `parentId`, exactly like the mirror's own tree: the client builds the
 * hierarchy, the daemon never ships a nested shape it would have to keep in
 * sync with the mirror's.
 */
export interface ConfluencePageRef {
  id: string;
  title: string;
  parentId: string | null;
}

/** Reply to `confluence.pageTree`. */
export interface ConfluencePageTree {
  space: string;
  pages: ConfluencePageRef[];
  /** Roots already taken by a project — the picker disables these. */
  taken: string[];
}

// ---------------------------------------------------------------------------
// Planning documents (mirror pages)
// ---------------------------------------------------------------------------

export interface DocSummary {
  /** Mirror-relative path, e.g. "ENG/회원 관리 기획서.md". */
  path: string;
  title: string;
  pageId: string;
  parentPageId: string | null;
  version: number;
  /** True when the local body no longer matches the last synced hash. */
  modified: boolean;
  /** True when this page has an unresolved conflict. */
  conflict: boolean;
  /**
   * A page file that exists in the mirror but has never been pushed — a
   * planning session's new 기획서. Its `pageId` is the local `new-…`
   * placeholder until 게시 creates the remote page.
   */
  isNew: boolean;
}

export interface DocAttachment {
  filename: string;
  mediaType: string;
  /** base64 bytes; the editor turns them into data urls for display. */
  data: string;
}

export interface DocState {
  frontmatter: { pageId: string; version: number; space: string; title: string; parentPageId: string | null };
  markdown: string;
  attachments: DocAttachment[];
  conflict: ConfluenceConflict | null;
}

export interface DocSaved {
  /** The normalized markdown actually on disk now. */
  markdown: string;
  version: number;
}

export interface DocLock {
  /** Locked while a Claude turn runs, or while a client holds doc.lock. */
  locked: boolean;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Comment overlay → tool contract (DESIGN §6)
// ---------------------------------------------------------------------------

/**
 * One pinned element in the repo's preview app. The overlay runs INSIDE the
 * repo's dev server (dev only), so the repo carries a hand-synced duplicate
 * of this shape (connected-repo/src/preview-bridge/types.ts) — the two repos
 * are kept in sync by hand, and both files say so.
 */
export interface DrafthouseCommentTarget {
  /** React component display name, falling back to the tag name. */
  component: string;
  /** The element's own text (direct text nodes), trimmed and capped. */
  text: string;
  /** CSS path from the [data-screen] wrapper down to the element. */
  path: string;
  /** Viewport rect of the element at pin time. */
  rect: { x: number; y: number; width: number; height: number };
}

/** A single comment (DESIGN §6 v1: click, comment, send — nothing else). */
export interface DrafthouseComment {
  type: "drafthouse.comment";
  screen: string;
  state: string;
  element: DrafthouseCommentTarget;
  comment: string;
}

/**
 * What the preview app posts to window.parent when the planner sends the
 * batch: one envelope for all pins, then the overlay clears them.
 *
 *     { type: "drafthouse.comments", screen, state,
 *       items: [{ element, comment }, …] }
 *
 * The hub accepts it only from the preview iframe (source + origin checked).
 */
export interface DrafthouseCommentsEnvelope {
  type: "drafthouse.comments";
  screen: string;
  state: string;
  items: Array<{ element: DrafthouseCommentTarget; comment: string }>;
}

/**
 * One screen the connected repo declares, as its overlay reports it (PLAN D7).
 *
 * `spec` is a MIRROR-RELATIVE PATH, not a Confluence id: the repo names the
 * 기획서 file it was built from, and the tool resolves that against its own
 * page list. A repo that had to carry Confluence ids would be a repo that
 * breaks when a space is re-keyed, and it would make the tool's storage the
 * repo's business.
 */
export interface DrafthouseScreen {
  /** Route the preview app serves it at, e.g. `/member/MemberList`. */
  route: string;
  /** What the 기획서 calls it. */
  title: string;
  /** `?state=` variants this screen actually implements. */
  states: string[];
  /** The 기획서 this screen was built from, or null when it names none. */
  spec: string | null;
}

/**
 * What the preview app posts on load: everything it can render. The tool never
 * parses the repo's code, so this is the only way it can offer a screen picker
 * — and the only reason it can badge a 기획서 as having a screen at all.
 */
export interface DrafthouseScreensEnvelope {
  type: "drafthouse.screens";
  screens: DrafthouseScreen[];
}

/**
 * The tool asking for the list again.
 *
 * A request rather than a retry on the overlay's side: a retry window that
 * expires loses the list with no way to ask for it back, while a request can
 * only be lost while the overlay is unmounted — and the overlay's own mount
 * post then lands at a tool that is provably already listening. Every
 * ordering is covered and neither side waits on the other.
 */
export interface DrafthouseScreensRequestEnvelope {
  type: "drafthouse.screens?";
}

/**
 * The one message that goes the other way: show this route in this state.
 * Sent when the planner picks a 기획서 whose screen the repo declares, or taps
 * a state chip. The preview app routes; the tool does not touch its url.
 */
export interface DrafthouseNavigateEnvelope {
  type: "drafthouse.navigate";
  route: string;
  /** Omitted or null means the screen's default. */
  state?: string | null;
}

// ---------------------------------------------------------------------------
// Onboarding (DESIGN §8)
// ---------------------------------------------------------------------------

/**
 * Three machine-wide gates plus the project. The connected repo used to be a
 * gate of its own; it lives inside `project` now, because a machine carries
 * several and "the repo" only means something once a project says which.
 */
export type OnboardingStepId = "claude" | "git" | "confluence" | "project";
export type OnboardingStatus = "pass" | "warn" | "fail";
export type OnboardingFixKind =
  | "install-claude"
  | "login-claude"
  | "install-git"
  | "repo-install"
  | "confluence-sync";

export interface OnboardingFix {
  kind: OnboardingFixKind;
  label: string;
}

export interface OnboardingStep {
  id: OnboardingStepId;
  /** `fail` blocks the tabs; `warn` shows its reason and fix only. */
  status: OnboardingStatus;
  /** Korean: what passed, or why it failed and what to do. */
  detail: string;
  fix?: OnboardingFix;
  /** Confluence only: spaces the credentials can see, for the pick UI. */
  spaces?: ConfluenceSpace[];
}

// ---------------------------------------------------------------------------
// Publish path (diff review → gates → commit → push)
// ---------------------------------------------------------------------------

/** One `@@ …` block of a file's unified diff, header line included. */
export interface DiffHunk {
  header: string;
  lines: string[];
}

export interface DiffFile {
  /** Path relative to the repo root, forward slashes. */
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** Hunk bodies; empty for binary files. */
  hunks: DiffHunk[];
  /** True when git reported the file as binary; no hunks to show. */
  binary?: boolean;
}

/** Where a 저장 or a 넘기기 stands. Broadcast as `diff.status` while it moves. */
export interface DiffStatus {
  stage: "computing" | "gating" | "pushing" | "published" | "handing-off" | "handed-off" | "failed";
  /** Which gate is running, or which one failed. */
  gate?: "check" | "build" | "commit" | "push" | "diff" | "pr";
  /** Progress line, or the failing command's output tail when `failed`. */
  detail?: string | null;
  /** The saved commit sha, once `stage === "published"`. */
  commit?: string | null;
  /** The pull request, once `stage === "handed-off"`. */
  handoff?: HandoffStatus | null;
}

export interface PermissionSuggestion {
  destination: string;
  label: string;
  raw: unknown;
}

export interface AskQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskQuestionOption[];
  multiSelect: boolean;
}

export type ServerMessage =
  | { type: "hello"; protocolVersion: number; status: DaemonStatus }
  | { type: "ok"; id: string; data: unknown }
  | { type: "error"; id: string | null; message: string; code?: string }
  | { type: "session.event"; sessionId: string; event: ChatEvent }
  | { type: "session.state"; sessionId: string; state: SessionState; detail?: string }
  | {
      type: "permission.request";
      requestId: string;
      sessionId: string;
      toolName: string;
      input: unknown;
      suggestions: PermissionSuggestion[];
    }
  | {
      type: "question.request";
      requestId: string;
      sessionId: string;
      questions: AskQuestion[];
    }
  | { type: "status"; status: DaemonStatus }
  | { type: "repo.status"; status: RepoStatus }
  | { type: "diff.status"; status: DiffStatus }
  | { type: "confluence.status"; status: ConfluenceStatus }
  | { type: "doc.changed"; path: string }
  | { type: "doc.locked"; lock: DocLock }
  /**
   * The registry moved: a project was created, renamed, removed, or activated.
   * Every open client re-points at once — two windows on one daemon must never
   * disagree about which project they are showing.
   */
  | { type: "project.changed"; projects: ProjectSummary[]; activeSlug: string | null };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function parseClientMessage(raw: string):
  | { ok: true; value: ClientMessage }
  | { ok: false; error: string; id: string | null } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid JSON", id: null };
  }
  const id =
    json && typeof json === "object" && typeof (json as { id?: unknown }).id === "string"
      ? (json as { id: string }).id
      : null;
  const parsed = clientMessageSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), id };
  }
  return { ok: true, value: parsed.data };
}
export * from "./update.js";
export * from "./turn-marker.js";
