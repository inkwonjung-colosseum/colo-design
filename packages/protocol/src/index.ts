import { z } from "zod";

/**
 * Wire protocol between the daemon (runs on the planner's own machine,
 * drives their own Claude Code login) and the planner UI.
 *
 * Messages that mean "the repo" mean THE ACTIVE PROJECT's — one connected
 * repo. No message names a directory: the daemon resolves every path from
 * the project registry itself, which also means a client can never point a
 * session at an arbitrary folder. `project.activate` is what moves that
 * target.
 *
 * The sidebar (PLAN D16) is the one exception: `project.changed` carries
 * per-project `phase · pendingChanges · working · handoff`, so an INACTIVE
 * project's row can badge itself without the planner switching to it.
 *
 * Client -> daemon messages are validated with zod because they arrive over a
 * socket. Daemon -> client messages are produced by us, so they are plain types.
 */

export const PROTOCOL_VERSION = 11;

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
    /**
     * A name for a thread the tool is opening on the planner's behalf. The
     * first turn names an unnamed thread, so a handoff — whose first turn is
     * a sentence the tool wrote — would otherwise be titled with the file
     * path inside it.
     */
    title: z.string().min(1).max(80).optional(),
    /** Preview tools (PLAN D61) for this session. Omitted means on. */
    previewTools: z.boolean().optional(),
    /** Continue an existing thread by id. */
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
  /**
   * 되감기 (PLAN D95): discard the k-th answer and receive it again — files
   * (the turn's checkpoint) and memory (a truncating fork) go back together.
   * `turn` is the 1-based answer index; `text` is what goes out again (the
   * same words for 다시 요청, edited words for 고쳐서 다시 보내기). The reply
   * carries the NEW session id.
   */
  z.object({
    ...withId,
    type: z.literal("session.rewind"),
    sessionId: z.string().min(1),
    turn: z.number().int().positive(),
    text: z.string().min(1),
    images: z
      .array(z.object({ mediaType: z.string().min(1), data: z.string().min(1) }))
      .optional(),
  }),
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
  /**
   * The palette with no thread open. The daemon answers from its own CLI
   * probe (one boot, cached), so an empty workspace still reads like the
   * terminal's `/`.
   */
  z.object({ ...withId, type: z.literal("cli.commands") }),
  z.object({ ...withId, type: z.literal("session.contextUsage"), sessionId: z.string().min(1) }),
  z.object({
    ...withId,
    type: z.literal("repo.files"),
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
   * Registers a project and brings it up: clones the repo, installs when the
   * dependency hash moved, starts the preview command. Progress arrives as
   * `repo.status`; the reply is the created project.
   */
  z.object({
    ...withId,
    type: z.literal("project.create"),
    name: z.string().min(1).max(64),
    repoUrl: z.string().min(1).nullable(),
    /** What a handoff PR will target. Defaults to `main`. */
    baseBranch: z.string().min(1).max(128).optional(),
    /**
     * D94: the repo has no `cds-design.json` — instead of blocking on a
     * developer, Claude prepares the connection (brief turn → JSON · bridge ·
     * CLAUDE.md → machine validation) and the developer receives it as the
     * first PR.
     */
    bootstrap: z.boolean().optional(),
    /**
     * The planner saw this repo's `install`/`preview` commands and said they
     * may run on this machine. Absent means not yet approved: the workspace
     * stops after clone with errorKind `commands` until an update approves.
     */
    approveCommands: z.boolean().optional(),
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
    baseBranch: z.string().min(1).max(128).optional(),
    /** Approves this repo's commands post-hoc — the error card's button. */
    approveCommands: z.boolean().optional(),
  }),
  /**
   * Forgets a project. Its folder survives unless `deleteFiles` — unpushed
   * screen work lives in the clone, and a mis-click must not take it.
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
   * declared in `cds-design.json`. Resolves when it settles; progress arrives
   * as `repo.status`.
   */
  z.object({
    ...withId,
    type: z.literal("repo.sync"),
    /**
     * 다시 시작: when the declared preview port is already taken, kill the
     * program holding it instead of reporting. Only the error screen's
     * button sends this — a plain sync must never kill.
     */
    force: z.boolean().optional(),
  }),
  /**
   * 레포 최신화: bring the clone current with the remote without the planner
   * reading git. Unsaved work rides along (stashed, moved onto, replayed);
   * what git cannot combine by itself briefs the named session as its next
   * turn, exactly like a failing gate. Resolves with the resulting
   * `RepoStatus`.
   */
  z.object({
    ...withId,
    type: z.literal("repo.refresh"),
    /** Live thread that receives a conflict brief; absent = report only. */
    sessionId: z.string().min(1).optional(),
  }),
  /**
   * Change the connected repo's clone url. The daemon persists it and
   * re-clones when the url moved. Authentication rides on the machine-wide
   * GitHub token (`github.token.set`), never on the project.
   */
  z.object({
    ...withId,
    type: z.literal("repo.update"),
    /** Repository url; `null` clears it. */
    url: z.string().min(1).nullable().optional(),
  }),
  /** Uncommitted worktree changes vs HEAD, for the publish review panel. */
  z.object({ ...withId, type: z.literal("diff.get") }),
  /** Runs the three machine-wide onboarding checks; read-only. */
  z.object({ ...withId, type: z.literal("onboarding.check") }),
  z.object({
    ...withId,
    type: z.literal("onboarding.fix"),
    kind: z.enum(["install-claude", "login-claude", "install-git", "install-node", "install-pnpm"]),
  }),
  /**
   * 저장 (PLAN D5[넘기기]): gate, commit and push the reviewed worktree diff onto the
   * project's own `cds-design/…` branch, created on the first save of a cycle.
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
    /** PR body; the daemon proposes one naming the screens behind the work. */
    body: z.string().max(20_000).optional(),
    sessionId: z.string().min(1).optional(),
  }),
  /**
   * Re-read the open pull request from GitHub: merged, closed, or still open.
   * Asked for rather than polled — a timer would hit the API every minute for
   * a state that only moves when a human acts on it.
   */
  z.object({ ...withId, type: z.literal("repo.handoffStatus") }),
  /**
   * 저장 검토의 요약 한 번 (PLAN D51). The daemon asks Claude one turn — no
   * tools, a 3-second leash — to say what changed in planner's words, and
   * falls back to grouping the changed paths when that cannot land. Cached
   * per diff hash on the daemon, so reopening the review is free.
   */
  z.object({ ...withId, type: z.literal("repo.summarize") }),
  /**
   * 저장 기록 (PLAN D53): the cycle's commits, `git log <base>..HEAD`. This
   * is what the `저장 기록` drawer lists — messages and times, no git words.
   */
  z.object({ ...withId, type: z.literal("repo.history") }),
  /**
   * 되돌리기 (PLAN D53): bring the worktree back to a saved point as a NEW
   * commit on the cycle branch — never reset · revert · force-push, because
   * a developer may be reading that branch right now. Progress rides the
   * same `diff.status` stream a 저장 uses (`pushing → published`).
   */
  z.object({
    ...withId,
    type: z.literal("repo.restore"),
    /** A sha from `repo.history`. */
    sha: z.string().min(1),
  }),
  /**
   * 변경 버리기 (PLAN D53): throw away every unsaved worktree change — the
   * paths a 저장 would have carried, and only paths inside the clone. The
   * confirmation dialog is the UI's job; this side just refuses to reach
   * outside the repo.
   */
  z.object({ ...withId, type: z.literal("repo.discard") }),
  /**
   * The turn-start snapshots (PLAN D52): one per 화면 turn, oldest last.
   * The planner sees these as `이 답변 이전으로 되돌리기` on a turn card.
   */
  z.object({ ...withId, type: z.literal("repo.checkpoints") }),
  /**
   * Put the worktree back the way it stood when a turn started (PLAN D52).
   * Only paths the write policy allows move; files the snapshot never had
   * are removed.
   */
  z.object({
    ...withId,
    type: z.literal("repo.checkpoint.restore"),
    /** The `id` of one `repo.checkpoints` entry. */
    id: z.string().min(1),
  }),
  /**
   * Store (or clear) the machine-wide GitHub token — the one gate of the
   * onboarding list the planner answers with a value rather than an install.
   * The daemon saves it to the OS credential store and never echoes it back;
   * the reply is the recomputed `github` onboarding step.
   */
  z.object({
    ...withId,
    type: z.literal("github.token.set"),
    /** `null` forgets the stored token. */
    token: z.string().min(1).nullable(),
  }),
  /**
   * Repos the stored token can reach, most recently pushed first. Answered
   * from a short-lived cache; `refresh` re-asks GitHub. This is the project
   * picker's list, with a manual url as the fallback for what a token
   * cannot see.
   */
  z.object({
    ...withId,
    type: z.literal("github.repos.list"),
    refresh: z.boolean().optional(),
  }),
  /**
   * One repo, judged before any clone: does it carry a `cds-design.json`, may
   * this token open pull requests against it, and what branch would it target.
   */
  z.object({
    ...withId,
    type: z.literal("github.repo.inspect"),
    owner: z.string().min(1),
    repo: z.string().min(1),
  }),
  /**
   * 코멘트 기록 (PLAN D57): the pins the planner sent from the preview land
   * in the project's own `comments.json`. The set REPLACES that screen·state
   * pair's unresolved rows — the overlay re-sends what is still pinned, so a
   * re-send must not double a comment — while resolved rows stay as history.
   */
  z.object({
    ...withId,
    type: z.literal("comments.record"),
    screen: z.string().min(1),
    state: z.string().min(1),
    items: z
      .array(
        z.object({
          /** What the planner wrote. */
          text: z.string().min(1),
          /** The commented element's own text, as the overlay captured it. */
          elementText: z.string(),
          /**
           * Where the pin sat (PLAN D78): the identity the overlay resolved
           * for the element, recorded so the pin can be drawn again — the
           * comment lives on the screen, not only in this list. `text` stays
           * top-level as `elementText`; old rows without it read as
           * 자리 없는 코멘트.
           */
          element: z
            .object({
              component: z.string(),
              path: z.string(),
              rect: z.object({
                x: z.number(),
                y: z.number(),
                width: z.number(),
                height: z.number(),
              }),
            })
            .optional(),
        }),
      )
      .min(1),
  }),
  /**
   * The active project's whole comment store (PLAN D57) — the `💬 코멘트`
   * popover's list, resolved entries included: they are the history the
   * turn's pins leave behind.
   */
  z.object({ ...withId, type: z.literal("comments.list") }),
  /**
   * Toggle one comment's resolved mark (PLAN D57). The row never leaves the
   * store; this only moves it out of the 미해결 count.
   *
   * `commentId`, never `id`: the wire's `id` is the CORRELATION id every
   * reply echoes, and the client's `call` spreads the payload over its own —
   * a field named `id` here would overwrite it and the reply would land on
   * nobody (found by the desktop comments suite).
   */
  z.object({
    ...withId,
    type: z.literal("comments.resolve"),
    commentId: z.string().min(1),
    resolved: z.boolean(),
  }),
  /**
   * 답하기 (PLAN D88): the planner's answer to ONE developer comment, from
   * inside the tool. The daemon picks the endpoint by the id's cached kind —
   * an inline thread's replies, or an issue comment on the pull request.
   */
  z.object({
    ...withId,
    type: z.literal("comments.reply"),
    /** `reviewId`, never `id`: the wire's `id` is the CORRELATION id (the
        comments.resolve lesson). The developer comment's numeric id rides here. */
    reviewId: z.number(),
    body: z.string().min(1),
  }),
]);

