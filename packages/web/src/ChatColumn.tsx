import type { ColoDesignScreen, SessionSummary } from "@colo-design/protocol";
import { useEffect, useRef, useState } from "react";
import { Composer } from "./Composer";
import { Fold, PermissionCard, PlanCard, QuestionCard, Transcript } from "./components";
import type { Daemon } from "./daemon-client";
import { ChevronDownIcon } from "./icons";
import type { MidTurnSend, SendKey } from "./settings";
import { suggestionsFromScreens } from "./suggestions";
import { PLAN_TOOL } from "./tool-names";
import type { Sessions } from "./useSessions";

/**
 * The middle column: one transcript, the cards that interrupt it, and the
 * composer under it. Everything about the session arrives as one `Sessions`.
 */
export function ChatColumn({
  daemon,
  sessions,
  sendKey,
  midTurnSend,
  placeholder,
  disabled,
  titleFor,
  onRenameSession,
  onDeleteSession,
  screens,
  showThinking,
}: {
  daemon: Daemon;
  sessions: Sessions;
  sendKey: SendKey;
  midTurnSend: MidTurnSend;
  placeholder: string;
  disabled: boolean;
  /** The name a thread wears: the planner's rename, else the daemon's summary. */
  titleFor: (session: SessionSummary) => string;
  /** 클릭 · F2 이름 바꾸기 (PLAN D59) — 설정's store keeps it. */
  onRenameSession: (sessionId: string, title: string) => void;
  /** The head's `···` → 지우기 (PLAN D76): the transcript goes for good, one
      unconditional confirm on the way. */
  onDeleteSession: (session: SessionSummary) => void;
  /** The screens the connected repo declares — the empty conversation's
      starter chips point at them instead of generic sentences. */
  screens: ColoDesignScreen[];
  /** 생각 과정 보기 (설정) — 꺼져 있으면 생각 블록은 테이프에서 빠진다. */
  showThinking: boolean;
}) {
  const { api, pending, resolvePending } = daemon;
  // 계획 먼저 (이번 턴 한정): armed 는 한 번의 보내기로 소비되고, 대화가
  // 바뀌면 자리를 비운다 — 다른 대화에 남의 자세가 묻지 않게.
  const [planArmed, setPlanArmed] = useState(false);
  const draftKey = sessions.activeId ?? `new:${daemon.activeSlug ?? "none"}`;
  useEffect(() => setPlanArmed(false), [draftKey]);
  /** This thread's turn-start snapshots (PLAN D52), refetched when a turn ends. */
  const [checkpoints, setCheckpoints] = useState<Array<{ id: string; turn: number }>>([]);
  const [restoring, setRestoring] = useState(false);
  // 고쳐서 다시 보내기 (PLAN D95): the planner's own words return to the
  // composer for an edit; the nonce re-fires the seed on every click.
  const [seed, setSeed] = useState<{ text: string; nonce: number }>({
    text: "",
    nonce: 0,
  });
  const bottom = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLElement>(null);
  const { active, activeId, error, setError } = sessions;
  /** 닫힘은 접힘이다(Fold) — 오류 줄 자체는 useSessions 의 데이터라 여기서
      접는 중만 간직한다. 새 오류는 접는 중이라도 다시 편다. */
  const [errorClosing, setErrorClosing] = useState(false);
  const showError = (message: string) => {
    setError(message);
    setErrorClosing(false);
  };
  /**
   * 실사 결함: 중지를 눌러도 응답이 돌아올 때까지 아무 일도 일어나지 않는 것처럼
   * 보였다. 클릭은 즉시 "정리 중…" 이 되고, 턴이 멈추면(데몬의 이행 보장이
   * 유예 안에 끊는다) 제자리로 돌아온다.
   */
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!sessions.running) setStopping(false);
  }, [sessions.running]);
  const stop = () => {
    if (!activeId) return;
    setStopping(true);
    void api.interrupt(activeId).catch(() => undefined);
  };
  const visiblePending = pending.filter((request) => request.sessionId === activeId);
  /** Whether the newest message is what the planner is looking at. */
  const pinned = useRef(true);
  /** Mirror of `pinned` for rendering — the pill is the scrolled-up reader's way back. */
  const [unpinned, setUnpinned] = useState(false);
  /** The head's `···` menu, and the rename it can open (PLAN D59). */
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  /** The open thread's summary — the head renders only when one is open. */
  const activeSummary = activeId
    ? (sessions.list.find((session) => session.sessionId === activeId) ?? null)
    : null;
  const beginRename = () => {
    if (!activeSummary) return;
    setMenuOpen(false);
    setDraft(titleFor(activeSummary));
    setRenaming(true);
  };
  const commitRename = () => {
    setRenaming(false);
    if (!activeSummary) return;
    const name = draft.trim();
    if (!name || titleFor(activeSummary) === name) return;
    onRenameSession(activeSummary.sessionId, name);
  };

  // Within one row of the bottom counts as watching the stream come in.
  const rememberPin = () => {
    const el = scroll.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    pinned.current = atBottom;
    setUnpinned(!atBottom);
  };

  // Deltas fold into the last block without changing its count, so keying on
  // the length lets a long answer stream in below the fold — the exact case
  // this follow exists for. The blocks array itself changes on every event;
  // the scroll is instant because a tail that animates keeps losing the
  // race against its own deltas.
  useEffect(() => {
    if (pinned.current) bottom.current?.scrollIntoView();
  }, [active?.blocks]);

  // A reader who scrolled up owns the scroll position; the transcript takes
  // it back only when they return to the bottom. Opening another thread is
  // a fresh look — its newest message is where a reader starts.
  useEffect(() => {
    pinned.current = true;
    setUnpinned(false);
  }, [activeId]);

  // The head's menu answers Escape like every menu in the app, and the
  // backdrop under it takes any click that misses the menu — the same rules
  // the composer's selector chips already keep.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // Checkpoints exist per completed turn (PLAN D52): refetch when a turn
  // settles or the thread changes, and offer the matching snapshot on each
  // answer. A failed fetch just leaves the buttons off.
  useEffect(() => {
    if (!activeId || sessions.running) return;
    let cancelled = false;
    void api
      .checkpoints()
      .then((list) => {
        if (!cancelled) {
          setCheckpoints(list.entries.filter((entry) => entry.sessionId === activeId));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeId, sessions.running, api]);

  const restoreCheckpoint = (id: string) => {
    if (restoring) return;
    setRestoring(true);
    void api
      .restoreCheckpoint(id)
      .then(() => api.checkpoints())
      .then((list) => {
        setCheckpoints(list.entries.filter((entry) => entry.sessionId === activeId));
        setRestoring(false);
      })
      .catch((e: Error) => {
        setRestoring(false);
        showError(e.message);
      });
  };
  // The pill jumps instantly, like the follow: an animated tail would race
  // the very deltas it is trying to catch up on.
  const jumpToLatest = () => {
    pinned.current = true;
    setUnpinned(false);
    bottom.current?.scrollIntoView();
  };
  return (
    <main className="planner__chat">
      {activeSummary && (
        <header className="thread">
          {/* A turn in flight announces itself as light, not words: the lamp
              exists only while the daemon is streaming this thread's turn. */}
          {sessions.running && <span className="thread__lamp" aria-hidden />}
          {renaming ? (
            <input
              className="thread__rename"
              value={draft}
              autoFocus
              aria-label="대화 이름"
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitRename();
                if (event.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <button
              type="button"
              className="thread__title"
              title={`${titleFor(activeSummary)} — 클릭하면 이름을 바꿉니다`}
              onClick={beginRename}
              onKeyDown={(event) => {
                if (event.key === "F2") {
                  event.preventDefault();
                  beginRename();
                }
              }}
            >
              {titleFor(activeSummary)}
            </button>
          )}
          {/* 이 대화가 만든 화면 칩 (D59) waits for the data: nothing on the
              wire says which screens a thread made. Title and menu ship. */}
          <span className="thread__spacer" />
          <button
            type="button"
            className="ghost thread__more"
            aria-label="대화 메뉴"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            ···
          </button>
          {menuOpen && (
            <>
              <button
                type="button"
                className="selector__backdrop"
                aria-label="메뉴 닫기"
                onClick={() => setMenuOpen(false)}
              />
              <span className="selector__menu thread__menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="selector__row"
                  onClick={beginRename}
                >
                  <span className="selector__label">이름 바꾸기</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="selector__row"
                  onClick={() => {
                    setMenuOpen(false);
                    onDeleteSession(activeSummary);
                  }}
                >
                  <span className="selector__label">지우기</span>
                </button>
              </span>
            </>
          )}
        </header>
      )}
      <div className="chatstack">
        <section className="scroll" ref={scroll} onScroll={rememberPin}>
          {error && (
            <Fold
              closing={errorClosing}
              onCollapsed={() => {
                setError(null);
                setErrorClosing(false);
              }}
            >
              <div className="notice notice--error">
                <span className="notice__text">{error}</span>
                <button
                  type="button"
                  className="notice__close"
                  aria-label="오류 닫기"
                  disabled={errorClosing}
                  onClick={() => setErrorClosing(true)}
                >
                  ×
                </button>
              </div>
            </Fold>
          )}
          {/* 실사 결함: 기록 있는 대화가 조용히 빈 대화로 열렸다 — 실패가
              실패로 보이지 않았다. 카드가 그 사실을 말하고 다시 시도는 같은
              열기를 다시 묻는다. */}
          {sessions.historyFailed && !error && (
            <div className="notice notice--error" role="alert">
              <span className="notice__text">
                대화 기록을 읽지 못했습니다 — 다시 시도로 다시 열어 주세요.
              </span>
              <button type="button" className="ghost" onClick={sessions.reopen}>
                다시 시도
              </button>
            </div>
          )}
          <Transcript
            blocks={active?.blocks ?? []}
            live={sessions.running || restoring}
            onRetry={(text) => sessions.submit(text, []).catch(() => undefined)}
            starters={suggestionsFromScreens(screens)}
            onStarter={(text) => setSeed({ text, nonce: seed.nonce + 1 })}
            checkpoints={checkpoints}
            onRestoreCheckpoint={restoreCheckpoint}
            showThinking={showThinking}
          />
          {/* A turn's first seconds: the tape holds only the planner's words,
            so the start says itself — spinner + shimmer until blocks land.
            The tape speaks for itself the moment any Claude block exists —
            any block the planner can actually SEE. 생각 과정이 꺼져 있으면
            생각만 도착한 턴은 테이프에 아무것도 그리지 않으므로, 그 블록은
            여기서도 도착한 셈에 들지 않는다. 그러지 않으면 Claude 가 생각만
            하는 동안 화면이 통째로 조용해진다. */}
          {sessions.running &&
            !(active?.blocks ?? []).some(
              (block) => block.type !== "user" && (showThinking || block.type !== "thinking"),
            ) && (
              <div className="turnlive" role="status">
                <span className="spinner" />
                작업 중…
              </div>
            )}
          {visiblePending.map((request) =>
            request.kind === "permission" ? (
              request.toolName === PLAN_TOOL ? (
                // 계획의 승인은 카드가 다르고, 승인의 뒷정리도 다르다 — 데몬이
                // 작업 모드로 되돌렸으니 칩과 대화의 권한 선택이 그 진실을 따라
                // 온다(계획만 세우기로 세운 대화는 승인 한 번으로 소비된다).
                <PlanCard
                  key={request.requestId}
                  request={request}
                  onRespond={(decision, message) => {
                    void api.respondPermission(request.requestId, decision, message);
                    resolvePending(request.requestId);
                    if (decision === "allow") sessions.afterPlanApproval();
                  }}
                />
              ) : (
                <PermissionCard
                  key={request.requestId}
                  request={request}
                  onRespond={(decision, message) => {
                    void api.respondPermission(request.requestId, decision, message);
                    resolvePending(request.requestId);
                  }}
                />
              )
            ) : (
              <QuestionCard
                key={request.requestId}
                request={request}
                onRespond={(answers) => {
                  void api.respondQuestion(request.requestId, answers);
                  resolvePending(request.requestId);
                }}
              />
            ),
          )}
          <div ref={bottom} />
        </section>
        {/* The scrolled-up reader's way back. It floats here, outside the
            scrolling element — inside it, it would drift away with the very
            content it covers. While a turn streams, the pill names what keeps
            landing below the fold instead of pointing at a place. */}
        {unpinned && (
          <button
            type="button"
            className={
              sessions.running ? "chatstack__pill chatstack__pill--live" : "chatstack__pill"
            }
            onClick={jumpToLatest}
          >
            {sessions.running ? "새 내용" : "맨 아래로"}
            <ChevronDownIcon />
          </button>
        )}
      </div>

      <Composer
        disabled={disabled}
        draftKey={draftKey}
        placeholder={placeholder}
        usage={sessions.usage}
        plan={daemon.status?.planUsage ?? null}
        onRefreshUsage={sessions.refreshUsage}
        selector={sessions.selector}
        commands={sessions.commands}
        onSetModel={(model) => void sessions.setModel(model)}
        onSetEffort={(effort) => void sessions.setEffort(effort)}
        onSetPermissionMode={(mode) => void sessions.setPermissionMode(mode)}
        running={sessions.running}
        stopping={stopping}
        queue={sessions.queue}
        dropped={sessions.dropped}
        onTakeQueued={sessions.takeQueued}
        onSendQueuedNow={sessions.sendQueuedNow}
        onDismissDropped={sessions.dismissDropped}
        seed={seed}
        sendKey={sendKey}
        midTurnSend={midTurnSend}
        planArmed={planArmed}
        onTogglePlanArmed={() => setPlanArmed((v) => !v)}
        onSend={(text, attachments) => {
          const sent = sessions.submit(text, attachments, planArmed);
          // 칩은 한 번의 보내기로 소비된다 — 다음 턴의 자세는 다시 고른다.
          if (planArmed) setPlanArmed(false);
          return sent;
        }}
        onInterrupt={stop}
        onFindFiles={(query) => api.findFiles(query)}
      />
    </main>
  );
}
