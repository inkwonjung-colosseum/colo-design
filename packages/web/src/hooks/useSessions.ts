import type {
  ContextUsage,
  EffortLevel,
  LostSend,
  QueuedSend,
  QueuedSendPayload,
  SessionCommand,
  SessionModelInfo,
  SessionPinHint,
  SessionSelectors,
  SessionSummary,
} from "@colo-design/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment } from "../lib/attachment";

/**
 * 방에서 돌아온 보내기 하나 — 입력창을 그때 그대로 되살리는 데 필요한 전부.
 * `pins` 까지 들고 오는 것이 계약이다: 그 말이 가리킨 화면이 곧 다음 턴의
 * 화면 확인 게이트 입력이므로, 여기서 떨굴 핀은 다시 보낸 말을 검증 밖으로
 * 내보낸다.
 */
interface QueuedRestore {
  text: string;
  attachments: Attachment[];
  pins?: Array<{ screen: string }>;
}

import { modelRowOf } from "../lib/chat-options";
import { type Daemon, EMPTY_SESSION, type SessionView } from "../lib/daemon-client";
import {
  type ChatSettings,
  loadModelCatalog,
  saveModelCatalog,
  switchProviderPatch,
  withChatPick,
} from "../lib/settings";

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

/**
 * 대화 모두 지우기의 포인터 정리 — 어느 스레드가 마지막이었든 이 프로젝트의
 * 기록은 통째로 간다.
 */