// ---------------------------------------------------------------------------
// 코멘트 저장소 (PLAN D57)
// ---------------------------------------------------------------------------

/** One row of the project's `comments.json`, verbatim over the wire. */
export interface CommentItem {
  id: string;
  /** The screen the pin sat on, as the overlay's envelope named it. */
  screen: string;
  /** The screen state the pin sat on. */
  state: string;
  /** What the planner wrote. */
  text: string;
  /** The commented element's own text, as the overlay captured it. */
  elementText: string;
  /**
   * Where the pin sat (PLAN D78) — the recorded pin's anchor. Old rows and
   * anchorless comments have no `element`; they read as 자리 없는 코멘트.
   */
  element?: {
    component: string;
    path: string;
    rect: { x: number; y: number; width: number; height: number };
  };
  /** When the row was written, ISO 8601. */
  at: string;
  resolved: boolean;
}

/** `comments.record` — the ids the daemon just wrote, for the batch's return. */
export interface CommentsRecorded {
  recorded: number;
  /**
   * The written rows' ids, in envelope order. The sender turns them into
   * 확인해 주세요 attention at turn end — matching by id, not text, so two
   * pins with the same words stay two pins and a reworded row never lights
   * the wrong one.
   */
  ids: string[];
}

/** `comments.list` — every row, resolved included, oldest first. */
export interface CommentsList {
  items: CommentItem[];
}

