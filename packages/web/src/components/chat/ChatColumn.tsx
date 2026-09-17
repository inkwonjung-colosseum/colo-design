import type { DeveloperReview, SessionSummary } from "@colo-design/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { Fold, PermissionCard, PlanCard, QuestionCard, Transcript } from "../../components";
import type { Pins } from "../../hooks/usePins";
import type { Sessions } from "../../hooks/useSessions";
import type { Daemon } from "../../lib/daemon-client";
import { BUSY_SAVE } from "../../lib/delivery";
import { ownerRepoOf } from "../../lib/format";
import { handoffDraft } from "../../lib/handoff-draft";
import { composing } from "../../lib/ime";
import { PLAN_TOOL } from "../../lib/labels";
import { pinsToTurn, reviewToTurn } from "../../lib/preview-turns";
import { type MidTurnSend, type SendKey, saveHandledReview } from "../../lib/settings";
import { GENERIC_STARTERS } from "../../lib/suggestions";
import { blockOnTape } from "../../lib/tape-visibility";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";
import { CheckIcon, ChevronDownIcon, ExportIcon, EyeIcon, PencilIcon, TrashIcon } from "../icons";
import { TurnClock } from "../preview/TurnClock";
import { Tip } from "../shell/Tip";
import { SaveCard, type SaveCardStatus } from "../transcript/SaveCard";
import { type Attachment, Composer } from "./Composer";
import { ComposerChips } from "./ComposerChips";
import { HandoffCard } from "./HandoffCard";
import { SaveReviewBody } from "./SaveReviewBody";

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
  midTurnSend,
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
  onOpenSendSettings,
  onOpenProviderSettings,
}: {
  daemon: Daemon;
  sessions: Sessions;
  sendKey: SendKey;
  midTurnSend: MidTurnSend;
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
   * 사이클 동작 요청 (PageWorkspace 의 단일 통로): 상단 바의 저장·넘기기와
   * ⌘S 가 여기로 온다 — 모달이던 시절의 setSaveOpen 대신, 대화 안 카드가
   * 응답한다. nonce 가 오르면 한 번 집는다.
   */
  cycleRequest: { kind: "save" | "handoff" | "check"; nonce: number } | null;
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
  /** 컴포저 힌트의 `바꾸기` — 설정의 동작 칸으로 바로 연다. */
  onOpenSendSettings?: () => void;
  /** 모델 메뉴 헤더의 ⚙ — 설정의 프로바이더 칸으로 바로 연다. */
  onOpenProviderSettings?: () => void;
}) {
  const { api, pending, resolvePending } = daemon;
  const draftKey = sessions.activeId ?? `new:${daemon.activeSlug ?? "none"}`;
  /** This thread's turn-start snapshots, refetched when a turn ends. */
  const [checkpoints, setCheckpoints] = useState<Array<{ id: string; turn: number }>>([]);
  const [restoring, setRestoring] = useState(false);
  // 컴포저의 readAttachments 를 등록받아 대화 열 전체가 같은 손을 쓴다.
  // dragleave 는 자식 진입에도 발사되므로 깊이 카운터로 편렬을 잡는다.
  const attachFiles = useRef<((files: FileList | File[]) => void) | null>(null);
  const registerAttach = useCallback((fn: ((files: FileList | File[]) => void) | null) => {
    attachFiles.current = fn;
  }, []);
  const [dragDepth, setDragDepth] = useState(0);
  const [attachNonce, setAttachNonce] = useState(0);
  /** 빈 대화의 "붙여 시작하기" 칩 — 파일 고르기 + 문장 초안 한 번에. */
  const startWithAttachment = () => {
    setAttachNonce((nonce) => nonce + 1);
    setSeed({ text: "이걸 화면으로 만들어 줘", nonce: seed.nonce + 1 });
  };
  // 고쳐서 다시 보내기: the planner's own words return to the
  // composer for an edit; the nonce re-fires the seed on every click.
  const [seed, setSeed] = useState<{ text: string; nonce: number }>({
    text: "",
    nonce: 0,
  });
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

  // --- 저장 → (다시) 넘기기: 한 번의 클릭 (docs/plan/chat.md §4.1) --------
  // 반영·반려 뒤의 새 변경은 새 사이클이라 넘기기를 자동으로 잇지 않는다 —
  // `merged`·`closed` 는 "저장하기"만, 열린 요청(`open`·`changes_requested`)
  // 은 저장 뒤 handoff 로 이어 같은 요청을 갱신한다.
  const repo = daemon.repo;
  const pendingChanges = repo?.pendingChanges ?? 0;
  const handoff = repo?.handoff ?? null;
  const diffStage = daemon.diffStatus?.stage;
  const [savingNow, setSavingNow] = useState(false);
  const [saveMemo, setSaveMemo] = useState("");
  /** 답장 모드 — 사람 메시지의 `답하기`가 여는 컴포저 상태. 내면 api.replyToReview. */
  const [replyTo, setReplyTo] = useState<DeveloperReview | null>(null);
  /** 넘기기 카드 — 대화 안의 검토 자리. 상단 바·복도·⌘K 가 연다. */
  const [handoffOpen, setHandoffOpen] = useState(false);
  const runSave = useCallback(() => {
    if (savingNow) return;
    // 저장은 됐고 넘기기만 멈춘 카드의 다시 시도 — 저장을 다시 돌리지 않는다.
    const handoffOnly = diffStage === "failed" && daemon.diffStatus?.gate === "pr";
    // 열린 요청(open·changes_requested)은 저장 뒤 같은 요청을 갱신한다 —
    // "저장하고 다시 넘기기". 새 사이클(없음·반영됨·반려)은 저장만 하고
    // 넘기기는 완료 카드의 복도가 잇는다(states.md §2.2).
    const openCycle = handoff?.state === "open" || handoff?.state === "changes_requested";
    setSavingNow(true);
    void (
      handoffOnly
        ? api.handoff({ sessionId: activeId })
        : api
            .save(saveMemo.trim() || undefined, activeId)
            .then((status) =>
              openCycle && status.stage === "published"
                ? api.handoff({ sessionId: activeId })
                : status,
            )
    )
      .catch((e: Error) => showError(e.message))
      .finally(() => setSavingNow(false));
  }, [activeId, savingNow, handoff, api, saveMemo, showError, diffStage, daemon.diffStatus]);
  // 저장이 착지하면 메모 칸을 비운다 — 다음 사이클의 AI 제안이 다시 채운다.
  // 실패한 저장의 메모는 남는다: 고쳐 쓴 한 줄이 재시도에도 실려야 한다.
  useEffect(() => {
    if (diffStage === "published" || diffStage === "handed-off") setSaveMemo("");
  }, [diffStage]);
  /**
   * 사이클 요청의 응답 — 저장은 살아있는 카드로 스크롤(검토는 카드의 몸통),
   * 넘기기는 대화 안 카드를 연다. check 는 ScreenPanel 의 몫이라 여기선
   * 무시한다.
   */
  useEffect(() => {
    if (!cycleRequest) return;
    if (cycleRequest.kind === "save") scrollToSaveCard();
    else if (cycleRequest.kind === "handoff") setHandoffOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycleRequest]);
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
  // "지금 저장하기"의 원인이 되는 라벨 — 잠긴 이유는 ComposerChips 가
  // deriveDelivery 로 따로 읽는다; 여기는 버튼의 말만 고른다. 저장은 됐고
  // 넘기기만 멈춘 카드(gate:"pr")는 저장을 다시 돌리지 않는다.
  const handoffFailed = diffStage === "failed" && daemon.diffStatus?.gate === "pr";
  const saveLabel = handoffFailed
    ? "다시 넘기기"
    : handoff?.state === "open" || handoff?.state === "changes_requested"
      ? "저장하고 다시 넘기기"
      : "저장하기";
  const liveSaveStatus: SaveCardStatus | null =
    savingNow || diffStage === "computing" || diffStage === "pushing" || diffStage === "handing-off"
      ? "progress"
      : diffStage === "failed"
        ? "failed"
        : pendingChanges > 0
          ? "pending"
          : null;
  // 살아있는 대기 카드로 스크롤 + panelring 두 번(컴포저 칩·카드 버튼이 공유).
  const scrollToSaveCard = () => {
    const el = document.getElementById("live-savecard");
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  };
  const liveSaveHint = handoffFailed
    ? "저장은 끝났습니다 — 개발자에게 넘기는 일만 다시 시도합니다."
    : handoff?.state === "open" || handoff?.state === "changes_requested"
      ? "저장하고 넘기면 개발자가 이어서 확인해요. 저장 전에는 우리 팀 앱에 아무 표시도 남지 않아요."
      : "저장하면 이번 작업이 커밋됩니다 — 넘기기는 저장 뒤 카드에서 이어갑니다.";
  const liveFailDetail = handoffFailed
    ? (daemon.diffStatus?.detail ?? "넘기지 못했습니다.")
    : daemon.diffStatus?.reason === "push-auth"
      ? "GitHub 인증에 실패했습니다 — 설정에서 토큰을 확인해 주세요."
      : (daemon.diffStatus?.detail ?? "저장하지 못했습니다.");
  /**
   * 닫은 제안: 데몬은 한 문장을 한 번 보내고 잊지만, 계획자가 닫은
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
  /** The head's `···` menu, and the rename it can open. */
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

  // Checkpoints exist per completed turn: refetch when a turn
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

  /**
   * 되돌리기는 대화 삭제보다 조용히 위험하다 — 이후 턴들이 만든 화면까지
   * 통째로 이전으로 돌아간다. 삭제가 묻는데 되돌리기가 안 묻는 건 위험도가
   * 뒤집힌 것이니, 같은 ConfirmDialog 로 한 번 묻는다.
   */
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const restoreCheckpoint = (id: string) => {
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
  // the very deltas it is trying to catch up on.
  const jumpToLatest = () => {
    pinned.current = true;
    setUnpinned(false);
    bottom.current?.scrollIntoView();
  };
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
              autoFocus
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
                    <span className="selector__label">대화 보내기</span>
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
            starters={GENERIC_STARTERS}
            onStarterAttach={startWithAttachment}
            onStarter={(text) => setSeed({ text, nonce: seed.nonce + 1 })}
            checkpoints={checkpoints}
            onRestoreCheckpoint={(id) => setConfirmRestore(id)}
            showTools={showTools}
            onBackgroundTask={backgroundTask}
            onStopTask={stopTask}
            onRewind={
              daemon.status?.providers?.find((p) => p.id === sessions.selector?.provider)
                ?.capabilities?.rewind === true
                ? (turn, text) => void sessions.rewindAnswer(turn, text)
                : undefined
            }
            onFixReview={(reviews) => {
              for (const review of reviews) saveHandledReview(review.pr, review.id);
              onReviewsHandled();
              void sessions.submit(reviewToTurn(reviews), []);
            }}
            onReplyReview={(review) => setReplyTo(review)}
            saveCorridor={
              pendingChanges === 0 && (!handoff || handoff.state === "closed")
                ? { onHandoff: () => setHandoffOpen(true) }
                : null
            }
          />
          {/* 살아있는 저장 제안(§3.2): 완료된 저장은 daemon-client 의 "save"
              블록(cycle.saved 접힘)이 대신하므로, 이 카드는 대기·진행·실패
              세 상태에서만 뜬다 — 완료로 넘어가면 사라져 기록에 자리를 넘긴다. */}
          {liveSaveStatus && (
            <SaveCard
              id="live-savecard"
              status={liveSaveStatus}
              title="이번에 바뀐 것"
              sub={
                handoffFailed
                  ? "저장됨 · 넘기기에서 멈춤"
                  : `저장 전 · 바뀐 파일 ${pendingChanges}개`
              }
              review={
                // 넘기기 단계로 넘어가면 diff 는 이미 비었다 — 빈 검토가
                // "저장할 게 없다"고 거짓말하지 않게 몸통은 그때 내린다.
                diffStage === "handing-off" || diffStage === "handed-off" ? null : (
                  <SaveReviewBody daemon={daemon} memo={saveMemo} onMemo={setSaveMemo} />
                )
              }
              tagLabel={
                liveSaveStatus === "failed"
                  ? handoffFailed
                    ? "넘기기 실패"
                    : "저장 실패"
                  : liveSaveStatus === "progress"
                    ? diffStage === "handing-off"
                      ? "넘기는 중"
                      : "저장하는 중"
                    : "저장 대기"
              }
              tagTone={liveSaveStatus === "failed" ? "danger" : "warn"}
              hint={liveSaveHint}
              detail={liveSaveStatus === "failed" ? liveFailDetail : null}
              onRetry={liveSaveStatus === "failed" ? runSave : undefined}
              retryReason={sessions.running ? BUSY_SAVE : null}
              primary={{
                label: saveLabel,
                onClick: runSave,
                // 도는 턴 중의 저장 잠금 (docs/plan/chat.md §4.1 각주 1) —
                // 상단바·⌘S·지금 저장하기 칩이 이미 읽는 같은 규칙이다. 턴이
                // 워크트리에 쓰는 중에 커밋하면 반쯤 쓰인 파일이 저장된다.
                disabled: savingNow || sessions.running,
                reason: sessions.running ? BUSY_SAVE : undefined,
              }}
              secondary={{
                label: "더 고칠래요",
                onClick: () =>
                  document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(),
              }}
            />
          )}
          {/* 넘기기 카드 — 모달이 아니라 대화 안의 검토 자리(states.md §2.1).
              상단 바·저장 카드의 복도·⌘K 가 연다; Escape 는 접기일 뿐이다. */}
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
          {/* A turn's first seconds: the tape holds only the planner's words,
            so the start says itself — spinner + shimmer until blocks land.
            The tape speaks for itself the moment any agent block exists —
            any block the planner can actually SEE. 생각 과정이 꺼져 있으면
            생각만 도착한 턴은 테이프에 아무것도 그리지 않으므로, 그 블록은
            여기서도 도착한 셈에 들지 않는다. 그러지 않으면 AI 가 생각만
            하는 동안 화면이 통째로 조용해진다. */}
          {sessions.running &&
            !(active?.blocks ?? []).some(
              (block) => block.type !== "user" && blockOnTape(block, showThinking, showTools),
            ) && (
              <div className="turnlive" role="status">
                <span className="spinner" />
                작업 중
                {active?.turnStartedAt != null && <TurnClock startedAt={active.turnStartedAt} />}
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
                    // 카드는 데몬이 답을 받아들일 때까지 남는다 — 응답이
                    // 길에서 죽으면 결정이 사라진 채 카드만 닫히던 결함.
                    void api
                      .respondPermission(request.requestId, decision, message)
                      .then(() => {
                        resolvePending(request.requestId);
                        if (decision === "allow") sessions.afterPlanApproval();
                      })
                      .catch((e) => showError(e instanceof Error ? e.message : String(e)));
                  }}
                />
              ) : (
                <PermissionCard
                  key={request.requestId}
                  request={request}
                  onRespond={(decision, message) => {
                    void api
                      .respondPermission(request.requestId, decision, message)
                      .then(() => resolvePending(request.requestId))
                      .catch((e) => showError(e instanceof Error ? e.message : String(e)));
                  }}
                />
              )
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
        disabled={disabled}
        draftKey={draftKey}
        placeholder={placeholder}
        usage={sessions.usage}
        plan={daemon.status?.planUsage ?? null}
        planProviderLabel={
          daemon.status?.planUsage?.provider
            ? ((daemon.status?.providers ?? []).find(
                (p) => p.id === daemon.status?.planUsage?.provider,
              )?.label ?? null)
            : null
        }
        onRefreshUsage={sessions.refreshUsage}
        selector={sessions.selector}
        commands={sessions.commands}
        onSetModel={(model) => void sessions.setModel(model)}
        onSetEffort={(effort) => void sessions.setEffort(effort)}
        onSetPermissionMode={(mode) => void sessions.setPermissionMode(mode)}
        onSetMode={(mode) => void sessions.setMode(mode)}
        providers={
          sessions.activeId
            ? undefined
            : daemon.status?.providers?.filter((p) => !disabledProviders.includes(p.id))
        }
        onPickProvider={sessions.activeId ? undefined : sessions.pickProvider}
        running={sessions.running}
        stopping={stopping}
        queue={sessions.queue}
        dropped={sessions.dropped}
        onTakeQueued={sessions.takeQueued}
        onSendQueuedNow={sessions.sendQueuedNow}
        onClearQueue={() => void sessions.clearQueue()}
        onTakeDropped={sessions.takeDropped}
        onDismissDropped={sessions.dismissDropped}
        hurrying={sessions.hurrying}
        suggestion={suggestion}
        onDismissSuggestion={() => setHiddenSuggestion(active?.suggestion ?? null)}
        tasks={active?.tasks ?? []}
        onStopTask={stopTask}
        seed={seed}
        seedAttach={attachNonce}
        registerAttach={registerAttach}
        sendKey={sendKey}
        midTurnSend={midTurnSend}
        onOpenSendSettings={onOpenSendSettings}
        onOpenProviderSettings={onOpenProviderSettings}
        onToggleFastMode={(fast) => void sessions.setFastMode(fast)}
        onSend={async (text, attachments, sentPins) => {
          // 답장 모드: 사람 메시지의 `답하기`가 연 상태 — 컴포저의 말은
          // 새 턴이 아니라 개발자에게 가는 답이다.
          if (replyTo) {
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
          const name =
            !sessions.activeId && sentPins.length > 0 ? sentPins[0]!.screen : undefined;
          await sessions.submit(
            sentPins.length > 0 ? pinsToTurn(sentPins, text, () => null) : text,
            [...pinImages, ...attachments],
            { name },
            // 게이트 재배선: 이 턴이 가리킨 화면들 — 턴이 끝나면 기계가
            // 다시 열어 본다. 핀의 몫은 여기서, 캡처의 몫은 sendLook 에서.
            sentPins.map((pin) => ({ screen: pin.screen, state: pin.state })),
          );
          // 턴이 나갔으면 핀을 기록하고 비운다 — 실패해도 턴은 이미 나갔다.
          if (sentPins.length > 0) void pins.markSent(sentPins);
        }}
        pins={pins.list}
        pinNumberStart={pins.ghosts.length + 1}
        focusPinId={focusPinId}
        onPinRemove={pins.remove}
        onPinNote={pins.setNote}
        onPinIntent={pins.setIntent}
        // 행 클릭 → 오버레이 배지 강조.
        onPinFocus={(id) => void window.coloDesignDesktop?.preview?.pinFlash?.(id)}
        onInterrupt={stop}
        onFindFiles={(query) => api.findFiles(query)}
        composerChips={
          <ComposerChips
            pendingChanges={pendingChanges}
            branch={repo?.branch ?? null}
            phase={repo?.phase ?? null}
            handoff={handoff}
            running={sessions.running}
            shelf={repo?.shelf ?? null}
            onScrollToSave={scrollToSaveCard}
            onSaveNow={() => {
              scrollToSaveCard();
              runSave();
            }}
          />
        }
      />
      {confirmRestore && (
        <ConfirmDialog
          title="이 요청 이전으로 되돌리기"
          body={<>이 요청이 바꾼 화면 파일을, 이 요청이 시작하기 전 모습으로 되돌릴까요?</>}
          hint="그 뒤에 이어진 작업이 만든 화면까지 함께 돌아갑니다. 대화 기록은 그대로 남습니다."
          confirmLabel="되돌리기"
          onConfirm={() => {
            restoreCheckpoint(confirmRestore);
            setConfirmRestore(null);
          }}
          onClose={() => setConfirmRestore(null)}
        />
      )}
    </main>
  );
}
