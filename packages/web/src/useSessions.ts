import type {
  ContextUsage,
  EffortLevel,
  LostSend,
  PermissionMode,
  QueuedSend,
  QueuedSendPayload,
  SessionCommand,
  SessionModelInfo,
  SessionSelectors,
  SessionSummary,
} from "@colo-design/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment } from "./Composer";
import { type Daemon, EMPTY_SESSION, type SessionView } from "./daemon-client";
import { type ChatSettings, loadModelCatalog, saveModelCatalog } from "./settings";

/** Reload 후 마지막으로 연 대화를 프로젝트별로 되돌려 놓는 곳 (실사 결함). */
const LAST_THREAD_KEY = "colo-design.last-thread";

/**
 * 프로젝트의 저장된 마지막 스레드 포인터를 지운다 (삭제 부활 결함). 복원
 * 효과는 activeId 가 null 로 떨어지는 순간 이 포인터를 읽는데, 그 시점의
 * 목록은 아직 갱신 전이라 지워진 행을 그대로 담고 있다. 포인터를 남겨 두면
 * 방금 지운 스레드가 대화창에 되살아난다.
 */
function forgetLastThread(slug: string | null, sessionId: string) {
  if (!slug) return;
  try {
    const map = JSON.parse(localStorage.getItem(LAST_THREAD_KEY) ?? "{}") as Record<string, string>;
    if (map[slug] !== sessionId) return;
    delete map[slug];
    localStorage.setItem(LAST_THREAD_KEY, JSON.stringify(map));
  } catch {
    // 손상된 기록은 버려진 것과 같다 — 조용히 건너뛴다.
  }
}