/** `comments.resolve` — the mark moved; the row stayed. */
export interface CommentResolved {
  ok: true;
}

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
  /**
   * `files` holds `specs/` paths of documents that rode along with the turn.
   * `thumbs` (D87) holds the JPEG crops the view took of the pinned elements,
   * capped at six — live-only echoes the chat card draws as thumbnails; a
   * replayed transcript keeps the words, not the bytes.
   */
  | { kind: "user.echo"; text: string; images: number; files: string[]; thumbs?: string[] }
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
  | { kind: "compact"; trigger: string }
  /**
   * Claude opened a screen in the hidden preview (`screen_open`, PLAN D91).
   * Not a transcript event — `foldEvent` must NOT build a chat block from
   * it; the web keeps it as the session's `lastOpened` and follows at
   * turn end.
   */
  | { kind: "preview.opened"; route: string; state: string | null };

// ---------------------------------------------------------------------------
// Daemon -> client
// ---------------------------------------------------------------------------

/**
 * One conversation of one project, as the sidebar tree's child row shows it
 * (PLAN D59). The daemon maps the session state onto the four words the tree
 * draws; the planner's own rename rides the client's 설정, not this wire.
 */
export interface ThreadSummary {
  id: string;
  title: string;
  /** `running` a turn is on; `awaiting` a permission or question; `finished`
      a turn ended and nothing has followed it; `idle` everything else. */
  state: "running" | "awaiting" | "finished" | "idle";
  updatedAt: string;
}

