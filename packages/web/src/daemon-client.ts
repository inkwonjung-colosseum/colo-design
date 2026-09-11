import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorWords } from "./error-words";
import type {
  AskQuestion,
  ChatEvent,
  ContextUsage,
  EffortLevel,
  PermissionMode,
  DaemonStatus,
  DiffFile,
  DiffStatus,
  GitHubRepoInspection,
  GitHubRepoList,
  HandoffStatus,
  HandoffStatusReport,
  DeveloperReview,
  OnboardingFixKind,
  OnboardingStep,
  PermissionSuggestion,
  ProjectList,
  ProjectSummary,
  RepoStatus,
  ServerMessage,
  SessionCommand,
  SessionState,
  SessionSelectors,
  SessionSummary,
} from "@cds-design/protocol";

// ---------------------------------------------------------------------------
// Transcript model: ChatEvents folded into renderable blocks
// ---------------------------------------------------------------------------

export type Block =
  | {
      type: "user";
      id: string;
      text: string;
      images: number;
      files: string[];
      /** D87: the pin crops, live-echo only; a replayed transcript has none. */
      thumbs?: string[];
    }
  | { type: "text"; id: string; text: string; agentId: string | null; streaming: boolean }
  | { type: "thinking"; id: string; text: string; agentId: string | null; streaming: boolean }
  | {
      type: "tool";
      id: string;
      name: string;
      input: unknown;
      agentId: string | null;
      result?: unknown;
      isError?: boolean;
      done: boolean;
    }
  | {
      type: "turn";
      id: string;
      subtype: string;
      isError: boolean;
      costUsd: number | null;
      durationMs: number | null;
    }
  | { type: "notice"; id: string; level: "info" | "warn" | "error"; text: string };

let noticeSeq = 0;

export function foldEvent(blocks: Block[], event: ChatEvent): Block[] {
  switch (event.kind) {
    case "user.echo":
      return [
        ...blocks,
        {
          type: "user",
          id: `u${++noticeSeq}`,
          text: event.text,
          images: event.images,
          files: event.files,
          ...(event.thumbs && event.thumbs.length > 0 ? { thumbs: event.thumbs } : {}),
        },
      ];

    case "text.delta": {
      const index = blocks.findIndex((b) => b.type === "text" && b.id === event.blockId);
      if (index === -1) {
        return [
          ...blocks,
          {
            type: "text",
            id: event.blockId,
            text: event.text,
            agentId: event.agentId,
            streaming: true,
          },
        ];
      }
      const next = [...blocks];
      const current = next[index] as Extract<Block, { type: "text" }>;
      next[index] = { ...current, text: current.text + event.text };
      return next;
    }

    case "text.done": {
      const index = blocks.findIndex((b) => b.type === "text" && b.id === event.blockId);
      if (index !== -1) {
        const next = [...blocks];
        next[index] = {
          ...(next[index] as Extract<Block, { type: "text" }>),
          text: event.text,
          streaming: false,
        };
        return next;
      }
      // The block ids of the deltas and of the aggregated message can drift
      // apart — a stream that skips `message_start` has nothing to key on. The
      // API streams one text block at a time per agent, so a `done` with an
      // unfamiliar id is that streaming block under another name. Without this
      // the planner sees every sentence twice, once mid-stream and once final.
      const streaming = blocks.findLastIndex(
        (b) => b.type === "text" && b.streaming && b.agentId === event.agentId,
      );
      if (streaming !== -1) {
        const next = [...blocks];
        next[streaming] = {
          ...(next[streaming] as Extract<Block, { type: "text" }>),
          id: event.blockId,
          text: event.text,
          streaming: false,
        };
        return next;
      }
      if (!event.text.trim()) return blocks;
      return [
        ...blocks,
        { type: "text", id: event.blockId, text: event.text, agentId: event.agentId, streaming: false },
      ];
    }

    case "thinking.delta": {
      const index = blocks.findIndex((b) => b.type === "thinking" && b.id === event.blockId);
      if (index === -1) {
        return [
          ...blocks,
          { type: "thinking", id: event.blockId, text: event.text, agentId: event.agentId, streaming: true },
        ];
      }
      const next = [...blocks];
      const current = next[index] as Extract<Block, { type: "thinking" }>;
      next[index] = { ...current, text: current.text + event.text, streaming: true };
      return next;
    }

    case "tool.start":
      return [
        ...blocks,
        {
          type: "tool",
          id: event.toolUseId,
          name: event.name,
          input: event.input,
          agentId: event.agentId,
          done: false,
        },
      ];

    case "tool.end": {
      const index = blocks.findIndex((b) => b.type === "tool" && b.id === event.toolUseId);
      if (index === -1) return blocks;
      const next = [...blocks];
      next[index] = {
        ...(next[index] as Extract<Block, { type: "tool" }>),
        result: event.content,
        isError: event.isError,
        done: true,
      };
      return next;
    }

    case "turn.end": {
      // No `thinking.done` event exists: a finished turn is what settles its
      // thinking folds, so they stop reading as still-running ("생각 중").
      const settled = blocks.map((block) =>
        block.type === "thinking" && block.streaming ? { ...block, streaming: false } : block,
      );
      return [
        ...settled,
        {
          type: "turn",
          id: `t${++noticeSeq}`,
          subtype: event.subtype,
          isError: event.isError,
          costUsd: event.costUsd,
          durationMs: event.durationMs,
        },
      ];
    }

    case "retry":
      return [
        ...blocks,
        {
          type: "notice",
          id: `n${++noticeSeq}`,
          level: "warn",
          text:
            event.error === "rate_limit"
              ? `구독 사용량을 채웠습니다 — ${Math.round(event.delayMs / 1000)}초 후에 다시 시도해요 (${event.attempt}/${event.maxRetries}).`
              : `${errorWords(event.error) ?? "잠시 문제가 생겼습니다"} — ${Math.round(event.delayMs / 1000)}초 후에 다시 시도해요.`,
        },
      ];

    case "notice":
      return [
        ...blocks,
        { type: "notice", id: `n${++noticeSeq}`, level: event.level, text: event.text },
      ];

    case "compact":
      return [
        ...blocks,
        {
          type: "notice",
          id: `n${++noticeSeq}`,
          level: "info",
          text: `길어진 대화를 정리하고 이어갑니다 (${event.trigger}).`,
        },
      ];

    case "init":
    case "preview.opened":
      // D91: `preview.opened` is not a transcript event — the session view
      // keeps it as `lastOpened` (below), and no block is built. The
      // exhaustive switch is why it cannot slip through unhandled.
      return blocks;
  }
}