/** The chat state of the one workspace, as its views consume it. */
export interface Sessions {
  /** Stored + live threads of this workspace, newest first. */
  list: SessionSummary[];
  activeId: string | null;
  /** Transcript of the active thread; null when none is open. */
  active: SessionView | null;
  running: boolean;
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
  /** 빠르게 — 이 대화에만 걸리는 자세라 설정에 남지 않는다. */
  setFastMode: (fast: boolean) => Promise<void>;
  error: string | null;
  setError: (error: string | null) => void;
  /**
   * 실사 결함: 목록이 아는 대화를 열었는데 기록이 비어 돌아왔다 — 조용한
   * 실패였다(빈 대화가 진짜 빈 대화로 읽혔다). 이 깃발이 그 실패를 카드로
   * 보이게 하고, `reopen` 이 다시 시도다.
   */
  historyFailed: boolean;
  /** The history-failure card's 다시 시도 — the same open, asked again. */
  reopen: () => void;
  /** Open a thread from the list, hydrating its stored transcript. */
  open: (summary: SessionSummary) => Promise<void>;
  /**
   * Open a thread by id alone, resuming it into a live session
   * (`session.create { resume }`, PLAN D59) — the tree's jump into a row
   * this project's list has not fetched, and the landing after a switch
   * across projects.
   */
  resume: (sessionId: string) => Promise<void>;
  /**
   * Start a thread and open it. Resolves with its id — the shell needs it to
   * make the new thread the open one, and React state cannot be read back
   * the instant after this returns.
   * `title` names a thread the TOOL is opening (the 화면 handoff): its first
   * turn is a sentence this app wrote, so letting that turn name the thread
   * puts a file path in the conversation.
   */
  create: (title?: string) => Promise<string | null>;
  /**
   * Delete a stored thread for good (PLAN D76). The 4판's 보관 used to stand
   * between a click and this; with it gone the confirm is the only thing
   * that does, so it asks unconditionally — an irreversible act asks. The
   * list refresh is what takes the row out of the tree and the head.
   *
   * 결함③ (PLAN 0단계): the ask is this app's ConfirmDialog now, so `remove`
   * only NOMINATES a thread (`confirmRemove`) and the dialog's own buttons
   * close or commit. The dialog renders where the rest of the workspace
   * renders — PageWorkspace.
   */
  remove: (session: SessionSummary) => void;
  /** The thread a click nominated for deletion; null when none is pending. */
  confirmRemove: SessionSummary | null;
  /** The dialog's 닫기 — clears the nomination. */
  cancelRemove: () => void;
  /** The dialog's 지우기 — actually deletes and refreshes. */
  acceptRemove: () => Promise<void>;
  /**
   * The composer's send. `thread.name` names a thread created BY this send —
   * a first send that opens one (핀으로 열리는 대화는 첫 핀의 화면 이름을
   * 얻는다, 재설계 C2/M5); an existing target ignores it.
   */
  submit: (text: string, attachments: Attachment[], thread?: { name?: string }) => Promise<void>;
  /**
   * 계획 승인의 뒷정리: 데몬이 작업 모드로 되돌린 직후, 칩과 대화의 권한
   * 선택을 그 진실에 맞춘다. 계획만 세우기로 세워진 대화는 승인 한 번으로
   * 소비된다 — 계획 모드는 한 턴의 자세다.
   */
  afterPlanApproval: () => void;
  /**
   * 되감기 (PLAN D95): discard the k-th answer — files and memory go back —
   * and send `text` again. The daemon forks the conversation; this side
   * adopts the new id (제목은 데몬이 물려준다) and refreshes the list.
   */
  rewindAnswer: (
    turn: number,
    text: string,
    images?: Array<{ mediaType: string; data: string }>,
  ) => Promise<void>;
  /**
   * Machine-authored turn: no composer, no attachments. `images` rides the
   * same wire a composer attachment does (PLAN D87) — the pin crops, the
   * 화면 보여 주기 frame.
   */
  sendTurn: (
    text: string,
    images?: Array<{ mediaType: string; data: string }>,
    target?: string,
  ) => Promise<void>;
  /**
   * 다음 턴에 밀려 있는 것 (PLAN D86): 데몬의 대기 줄, 오래된 것부터. 턴이
   * 끝나면 빈다. The composer's list above the field draws it.
   */
  queue: QueuedSend[];
  /** Sends the room lost without delivering — the composer's 되살리기 rows. */
  dropped: LostSend[];
  /**
   * 고쳐서 보내기: take a waiting send back out of the daemon's room, as the
   * composer's own attachments. Null when it already went out.
   */
  takeQueued: (itemId: string) => Promise<{ text: string; attachments: Attachment[] } | null>;
  /** 지금 보내기: cut the running turn and deliver this send first. */
  sendQueuedNow: (itemId: string) => Promise<void>;
  /** The send a 지금 보내기 click is currently cutting for — its row waits too. */
  hurrying: string | null;
  /**
   * 되살리기: hand one lost send back into the field, attachments included
   * when their bytes survived the persist cap.
   */
  takeDropped: (itemId: string) => Promise<{ text: string; attachments: Attachment[] } | null>;
  /** Let go of one undelivered send (restored into the field, or unwanted). */
  dismissDropped: (itemId: string) => void;
  refresh: () => Promise<void>;
  /** A fresh usage reading on demand — the usage popover refreshes on open. */
  refreshUsage: () => void;
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
    /**
     * How Claude answers, as 설정 holds it (PLAN D10). Owned above this hook:
     * the same three values drive the settings dialog, and two copies of
     * "which model" would disagree the first time one of them was edited.
     */
    chat: ChatSettings;
    onChatChange: (patch: Partial<ChatSettings>) => void;
  },
): Sessions {
  const { ready, chat, onChatChange } = opts;
  const { connection, api, sessions, ensureSession, hydrate, markLive } = daemon;
  const forgetDropped = daemon.dismissDropped;
  const [list, setList] = useState<SessionSummary[]>([]);
  /** `open` reads the list without inheriting its closure — a mirror ref. */
  const listRef = useRef(list);
  listRef.current = list;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  const [selector, setSelector] = useState<SessionSelectors | null>(null);
  const [commands, setCommands] = useState<SessionCommand[]>([]);
  const [catalog, setCatalog] = useState<SessionModelInfo[]>(loadModelCatalog);
  const [error, setError] = useState<string | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);

  const active = activeId ? (sessions[activeId] ?? EMPTY_SESSION) : null;
  const running = active?.state === "running";

  const refresh = useCallback(async () => {
    setList(await api.listSessions().catch(() => [] as SessionSummary[]));
  }, [api]);

  /**
   * One open thread's tape, read once: shared by the sidebar's open and the
   * reload's saved-thread restore, so both fill the transcript the same way —
   * and a listed session answering nothing reads as the failure it is.
   */
  const loadHistory = useCallback(
    async (sessionId: string) => {
      setHistoryFailed(false);
      try {
        const events = await api.history(sessionId);
        hydrate(sessionId, events);
        if (events.length === 0 && listRef.current.some((row) => row.sessionId === sessionId)) {
          setHistoryFailed(true);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [api, hydrate],
  );

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
        // 화면 도구는 세션이 태어날 때 정해진다(PLAN D61): 설정값을 그대로
        // 실어 보낸다. 이후 설정을 바꿔도 진행 중인 세션은 무관하다 — 도구
        // 목록은 실행 중인 query 에 되돌려 꽂지 않는다. 새 세션부터 적용이다.
        previewTools: picked.previewTools,
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
  // project's rows left a clickable conversation the daemon would answer in
  // the wrong clone. Clear both the list and the open thread; `ready` rarely
  // flips on a switch between two prepared repos, so this is the only
  // reliable trigger.
  const activeSlug = daemon.activeSlug;
  const listedSlug = useRef(activeSlug);
  useEffect(() => {
    if (listedSlug.current === activeSlug) return;
    // 처리한 전환에 마크를 남긴다: 초깃값 그대로인 마크는 돌아오는 전환(시작
    // 프로젝트로의 복귀)을 조기 반환시켜, 목록이 나가던 프로젝트의 행을 든 채
    // 남는다 — 활성 대화의 id 는 새 프로젝트 것이라 머리(제목·이름 바꾸기)가
    // 사라진다. 따뜻한 미리보기 아래 전환은 ready 를 흔들지 않으므로(위
    // 코멘트), 이 효과가 목록 갱신의 유일한 길이다.
    listedSlug.current = activeSlug;
    setList([]);
    setActiveId(null);
    if (connection === "open") void refresh();
  }, [activeSlug, connection, refresh]);

  // Reload 가 대화를 잃게 두지 않는다 (실사 결함): 프로젝트별 마지막으로 연
  // 스레드를 기억해 목록이 도착하면 되돌아간다. 없거나 사라진 스레드면 그대로
  // null — "앱을 열었다고 스레드를 만들지 않는다"는 원칙은 그대로다.
  useEffect(() => {
    if (connection !== "open" || !ready || activeId !== null || list.length === 0) return;
    try {
      const saved = (
        JSON.parse(localStorage.getItem(LAST_THREAD_KEY) ?? "{}") as Record<string, string>
      )[activeSlug ?? ""];
      if (saved && list.some((s) => s.sessionId === saved)) {
        ensureSession(saved);
        setActiveId(saved);
        // 실사 결함: 이 복원이 setActiveId 만 하고 대화록을 읽지 않았다 —
        // 기록 가득한 대화가 새로고침마다 "빈 대화"로 열렸다. 다시 열 때는
        // open() 과 같은 적재를 지난다.
        void loadHistory(saved);
      }
    } catch {
      // 손상된 기록은 버려진 것과 같다 — 조용히 건너뛴다.
    }
  }, [connection, ready, activeId, activeSlug, list, loadHistory, ensureSession]);

  useEffect(() => {
    if (!activeId || !activeSlug) return;
    try {
      const map = JSON.parse(localStorage.getItem(LAST_THREAD_KEY) ?? "{}") as Record<
        string,
        string
      >;
      map[activeSlug] = activeId;
      localStorage.setItem(LAST_THREAD_KEY, JSON.stringify(map));
    } catch {
      // 저장 실패는 치명적이지 않다 — 다음 전환에 다시 쓴다.
    }
  }, [activeId, activeSlug]);

  // Nothing is created just because the app opened: an empty thread the
  // planner never typed into is noise in their list. The first message (or
  // the 새 대화 button) is what starts one.

  // Context usage only moves when a turn finishes, so read it on settle
  // instead of polling. The effect also carries the empty-state palette (the
  // daemon's CLI probe), so it runs with no thread open too — it only sits
  // out while the open thread's turn is still streaming.
  useEffect(() => {
    if (activeId && running) return;
    let cancelled = false;
    // The palette comes from the session's own CLI, which answers only once
    // its query is up; one retry covers that boot window without polling.
    // With no thread open, the probe fills the same list — asked only once
    // the wire is up (the effect re-runs on `connection`), and opening a
    // thread cancels a still-in-flight probe, so a session's own answer can
    // never be overwritten by the standalone one.
    if (!activeId) {
      if (connection !== "open") return;
      void api
        .cliCommands()
        .then((next) => !cancelled && setCommands(next))
        .catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }
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
  }, [activeId, running, api, connection, active?.blocks.length]);

  /**
   * The settle-time read above only fires when a turn lands, so a 5-hour
   * window that reset while the app sat idle would leave the popover with
   * nothing until the next turn. Opening the popover is a question about
   * right now — this answers it. The daemon remembers whatever comes back,
   * so every screen's chip catches up through the status broadcast too.
   */
  const refreshUsage = useCallback(() => {
    if (!activeId) return;
    void api
      .contextUsage(activeId)
      .then((next) => setUsage(next))
      .catch(() => undefined);
  }, [activeId, api]);

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
    await loadHistory(summary.sessionId);
  };

  /**
   * The history-failure card's 다시 시도: the same open, through the list's own
   * copy of the summary — the daemon answering this time fills the tape.
   */
  const reopen = () => {
    const summary = activeId
      ? listRef.current.find((row) => row.sessionId === activeId)
      : undefined;
    if (summary) void open(summary);
  };

  /**
   * The tree's open-by-id (PLAN D59): `session.create { resume }` makes the
   * stored conversation live again in one message — no list fetch first, no
   * hydrate-then-wait. A live id is the caller's to focus through `open`;
   * resuming one would fork it.
   */
  const resume = async (sessionId: string) => {
    discardIfUnused(activeId);
    try {
      await startSession(sessionId);
      void refresh();
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

  /**
   * 지우기 (PLAN D76): the confirm is unconditional — a transcript that
   * cannot come back deserves the question, and there is no archive step
   * left to soften the click. 결함③ (PLAN 0단계): the question is the app's
   * ConfirmDialog, so this only nominates; `acceptRemove` commits.
   */
  const [confirmRemove, setConfirmRemove] = useState<SessionSummary | null>(null);
  const remove = (session: SessionSummary) => {
    setConfirmRemove(session);
  };
  const cancelRemove = useCallback(() => setConfirmRemove(null), []);
  const acceptRemove = useCallback(async () => {
    const session = confirmRemove;
    setConfirmRemove(null);
    if (!session) return;
    if (activeId === session.sessionId) {
      setActiveId(null);
      // 위 setActiveId 와 같은 동기 플러시에 지운다: 복원 효과가 실행될
      // 때는 포인터가 이미 없어 갱신 전의 낡은 목록이 지워진 스레드를
      // 되살릴 수 없다.
      forgetLastThread(activeSlug, session.sessionId);
    }
    try {
      await api.deleteSession(session.sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    void refresh();
  }, [activeId, activeSlug, api, confirmRemove, refresh]);

  /** Resolve the session a turn should land in, creating or resuming as needed.
   * `wanted` pins the destination (the id a caller just created) — without it
   * the fallback reads `activeId`, which a closure captured before that
   * create's setState landed and would open a second, nameless thread. */
  const targetSession = async (wanted?: string, name?: string): Promise<string> => {
    const id = wanted ?? activeId;
    if (!id) return await startSession(undefined, name);
    // A stored thread the planner picked from the list: continue it in place.
    // Forking is a developer's concern, not theirs.
    // 결함(죽은 질의에 말이 사라진다): a live thread whose CLI crashed —
    // state error, the crash card's own state — must not be sent into.
    // Nothing consumes that queue anymore, so the words would sink without an
    // answer. Reopening resumes the stored transcript in a fresh CLI, which
    // is the promise the crash card already made ("다시 보내면 이어집니다").
    const picked = daemon.sessions[id];
    if (picked && (!picked.live || picked.state === "error")) return await startSession(id);
    return id;
  };

  /**
   * 대기 줄 (PLAN D86) — 데몬이 쥔 목록을 그대로 읽는다.
   *
   * 화면이 직접 세던 때에는 "보냈다" 만 알고 "언제 나갔다" 는 몰랐다: 말을
   * 붙들고 있는 쪽은 데몬이고(Session.held), 그 줄이 언제 풀리는지도 데몬만
   * 안다. 턴 끝에 비는 것도 그쪽에서 온다.
   */
  const queue = active?.queue ?? [];
  const dropped = active?.dropped ?? [];

  const toAttachments = (payload: NonNullable<QueuedSendPayload>): Attachment[] =>
    payload.images.map(
      (image, index): Attachment => ({
        name: `이미지 ${index + 1}`,
        mediaType: image.mediaType,
        data: image.data,
        size: Math.floor((image.data.length * 3) / 4),
      }),
    );

  const takeQueued = async (itemId: string) => {
    if (!activeId) return null;
    const payload = await api.queueRemove(activeId, itemId);
    if (!payload) return null;
    return { text: payload.text, attachments: toAttachments(payload) };
  };

  const [hurrying, setHurrying] = useState<string | null>(null);
  const sendQueuedNow = async (itemId: string) => {
    if (!activeId) return;
    setHurrying(itemId);
    try {
      await api.queueSendNow(activeId, itemId);
    } finally {
      setHurrying(null);
    }
  };

  const takeDropped = async (itemId: string) => {
    if (!activeId) return null;
    const payload = await api.queueTakeDropped(activeId, itemId);
    if (!payload) return null;
    return { text: payload.text, attachments: toAttachments(payload) };
  };

  const dismissDropped = (itemId: string) => {
    if (activeId) forgetDropped(activeId, itemId);
  };

  const submit = async (text: string, attachments: Attachment[], thread?: { name?: string }) => {
    try {
      const target = await targetSession(undefined, thread?.name);
      await api.send(
        target,
        text,
        attachments.map(({ mediaType, data }) => ({ mediaType, data })),
      );
      void refresh();
    } catch (e) {
      // PLAN D35: the composer keeps the words AND the attachments unless the
      // daemon accepted the turn. Its warning strip is also the ONE surface a
      // refused send speaks from — the banner would read the same news twice,
      // in two corners of the screen. The Korean sentence rides the rejection.
      throw e;
    }
  };

  /** 계획 승인 직후: 데몬이 되돌린 작업 모드를 칩과 대화의 선택에 반영한다. */
  const afterPlanApproval = useCallback(() => {
    if (!activeId) return;
    void api
      .selectors(activeId)
      .then((next) => {
        setSelector(next);
        if (next.models.length > 0) {
          setCatalog(next.models);
          saveModelCatalog(next.models);
        }
        if (next.permissionMode !== chat.permissionMode) {
          onChatChange({ permissionMode: next.permissionMode });
        }
      })
      .catch(() => undefined);
  }, [activeId, api, chat.permissionMode, onChatChange]);

  const rewindAnswer = async (
    turn: number,
    text: string,
    images?: Array<{ mediaType: string; data: string }>,
  ) => {
    if (!activeId) return;
    try {
      const { sessionId } = await api.rewind(activeId, turn, text, images);
      if (sessionId !== activeId) {
        ensureSession(sessionId);
        markLive(sessionId);
        setActiveId(sessionId);
      }
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * A machine-authored turn (the comment envelope): the same wire a typed
   * message uses, minus the composer. `images` rides along (D87). The target
   * resolves through targetSession for the same reason a typed word does — a
   * crashed query must be resumed, not fed. A caller that just created the
   * thread passes its id: the closure's `activeId` still reads the pre-create
   * value and would otherwise open a second, nameless thread (M5).
   */
  const sendTurn = async (
    text: string,
    images?: Array<{ mediaType: string; data: string }>,
    target?: string,
  ) => {
    try {
      const id = await targetSession(target);
      await api.send(id, text, images);
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Rejected on purpose (PLAN D35): a machine turn the daemon did not
      // accept must be retryable — the caller decides what survives on
      // screen, and swallowing here would tell it the send landed.
      throw e;
    }
  };

  /**
   * Composer chips. The local state flips immediately (a chip that waits a
   * round trip feels broken); the next settle re-reads the daemon's truth.
   * With no session open the pick is still real — it is what the next session
   * will be created with. A refused pick rolls the chip back to what the
   * session actually runs — the strip must not advertise an adoption that
   * never happened (the chat-level pick stays: the next session still wants
   * it).
   */
  const switchModel = async (model: string | null) => {
    const prev = selector?.model ?? null;
    onChatChange({ model });
    setSelector((current) => (current ? { ...current, model } : current));
    if (!activeId) return;
    try {
      await api.setModel(activeId, model);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSelector((current) => (current ? { ...current, model: prev } : current));
    }
  };

  const switchEffort = async (effort: EffortLevel | null) => {
    const prev = selector?.effort ?? null;
    onChatChange({ effort });
    setSelector((current) => (current ? { ...current, effort } : current));
    if (!activeId) return;
    try {
      await api.setEffort(activeId, effort);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSelector((current) => (current ? { ...current, effort: prev } : current));
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
    const prev = selector?.permissionMode ?? "default";
    onChatChange({ permissionMode });
    setSelector((current) => (current ? { ...current, permissionMode } : current));
    if (!activeId) return;
    try {
      await api.setPermissionMode(activeId, permissionMode);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSelector((current) => (current ? { ...current, permissionMode: prev } : current));
    }
  };

  /**
   * 빠르게는 부탁이지 명령이 아니다: 눌린 자리를 먼저 그려 두되, 다음
   * 메시지의 `fast_mode_state` 가 데몬을 통해 돌아오면 그 말이 이긴다.
   * 요청 자체가 실패하면 눌리기 전으로 돌려놓는다.
   */
  const switchFastMode = async (fast: boolean) => {
    if (!activeId) return;
    const prev = selector?.fastMode ?? false;
    setSelector((current) => (current ? { ...current, fastMode: fast } : current));
    try {
      await api.setFastMode(activeId, fast);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSelector((current) => (current ? { ...current, fastMode: prev } : current));
    }
  };

  return {
    activeId,
    list,
    active,
    running,
    open,
    resume,
    usage,
    error,
    setError,
    historyFailed,
    reopen,
    create,
    selector: selector ?? {
      model: chat.model,
      effort: chat.effort,
      permissionMode: chat.permissionMode,
      // 빠르게는 세션이 태어날 때 꺼진 채 시작한다(SDK 의
      // fastModePerSessionOptIn 과 같은 자세) — 설정에 남지 않으므로 세션이
      // 없을 때의 답은 언제나 꺼짐이다.
      fastMode: false,
      fastModeBlocked: null,
      // Local cache first (it matches what this planner last saw), then the
      // daemon's own copy so a fresh browser still gets a real picker.
      models: catalog.length > 0 ? catalog : (daemon.status?.models ?? []),
    },
    commands,
    setModel: switchModel,
    setEffort: switchEffort,
    setPermissionMode: switchPermissionMode,
    setFastMode: switchFastMode,
    remove,
    confirmRemove,
    cancelRemove,
    acceptRemove,
    submit,
    afterPlanApproval,
    rewindAnswer,
    sendTurn,
    queue,
    dropped,
    takeQueued,
    sendQueuedNow,
    hurrying,
    takeDropped,
    dismissDropped,
    refresh,
    refreshUsage,
  };
}