/**
 * A project as the client sees it: identity, what it builds, and — for the
 * sidebar (PLAN D16) — where its clone stands right now. The per-project
 * state rides `project.changed` because `repo.status` means THE ACTIVE
 * project only; these four fields are how an inactive row earns its badge.
 */
export interface ProjectSummary {
  slug: string;
  name: string;
  repoUrl: string | null;
  /** What a handoff PR targets. */
  baseBranch: string;
  /** Disk/process state. Only the active project climbs past `ready`; an inactive cloned one reports `ready` from disk alone. */
  phase: RepoPhase;
  /** Last counted unsaved-change files — the delivery chip's number, per project. */
  pendingChanges: number;
  /** A live Claude session is running in this project's clone right now. */
  working: boolean;
  /** The open (or merged) pull request of this project's save cycle. */
  handoff: HandoffStatus | null;
  /**
   * The project's conversations, newest first (PLAN D59) — the sidebar
   * tree's children. Optional: a daemon that has not scanned this clone
   * yet omits it, and an absent key means "unknown", not "none".
   */
  threads?: ThreadSummary[];
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
  | "preparing"
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
}

/**
 * One screen capture riding a 넘기기 (PLAN D56). The daemon's server opens
 * each declared screen·state in the preview driver — a desktop host injects
 * one; the browser dev path has none — and hands the captures to the
 * workspace, which commits them under `.cds-design/shots/` and links them
 * from the pull request body's `### 화면 미리보기` section.
 */
export interface HandoffShot {
  /** Route the screen is served at, as `cds-design.screens` declared it. */
  route: string;
  /** The state the screen was captured in, as the repo declared it. */
  state: string;
  /** The capture's bytes; `Buffer` on the daemon side, `Uint8Array` here. */
  png: Uint8Array;
}

export type RepoErrorKind =
  | "clone"
  | "install"
  | "registry-auth"
  | "pnpm-missing"
  | "preview"
  | "conflict"
  | "bootstrap"
  | "commands";