// ---------------------------------------------------------------------------
// Pending human-in-the-loop requests
// ---------------------------------------------------------------------------

export interface PendingPermission {
  kind: "permission";
  requestId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  suggestions: PermissionSuggestion[];
}

export interface PendingQuestion {
  kind: "question";
  requestId: string;
  sessionId: string;
  questions: AskQuestion[];
}

export type Pending = PendingPermission | PendingQuestion;

export type ConnectionState = "idle" | "connecting" | "open" | "closed" | "error";

interface SessionView {
  blocks: Block[];
  state: SessionState;
  model: string | null;
  /** True once this daemon holds a live query for the session. */
  live: boolean;
  /**
   * The screen Claude last opened in the hidden preview (PLAN D91) — the
   * truth the 따라가기 and the PiP label read, where the planner's own view
   * position used to be guessed.
   */
  lastOpened?: { route: string; state: string | null };
}

const EMPTY_SESSION: SessionView = {
  blocks: [],
  state: "idle",
  model: null,
  live: false,
};

/** Requests the UI can make. Every method resolves with the daemon's reply. */
/** PLAN D51 — the 저장 review opens with this. `claude` lines were written
    by the daemon's one-turn no-tool summary of the diff; `fallback` lines
    were counted out of the file list when that turn failed or was too slow. */
export interface DiffSummary {
  lines: string[];
  source: "claude" | "fallback";
}

/** PLAN D53 — one saved commit of the current cycle (`git log <base>..HEAD`). */
export interface SaveHistoryEntry {
  sha: string;
  message: string;
  at: number;
  files: string[];
}

export interface SaveHistory {
  base: string;
  entries: SaveHistoryEntry[];
}

/** PLAN D52 — one worktree snapshot taken when a screen turn started. */
export interface CheckpointEntry {
  id: string;
  sessionId: string;
  turn: number;
  at: number;
}

export interface CheckpointList {
  entries: CheckpointEntry[];
}

/** PLAN D57 — one recorded comment of the connected repo (`comments.json`). */
export interface CommentItem {
  id: string;
  screen: string;
  state: string;
  text: string;
  elementText: string;
  /** ISO 8601, when the daemon recorded the batch. */
  at: string;
  resolved: boolean;
}

