import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ContextUsage,
  EffortLevel,
  PermissionMode,
  SessionCommand,
  SessionModelInfo,
  SessionSelectors,
  SessionSummary,
} from "@cds-design/protocol";
import { EMPTY_SESSION, type Daemon, type SessionView } from "./daemon-client";
import type { Attachment } from "./Composer";
import { settleTransitions } from "./session-activity";
import { loadModelCatalog, saveModelCatalog, type ChatSettings } from "./settings";

/** The chat state of the one workspace, as its views consume it. */
export interface Sessions {
  /** Stored + live threads of this workspace, newest first. */
  list: SessionSummary[];
  activeId: string | null;
  /** Transcript of the active thread; null when none is open. */
  active: SessionView | null;
  running: boolean;
  /**
   * Threads whose turn ended while this one was not the open tab. The strip
   * marks them until the planner looks; a live dot that simply vanishes says
   * "finished" and "never ran" with the same pixel.
   */
  finished: string[];
  usage: ContextUsage | null;
  /**
   * 모델·추론·권한 chips. Always present: until a session can answer, the
   * chips report the stored choice this workspace will start its next session
   * with, so they can be set before the workspace is even connected.
   */
  selector: SessionSelectors;
  /** The /command palette rows of the active thread. */
  commands: SessionCommand[];
  setModel: (model: string | null) => Promise<void>;
  setEffort: (effort: EffortLevel | null) => Promise<void>;
  setPermissionMode: (mode: PermissionMode) => Promise<void>;
  error: string | null;
  setError: (error: string | null) => void;
  /** Open a thread from the list, hydrating its stored transcript. */
  open: (summary: SessionSummary) => Promise<void>;
  /**
   * Start a thread and open it. Resolves with its id — the shell needs it to
   * make the new tab the selected one, and React state cannot be read back
   * the instant after this returns.
   *
   * `title` names a thread the TOOL is opening (the 화면 handoff): its first
   * turn is a sentence this app wrote, so letting that turn name the thread
   * puts a file path in the tab strip.
   */
  create: (title?: string) => Promise<string | null>;
  /** Delete a stored thread for good. */
  remove: (session: SessionSummary) => Promise<void>;
  submit: (text: string, attachments: Attachment[]) => Promise<void>;
  /** Machine-authored turn: no composer, no attachments. */
  sendTurn: (text: string) => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * The chat state of the one workspace: its thread list, its active thread,
 * its error line. There is a single session axis now (PLAN D1) — every thread
 * is about screens — so there is exactly one of these per connection.
 *
 * `ready` is the connected repo being prepared: the daemon needs a clone
 * before it can give Claude a cwd to write screens into.
 */
export function useSessions(
  daemon: Daemon,
  opts: {
    ready: boolean;
    confirmBeforeDelete: boolean;
    /**
     * How Claude answers, as 설정 holds it (PLAN D10). Owned above this hook:
     * the same three values drive the settings dialog, and two copies of
     * "which model" would disagree the first time one of them was edited.
     */
    chat: ChatSettings;
    onChatChange: (patch: Partial<ChatSettings>) => void;
  },
): Sessions {
  const { connection, api, sessions, ensureSession, hydrate, markLive } = daemon;
  const { ready, confirmBeforeDelete, chat, onChatChange } = opts;

  const [list, setList] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  const [selector, setSelector] = useState<SessionSelectors | null>(null);
  const [commands, setCommands] = useState<SessionCommand[]>([]);
  const [catalog, setCatalog] = useState<SessionModelInfo[]>(loadModelCatalog);
  const [error, setError] = useState<string | null>(null);

  const active = activeId ? (sessions[activeId] ?? EMPTY_SESSION) : null;
  const running = active?.state === "running";

  /**
   * A turn that ended somewhere the planner was not looking. Tracked over the
   * whole session map rather than this page's list, so a thread that settles
   * while another page is open is still marked when the planner comes back.
   * Opening the thread is what clears it — that is what "seen" means here.
   */
  const [finished, setFinished] = useState<string[]>([]);
  const wasRunning = useRef<Record<string, boolean>>({});
  useEffect(() => {
    const states = Object.fromEntries(
      Object.entries(sessions).map(([sessionId, view]) => [sessionId, view.state]),
    );
    const { running: next, settled } = settleTransitions(wasRunning.current, states, activeId);
    wasRunning.current = next;
    if (settled.length === 0) return;
    setFinished((prev) => [...new Set([...prev, ...settled])]);
  }, [sessions, activeId]);
  useEffect(() => {
    if (!activeId) return;
    setFinished((prev) => (prev.includes(activeId) ? prev.filter((id) => id !== activeId) : prev));
  }, [activeId]);

  const refresh = useCallback(async () => {
    setList(await api.listSessions().catch(() => [] as SessionSummary[]));
  }, [api]);

  /**
   * Every path that opens a thread goes through here, so a new session starts
   * on the chips the planner has set rather than the CLI's defaults. Those
   * values are read from a ref: this callback must keep a stable identity, or
   * changing a chip while the first session is still being created would run
   * the create effect again and open a second thread.
   */
  const startRef = useRef({ chat });
  startRef.current = { chat };

  const startSession = useCallback(
    async (resume?: string, title?: string): Promise<string> => {
      const { chat: picked } = startRef.current;
      const { sessionId } = await api.createSession({
        ...(resume ? { resume } : {}),
        ...(picked.model ? { model: picked.model } : {}),
        ...(picked.effort ? { effort: picked.effort } : {}),
        ...(title ? { title } : {}),
      });
      ensureSession(sessionId);
      markLive(sessionId);
      setActiveId(sessionId);
      // Not a create option — the mode has to be applied to the live session.
      if (picked.permissionMode !== "default") {
        await api.setPermissionMode(sessionId, picked.permissionMode);
      }
      return sessionId;
    },
    [api, ensureSession, markLive],
  );

  useEffect(() => {
    if (connection !== "open" || !ready) return;
    void refresh();
  }, [connection, ready, refresh]);

  // The thread list is the active project's, so a switch that kept the old
  // project's tabs left a clickable conversation the daemon would answer in
  // the wrong clone. Clear both the list and the open thread; `ready` rarely
  // flips on a switch between two prepared repos, so this is the only
  // reliable trigger.
  const activeSlug = daemon.activeSlug;
  const listedSlug = useRef(activeSlug);
  useEffect(() => {
    if (listedSlug.current === activeSlug) return;
    listedSlug.current = activeSlug;
    setActiveId(null);
    setList([]);
    if (connection === "open") void refresh();
  }, [activeSlug, connection, refresh]);

  // Nothing is created just because the app opened: an empty thread the
  // planner never typed into is noise in their list. The first message (or
  // the 새 대화 button) is what starts one.

  // Context usage only moves when a turn finishes, so read it on settle
  // instead of polling.
  useEffect(() => {
    if (!activeId || running) return;
    let cancelled = false;
    void api
      .contextUsage(activeId)
      .then((next) => !cancelled && setUsage(next))
      .catch(() => undefined);
    void api
      .selectors(activeId)
      .then((next) => {
        if (cancelled) return;
        setSelector(next);
        // The model list belongs to the CLI and only a live session can be
        // asked for it; keep it so the chip still offers real rows next time
        // the app opens against a workspace that is not connected yet.
        if (next.models.length > 0) {
          setCatalog(next.models);
          saveModelCatalog(next.models);
        }
      })
      .catch(() => {
        if (!cancelled) setSelector(null);
      });
    // The palette comes from the session's own CLI, which answers only once
    // its query is up; one retry covers that boot window without polling.
    const loadCommands = (attempt: number) => {
      void api
        .commands(activeId)
        .then((next) => !cancelled && setCommands(next))
        .catch(() => {
          if (!cancelled && attempt === 0) setTimeout(() => loadCommands(1), 1500);
        });
    };
    loadCommands(0);
    return () => {
      cancelled = true;
    };
  }, [activeId, running, api, active?.blocks.length]);

  /**
   * A session nobody typed into wrote no transcript. Close it on the way out,
   * or the list fills with empty threads every time the planner switches away
   * from the one that was opened for them.
   */
  const discardIfUnused = useCallback(
    (sessionId: string | null) => {
      if (!sessionId) return;
      const view = sessions[sessionId];
      if (!view || !view.live || view.blocks.length > 0) return;
      void api.closeSession(sessionId).catch(() => undefined);
    },
    [api, sessions],
  );

  const open = async (summary: SessionSummary) => {
    if (summary.sessionId !== activeId) discardIfUnused(activeId);
    ensureSession(summary.sessionId);
    setActiveId(summary.sessionId);
    if (summary.live) markLive(summary.sessionId);
    try {
      hydrate(summary.sessionId, await api.history(summary.sessionId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const create = async (title?: string): Promise<string | null> => {
    discardIfUnused(activeId);
    try {
      const sessionId = await startSession(undefined, title);
      void refresh();
      return sessionId;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  };

  /** Permanently delete a stored thread. Confirms first unless turned off. */
  const remove = async (session: SessionSummary) => {
    if (
      confirmBeforeDelete &&
      !window.confirm(`"${session.title}" 대화를 삭제할까요? 대화 기록이 영구히 사라집니다.`)
    )
      return;
    if (activeId === session.sessionId) setActiveId(null);
    try {
      await api.deleteSession(session.sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    void refresh();
  };

  /** Resolve the session a turn should land in, creating or resuming as needed. */
  const targetSession = async (): Promise<string> => {
    if (!activeId) return await startSession();
    // A stored thread the planner picked from the list: continue it in place.
    // Forking is a developer's concern, not theirs.
    if (active && !active.live) return await startSession(activeId);
    ensureSession(activeId);
    markLive(activeId);
    return activeId;
  };

  const submit = async (text: string, attachments: Attachment[]) => {
    try {
      const target = await targetSession();
      await api.send(
        target,
        text,
        attachments
          .filter((a) => a.kind === "image")
          .map(({ mediaType, data }) => ({ mediaType, data })),
        attachments
          .filter((a) => a.kind === "document")
          .map(({ name, mediaType, data }) => ({ name, mediaType, data })),
      );
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * A machine-authored turn (the comment envelope): the same wire a typed
   * message uses, minus the composer.
   */
  const sendTurn = async (text: string) => {
    try {
      const target = activeId ?? (await startSession());
      await api.send(target, text);
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * Composer chips. The local state flips immediately (a chip that waits a
   * round trip feels broken); the next settle re-reads the daemon's truth.
   * With no session open the pick is still real — it is what the next session
   * will be created with.
   */
  const switchModel = async (model: string | null) => {
    onChatChange({ model });
    setSelector((prev) => (prev ? { ...prev, model } : prev));
    if (!activeId) return;
    try {
      await api.setModel(activeId, model);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const switchEffort = async (effort: EffortLevel | null) => {
    onChatChange({ effort });
    setSelector((prev) => (prev ? { ...prev, effort } : prev));
    if (!activeId) return;
    try {
      await api.setEffort(activeId, effort);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * 설정 can change these while a thread is open, and the daemon keeps a copy
   * per session — so a choice made in the dialog has to reach the live thread
   * too. Without this a planner sets 화면 수정은 바로 and keeps getting cards
   * in the very conversation they set it for.
   *
   * Keyed on the VALUES, not on the session: opening another thread must not
   * re-push settings `startSession` already carried at create time.
   */
  const pushed = useRef<ChatSettings | null>(null);
  useEffect(() => {
    const last = pushed.current;
    pushed.current = chat;
    if (!activeId || !last) return;
    const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
    if (last.model !== chat.model) void api.setModel(activeId, chat.model).catch(fail);
    if (last.effort !== chat.effort) void api.setEffort(activeId, chat.effort).catch(fail);
    if (last.permissionMode !== chat.permissionMode) {
      void api.setPermissionMode(activeId, chat.permissionMode).catch(fail);
    }
  }, [activeId, chat, api]);

  const switchPermissionMode = async (permissionMode: PermissionMode) => {
    onChatChange({ permissionMode });
    setSelector((prev) => (prev ? { ...prev, permissionMode } : prev));
    if (!activeId) return;
    try {
      await api.setPermissionMode(activeId, permissionMode);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };


  return {
    list,
    activeId,
    active,
    running,
    finished,
    usage,
    error,
    setError,
    open,
    create,
    selector: selector ?? {
      model: chat.model,
      effort: chat.effort,
      permissionMode: chat.permissionMode,
      // Local cache first (it matches what this planner last saw), then the
      // daemon's own copy so a fresh browser still gets a real picker.
      models: catalog.length > 0 ? catalog : (daemon.status?.models ?? []),
    },
    commands,
    setModel: switchModel,
    setEffort: switchEffort,
    setPermissionMode: switchPermissionMode,
    remove,
    submit,
    sendTurn,
    refresh,
  };
}