export interface RepoStatus {
  /** Absolute path of the clone on this machine. */
  root: string;
  phase: RepoPhase;
  /** Last progress line while working, or the reason for `error`. */
  detail: string | null;
  /**
   * Why the clone is in `phase: "error"` — decided at the failure site by the
   * daemon, so the UI routes a fix without sniffing `detail` text (PLAN D41).
   */
  errorKind?: RepoErrorKind | null;
  /**
   * The repo's own cds-design.json commands, once read (PLAN D37): the
   * transcript matches a Bash call against these to say `검사 실행` instead of
   * printing the command line.
   */
  commands?: {
    install?: string;
    check?: string;
    build?: string;
    preview?: string;
  };
  /** Preview origin once the declared preview port accepts connections. */
  previewUrl: string | null;
  /** Port declared in the repo's `cds-design.json`. */
  previewPort: number | null;
  /** Configured remote url, without any embedded credentials. */
  url: string | null;
  /**
   * The `cds-design/…` branch this cycle's work lives on, or `null` before the
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
   * a save finishes — never on a timer. It is what tells the planner's chip
   * that there is something to save, so a number that only moved on a poll
   * would leave the button lying for up to a minute.
   */
  pendingChanges: number;
}

// ---------------------------------------------------------------------------
// Preview envelopes (PLAN D64–D69) — two contracts live here.
//
// 1. 레포 브리지 계약 (D68): `cds-design.screens`(+ `screens?`) and
//    `cds-design.navigate` are ALL a connected repo owes the tool. The repo
//    carries a hand-synced duplicate of these shapes
//    (reference clone `src/preview-bridge/types.ts`); on the desktop the
//    envelopes ride the preview preload's `window.cdsDesign.post` → IPC, in a
//    plain browser they ride postMessage with the iframe.
// 2. 도구 내부 (D67 · D69): the comments bundle, the error report and the
//    comments-mode switch are the TOOL talking to itself — the desktop's
//    preview preload makes them, the main process relays them verbatim, and
//    the web consumes them. No repo code is involved, which is the point: the
//    overlay died the day it lived in the repo.
// ---------------------------------------------------------------------------
/**
 * One pinned element in the repo's preview app, described by the tool's own
 * overlay (D67) from the DOM it shares with the page: a `data-component`
 * name or the tag, the element's own text, a CSS path from the
 * `[data-screen]` wrapper, and the viewport rect at pin time.
 */
export interface CdsDesignCommentTarget {
  /** `data-component` when the repo sets one, else the tag name. */
  component: string;
  /** The element's own text (direct text nodes), trimmed and capped. */
  text: string;
  /** CSS path from the [data-screen] wrapper down to the element. */
  path: string;
  /** Viewport rect of the element at pin time. */
  rect: { x: number; y: number; width: number; height: number };
}

/** A single comment (DESIGN §6 v1: click, comment, send — nothing else). */
export interface CdsDesignComment {
  type: "cds-design.comment";
  screen: string;
  state: string;
  element: CdsDesignCommentTarget;
  comment: string;
}

/**
 * What the tool's preview overlay (D67) hands the main process when the
 * planner sends the batch: one envelope for all pins, then the overlay
 * clears them. The main process relays it verbatim to the web
 * (`cds-preview:comments`); nothing validates it in between because both
 * ends are the tool.
 *
 *     { type: "cds-design.comments", screen, state,
 *       items: [{ element, comment }, …] }
 */
export interface CdsDesignCommentsEnvelope {
  type: "cds-design.comments";
  screen: string;
  state: string;
  items: Array<{
    element: CdsDesignCommentTarget;
    comment: string;
    /**
     * What the planner was looking at (PLAN D87): the view crops the element
     * (`element.rect`) out of the page before handing the envelope to the
     * web, which sends it on as the turn's images. Filled by the VIEW — the
     * overlay does not know it exists; absent when the capture could not run.
     */
    shot?: { mediaType: string; data: string };
  }>;
}

/**
 * One recorded pin's 해결 toggle, from the overlay's own bubble (PLAN D78).
 * Tool-internal like the pin bundle: the overlay makes it, the view relays it
 * verbatim as `cds-preview:comment-resolve`, and the web calls
 * `comments.resolve` — the daemon never learns the overlay exists.
 */