export interface DaemonApi {
  /** Every thread of the one workspace, newest first. */
  listSessions: () => Promise<SessionSummary[]>;
  history: (sessionId: string) => Promise<ChatEvent[]>;
  /**
   * Omit `resume` for a fresh thread. `model` and `effort` carry the
   * composer's chips into the new session — the daemon otherwise starts every
   * thread on the CLI's own defaults. `previewTools` (PLAN D61) decides
   * whether the thread gets the cds-preview 도구 at all; 생략은 켬이다.
   */
  createSession: (opts?: {
    resume?: string;
    model?: string;
    effort?: EffortLevel;
    title?: string;
    previewTools?: boolean;
  }) => Promise<{ sessionId: string }>;
  send: (
    sessionId: string,
    text: string,
    images?: Array<{ mediaType: string; data: string }>,
    files?: Array<{ name: string; mediaType: string; data: string }>,
  ) => Promise<unknown>;
  interrupt: (sessionId: string) => Promise<unknown>;
  contextUsage: (sessionId: string) => Promise<ContextUsage | null>;
  /** 모델·노력·권한 chips; switches apply from the next response. */
  selectors: (sessionId: string) => Promise<SessionSelectors>;
  /** The /command palette rows. */
  commands: (sessionId: string) => Promise<SessionCommand[]>;
  /** The same palette with no thread open: the daemon's own CLI probe. */
  cliCommands: () => Promise<SessionCommand[]>;
  setModel: (sessionId: string, model: string | null) => Promise<unknown>;
  setEffort: (sessionId: string, effort: EffortLevel | null) => Promise<unknown>;
  setPermissionMode: (sessionId: string, mode: PermissionMode) => Promise<unknown>;
  /** @-mention autocomplete, over the connected repo's files. */
  findFiles: (query: string, limit?: number) => Promise<string[]>;
  closeSession: (sessionId: string) => Promise<unknown>;
  deleteSession: (sessionId: string) => Promise<unknown>;
  respondPermission: (
    requestId: string,
    decision: "allow" | "allowAlways" | "deny",
    message?: string,
  ) => Promise<unknown>;
  respondQuestion: (requestId: string, answers: Record<string, string | string[]>) => Promise<unknown>;
  refreshStatus: () => Promise<void>;
  /**
   * The registry, asked for on connect. `hello` already carries it, so the
   * switcher only needs this after a change it did not see broadcast.
   */
  projectList: () => Promise<ProjectList>;
  /**
   * Register a project and bring it up: clone the repo, install when needed,
   * start the preview. Resolves with the created project; progress arrives
   * as `repo.status`.
   */
  projectCreate: (input: {
    name: string;
    repoUrl: string | null;
    baseBranch?: string;
  }) => Promise<ProjectSummary>;
  /** Switch which project everything else means. */
  projectActivate: (slug: string) => Promise<ProjectList>;
  /** Rename, or re-point the repo url/base branch. */
  projectUpdate: (
    slug: string,
    changes: { name?: string; repoUrl?: string | null; baseBranch?: string },
  ) => Promise<ProjectList>;
  /** Forget a project; its folder survives unless `deleteFiles`. */
  projectRemove: (slug: string, deleteFiles?: boolean) => Promise<ProjectList>;
  repoStatus: () => Promise<RepoStatus>;
  /**
   * Clone when missing, pull, install when needed, start the preview. `force`
   * is the error screen's 다시 시작: kill whatever holds the declared preview
   * port before starting.
   */
  repoSync: (force?: boolean) => Promise<RepoStatus>;
  /**
   * 레포 최신화: pull the developer's merged work into the clone, with
   * unsaved changes riding along. A conflict goes to the named thread as
   * Claude's next turn.
   */
  repoRefresh: (sessionId?: string | null) => Promise<RepoStatus>;
  /** Change the connected repo's url. */
  repoUpdate: (url: string | null) => Promise<RepoStatus>;
  /** Worktree changes not saved yet, for the 저장 review panel. */
  diff: () => Promise<DiffFile[]>;
  /**
   * 저장 (PLAN D5): run the gates, then commit and push onto this cycle's own
   * `cds-design/…` branch. Progress arrives as `diff.status`.
   */
  save: (message?: string, sessionId?: string | null) => Promise<DiffStatus>;
  /**
   * 개발자에게 넘기기: the `build` gate, then open (or update) the pull request
   * for the saved branch. Progress arrives as `diff.status` like a save does.
   */
  handoff: (input: { title?: string; body?: string; sessionId?: string | null }) => Promise<DiffStatus>;
  /**
   * Re-read the handed-off request from GitHub. Asked for by the planner, never
   * polled — the state only moves when a developer acts on it.
   */
  /** 상태 확인 (PLAN D88) — the pull request plus the developer's comments. */
  handoffStatus: () => Promise<HandoffStatusReport>;
  /**
   * 저장 검토의 요약 (PLAN D51): one no-tool Claude turn over the diff,
   * answered in the planner's words. Asked once per diff, cached above this.
   */
  summarizeDiff: () => Promise<DiffSummary>;
  /**
   * 저장 기록 (PLAN D53): the saved commits of this cycle, `base` → HEAD.
   */
  saveHistory: () => Promise<SaveHistory>;
  /**
   * 되돌리기 (PLAN D53): put the worktree back to `sha` as a NEW commit — no
   * reset, no force-push; a developer may be reading the branch. Refuses
   * while unsaved changes sit in the worktree. Progress arrives as
   * `diff.status`, like a save.
   */
  restore: (sha: string) => Promise<DiffStatus>;
  /** 변경 버리기 (PLAN D53): drop unsaved changes on the allowed paths. */
  discard: () => Promise<{ removed: string[] }>;
  /** Turn-answer snapshots of this session (PLAN D52). */
  checkpoints: () => Promise<CheckpointList>;
  /** Move the worktree back to one snapshot's tree (PLAN D52). */
  restoreCheckpoint: (id: string) => Promise<{ restored: string[] }>;
  /**
   * 코멘트 기록 (PLAN D57): a pin batch lands in the project's comments.json
   * at send time. The daemon REPLACES that screen·state's unresolved items
   * with the batch — resending the same pins never duplicates, and resolved
   * history stays.
   */
  recordComments: (input: {
    screen: string;
    state: string;
    items: Array<{
      text: string;
      elementText: string;
      element?: { component: string; path: string; rect: { x: number; y: number; width: number; height: number } };
    }>;
  }) => Promise<{ recorded: number }>;
  /** Every recorded comment of the connected repo, resolved ones in. */
  listComments: () => Promise<{ items: CommentItem[] }>;
  resolveComment: (id: string, resolved: boolean) => Promise<{ ok: true }>;
  /** 답하기 (PLAN D88): the planner's answer to one developer comment. */
  replyToReview: (id: number, body: string) => Promise<{ ok: true }>;
  /** The four onboarding checks; read-only. */
  onboardingCheck: () => Promise<OnboardingStep[]>;
  /**
   * Store (or clear) the machine-wide GitHub token; resolves with the
   * recomputed `github` step.
   */
  githubTokenSet: (token: string | null) => Promise<OnboardingStep>;
  /** Repos the token can reach — the project picker's list. */
  githubReposList: (refresh?: boolean) => Promise<GitHubRepoList>;
  /** Judge one repo before any clone. */
  githubRepoInspect: (owner: string, repo: string) => Promise<GitHubRepoInspection>;
  /** Run a fix; resolves with whatever the fix returns (status/guidance). */
  onboardingFix: (kind: OnboardingFixKind) => Promise<unknown>;
}

