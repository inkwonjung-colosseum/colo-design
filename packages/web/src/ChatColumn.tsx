import type { ColoDesignScreen, SessionSummary } from "@colo-design/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Attachment, Composer } from "./Composer";
import { Fold, PermissionCard, PlanCard, QuestionCard, Transcript } from "./components";
import type { Daemon } from "./daemon-client";
import { ChevronDownIcon, PencilIcon, TrashIcon } from "./icons";
import { pinsToTurn } from "./preview-turns";
import type { MidTurnSend, SendKey } from "./settings";
import { suggestionsFromScreens } from "./suggestions";
import { blockOnTape } from "./tape-visibility";
import { PLAN_TOOL } from "./tool-names";
import type { Pins } from "./usePins";
import type { Sessions } from "./useSessions";

/**
 * The middle column: one transcript, the cards that interrupt it, and the
 * composer under it. Everything about the session arrives as one `Sessions`;
 * the composer's pin attachments (재설계 C1) arrive as one `Pins` and leave
 * as one turn (C2).
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
  showTools,
  pins,
  focusPinId,
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
  /** 작업 과정 보기 (설정) — 꺼져 있으면 도구 호출 묶음도 테이프에서 빠진다. */
  showTools: boolean;
  /** The workspace's pins (재설계 C1) — sent with the turn, cleared by markSent. */
  pins: Pins;
  /** 배지 클릭 → 그 핀 행의 메모 입력 (PageWorkspace 가 흔든 상태). */
  focusPinId: { id: string; nonce: number } | null;
}) {
  const { api, pending, resolvePending } = daemon;
  // The route id a pin carries → what the repo called the screen; the card,
  // the thread name and the tray rows all read this one rule (재설계 §3.6).
  const titleForScreen = useCallback(
    (screen: string) => screens.find((s) => s.route === `/${screen}`)?.title ?? screen,
    [screens],
  );
  const draftKey = sessions.activeId ?? `new:${daemon.activeSlug ?? "none"}`;
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
  // 다시 보내기 이중 실행 가드 (커미티 F-C2): the failed-turn card's button
  // walks straight into sessions.submit, not the composer — a double click
  // would resend the same words twice while the first is still in flight.
  const retrying = useRef(false);
  const retry = (text: string) => {
    if (retrying.current) return;
    retrying.current = true;
    sessions
      .submit(text, [])
      .catch(() => undefined)
      .finally(() => {
        retrying.current = false;
      });
  };
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
  /**
   * 작업 다루기 (PLAN D101): 턴 전체의 중지(위 `stop`)와 다른 손 — 그 작업
   * 하나만 세우거나, 턴을 붙잡은 작업을 뒤로 보낸다.
   */
  const stopTask = (taskId: string) => {
    if (!activeId) return;
    void api.stopTask(activeId, taskId).catch((e: Error) => showError(e.message));
  };
  const backgroundTask = (toolUseId: string) => {
    if (!activeId) return;
    void api.backgroundTask(activeId, toolUseId).catch((e: Error) => showError(e.message));
  };
  /**
   * 닫은 제안 (PLAN D99): 데몬은 한 문장을 한 번 보내고 잊지만, 계획자가 닫은
   * 칩은 이 창에서 다시 떠오르면 안 된다 — 무엇을 닫았는지는 창의 기억이다.
   */
  const [hiddenSuggestion, setHiddenSuggestion] = useState<string | null>(null);
  const suggestion =
    active?.suggestion && active.suggestion !== hiddenSuggestion ? active.suggestion : null;
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
                // Enter that commits the hangul must not also commit the
                // rename (isComposing, legacy keyCode 229 — 커미티 F-C1).
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
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
                  <span className="ic">
                    <PencilIcon />
                  </span>
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
                  <span className="ic ic--danger">
                    <TrashIcon />
                  </span>
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
            onRetry={retry}
            starters={suggestionsFromScreens(screens)}
            onStarter={(text) => setSeed({ text, nonce: seed.nonce + 1 })}
            checkpoints={checkpoints}
            onRestoreCheckpoint={restoreCheckpoint}
            showThinking={showThinking}
            showTools={showTools}
            onBackgroundTask={backgroundTask}
            onStopTask={stopTask}
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
              (block) => block.type !== "user" && blockOnTape(block, showThinking, showTools),
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
                onRespond={(answers, annotations) => {
                  void api.respondQuestion(request.requestId, answers, annotations);
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
        onTakeDropped={sessions.takeDropped}
        onDismissDropped={sessions.dismissDropped}
        hurrying={sessions.hurrying}
        suggestion={suggestion}
        onDismissSuggestion={() => setHiddenSuggestion(active?.suggestion ?? null)}
        activity={active?.activity}
        turnStartedAt={active?.turnStartedAt ?? null}
        tasks={active?.tasks ?? []}
        onStopTask={stopTask}
        seed={seed}
        sendKey={sendKey}
        midTurnSend={midTurnSend}
        onToggleFastMode={(fast) => void sessions.setFastMode(fast)}
        onSend={async (text, attachments, sentPins) => {
          // 핀과 문장은 한 턴으로 (재설계 C2): 본문이 목록을 실은 마커 턴이
          // 되고, 크롭은 이미지로 그대로 간다. 크롭을 첨부 맨 앞에 세운 것은
          // 데몬 thumbs(앞 6장 JPEG)가 카드 썸네일이 되기 때문이다.
          const pinImages: Attachment[] = sentPins.slice(0, 6).flatMap((pin) =>
            pin.shot
              ? [
                  {
                    kind: "image" as const,
                    name: `핀 ${pin.element.text || pin.element.component}`,
                    mediaType: pin.shot.mediaType,
                    data: pin.shot.data,
                    size: 0,
                  },
                ]
              : [],
          );
          // 핀으로 처음 열리는 대화는 첫 핀의 화면 이름을 얻는다 (M5).
          const name =
            !sessions.activeId && sentPins.length > 0
              ? (titleForScreen(sentPins[0]!.screen) ?? undefined)
              : undefined;
          await sessions.submit(
            sentPins.length > 0 ? pinsToTurn(sentPins, text, titleForScreen) : text,
            [...pinImages, ...attachments],
            { name },
          );
          // 턴이 나갔으면 핀을 기록하고 비운다 — 실패해도 턴은 이미 나갔다.
          if (sentPins.length > 0) void pins.markSent(sentPins);
        }}
        pins={pins.list}
        pinNumberStart={pins.ghosts.length + 1}
        focusPinId={focusPinId}
        titleForScreen={titleForScreen}
        onPinRemove={pins.remove}
        onPinNote={pins.setNote}
        onPinIntent={pins.setIntent}
        // 행 클릭 → 오버레이 배지 강조 (재설계 §3.9).
        onPinFocus={(id) => void window.coloDesignDesktop?.preview?.pinFlash?.(id)}
        onInterrupt={stop}
        onFindFiles={(query) => api.findFiles(query)}
      />
    </main>
  );
}
