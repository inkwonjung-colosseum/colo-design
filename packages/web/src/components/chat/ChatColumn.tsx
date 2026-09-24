import type {
  DeveloperReview,
  PlanUsage,
  SessionPinHint,
  SessionSummary,
} from "@colo-design/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { Fold, PermissionCard, QuestionCard, Transcript } from "../../components";
import type { Pins } from "../../hooks/usePins";
import type { Sessions } from "../../hooks/useSessions";
import type { Daemon } from "../../lib/daemon-client";
import { ownerRepoOf } from "../../lib/format";
import { handoffDraft } from "../../lib/handoff-draft";
import { composing } from "../../lib/ime";
import { pinsToTurn } from "../../lib/preview-turns";
import { isToolRunning } from "../../lib/progress";
import { type SendKey, saveHandledReview } from "../../lib/settings";
import { tailMoving } from "../../lib/tape-visibility";
import { CheckIcon, ChevronDownIcon, ExportIcon, EyeIcon, PencilIcon, TrashIcon } from "../icons";
import { TurnClock } from "../preview/TurnClock";
import { StateBanner } from "../StateBanner";
import { Tip } from "../shell/Tip";
import { type Attachment, Composer } from "./Composer";
import { HandoffCard } from "./HandoffCard";
import { WorkStrip } from "./WorkStrip";

/**
 * The middle column: one transcript, the cards that interrupt it, and the
 * composer under it. Everything about the session arrives as one `Sessions`;
 * the composer's pin attachments arrive as one `Pins` and leave
 * as one turn.
 */