/** One connection to one daemon, as the views consume it. */
export interface Daemon {
  connection: ConnectionState;
  connectionError: string | null;
  status: DaemonStatus | null;
  /**
   * Every registered project, and which one everything else means. Seeded
   * from `hello`, re-pointed by `project.changed` — two windows on one daemon
   * must never disagree about what they are showing.
   */
  projects: ProjectSummary[];
  activeSlug: string | null;
  sessions: Record<string, SessionView>;
  pending: Pending[];
  api: DaemonApi;
  /** Connected repo state; null until the daemon has reported it once. */
  repo: RepoStatus | null;
  /**
   * Where the current 저장 or 넘기기 stands; null until one starts. Both share
   * one channel — the daemon runs one at a time against one clone.
   */
  diffStatus: DiffStatus | null;
  /** Latest onboarding checks; null until first check returns. */
  onboarding: OnboardingStep[] | null;
  resolvePending: (requestId: string) => void;
  ensureSession: (sessionId: string) => void;
  hydrate: (sessionId: string, events: ChatEvent[]) => void;
  markLive: (sessionId: string) => void;
}

// ---------------------------------------------------------------------------
// Background-thread notifications (PLAN D50) — the web path of the desktop's
// Electron notices. The daemon knows nothing of windows here, so the client
// watches the session map itself and decides from the transition.
// ---------------------------------------------------------------------------

/** Asked once, after the planner's first send — never again (D50). */
const NOTIFICATION_ASKED_KEY = "cds-design.notification-asked";

/**
 * The desktop asks nothing and notifies from its own main process (D50
 * names this the BROWSER path); a second voice would ring twice.
 */
function requestNotificationPermissionOnce(): void {
  if (typeof Notification === "undefined" || window.cdsDesignDesktop) return;
  try {
    if (localStorage.getItem(NOTIFICATION_ASKED_KEY)) return;
    localStorage.setItem(NOTIFICATION_ASKED_KEY, "1");
    void Notification.requestPermission();
  } catch {
    // Storage can be blocked (private mode, embedded views); no ask, no harm.
  }
}

/**
 * The one notification's copy, worded like the desktop's notices (D50): the
 * thread's name is the title, the body says what to check once the window
 * is open.
 */