function forgetLastThreads(slug: string | null) {
  if (!slug) return;
  try {
    const map = JSON.parse(localStorage.getItem(LAST_THREAD_KEY) ?? "{}") as Record<string, string>;
    if (!(slug in map)) return;
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
  /**
   * 낙관 구간 — 보낸 말이 데몬에 수락되어 running 방송이 오기까지의 빈 자리.
   * 대기 표시가 이 구간에서도 사라지지 않게 하는 것이 존재의 이유다: 세션
   * 탄생(targetSession)과 send 왕복은 데몬의 시계 밖에서 일어난다. `since` 는
   * 보낸 순간의 창 시계 — 데몬의 turnStartedAt 이 도착하면 시계의 주인이
   * 그쪽으로 갈아탄다.
   */
  awaitingTurn: { sessionId: string; since: number } | null;
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
  /**
   * 새 대화가 어느 프로바이더로 돌지 골라 둔다 — 설정의 프로바이더 목록과 같은
   * 한 군데를 쓴다(switchProviderPatch): 컴포저의 칩도 설정도 다음 세션의
   * 프로바이더를 정하는 같은 사실의 두 얼굴이다. 열려 있는 대화는 건드리지
   * 않는다 — 스레드는 태어난 프로바이더에 묶인다.
   */
  pickProvider: (id: string) => void;
  /**
   * 설정에 골라 둔 다음 새 대화의 프로바이더 — `pickProvider`가 쓴 값의 읽는
   * 쪽. 열린 대화의 프로바이더(`selector.provider`)와 갈라질 수 있다: 스레드는
   * 태어난 프로바이더에 묶이고, 고름은 다음 대화부터 먹는다.
   */
  chatProvider: string;
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
   * (`session.create { resume }`) — the tree's jump into a row
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
   * 새 대화의 빈 자리로 — 세션을 만들지 않고 다음 대화의 준비 상태로
   * 돌아간다. 첫 입력 전까지 컴포저의 프로바이더 칩이 살아 있어 연결되고 켠
   * 프로바이더 중에 고를 수 있는 근거: 세션은 첫 문장이 나갈 때(submit →
   * targetSession) 비로소 태어나며 그때의 pick 이 프로바이더를 정한다.
   * 새 대화 버튼·⌘T 가 이 길을 쓰고, 곧장 보내는 길(화면 넘김 등)은
   * 세션 id 가 필요하므로 create 를 쓴다.
   */
  fresh: () => void;
  /**
   * Delete a stored thread for good. The 4판's 보관 used to stand
   * between a click and this; with it gone the confirm is the only thing
   * that does, so it asks unconditionally — an irreversible act asks. The
   * list refresh is what takes the row out of the tree and the head.
   *
   * The ask is this app's ConfirmDialog now, so `remove`
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
   * 대화 모두 지우기: the project menu's bulk delete. `remove` 의 한 건짜리
   * 확인과 같은 그릇 — slug 를 지명하고, 대화상자의 지우기가 acceptClear 로
   * 커밋한다. 비활성 프로젝트도 지울 수 있는 게 단건 삭제와 다른 점이다
   * (데몬이 slug 로 클론을 직접 연다).
   */
  clearAll: (slug: string) => void;
  /** The project whose threads a click nominated for deletion; null when none. */
  confirmClear: string | null;
  cancelClear: () => void;
  acceptClear: () => Promise<void>;
  /**
   * The composer's send. `thread.name` names a thread created BY this send —
   * a first send that opens one (핀으로 열리는 대화는 첫 핀의 화면 이름을
   * 얻는다); an existing target ignores it.
   */
  submit: (
    text: string,
    attachments: Attachment[],
    thread?: { name?: string },
    pins?: Array<{ screen: string }>,
    pinHints?: SessionPinHint[],
  ) => Promise<void>;
  /**
   * 여기서 새 대화(분기): 이 답까지의 기억을 이어받은 새 대화로 갈아탄다 —
   * 원래 대화는 목록에 그대로 남는다. 답은 하나도 나가지 않는다.
   */
  branchFrom: (turn: number) => Promise<void>;
  /**
   * Machine-authored turn: no composer, no attachments. `attachments` rides
   * the same wire a composer attachment does — the pin crops, the
   * 화면 보여 주기 frame.
   */
  sendTurn: (
    text: string,
    attachments?: Array<{ name: string; mediaType: string; data: string }>,
    target?: string,
    pins?: Array<{ screen: string }>,
    pinHints?: SessionPinHint[],
  ) => Promise<void>;
  /** 다음 턴에 보낼 말들 — 데몬의 대기 줄, 오래된 것부터. */
  queue: QueuedSend[];
  /**
   * 고쳐서 보내기: take one waiting send back out of the room, whole —
   * the composer puts the words and the files back in the field.
   */
  queueRemove: (itemId: string) => Promise<QueuedRestore | null>;
  /** 지금 보내기: cut the running turn and deliver THAT send first. */
  queueSendNow: (itemId: string) => Promise<void>;
  /** Sends the room lost without delivering — the composer's 되살리기 rows. */
  dropped: LostSend[];
  /**
   * 되살리기: hand one lost send back into the field, attachments included
   * when their bytes survived the persist cap. 핀도 함께 돌아온다 — 그것이
   * 화면 게이트의 입력이라, 버리면 되살린 말의 턴은 검증 없이 끝난다.
   */
  takeDropped: (itemId: string) => Promise<QueuedRestore | null>;
  /** Let go of one undelivered send (restored into the field, or unwanted). */
  dismissDropped: (itemId: string) => void;
  refresh: () => Promise<void>;
  /** A fresh usage reading on demand — the usage popover refreshes on open. */
  refreshUsage: () => void;
}

/**
 * The chat state of the one workspace: its thread list, its active thread,
 * its error line. There is a single session axis now — every thread
 * is about screens — so there is exactly one of these per connection.
 *
 * `ready` is the connected repo being prepared: the daemon needs a clone
 * before it can give the agent a cwd to write screens into.
 */
export function useSessions(
  daemon: Daemon,
  opts: {
    ready: boolean;
    /**
     * How the agent answers, as 설정 holds it. Owned above this hook:
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
  /**
   * 세션이 아직 없을 때 눌러 둔 프로바이더 모드 — 설정 어휘(Claude enum)가
   * 아니라 settings 에 남기지 않고 다음 세션 한 번에만 실어 보낸다.
   */
  const [commands, setCommands] = useState<SessionCommand[]>([]);
  const [catalog, setCatalog] = useState<SessionModelInfo[]>(() => loadModelCatalog(chat.provider));
  const [error, setError] = useState<string | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);

  const active = activeId ? (sessions[activeId] ?? EMPTY_SESSION) : null;
  const running = active?.state === "running";
  /**
   * 데몬이 아직 말하기 전의 대기 — 보내기 수락(running 방송)을 기다리는 낙관
   * 표시의 상태다. 한 번에 하나만 잡는다: 컴포저의 보내기가 유일한 발화 길이고,
   * 기계 턴(sendTurn)도 같은 길을 지난다.
   */
  const [awaitingTurn, setAwaitingTurn] = useState<{
    sessionId: string;
    since: number;
  } | null>(null);
  // 데몬의 첫 신호(idle 이 아닌 상태 방송, 또는 그보다 먼저 도착한 블록)가
  // 오면 낙관은 물러난다 — 이후의 시계와 표시는 데몬의 진실이 운영한다.
  useEffect(() => {
    if (!awaitingTurn) return;
    const view = sessions[awaitingTurn.sessionId];
    if (view && (view.state !== "idle" || view.blocks.length > 0)) setAwaitingTurn(null);
  }, [awaitingTurn, sessions]);

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
  /**
   * 프로바이더가 바뀌면 칩의 어휘도 바뀐다: 그 프로바이더의 카탈로그로
   * 갈아끼운다.
   */
  useEffect(() => {
    setCatalog(loadModelCatalog(chat.provider));
  }, [chat.provider]);

  /**
   * Which session the selector state is about. The fetch effect guards its
   * own writes with `cancelled`, but startSession's post-write refetch below
   * is outside that effect — without this stamp a late answer for a session
   * the planner already left would paint its chips over the new thread's.
   */
  const selectorFor = useRef<string | null>(null);
  const applySelectors = useCallback((sessionId: string, next: SessionSelectors) => {
    if (selectorFor.current !== sessionId) return;
    setSelector(next);
    // The model list belongs to the provider's CLI and only a live session
    // can be asked for it; keep it under that provider's id so the chip
    // still offers real rows next time — and never another provider's.
    if (next.models.length > 0) {
      const provider = next.provider ?? "claude";
      saveModelCatalog(provider, next.models);
      if (provider === startRef.current.chat.provider) setCatalog(next.models);
    }
  }, []);
  const startSession = useCallback(
    async (resume?: string, title?: string): Promise<string> => {
      const { chat: picked } = startRef.current;
      const provider = picked.provider ?? "claude";
      const { sessionId } = await api.createSession({
        // A resume names the thread, not the provider — the daemon's store
        // lookup decides which driver continues it.
        ...(resume ? {} : { provider }),
        ...(resume ? { resume } : {}),
        ...(!resume && picked.model ? { model: picked.model } : {}),
        ...(!resume && picked.effort ? { effort: picked.effort } : {}),
        ...(title ? { title } : {}),
      });
      ensureSession(sessionId);
      markLive(sessionId);
      setActiveId(sessionId);
      // The selector probe fired by setActiveId may race the create — ask
      // again once the thread is in, so the chip shows what applies.
      selectorFor.current = sessionId;
      void api
        .selectors(sessionId)
        .then((next) => applySelectors(sessionId, next))
        .catch(() => undefined);
      return sessionId;
    },
    [api, ensureSession, markLive, applySelectors],
  );

  /** 이 연결로 이미 재적재를 물었는지 — 끊김마다 한 번만 묻는다. */
  const seenOpen = useRef(false);
  useEffect(() => {
    if (connection !== "open" || !ready) {
      seenOpen.current = false;
      return;
    }
    void refresh();
    // 소켓이 끊긴 동안의 session.event 는 영구히 사라진다 — 도구 시작이
    // 사라지면 그 끝도 버려진다. 다시 이어진 첫 순간에 열린 대화의 기록을
    // 다시 읽어 그 사이의 턴을 채운다.
    if (seenOpen.current !== true) {
      seenOpen.current = true;
      if (activeId) void loadHistory(activeId);
    }
  }, [connection, ready, activeId, refresh, loadHistory]);

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
    // fresh() 와 같은 리셋 — 떠난 프로젝트 대화의 selector·usage·commands 가
    // 새 프로젝트의 빈 자리 칩을 칠하지 않게 (칩은 selector 를 먼저 입는다).
    selectorFor.current = null;
    setSelector(null);
    setUsage(null);
    setCommands([]);
    // 마커와 함께 기록 실패 깃발도 거둔다 — 낡은 대화의 '대화 기록을 읽지
    // 못했습니다' 카드가 새 프로젝트의 빈 대화 위에 남지 않게.
    setHistoryFailed(false);
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
    selectorFor.current = activeId;
    void api
      .selectors(activeId)
      .then((next) => {
        if (cancelled) return;
        applySelectors(activeId, next);
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
  }, [activeId, running, api, connection, applySelectors]);

  /**
   * The settle-time read above only fires when a turn lands, so a 5-hour
   * window that reset while the app sat idle would leave the popover with
   * nothing until the next turn. Opening the popover is a question about
   * right now — this answers it. The daemon remembers whatever comes back,
   * so every screen's chip catches up through the status broadcast too.
   */
  /** 이 세션의 사용량인지 — 늦게 돌아온 답이 다른 대화의 칩을 칠하지 않게. */
  const usageFor = useRef<string | null>(null);
  const refreshUsage = useCallback(() => {
    if (!activeId) return;
    usageFor.current = activeId;
    void api
      .contextUsage(activeId)
      .then((next) => {
        if (usageFor.current !== activeId) return;
        setUsage(next);
      })
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
      if (!view?.live || view.blocks.length > 0) return;
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
   * The tree's open-by-id: `session.create { resume }` makes the
   * stored conversation live again in one message — no list fetch first, no
   * hydrate-then-wait. A live id is the caller's to focus through `open`;
   * resuming one would fork it.
   */
  const resume = async (sessionId: string) => {
    discardIfUnused(activeId);
    try {
      await startSession(sessionId);
      // 되살린 대화도 열기와 같은 의무를 진다 — startSession 은 세션을 live 로
      // 만들 뿐 테이프를 채우지 않으므로, 여기서 빠뜨리면 제목만 바뀐 빈
      // 화면이 된다(다른 프로젝트의 대화를 처음 여는 길이 정확히 이 길이다).
      await loadHistory(sessionId);
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
   * 새 대화의 빈 자리 — 세션을 하나도 만들지 않은 채 "다음 대화"의 준비
   * 상태로 돌아간다. 첫 입력 전까지는 프로바이더 칩이 살아 있어야 한다(연결되고
   * 켠 프로바이더 중에 고른다): 세션은 첫 문장이 나갈 때 targetSession 이
   * 만들고, 그 순간의 pick 이 프로바이더를 정한다. 입력 전에 태어난 빈 세션은
   * discardIfUnused 가 닫고, 칩은 설정의 pick 을 다시 입는다. 복원 포인터는
   * setActiveId 와 같은 동기 플러시에서 지운다 — 남아 있으면 복원 효과가
   * 방금 떠난 스레드를 되살려 빈 자리를 깨먹는다(삭제 부활 결함과 한 뿌리).
   * 늦게 도착한 이전 세션의 selector 응답은 selectorFor 의 칸막이가 막는다.
   */
  const fresh = useCallback(() => {
    discardIfUnused(activeId);
    setActiveId(null);
    if (activeId) forgetLastThread(activeSlug, activeId);
    selectorFor.current = null;
    setSelector(null);
    setUsage(null);
    // 새 대화의 빈 자리 위에 이전 대화의 실패 카드가 남지 않게.
    setHistoryFailed(false);
  }, [activeId, activeSlug, discardIfUnused]);

  /**
   * 지우기: the confirm is unconditional — a transcript that
   * cannot come back deserves the question, and there is no archive step
   * left to soften the click. The question is the app's
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
    // 낙관 삭제 (OPTIMISTIC DELETE): 승인과 같은 커밋에서 행을 먼저 거둔다 —
    // 저장 스캔과 project.changed 의 한 바퀴를 화면에 보이지 않게. 실패하면
    // 아래에서 숨김을 풀어 행을 되돌린다.
    if (activeSlug) daemon.hideThread(activeSlug, session.sessionId);
    if (activeId === session.sessionId) {
      setActiveId(null);
      // 위 setActiveId 와 같은 동기 플러시에 지운다: 복원 효과가 실행될
      // 때는 포인터가 이미 없어 갱신 전의 낡은 목록이 지워진 스레드를
      // 되살릴 수 없다.
      forgetLastThread(activeSlug, session.sessionId);
      // fresh() 와 같은 리셋 — 지운 대화의 selector·usage 가 빈 자리의
      // 칩을 칠하면 프로바이더를 바꿔도 칩이 옛 것을 입은 채로 남는다.
      selectorFor.current = null;
      setSelector(null);
      setUsage(null);
      setHistoryFailed(false);
    }
    try {
      await api.deleteSession(session.sessionId);
    } catch (e) {
      if (activeSlug) daemon.unhideThread(activeSlug, session.sessionId);
      setError(e instanceof Error ? e.message : String(e));
    }
    void refresh();
  }, [activeId, activeSlug, api, daemon, confirmRemove, refresh]);

  const [confirmClear, setConfirmClear] = useState<string | null>(null);
  const clearAll = useCallback((slug: string) => setConfirmClear(slug), []);
  const cancelClear = useCallback(() => setConfirmClear(null), []);
  const acceptClear = useCallback(async () => {
    const slug = confirmClear;
    setConfirmClear(null);
    if (!slug) return;
    // 낙관 삭제 — 그 프로젝트의 행 전체를 승인과 같은 커밋에서 거둔다.
    // 비활성 프로젝트의 일괄 삭제라도 트리의 행은 같은 지연을 입는다.
    daemon.hideAllThreads(slug);
    if (slug === activeSlug) {
      // 지운 프로젝트가 눈앞의 것이면 열린 대화와 복원 포인터가 함께 간다 —
      // 단건 삭제의 setActiveId·forgetLastThread 와 같은 동기 순서.
      setActiveId(null);
      forgetLastThreads(slug);
      // 단건 삭제와 같은 리셋 — 지운 대화의 selector·usage 가 빈 자리의
      // 칩을 칠하면 프로바이더를 바꿔도 칩이 옛 것을 입은 채로 남는다.
      selectorFor.current = null;
      setSelector(null);
      setUsage(null);
      setHistoryFailed(false);
    }
    try {
      await api.deleteAllSessions(slug);
    } catch (e) {
      daemon.unhideAllThreads(slug);
      setError(e instanceof Error ? e.message : String(e));
    }
    void refresh();
  }, [daemon, confirmClear, activeSlug, api, refresh]);

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

  const dropped = active?.dropped ?? [];
  const queue = active?.queue ?? [];

  const toAttachments = (payload: NonNullable<QueuedSendPayload>): Attachment[] =>
    payload.attachments.map(
      (part): Attachment => ({
        kind: part.mediaType.startsWith("image/") ? "image" : "file",
        name: part.name,
        mediaType: part.mediaType,
        data: part.data,
        size: Math.floor((part.data.length * 3) / 4),
      }),
    );

  /**
   * 되살린 말의 전부 — 글자·파일만이 아니다. `pins` 는 그 말이 가리킨
   * 화면이고 화면 확인 게이트의 입력이므로(데몬은 이미 실어 보낸다),
   * 여기서 버리면 되살린 말의 턴은 아무도 검증하지 않은 채 끝난다.
   */
  const restored = (payload: NonNullable<QueuedSendPayload>): QueuedRestore => ({
    text: payload.text,
    attachments: toAttachments(payload),
    ...(payload.pins?.length ? { pins: payload.pins } : {}),
  });

  const takeDropped = async (itemId: string) => {
    if (!activeId) return null;
    const payload = await api.queueTakeDropped(activeId, itemId);
    if (!payload) return null;
    return restored(payload);
  };

  const queueRemove = async (itemId: string) => {
    if (!activeId) return null;
    const payload = await api.queueRemove(activeId, itemId);
    if (!payload) return null;
    return restored(payload);
  };

  const queueSendNow = async (itemId: string) => {
    if (!activeId) return;
    await api.queueSendNow(activeId, itemId);
  };

  const dismissDropped = (itemId: string) => {
    if (activeId) forgetDropped(activeId, itemId);
  };
  const submit = async (
    text: string,
    attachments: Attachment[],
    thread?: { name?: string },
    pins?: Array<{ screen: string }>,
    pinHints?: SessionPinHint[],
  ) => {
    try {
      const target = await targetSession(undefined, thread?.name);
      // 조용한 세션만 낙관을 얻는다 — 도는 중·대기 중인 세션엔 표시의 주인이
      // 이미 있다(진행 시계·확인 카드·대기 줄), 거기 겹치면 거짓말이 둘이 된다.
      const view = sessions[target];
      const wake = !view || view.state === "idle";
      if (wake) setAwaitingTurn({ sessionId: target, since: Date.now() });
      await api.send(
        target,
        text,
        attachments.map(({ name, mediaType, data }) => ({ name, mediaType, data })),
        pins,
        chat.midturn === "steer" ? "steer" : undefined,
        pinHints,
      );
      void refresh();
    } catch (e) {
      // 수락이 거절된 보내기엔 대기 표시의 근거가 없다 — 컴포저의 경고 줄이
      // 유일한 이야기꾼이다(위의 계약). 낙관도 함께 거둔다.
      setAwaitingTurn(null);
      // The composer keeps the words AND the attachments unless the
      // daemon accepted the turn. Its warning strip is also the ONE surface a
      // refused send speaks from — the banner would read the same news twice,
      // in two corners of the screen. The Korean sentence rides the rejection.
      throw e;
    }
  };

  /**
   * 여기서 새 대화(분기): 이 답까지의 기억을 이어받은 대화로 갈아탄다 —
   * 원래 대화는 목록에 그대로 남는다. 갈아탄 뒤의 적재는 열기와 같은
   * 이유다: 읽지 않으면 테이프가 비어 보이고, 다음 분기의 k 셈도 어긋난다.
   */
  const branchFrom = async (turn: number) => {
    if (!activeId) return;
    try {
      const { sessionId } = await api.branch(activeId, turn);
      if (sessionId !== activeId) {
        ensureSession(sessionId);
        markLive(sessionId);
        setActiveId(sessionId);
        await loadHistory(sessionId);
      }
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * A machine-authored turn (the comment envelope): the same wire a typed
   * message uses, minus the composer. `attachments` rides along. The target
   * resolves through targetSession for the same reason a typed word does — a
   * crashed query must be resumed, not fed. A caller that just created the
   * thread passes its id: the closure's `activeId` still reads the pre-create
   * value and would otherwise open a second, nameless thread.
   */
  const sendTurn = async (
    text: string,
    attachments?: Array<{ name: string; mediaType: string; data: string }>,
    target?: string,
    pins?: Array<{ screen: string }>,
    pinHints?: SessionPinHint[],
  ) => {
    try {
      const id = await targetSession(target);
      // 컴포저의 보내기와 같은 낙관 — 사람의 말이 아니어도 턴은 턴이다.
      const view = sessions[id];
      const wake = !view || view.state === "idle";
      if (wake) setAwaitingTurn({ sessionId: id, since: Date.now() });
      await api.send(id, text, attachments, pins, undefined, pinHints);
    } catch (e) {
      setAwaitingTurn(null);
      setError(e instanceof Error ? e.message : String(e));
      // Rejected on purpose: a machine turn the daemon did not
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
    // The pin lands under the provider that made it — the open session's
    // provider, or the settings pick when no thread is running. A Codex id
    // must never sit in the slot the next Claude session reads.
    onChatChange(withChatPick(chat, selector?.provider ?? chat.provider, { model }));
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
    onChatChange(withChatPick(chat, selector?.provider ?? chat.provider, { effort }));
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
    // selector 응답이 아직 오지 않았으면 이 세션의 프로바이더를 모른다 —
    // Claude 기본값으로 착각하면 비(非)Claude 대화에 Claude 모델을 밀어 넣는다.
    // 모르면 밀지 않는다.
    if (!activeId || !last || !selector) return;
    const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
    // A settings edit reaches the live thread only when the thread's
    // provider is the one the dialog is editing — a Codex session must not
    // receive a Claude alias, and the Claude enum must not reach a provider
    // that names its own modes.
    const same = (selector.provider ?? "claude") === chat.provider;
    if (same && last.model !== chat.model) void api.setModel(activeId, chat.model).catch(fail);
    if (same && last.effort !== chat.effort) void api.setEffort(activeId, chat.effort).catch(fail);
  }, [activeId, chat, selector, api]);

  /**
   * 새 대화의 프로바이더 — 설정의 프로바이더 목록과 같은 한 군데를 쓴다. 칩에서
   * 고른 것이 곧 설정에 남는다: 다음 세션은 그 프로바이더로 돌고, 열려 있는
   * 대화는 태어난 프로바이더에 묶여 무관하다.
   */
  const pickProvider = useCallback(
    (id: string) => onChatChange(switchProviderPatch(chat, id)),
    [onChatChange, chat],
  );

  // 메뉴에서 '자동' 행은 없어졌다 — 그러니 비어 있던 자리도 허공에 남을 수
  // 없다. 목록(또는 산 세션이 말해 주는 모델)이 처음 이름을 대는 순간, 모델은
  // 그 행을 데려가고 노력은 모델이 받는 수준의 가운데에서 시작한다. 사용자가
  // 누르는 것과 같은 길(switchModel·switchEffort)이므로 저장·세션 반영·
  // 되돌림까지 같이 된다. 공급자당 한 번만 시도한다 — 거절이 되돌림을 남기면
  // 이 효과가 다시 불려 무한히 재시도하는 것을 막는다.
  const seededModelFor = useRef<string | null>(null);
  const seededEffortFor = useRef<string | null>(null);
  useEffect(() => {
    const provider = selector?.provider ?? chat.provider;
    const models = selector?.models.length
      ? selector.models
      : catalog.length > 0
        ? catalog
        : (daemon.status?.modelsByProvider?.[provider] ?? []);
    if (models.length === 0) return;
    const pick =
      provider === chat.provider
        ? { model: chat.model, effort: chat.effort }
        : (chat.byProvider?.[provider] ?? { model: null, effort: null });
    // 초대 v4(PLAN 단계 5): 사용자가 이 공급자의 모델·생각 시간을 고른 적이
    // 없을 때만 프로젝트의 처음 값이 씨앗이 된다 — 고른 값이 있으면 그것이
    // 이기고, defaults.provider 가 다른 공급자를 겨누면 여기서는 아무 일도
    // 하지 않는다(데몬의 session.create 도 같은 규칙으로 채운다).
    const projectDefaults = daemon.status?.projects.find(
      (project) => project.slug === daemon.status?.activeProject,
    )?.defaults;
    const defaultsFit =
      projectDefaults !== undefined &&
      (!projectDefaults.provider || projectDefaults.provider === provider);
    if (pick.model == null) {
      if (seededModelFor.current === provider) return;
      const row =
        (defaultsFit && projectDefaults.model
          ? modelRowOf(models, projectDefaults.model)
          : undefined) ??
        modelRowOf(models, selector?.model ?? null) ??
        models[0];
      if (!row) return;
      seededModelFor.current = provider;
      void switchModel(row.value);
      return;
    }
    if (pick.effort == null) {
      if (seededEffortFor.current === provider) return;
      const row = modelRowOf(models, pick.model);
      const levels = row?.supportedEffortLevels ?? [];
      const level =
        defaultsFit && projectDefaults.effort && levels.includes(projectDefaults.effort)
          ? projectDefaults.effort
          : levels[Math.floor(levels.length / 2)];
      if (!row?.supportsEffort || !level) return;
      seededEffortFor.current = provider;
      void switchEffort(level);
    }
    // switchModel·switchEffort는 매 렌더 새 몸이지만 위의 한 번 guards가
    // 재시도를 막는다 — 의존성에서 일부러 뺀다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selector, chat, catalog, daemon.status, switchModel, switchEffort]);

  return {
    activeId,
    list,
    active,
    running,
    awaitingTurn,
    open,
    resume,
    usage,
    error,
    setError,
    historyFailed,
    reopen,
    create,
    fresh,
    selector: selector ?? {
      provider: chat.provider,
      model: chat.model,
      effort: chat.effort,
      // 빠르게는 세션이 태어날 때 꺼진 채 시작한다.
      fastMode: false,
      fastModeBlocked: null,
      // Local cache first (it matches what this planner last saw), then the
      // daemon's own copy so a fresh browser still gets a real picker —
      // both keyed by the provider the next session will run on.
      models:
        catalog.length > 0 ? catalog : (daemon.status?.modelsByProvider?.[chat.provider] ?? []),
    },
    commands,
    setModel: switchModel,
    setEffort: switchEffort,
    pickProvider,
    chatProvider: chat.provider,
    remove,
    confirmRemove,
    cancelRemove,
    acceptRemove,
    clearAll,
    confirmClear,
    cancelClear,
    acceptClear,
    submit,
    branchFrom,
    sendTurn,
    queue,
    queueRemove,
    queueSendNow,
    dropped,
    takeDropped,
    dismissDropped,
    refresh,
    refreshUsage,
  };
}