export interface CdsDesignCommentsResolveEnvelope {
  type: "cds-design.comments.resolve";
  id: string;
  resolved: boolean;
}

/**
 * One recorded pin's 다시 요청, from the attention bubble (PLAN D78): the
 * overlay asks, the view relays it verbatim as `cds-preview:comment-resend`,
 * and the web composes the turn with its own `commentToTurn` — the popover's
 * 다시 보내기 on the same line.
 */
export interface CdsDesignCommentsResendEnvelope {
  type: "cds-design.comments.resend";
  id: string;
}

/**
 * The whole recorded list the web pushes DOWN into the view (PLAN D78) —
 * `preview.pins(items)` → `cds-overlay:pins`. The overlay filters it against
 * the page's own `[data-screen]`·`[data-state]`, so a screen switch needs no
 * round trip. `attention` names the ids a just-finished turn owes a look at
 * (확인해 주세요).
 */
export interface CdsDesignPinsPayload {
  items: CommentItem[];
  attention?: string[];
}

/**
 * What the desktop reports when the screen it is showing fails (PLAN D49 →
 * D69): `console-message` errors and a crashed renderer are `runtime`, a
 * failed main-frame load is `build`. Built from the preview view's own
 * events — no repo hook involved — and sent to the web as
 * `cds-preview:error`, where the banner above the frame offers it to Claude
 * as one marker turn.
 */
export interface CdsDesignErrorEnvelope {
  type: "cds-design.error";
  /** A crash inside the page, or the build that serves it. */
  kind: "runtime" | "build";
  /** The error text, as the browser or the loader reported it. */
  message: string;
  /** The route that was up when it failed. */
  route: string;
  /** The state the screen was showing. */
  state: string;
}

/**
 * The 💬 코멘트 toggle's word to the overlay (PLAN D58 → D67): the web keeps
 * the truth and the main process re-tells the preview preload
 * (`cds-overlay:mode`). Tool-internal — the repo never sees it; the overlay
 * has no toggle of its own, so the two can never disagree.
 */
export interface CdsDesignCommentsModeEnvelope {
  type: "cds-design.comments.mode";
  on: boolean;
}

/**
 * One developer comment (PLAN D88), as 상태 확인 lists it: an inline code
 * comment or a review body — the 답하기 endpoint differs, so the kind rides
 * along. `path`·`line` are the developer's own location words; the card's
 * 자세히 is where they show (D37·D38).
 */
export interface DeveloperReview {
  id: number;
  kind: "inline" | "review";
  author: string;
  body: string;
  pr: number;
  path?: string;
  line?: number;
  at: string;
}

/** `repo.handoffStatus` — the pull request plus the developer's comments. */
export interface HandoffStatusReport extends HandoffStatus {
  reviews?: DeveloperReview[];
}

/** `comments.reply` — the answer went out under the planner's own name. */
export interface DeveloperReviewReplied {
  ok: true;
}

/** `session.rewind` — the forked (or fresh) conversation to carry on in. */
export interface SessionRewound {
  sessionId: string;
  /** True when the fork was refused and only the FILES went back (D95). */
  memoryKept: boolean;
}

/**
 * One screen the connected repo declares, as its overlay reports it (PLAN D7).
 * `spec` is the `specs/` file name of the 기획서 the screen was built from —
 * an attachment that rode along with a chat turn, committed beside the screen.
 * The repo names the file it was built from; the tool never resolves it
 * further. A repo that had to carry global document ids would break when the
 * documents move; a file name beside the screen cannot.
 */