function backgroundNotice(
  title: string,
  state: SessionState,
): { title: string; body: string } | null {
  switch (state) {
    case "idle":
      return { title: `${title} · 완료`, body: "Claude가 답을 마쳤습니다. 열어서 확인해 보세요." };
    case "error":
      return { title: `${title} · 중단`, body: "Claude가 중단됐습니다. 대화에서 이유를 확인할 수 있습니다." };
    case "waiting_permission":
      return { title: `${title} · 확인 필요`, body: "Claude가 진행 허락을 기다리고 있습니다." };
    case "waiting_question":
      return { title: `${title} · 답 필요`, body: "Claude가 질문에 대한 답을 기다리고 있습니다." };
    default:
      return null;
  }
}

/**
 * A background thread finished or started waiting: look its name up and
 * raise the browser notification. Permission never granted (or a browser
 * without the API) makes this a no-op — the in-app strip still tells the
 * story.
 */
async function notifyBackgroundThread(
  findTitle: (sessionId: string) => Promise<string | null>,
  sessionId: string,
  state: SessionState,
): Promise<void> {
  if (typeof Notification === "undefined" || window.cdsDesignDesktop) return;
  if (Notification.permission !== "granted") return;
  const stored = await findTitle(sessionId).catch(() => null);
  const notice = backgroundNotice(stored ?? "대화", state);
  if (!notice) return;
  try {
    new Notification(notice.title, { body: notice.body });
  } catch {
    // Some browsers gate the constructor behind a service worker; the strip
    // is the fallback there too.
  }
}