export function ChatColumn({
  daemon,
  sessions,
  sendKey,
  placeholder,
  disabled,
  titleFor,
  onRenameSession,
  onDeleteSession,
  showThinking,
  showTools,
  disabledProviders,
  pins,
  focusPinId,
  cycleRequest,
  onReviewsHandled,
  onExportThread,
  onChatChange,
  onOpenProviderSettings,
  onOpenHistory,
}: {
  daemon: Daemon;
  sessions: Sessions;
  sendKey: SendKey;
  placeholder: string;
  disabled: boolean;
  /** The name a thread wears: the planner's rename, else the daemon's summary. */
  titleFor: (session: SessionSummary) => string;
  /** 클릭 · F2 이름 바꾸기 — 설정's store keeps it. */
  onRenameSession: (sessionId: string, title: string) => void;
  /** The head's `···` → 지우기: the transcript goes for good, one
      unconditional confirm on the way. */
  onDeleteSession: (session: SessionSummary) => void;
  /** 생각 과정 보기 (설정) — 꺼져 있으면 생각 블록은 테이프에서 빠진다. */
  showThinking: boolean;
  /** 작업 과정 보기 (설정) — 꺼져 있으면 도구 호출 묶음도 테이프에서 빠진다. */
  showTools: boolean;
  /** 설정에서 끈 프로바이더 — 새 대화의 칩 옵션에서도 빠진다. */
  disabledProviders: string[];
  /** The workspace's pins — sent with the turn, cleared by markSent. */
  pins: Pins;
  /** 배지 클릭 → 그 핀 행의 메모 입력 (PageWorkspace 가 흔든 상태). */
  focusPinId: { id: string; nonce: number } | null;
  /**
   * 사이클 동작 요청 (PageWorkspace 의 단일 통로): 상단 바의 제출·넘기기가
   * 여기로 온다 — 모달이던 시절의 setSaveOpen 대신, 대화 안 카드가 응답한다.
   * nonce 가 오르면 한 번 집는다. `check`·`history` 는 미리보기 쪽의 몫이라
   * 이 열은 지나친다.
   */
  cycleRequest: { kind: "submit" | "handoff" | "check" | "history"; nonce: number } | null;
  /** 고치기·답하기로 처리한 코멘트 — 상단 바의 `· 개발자 코멘트 N` 배지가
      같은 수를 다시 읽게 PageWorkspace 에 알린다. */
  onReviewsHandled: () => void;
  /**
   * ··· 메뉴의 대화보내기 — 활성 대화의 기록이 마크다운 파일로 나간다.
   * 없으면 행 자체가 없다(보낼 수 없는 자리).
   */
  onExportThread?: () => void;
  /** ··· 메뉴의 보기 스위치 — 설정의 대화 칸에도 있는 같은 값. */
  onChatChange?: (patch: { showThinking?: boolean; showTools?: boolean }) => void;
  /** 모델 메뉴 헤더의 ⚙ — 설정의 프로바이더 칸으로 바로 연다. */
  onOpenProviderSettings?: () => void;
  /** 정산 줄의 `작업 기록에서 되돌리기`(P2-2) — 미리보기 쪽 드로어를 연다. */
  onOpenHistory?: () => void;
}) {
  const { api, pending, resolvePending } = daemon;
  const draftKey = sessions.activeId ?? `new:${daemon.activeSlug ?? "none"}`;
  // 컴포저의 readAttachments 를 등록받아 대화 열 전체가 같은 손을 쓴다.
  // dragleave 는 자식 진입에도 발사되므로 깊이 카운터로 편렬을 잡는다.
  const attachFiles = useRef<((files: FileList | File[]) => void) | null>(null);
  const registerAttach = useCallback((fn: ((files: FileList | File[]) => void) | null) => {
    attachFiles.current = fn;
  }, []);
  // 테이프의 `고쳐서 다시 보내기`가 컴포저의 restore 손을 등록받는다 —
  // 미배선이면 버튼이 그려지지 않는다(Transcript 의 onResendEdit 가드).
  const resendRef = useRef<((text: string) => void) | null>(null);
  const registerResend = useCallback((fn: ((text: string) => void) | null) => {
    resendRef.current = fn;
  }, []);
  const [dragDepth, setDragDepth] = useState(0);
  const bottom = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLElement>(null);
  // 다시 보내기 이중 실행 가드: the failed-turn card's button
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
   * 작업 다루기: 턴 전체의 중지(위 `stop`)와 다른 손 — 그 작업
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

  // --- 제출: 한 번의 클릭 ------------------------------------------------
  const diffStage = daemon.diffStatus?.stage;
  const [savingNow, setSavingNow] = useState(false);
  /** 답장 모드 — 사람 메시지의 `답하기`가 여는 컴포저 상태. 내면 api.replyToReview. */
  const [replyTo, setReplyTo] = useState<DeveloperReview | null>(null);
  /** 넘기기 카드 — 대화 안의 검토 자리. 상단 바·복도·⌘K 가 연다. */
  const [handoffOpen, setHandoffOpen] = useState(false);
  /**
   * 제출 — 이번 작업을 묶어 개발자에게 넘긴다. P2-1 뒤로 계획자에게 남은
   * 유일한 손이다: 커밋은 턴이 끝날 때마다 데몬이 스스로 하므로 여기서 부르는
   * save 는 "남은 것까지 담고 푸시를 **기다린다**" 는 뜻이다 — 푸시 실패를
   * 게이트로 올리는 길은 이것뿐이다(자동 저장의 푸시는 백그라운드라 조용하다).
   * 넘기기의 제목·본문은 데몬이 정한 기본값으로 나가고, 직접 고치려는 길
   * (카드)은 파레트의 넘기기가 남긴다.
   */
  const runSubmit = useCallback(() => {
    if (savingNow || sessions.running) return;
    const handoffOnly = diffStage === "failed" && daemon.diffStatus?.gate === "pr";
    setSavingNow(true);
    void (
      handoffOnly
        ? api.handoff({ sessionId: activeId })
        : api
            .save(undefined, activeId)
            .then((status) =>
              status.stage === "published" ? api.handoff({ sessionId: activeId }) : status,
            )
    )
      .then((status) => {
        // E5: 영수증 — 제출이 무사히 끝나면 같은 자리에 카드가 '넘긴 내용'으로
        // 선다. 누른 손이 어디로 갔는지 한눈에: 링크·리뷰어·다음 소식.
        if (status.stage === "handed-off") setHandoffOpen(true);
        return status;
      })
      .catch((e: Error) => showError(e.message))
      .finally(() => setSavingNow(false));
  }, [activeId, savingNow, sessions.running, api, showError, diffStage, daemon.diffStatus]);
  /**
   * 사이클 요청의 응답 — 제출은 곧 제출(칩·상단 바가 같은 핸들러를 누른다),
   * 넘기기는 대화 안 카드를 연다. check 는 ScreenPanel 의 몫이라 여기선
   * 무시한다.
   */
  // 이 열은 홈에서 내렸다 다시 탄다 — 마지막으로 본 nonce 만 기억해
  // 재생을 묵살한다. 같은 nonce 를 다시 보는 것은 사용자 손이 아니라
  // 리마운트이니, nonce 가 실제로 바뀐 때만 응답한다.
  const cycleNonce = useRef(-1);
  useEffect(() => {
    if (!cycleRequest || cycleRequest.nonce === cycleNonce.current) return;
    cycleNonce.current = cycleRequest.nonce;
    if (cycleRequest.kind === "submit") runSubmit();
    else if (cycleRequest.kind === "handoff") setHandoffOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycleRequest, runSubmit]);
  // 넘기기 카드가 열리면 그 자리로 — 카드는 렌더 뒤에 생기니 한 박자 늦춘다.
  useEffect(() => {
    if (!handoffOpen) return;
    const el = document.getElementById("live-handoffcard");
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [handoffOpen]);
  /** 넘기기 카드의 목적지·초안 — 구 HandoffPanel 이 ScreenPanel 에서 읽던
      같은 계산을 대화 열이 이어받는다. */
  const destination = ownerRepoOf(
    daemon.projects.find((project) => project.slug === daemon.activeSlug)?.repoUrl ?? null,
  );
  const { title: proposedTitle, body: proposedBody } = handoffDraft(
    daemon.projects.find((project) => project.slug === daemon.activeSlug)?.name ?? "",
  );
  // 저장은 됐고 넘기기만 멈춘 실패(gate:"pr")는 저장을 다시 돌리지 않는다.
  const handoffFailed = diffStage === "failed" && daemon.diffStatus?.gate === "pr";
  // 실패 배너의 한 줄 — 카드가 없는 지금, 데몬이 diff.status 로 말하는
  // 실패가 사람에게 보이는 유일한 자리다.
  const saveFailDetail = handoffFailed
    ? (daemon.diffStatus?.detail ?? "넘기지 못했습니다.")
    : daemon.diffStatus?.reason === "push-auth"
      ? "연결 코드가 만료됐어요 — 개발자에게 새 코드를 요청하세요"
      : (daemon.diffStatus?.detail ?? "제출하지 못했습니다.");
  // 배너의 다시 제출하기가 runSubmit 을 직결로 부른다 — 상단 바 버튼과 달리
  // 이 길에는 사전 차단이 없어서, 턴 도중·저장 중 클릭이 조용히 묻혔다(베타
  // 테스트 B6의 잔여). 못 쓰는 순간 버튼이 스스로 이유를 말하게 한다.
  const retryBlockedByTurn = sessions.running;
  const retryBusy = savingNow || sessions.running;

  /**
   * 닫은 제안: 데몬은 한 문장을 한 번 보내고 잊지만, 계획자가 닫은
   * 칩은 이 창에서 다시 떠오르면 안 된다 — 무엇을 닫았는지는 창의 기억이다.
   */
  const [hiddenSuggestion, setHiddenSuggestion] = useState<string | null>(null);
  const suggestion =
    active?.suggestion && active.suggestion !== hiddenSuggestion ? active.suggestion : null;
  const visiblePending = pending.filter((request) => request.sessionId === activeId);
  /**
   * 테이프 꼬리의 움직임 — 도는 도구나 흐르는 말이 꼬리에 없으면(=tailMoving 이
   * 거짓이면) 턴이 도는 한 대기 표시가 선다. 첫 보이는 블록 전의 빈 자리만이
   * 아니라, 생각 과정이 숨겨진 채 생각만 흐르는 도구 사이의 침묵도 그 자리다
   * (실사 — 그 구간마다 스피너도 시계도 없이 화면이 통째로 조용해졌다).
   * 시계의 시작은 데몬의 turnStartedAt 이 주인이고, 방송 전의 빈 자리만
   * 보낸 순간이 임시로 잡는다.
   */
  const tailLive = tailMoving(active?.blocks ?? [], showThinking, showTools, isToolRunning);
  const awaitingHere = sessions.awaitingTurn?.sessionId === activeId ? sessions.awaitingTurn : null;
  const clockStart = active?.turnStartedAt ?? awaitingHere?.since ?? null;
  /** Whether the newest message is what the planner is looking at. */
  const pinned = useRef(true);
  /** Mirror of `pinned` for rendering — the pill is the scrolled-up reader's way back. */
  const [unpinned, setUnpinned] = useState(false);
  /** The head's `···` menu, and the rename it can open. */
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  /** The open thread's summary — the head renders only when one is open. */
  const activeSummary = activeId
    ? (sessions.list.find((session) => session.sessionId === activeId) ?? null)
    : null;
  /**
   * The account the composer is about to spend: the open session's provider,
   * or the one picked for the next session when no thread is open. The usage
   * chip reads that provider's budget first — claude's 43% and codex's are
   * different accounts, so the chip follows the composer, not whichever
   * account happened to be read last.
   */
  const composerProvider = sessions.selector?.provider ?? "claude";
  /**
   * One reading per enabled provider — the settings' "새 대화 목록" switch
   * decides which accounts the chip may show at all, and a provider whose
   * CLI is missing or whose account was never read simply has no row.
   */
  const planRows = (daemon.status?.providers ?? [])
    .filter((p) => p.available && !disabledProviders.includes(p.id))
    .map((p) => ({ id: p.id, plan: daemon.status?.planUsageByProvider?.[p.id], label: p.label }))
    .filter((row): row is { id: string; plan: PlanUsage; label: string } => row.plan != null)
    .sort((a, b) => Number(b.id === composerProvider) - Number(a.id === composerProvider));
  const plans = planRows.map(({ plan, label }) => ({ plan, label }));
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
  }, []);

  // A reader who scrolled up owns the scroll position; the transcript takes
  // it back only when they return to the bottom. Opening another thread is
  // a fresh look — its newest message is where a reader starts.
  useEffect(() => {
    pinned.current = true;
    setUnpinned(false);
  }, []);

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

  // the very deltas it is trying to catch up on.
  const jumpToLatest = () => {
    pinned.current = true;
    setUnpinned(false);
    bottom.current?.scrollIntoView();
  };
  // 컴포저 잠금의 사유 — disabled prop 은 이유를 모르는 채 잠그므로, 연결이
  // 닿아 있는지가 여기서 읽을 수 있는 유일한 원인이다. 끊긴 선 위의 보내기는
  // 어차피 실패하니 잠그고 이유를 보이는 쪽이 조용한 실패보다 낫다. 사유가
  // 여럿일 수 있어도 한 줄만 선다 — 연결이 가장 먼저다.
  const composerLockReason =
    daemon.connection === "closed" || daemon.connection === "error"
      ? "연결이 끊겼어요"
      : daemon.connection !== "open"
        ? "연결하는 중이에요"
        : null;
  const composerDisabled = disabled || composerLockReason !== null;
  return (
    <main
      className={`planner__chat${dragDepth > 0 ? " planner__chat--droptarget" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragDepth((depth) => depth + 1);
      }}
      onDragLeave={() => setDragDepth((depth) => Math.max(0, depth - 1))}
      onDrop={(event) => {
        event.preventDefault();
        setDragDepth(0);
        if (event.dataTransfer.files.length > 0) {
          attachFiles.current?.(event.dataTransfer.files);
        }
      }}
    >
      {activeSummary && (
        <header className="thread">
          {/* A turn in flight announces itself as light, not words: the lamp
              exists only while the daemon is streaming this thread's turn. */}
          {sessions.running && <span className="thread__lamp" aria-hidden />}
          {renaming ? (
            <input
              className="thread__rename"
              value={draft}
              aria-label="대화 이름"
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                // Enter that commits the hangul must not commit the rename.
                if (composing(event)) return;
                if (event.key === "Enter") commitRename();
                if (event.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <Tip
              label={`${titleFor(activeSummary)} — 클릭하면 이름을 바꿉니다`}
              side="bottom"
              align="start"
            >
              <button
                type="button"
                className="thread__title"
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
            </Tip>
          )}
          {/* 이 대화가 만든 화면 칩 waits for the data: nothing on the
              wire says which screens a thread made. Title and menu ship. */}
          <span className="thread__spacer" />
          <Tip label={menuOpen ? undefined : "대화 메뉴"} side="bottom" align="end">
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
          </Tip>
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
                {onExportThread && (
                  <button
                    type="button"
                    role="menuitem"
                    className="selector__row"
                    onClick={() => {
                      setMenuOpen(false);
                      onExportThread();
                    }}
                  >
                    <span className="ic">
                      <ExportIcon />
                    </span>
                    <span className="selector__label">대화 내보내기</span>
                  </button>
                )}
                {onChatChange && (
                  <>
                    <span className="node__pop__sep" aria-hidden="true" />
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={showThinking}
                      className="selector__row"
                      onClick={() => onChatChange({ showThinking: !showThinking })}
                    >
                      <span className="ic">
                        <EyeIcon />
                      </span>
                      <span className="selector__label">생각 과정 보기</span>
                      {showThinking && (
                        <span className="selector__hint">
                          <CheckIcon size={11} />
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={showTools}
                      className="selector__row"
                      onClick={() => onChatChange({ showTools: !showTools })}
                    >
                      <span className="ic">
                        <EyeIcon />
                      </span>
                      <span className="selector__label">작업 과정 보기</span>
                      {showTools && (
                        <span className="selector__hint">
                          <CheckIcon size={11} />
                        </span>
                      )}
                    </button>
                  </>
                )}
                <span className="node__pop__sep" aria-hidden="true" />
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
              <StateBanner
                tone="danger"
                role="alert"
                title={error}
                closeLabel="오류 닫기"
                onClose={() => setErrorClosing(true)}
              />
            </Fold>
          )}
          {/* 실사 결함: 기록 있는 대화가 조용히 빈 대화로 열렸다 — 실패가
              실패로 보이지 않았다. 카드가 그 사실을 말하고 다시 시도는 같은
              열기를 다시 묻는다. */}
          {sessions.historyFailed && !error && (
            <StateBanner
              tone="danger"
              role="alert"
              title="대화 기록을 읽지 못했습니다"
              sub="다시 시도로 다시 열어 주세요."
              action={{ label: "다시 시도", onClick: sessions.reopen }}
            />
          )}
          <Transcript
            /* 대화 신원이 곧 리마운트다 — 버블의 펼침·접힘 같은 로컬 상태가
               다른 대화로 새지 않는다. */
            key={activeId ?? "new"}
            blocks={active?.blocks ?? []}
            live={sessions.running}
            onRetry={retry}
            onResendEdit={(text) => resendRef.current?.(text)}
            showTools={showTools}
            onBackgroundTask={backgroundTask}
            onStopTask={stopTask}
            onBranch={
              daemon.status?.providers?.find((p) => p.id === sessions.selector?.provider)
                ?.capabilities?.branch === true
                ? (turn) => void sessions.branchFrom(turn)
                : undefined
            }
            onReplyReview={(review) => setReplyTo(review)}
            onDevReply={async (reviewId, text) => {
              await api.replyToReview(reviewId, text);
            }}
            onOpenHistory={onOpenHistory}
          />
          {/* 제출 · 넘기기 실패 — 카드가 물러난 지금, 데몬이 diff.status 로
              말하는 실패가 사람에게 보이는 자리다. 닫기는 없다: 실패는 다음
              시도가 시작되는 순간에만 사라진다(실패가 조용히 지워졌던 실사
              결함의 반대 판정). 재시도는 상단 바의 제출과 같은 핸들러다 —
              P2-1 뒤로 사람이 다시 누를 수 있는 손은 그것 하나다. */}
          {diffStage === "failed" && (
            <StateBanner
              tone="danger"
              role="alert"
              title={handoffFailed ? "넘기기에 실패했습니다" : "제출에 실패했습니다"}
              sub={saveFailDetail}
              action={{
                label: retryBlockedByTurn
                  ? "AI가 고치는 중"
                  : handoffFailed
                    ? "다시 넘기기"
                    : "다시 제출하기",
                disabled: retryBusy,
                onClick: runSubmit,
              }}
            />
          )}
          {/* 넘기기 카드 — 모달이 아니라 대화 안의 검토 자리.
              상단 바·복도·⌘K 가 연다; Escape 는 접기일 뿐이다. */}
          {handoffOpen && (
            <div id="live-handoffcard">
              <HandoffCard
                daemon={daemon}
                destination={destination}
                proposedTitle={proposedTitle}
                proposedBody={proposedBody}
                sessionId={activeId}
                onClose={() => setHandoffOpen(false)}
              />
            </div>
          )}
          {/* A turn's silence line — from the send click to the first
            visible block, and again in every quiet stretch after: 도구와
            도구 사이 모델이 생각만 하는 구간(생각 과정은 기본 숨김)에는
            테이프가 새로 그리는 것이 없다. The tape speaks for itself the
            moment a visible block lands or streams — 도는 도구의 막대,
            흐르는 말 — and this line stands only when nothing on it moves.
            그렇지 않으면 도는 턴이 스피너도 시계도 없는 화면으로 보인다. */}
          {(sessions.running || awaitingHere) && !tailLive && (
            <div className="turnlive" role="status" aria-label="작업 중">
              <span className="turnlive__dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              {clockStart != null && <TurnClock startedAt={clockStart} />}
            </div>
          )}
          {visiblePending.map((request) =>
            request.kind === "permission" ? (
              <PermissionCard
                key={request.requestId}
                request={request}
                // 레포가 정한 명령은 이름으로 읽힌다(P3-1): 이 prop 이 없으면
                // 같은 카드가 날 셸 줄(`pnpm run check`)을 머리에 세우고,
                // 비개발자에게 그것은 허용할지 말지를 정할 근거가 못 된다.
                // 홈 인박스는 이미 같은 값을 넘긴다 — 두 자리가 같은 말을 한다.
                commands={daemon.repo?.commands}
                onRespond={(decision, message) => {
                  void api
                    .respondPermission(request.requestId, decision, message)
                    .then(() => resolvePending(request.requestId))
                    .catch((e) => showError(e instanceof Error ? e.message : String(e)));
                }}
              />
            ) : (
              <QuestionCard
                key={request.requestId}
                request={request}
                onRespond={(answers, annotations) => {
                  void api
                    .respondQuestion(request.requestId, answers, annotations)
                    .then(() => resolvePending(request.requestId))
                    .catch((e) => showError(e instanceof Error ? e.message : String(e)));
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

      {/* 하위 작업 · 할 일의 목차 — 컴포저 위에 고정으로 선다. 테이프가
          아무리 길어져도 "몇 개가 도는지"는 여기서 한 번에 읽힌다. */}
      <WorkStrip blocks={active?.blocks ?? []} />

      {replyTo && (
        <div className="replybanner" role="status">
          <span className="replybanner__text">
            {replyTo.author}님의 코멘트에 답하기 — 내면 개발자에게 전달됩니다
          </span>
          <button type="button" className="replybanner__cancel" onClick={() => setReplyTo(null)}>
            취소
          </button>
        </div>
      )}

      <Composer
        disabled={composerDisabled}
        disabledReason={composerLockReason}
        draftKey={draftKey}
        placeholder={placeholder}
        usage={sessions.usage}
        plans={plans}
        onRefreshUsage={sessions.refreshUsage}
        selector={sessions.selector}
        commands={sessions.commands}
        onSetModel={(model) => void sessions.setModel(model)}
        onSetEffort={(effort) => void sessions.setEffort(effort)}
        // 프로바이더 재료는 열린 대화에서도 건네진다 — 뿌리 카드의 프로바이더
        // 행은 언제나 서고, 고름은 다음 새 대화부터 먹는다(스레드는 태어난
        // 프로바이더에 묶이므로 열린 대화를 바꾸지는 않는다).
        providers={daemon.status?.providers?.filter((p) => !disabledProviders.includes(p.id))}
        onPickProvider={sessions.pickProvider}
        nextProvider={sessions.chatProvider}
        providerLocked={sessions.activeId != null}
        running={sessions.running}
        stopping={stopping}
        queue={sessions.queue}
        onRemoveQueued={sessions.queueRemove}
        onSendQueuedNow={sessions.queueSendNow}
        dropped={sessions.dropped}
        onTakeDropped={sessions.takeDropped}
        onDismissDropped={sessions.dismissDropped}
        suggestion={suggestion}
        onDismissSuggestion={() => setHiddenSuggestion(active?.suggestion ?? null)}
        tasks={active?.tasks ?? []}
        onStopTask={stopTask}
        registerAttach={registerAttach}
        registerResend={registerResend}
        dev={daemon.status?.dev === true}
        sendKey={sendKey}
        onOpenProviderSettings={onOpenProviderSettings}
        onSend={async (text, attachments, sentPins, restoredScreens) => {
          // 답장 모드: 사람 메시지의 `답하기`가 연 상태 — 컴포저의 말은
          // 새 턴이 아니라 개발자에게 가는 답이다.
          if (replyTo) {
            // 답장 모드에는 첨부를 실어 보낼 길이 없다 — replyToReview 는
            // 문장만 받는다. 보낸 척 지나치면 붙인 그림이 필드 비움과 함께
            // 조용히 사라진다. 거절로 돌려 보내면 Composer 는 말을 지우지
            // 않고 경고 줄에 이유를 세운다.
            if (attachments.length > 0) {
              throw new Error("답장에는 파일을 첨부할 수 없습니다");
            }
            try {
              await api.replyToReview(replyTo.id, text);
            } catch (e) {
              showError(e instanceof Error ? e.message : String(e));
              // 다시 던진다 — Composer 가 실패를 알아야 보낸 말을 지우지
              // 않고, 답하기 배너도 그대로 남아 다시 시도할 수 있다.
              throw e;
            }
            // 답이 나간 코멘트는 처리된 것 — 상단 바의 `· 개발자 코멘트 N`
            // 배지가 같은 수를 다시 읽는다.
            saveHandledReview(replyTo.pr, replyTo.id);
            onReviewsHandled();
            setReplyTo(null);
            return;
          }
          // 핀과 문장은 한 턴으로: 본문이 목록을 실은 마커 턴이
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
          // 핀으로 처음 열리는 대화는 첫 핀의 화면 이름을 얻는다.
          const name = !sessions.activeId && sentPins.length > 0 ? sentPins[0]?.screen : undefined;
          // 빠른 수정: 핀의 정체를 데이터로도 실어 보낸다 — 데몬이 클론에서
          // `파일 후보:`를 찾아 턴에 얹는다. prose(마커 턴 본문)와 같은 말이지만
          // 데몬이 읽는 쪽이다. 영역 핀은 정체가 없다 — id 만 가면 검색이
          // 저절로 비워진다.
          const pinHints: SessionPinHint[] = sentPins.map((pin) => ({
            id: pin.id,
            // 핀의 화면(2026-09-22) — 정체 검색이 빈손일 때 관찰 지도의 열쇠다.
            screen: pin.screen,
            ...(pin.element.kind === "region"
              ? {}
              : {
                  ...(pin.element.text ? { text: pin.element.text } : {}),
                  ...(pin.element.owners?.length ? { owners: pin.element.owners } : {}),
                  ...(pin.element.attrs?.testId ? { testId: pin.element.attrs.testId } : {}),
                }),
          }));
          await sessions.submit(
            sentPins.length > 0 ? pinsToTurn(sentPins, text, () => null) : text,
            [...pinImages, ...attachments],
            { name },
            // 게이트 재배선: 이 턴이 가리킨 화면들 — 턴이 끝나면 기계가
            // 다시 열어 본다. 핀의 몫은 여기서, 캡처의 몫은 sendLook 에서.
            // 방에서 꺼낸·되살린 말의 화면도 같은 자리로 돌아온다(감사 C4) —
            // 그러지 않으면 되살린 말의 턴은 게이트 없이 끝난다.
            dedupeScreens([
              ...sentPins.map((pin) => ({ screen: pin.screen })),
              ...(restoredScreens ?? []),
            ]),
            sentPins.length > 0 ? pinHints : undefined,
          );
          // 턴이 나갔으면 핀을 기록하고 비운다 — 실패해도 턴은 이미 나갔다.
          if (sentPins.length > 0) void pins.markSent(sentPins);
        }}
        pins={pins.list}
        pinNumberStart={pins.ghosts.length + 1}
        focusPinId={focusPinId}
        onPinRemove={pins.remove}
        onPinNote={pins.setNote}
        // 행 클릭 → 오버레이 배지 강조.
        onPinFocus={(id) => void window.coloDesignDesktop?.preview?.pinFlash?.(id)}
        onInterrupt={stop}
        onFindFiles={(query) => api.findFiles(query)}
      />
    </main>
  );
}

/**
 * 같은 화면을 두 번 보내지 않는다 — 핀과 되살린 말이 같은 화면을
 * 가리킬 수 있고, 게이트는 어차피 한 번만 열어 본다(보내는 쪽에서도
 * 같은 화면은 한 번만 실운다 — 2026-09-21 상태 축 철거로 키는 화면뿐이다).
 */
function dedupeScreens(screens: Array<{ screen: string }>): Array<{ screen: string }> {
  const seen = new Set<string>();
  return screens.filter((row) => {
    if (seen.has(row.screen)) return false;
    seen.add(row.screen);
    return true;
  });
}