export interface CdsDesignScreen {
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
 * — and the only reason the screen list can mark what was built from what.
 */
export interface CdsDesignScreensEnvelope {
  type: "cds-design.screens";
  screens: CdsDesignScreen[];
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
export interface CdsDesignScreensRequestEnvelope {
  type: "cds-design.screens?";
}

/**
 * The one message that goes the other way: show this route in this state.
 * Sent when the planner picks a screen in the list, or taps a state chip.
 * The preview app routes; the tool does not touch its url.
 */
export interface CdsDesignNavigateEnvelope {
  type: "cds-design.navigate";
  route: string;
  /** Omitted or null means the screen's default. */
  state?: string | null;
}

// ---------------------------------------------------------------------------
// Onboarding (DESIGN §8)
// ---------------------------------------------------------------------------

/**
 * Machine-wide gates, answered once: Claude Code, git, Node·pnpm (the runtime
 * the connected repo's install · preview · build commands run on), and the
 * GitHub token whose repo list the project picker shows. Which repo a planner
 * works on is NOT a gate — a project is added from the workspace itself, and
 * its clone reports its own progress through `repo.status`.
 */
export type OnboardingStepId = "claude" | "git" | "runtime" | "github";
export type OnboardingStatus = "pass" | "warn" | "fail";
export type OnboardingFixKind =
  | "install-claude"
  | "login-claude"
  | "install-git"
  | "install-node"
  | "install-pnpm";

export interface OnboardingFix {
  kind: OnboardingFixKind;
  label: string;
  /** Set when the fix is a link the planner follows (`install-node`): the tool installs nothing itself. */
  href?: string;
}

export interface OnboardingStep {
  id: OnboardingStepId;
  /** `fail` blocks the tabs; `warn` shows its reason and fix only. */
  status: OnboardingStatus;
  /** Korean: what passed, or why it failed and what to do. */
  detail: string;
  fix?: OnboardingFix;
}

// ---------------------------------------------------------------------------
// GitHub token, repo list, repo inspection (onboarding · project picker)
// ---------------------------------------------------------------------------

/** One repo the stored token can reach, as the project picker lists it. */
export interface GitHubRepo {
  /** `owner/name`, which is also how GitHub sorts and searches it. */
  fullName: string;
  owner: string;
  name: string;
  /** The https clone url the daemon hands to git. */
  cloneUrl: string;
  /** What a handoff PR would target. */
  defaultBranch: string;
  /** Whether this token may push — 넘기기 opens pull requests with it. */
  canPush: boolean;
  /** When the repo last moved, for the picker's most-recent-first order. */
  pushedAt: string | null;
}

export interface GitHubRepoList {
  repos: GitHubRepo[];
  /**
   * True when listing stopped at the page cap — the token can see more than
   * we showed, so the picker's search stays honest about it.
   */
  truncated: boolean;
}

/** What the picker shows about the one repo a planner chose, before cloning. */
export interface GitHubRepoInspection {
  hasCdsDesign: boolean;
  canPush: boolean;
  defaultBranch: string;
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

/** `repo.summarize` — the save review's opening lines (PLAN D51). */
export interface RepoSummary {
  /** Up to three Korean sentences, no file names. Empty when nothing changed. */
  lines: string[];
  /** Who wrote them: the one Claude turn, or the path-grouping fallback. */
  source: "claude" | "fallback";
}

/** One saved point in `repo.history` (PLAN D53). */
export interface RepoHistoryEntry {
  sha: string;
  /** The planner's own 저장 memo, verbatim. */
  message: string;
  /** Committer time, ISO 8601. */
  at: string;
  /** Files the save carried, relative to the repo root. */
  files: string[];
}

/** `repo.history` — the cycle's saves, newest first (PLAN D53). */
export interface RepoHistory {
  /** What the entries are counted against, e.g. `origin/main`. */
  base: string;
  entries: RepoHistoryEntry[];
}

/** One turn-start snapshot (PLAN D52). */
export interface RepoCheckpoint {
  /** Opaque to clients; passed back to `repo.checkpoint.restore`. */
  id: string;
  sessionId: string;
  /** The 화면 turn this snapshot was taken before, counted from 1. */
  turn: number;
  at: string;
}

export interface RepoCheckpoints {
  entries: RepoCheckpoint[];
}

export interface RepoCheckpointRestore {
  /** Paths the restore touched, relative to the repo root. */
  restored: string[];
}

export interface RepoDiscard {
  /** Unsaved changes that were thrown away, relative to the repo root. */
  removed: string[];
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
export * from "./shortcuts.js";
export * from "./update.js";
export * from "./tool-names.js";
export * from "./turn-marker.js";