export function useDaemon(url: string | null): Daemon {
  const socket = useRef<WebSocket | null>(null);
  const pendingCalls = useRef(new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>());
  const counter = useRef(0);

  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Record<string, SessionView>>({});
  const [pending, setPending] = useState<Pending[]>([]);
  const [repo, setRepo] = useState<RepoStatus | null>(null);
  const [diffStatus, setDiffStatus] = useState<DiffStatus | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingStep[] | null>(null);
  /**
   * The thread the planner is looking at: the last one they opened or spoke
   * into. A DIFFERENT thread settling is what a notification is for (D50);
   * the one on screen settles where they can see it.
   */
  const watched = useRef<string | null>(null);
  /** The states at the previous pass — the transition is the event. */
  const prevStates = useRef<Record<string, SessionState>>({});

  useEffect(() => {
    if (!url) return;
    setConnection("connecting");
    setConnectionError(null);

    let ws: WebSocket | null = null;
    let disposed = false;
    let everOpen = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const flushPending = () => {
      for (const call of pendingCalls.current.values()) call.reject(new Error("연결이 끊어졌습니다 — 다시 연결하는 중"));
      pendingCalls.current.clear();
    };

    const connect = () => {
      if (disposed) return;
      setConnection("connecting");
      let sock: WebSocket;
      try {
        sock = new WebSocket(url);
      } catch (error) {
        setConnection("error");
        setConnectionError(error instanceof Error ? error.message : "invalid daemon url");
        return;
      }
      ws = sock;
      socket.current = sock;

      sock.onopen = () => {
        if (disposed) {
          sock.close();
          return;
        }
        everOpen = true;
        attempt = 0;
        setConnection("open");
      };
      sock.onerror = () => {
        // A dead socket always closes right after; the reconnect decision
        // lives in onclose so nothing has to be duplicated here.
      };
      sock.onclose = () => {
        socket.current = null;
        if (disposed) return;
        flushPending();
        if (!everOpen) {
          // First attempt never got in: most likely a wrong url or the daemon
          // is genuinely down. Show the connect screen; the retry below still
          // brings the app back if the daemon appears afterwards.
          setConnection("error");
          setConnectionError("Could not reach the daemon. Is it running?");
        }
        const delay = Math.min(1000 * 2 ** attempt, 5000);
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      };

      sock.onmessage = handleMessage;
    };

    const handleMessage = (raw: MessageEvent) => {
      const message = JSON.parse(raw.data as string) as ServerMessage;

      if (message.type === "ok" || message.type === "error") {
        const call = pendingCalls.current.get(message.id ?? "");
        if (call) {
          pendingCalls.current.delete(message.id!);
          if (message.type === "ok") call.resolve(message.data);
          else call.reject(new Error(message.message));
        }
        return;
      }

      if (message.type === "hello" || message.type === "status") {
        setStatus(message.status);
        // Status carries the registry, so a reconnect re-points the switcher
        // without a round trip of its own.
        setProjects(message.status.projects);
        setActiveSlug(message.status.activeProject);
        return;
      }

      if (message.type === "project.changed") {
        setProjects(message.projects);
        setActiveSlug(message.activeSlug);
        return;
      }

      if (message.type === "repo.status") {
        setRepo(message.status);
        return;
      }

      if (message.type === "diff.status") {
        setDiffStatus(message.status);
        return;
      }

      if (message.type === "session.event") {
        setSessions((prev) => {
          const view = prev[message.sessionId] ?? EMPTY_SESSION;
          const next: SessionView =
            message.event.kind === "init"
              ? { ...view, model: message.event.model }
              : message.event.kind === "preview.opened"
                ? // D91: the screen Claude is actually looking at — kept
                  // beside the view, not in the transcript.
                  { ...view, lastOpened: { route: message.event.route, state: message.event.state } }
                : { ...view, blocks: foldEvent(view.blocks, message.event) };
          return { ...prev, [message.sessionId]: next };
        });
        return;
      }

      if (message.type === "session.state") {
        setSessions((prev) => ({
          ...prev,
          [message.sessionId]: { ...(prev[message.sessionId] ?? EMPTY_SESSION), state: message.state },
        }));
        return;
      }

      if (message.type === "permission.request") {
        const entry: PendingPermission = {
          kind: "permission",
          requestId: message.requestId,
          sessionId: message.sessionId,
          toolName: message.toolName,
          input: message.input,
          suggestions: message.suggestions,
        };
        setPending((prev) => [...prev, entry]);
        return;
      }

      if (message.type === "question.request") {
        const entry: PendingQuestion = {
          kind: "question",
          requestId: message.requestId,
          sessionId: message.sessionId,
          questions: message.questions,
        };
        setPending((prev) => [...prev, entry]);
      }
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (ws) {
        ws.onclose = null;
        ws.onmessage = null;
        ws.close();
      }
      socket.current = null;
    };
  }, [url]);

  const call = useCallback(<T,>(payload: Record<string, unknown>, timeoutMs = 60_000): Promise<T> => {
    const ws = socket.current;
    if (!ws || ws.readyState !== ws.OPEN) return Promise.reject(new Error("아직 연결되지 않았습니다"));
    const id = `c${++counter.current}`;
    return new Promise<T>((resolve, reject) => {
      pendingCalls.current.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ id, ...payload }));
      setTimeout(() => {
        if (pendingCalls.current.delete(id)) reject(new Error("daemon did not respond"));
      }, timeoutMs);
    });
  }, []);

  /** Keep the reply of a repo request as state, so a caller gets both. */
  const keepRepo = useCallback((next: RepoStatus) => {
    setRepo(next);
    return next;
  }, []);

  /**
   * Keep a registry reply as state. The reply and its `project.changed`
   * broadcast race, and whichever lands second carries the same registry.
   */
  const keepProjects = useCallback((next: ProjectList) => {
    setProjects(next.projects);
    setActiveSlug(next.activeSlug);
    return next;
  }, []);

  const api = useMemo<DaemonApi>(
    () => ({
      listSessions: () => call<SessionSummary[]>({ type: "session.list" }),
      history: (sessionId: string) => call<ChatEvent[]>({ type: "session.history", sessionId }),
      createSession: (opts?: {
        resume?: string;
        model?: string;
        effort?: EffortLevel;
        title?: string;
        previewTools?: boolean;
      }) =>
        call<{ sessionId: string }>({
          type: "session.create",
          ...(opts?.resume ? { resume: opts.resume } : {}),
          ...(opts?.model ? { model: opts.model } : {}),
          ...(opts?.effort ? { effort: opts.effort } : {}),
          ...(opts?.title ? { title: opts.title } : {}),
          // false is the meaningful value, so it rides even when every other
          // field is absent — `previewTools === undefined` is the only skip.
          ...(opts?.previewTools === undefined ? {} : { previewTools: opts.previewTools }),
        }),
      send: (
        sessionId: string,
        text: string,
        images?: Array<{ mediaType: string; data: string }>,
        files?: Array<{ name: string; mediaType: string; data: string }>,
      ) => {
        // Speaking into a thread is looking at it (D50), and the first send
        // is the one moment the browser may ask about notifications.
        watched.current = sessionId;
        requestNotificationPermissionOnce();
        return call({
          type: "session.send",
          sessionId,
          text,
          ...(images?.length ? { images } : {}),
          ...(files?.length ? { files } : {}),
        });
      },
      interrupt: (sessionId: string) => call({ type: "session.interrupt", sessionId }),
      contextUsage: (sessionId: string) =>
        call<ContextUsage | null>({ type: "session.contextUsage", sessionId }),
      selectors: (sessionId: string) => call<SessionSelectors>({ type: "session.selectors", sessionId }),
      commands: (sessionId: string) => call<SessionCommand[]>({ type: "session.commands", sessionId }),
      cliCommands: () =>
        call<SessionCommand[]>(
          { type: "cli.commands" },
          // The probe boots the CLI once — seconds, not the usual round trip.
          60_000,
        ),
      findFiles: (query: string, limit = 40) => call<string[]>({ type: "repo.files", query, limit }),
      setModel: (sessionId: string, model: string | null) =>
        call({ type: "session.setModel", sessionId, model }),
      setEffort: (sessionId: string, effort: EffortLevel | null) =>
        call({ type: "session.setEffort", sessionId, effort }),
      setPermissionMode: (sessionId: string, mode: PermissionMode) =>
        call({ type: "session.setPermissionMode", sessionId, mode }),
      respondPermission: (requestId: string, decision: "allow" | "allowAlways" | "deny", message?: string) =>
        call({ type: "permission.respond", requestId, decision, message }),
      closeSession: (sessionId: string) => call({ type: "session.close", sessionId }),
      deleteSession: (sessionId: string) =>
        call(
          { type: "session.delete", sessionId },
          // A stored transcript is removed with the session.
          120_000,
        ),
      respondQuestion: (requestId: string, answers: Record<string, string | string[]>) =>
        call({ type: "question.respond", requestId, answers }),
      refreshStatus: () => call<DaemonStatus>({ type: "daemon.status" }).then(setStatus),
      projectList: () => call<ProjectList>({ type: "project.list" }).then(keepProjects),
      // Creating clones the repo and installs when needed: a first run is
      // minutes, not the minute a normal request gets.
      projectCreate: (input: {
        name: string;
        repoUrl: string | null;
        baseBranch?: string;
      }) =>
        call<ProjectSummary>(
          {
            type: "project.create",
            name: input.name,
            repoUrl: input.repoUrl,
            ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
          },
          900_000,
        ),
      // Activating stops one preview server and starts another, and the
      // incoming project may still need its clone or install.
      projectActivate: (slug: string) =>
        call<ProjectList>({ type: "project.activate", slug }, 600_000).then(keepProjects),
      projectUpdate: (
        slug: string,
        changes: { name?: string; repoUrl?: string | null; baseBranch?: string },
      ) =>
        call<ProjectList>(
          {
            type: "project.update",
            slug,
            ...(changes.name !== undefined ? { name: changes.name } : {}),
            ...(changes.repoUrl !== undefined ? { repoUrl: changes.repoUrl } : {}),
            ...(changes.baseBranch !== undefined ? { baseBranch: changes.baseBranch } : {}),
          },
          // A moved url re-clones.
          600_000,
        ).then(keepProjects),
      projectRemove: (slug: string, deleteFiles?: boolean) =>
        call<ProjectList>(
          { type: "project.remove", slug, ...(deleteFiles ? { deleteFiles } : {}) },
          120_000,
        ).then(keepProjects),
      repoStatus: () => call<RepoStatus>({ type: "repo.status" }).then(keepRepo),
      // A first run clones and installs the connected repo: minutes, not the
      // minute a normal request is given before it is declared lost. `force`
      // rides only the stopped screen's 다시 시작.
      repoSync: (force = false) =>
        call<RepoStatus>({ type: "repo.sync", ...(force ? { force: true } : {}) }, 600_000).then(keepRepo),
      // A refresh is one fetch-and-merge on the clone: the window a network
      // read gets, not the minutes a first clone or install takes.
      repoRefresh: (sessionId?: string | null) =>
        call<RepoStatus>(
          { type: "repo.refresh", ...(sessionId ? { sessionId } : {}) },
          120_000,
        ).then(keepRepo),
      repoUpdate: (url: string | null) =>
        call<RepoStatus>({ type: "repo.update", url }, 600_000).then(keepRepo),
      diff: () => call<DiffFile[]>({ type: "diff.get" }, 120_000),
      // A save runs the repo's own check and build before pushing: the
      // same minutes a first sync is given.
      save: (message?: string, sessionId?: string | null) =>
        call<DiffStatus>(
          {
            type: "repo.save",
            ...(message ? { message } : {}),
            ...(sessionId ? { sessionId } : {}),
          },
          600_000,
        ),
      // A handoff is a gate plus a network write: the repo's `build` runs
      // first, and only then does the pull request go out. Same window as a
      // save, because the gate is the slow half of both.
      handoff: (input: { title?: string; body?: string; sessionId?: string | null }) =>
        call<DiffStatus>(
          {
            type: "repo.handoff",
            ...(input.title ? { title: input.title } : {}),
            ...(input.body ? { body: input.body } : {}),
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          },
          600_000,
        ),
      githubTokenSet: (token: string | null) =>
        call<OnboardingStep>({ type: "github.token.set", token }, 60_000).then((step) => {
          // The reply is one gate; fold it into the wizard's list in place.
          setOnboarding((prev) =>
            prev ? prev.map((entry) => (entry.id === step.id ? step : entry)) : [step],
          );
          return step;
        }),
      // Listing walks up to five pages of GitHub: the window a few network
      // reads get, not the one a local request does.
      githubReposList: (refresh?: boolean) =>
        call<GitHubRepoList>(
          { type: "github.repos.list", ...(refresh ? { refresh } : {}) },
          120_000,
        ),
      githubRepoInspect: (owner: string, repo: string) =>
        call<GitHubRepoInspection>({ type: "github.repo.inspect", owner, repo }, 60_000),
      // One read of one pull request — no gate, no push. The window a remote
      // read gets, not the one a transfer does.
      handoffStatus: () => call<HandoffStatusReport>({ type: "repo.handoffStatus" }, 120_000),
      // The summary runs one short Claude turn on the daemon: the window a
      // generation gets, not the minutes a gate takes.
      summarizeDiff: () => call<DiffSummary>({ type: "repo.summarize" }, 120_000),
      saveHistory: () => call<SaveHistory>({ type: "repo.history" }, 60_000),
      // A restore commits and pushes, and the repo's checks may run on the
      // way: the same window a save is given.
      restore: (sha: string) => call<DiffStatus>({ type: "repo.restore", sha }, 600_000),
      discard: () => call<{ removed: string[] }>({ type: "repo.discard" }, 120_000),
      checkpoints: () => call<CheckpointList>({ type: "repo.checkpoints" }, 60_000),
      restoreCheckpoint: (id: string) =>
        call<{ restored: string[] }>({ type: "repo.checkpoint.restore", id }, 120_000),
      recordComments: (input: {
        screen: string;
        state: string;
        items: Array<{
          text: string;
          elementText: string;
          element?: { component: string; path: string; rect: { x: number; y: number; width: number; height: number } };
        }>;
      }) =>
        call<{ recorded: number }>({
          type: "comments.record",
          screen: input.screen,
          state: input.state,
          items: input.items,
        }),
      listComments: () => call<{ items: CommentItem[] }>({ type: "comments.list" }),
      resolveComment: (id: string, resolved: boolean) =>
        call<{ ok: true }>({ type: "comments.resolve", commentId: id, resolved }),
      replyToReview: (id: number, body: string) =>
        call<{ ok: true }>({ type: "comments.reply", reviewId: id, body }, 60_000),
      onboardingCheck: () =>
        call<OnboardingStep[]>({ type: "onboarding.check" }, 120_000).then((steps) => {
          setOnboarding(steps);
          return steps;
        }),
      onboardingFix: (kind: OnboardingFixKind) =>
        call(
          { type: "onboarding.fix", kind },
          // install-pnpm runs corepack to completion; the others only
          // launch an installer or a login window.
          600_000,
        ),
    }),
    [call, keepProjects, keepRepo],
  );

  // PLAN D50: a background thread that finished its turn — or stopped to
  // ask — calls. Derived from the session map, so a reconnect that replays
  // the same states fires nothing: the transition is the event.
  useEffect(() => {
    const next: Record<string, SessionState> = {};
    for (const [sessionId, view] of Object.entries(sessions)) {
      next[sessionId] = view.state;
      if (
        prevStates.current[sessionId] === "running" &&
        view.state !== "running" &&
        sessionId !== watched.current
      ) {
        void notifyBackgroundThread(
          (id) =>
            call<SessionSummary[]>({ type: "session.list" }).then(
              (list) => list.find((session) => session.sessionId === id)?.title ?? null,
            ),
          sessionId,
          view.state,
        );
      }
    }
    prevStates.current = next;
  }, [sessions, call]);

  const resolvePending = useCallback((requestId: string) => {
    setPending((prev) => prev.filter((p) => p.requestId !== requestId));
  }, []);

  const ensureSession = useCallback((sessionId: string) => {
    setSessions((prev) => (prev[sessionId] ? prev : { ...prev, [sessionId]: EMPTY_SESSION }));
  }, []);

  /** Replace a session's transcript with a stored one, without resuming it. */
  const hydrate = useCallback((sessionId: string, events: ChatEvent[]) => {
    setSessions((prev) => ({
      ...prev,
      [sessionId]: {
        ...(prev[sessionId] ?? EMPTY_SESSION),
        blocks: events.reduce<Block[]>(foldEvent, []),
      },
    }));
  }, []);

  const markLive = useCallback((sessionId: string) => {
    watched.current = sessionId;
    setSessions((prev) => ({
      ...prev,
      [sessionId]: { ...(prev[sessionId] ?? EMPTY_SESSION), live: true },
    }));
  }, []);

  return {
    connection,
    connectionError,
    status,
    projects,
    activeSlug,
    sessions,
    pending,
    api,
    resolvePending,
    ensureSession,
    hydrate,
    markLive,
    repo,
    diffStatus,
    onboarding,
  };
}

export { EMPTY_SESSION };
export type { SessionView };
