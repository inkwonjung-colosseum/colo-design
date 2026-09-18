import type {
  ChangedFileLite,
  ColoDesignPinEnvelope,
  DeveloperReview,
  DiffFile,
  SessionState,
} from "@colo-design/protocol";
import { markTurn } from "@colo-design/protocol";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Fold, useFoldNotice } from "../../components";
import { useModalEscape, useModalFocus } from "../../hooks/use-modal-focus";
import { type Pins, pinsSync } from "../../hooks/usePins";
import type { Daemon } from "../../lib/daemon-client";
import { type Delivery, deriveDelivery } from "../../lib/delivery";
import { ownerRepoOf, timeAgo } from "../../lib/format";
import { linkClick, openLink } from "../../lib/open-link";
import { errorToTurn, lookToTurn, reviewToTurn } from "../../lib/preview-turns";
import { guidanceFor } from "../../lib/repo-guidance";
import {
  isReplyConfirmed,
  loadHandledReviews,
  markReplyConfirmed,
  markRepoPrepSeen,
  saveHandledReview,
} from "../../lib/settings";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";
import type { SettingsCategory } from "../dialogs/SettingsDialog";
import {
  ArchiveIcon,
  BranchIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CloseIcon,
  ExternalLinkIcon,
  EyeIcon,
  HandoffIcon,
  HistoryIcon,
  MinusIcon,
  PencilIcon,
  RefreshIcon,
  SaveIcon,
  TrashIcon,
  WarnIcon,
} from "../icons";
import { errorKindOf, ProgressPanel } from "../onboarding/RepoProgress";
import {
  type PreviewError,
  PreviewHost,
  type PreviewLocation,
  type PreviewTarget,
} from "../preview/PreviewHost";
import { HistoryDrawer } from "../shell/HistoryDrawer";
import { Tip } from "../shell/Tip";
import { ChangedFiles } from "./ChangedFiles";
import { FILE_STATUS_LABEL } from "./DiffPanel";

/**
 * 칩의 tone → leading 글리프 타일. delivery.ts 의 DeliveryTone 여섯 개가 전부다:
 * merged 는 이 UI 에서 몇 안 되는 발화 수단인 초록 계열(ok) — 사이클의 종착.
 * pending · changes 는 저장할 일·요청 계열
 * (warn), saved 는 아직 로컬인 가지(quiet), handed 는 개발자 검토 중(quiet).
 * 코멘트 전용 tone 은 없다 — 개발자의 말은 changes 가 운반한다.
 *
 * `none`(변경 없음)은 종착이 아니라 휴면이다 — 같은 초록 체크를 쓰면
 * 나침반의 첫 칸이 끝 칸의 훈장을 달고, 막 켠 앱의 첫 신호가 "완주"로
 * 읽힌다. 무채색 막대로 분리했다(styles.css 의 경고 문구가 색에 대해서는
 * 이미 같은 위험을 적어 뒀다).
 */
function chipGlyph(tone: Delivery["chip"]["tone"]): ReactNode {
  switch (tone) {
    case "none":
      return (
        <span className="ic ic--quiet">
          <MinusIcon />
        </span>
      );
    case "merged":
      return (
        <span className="ic ic--ok">
          <CircleCheckIcon />
        </span>
      );
    case "pending":
    case "changes":
      return (
        <span className="ic ic--warn">
          <PencilIcon />
        </span>
      );
    case "saved":
      return (
        <span className="ic ic--quiet">
          <BranchIcon />
        </span>
      );
    case "handed":
      return (
        <span className="ic ic--quiet">
          <EyeIcon />
        </span>
      );
    case "shelf":
      return (
        <span className="ic ic--quiet">
          <ArchiveIcon />
        </span>
      );
  }
}

/** 변경 점의 빈 값 — 같은 이유(렌더마다 새 배열)로 상수 하나. */
const NO_CHANGED_FILES: ChangedFileLite[] = [];
/** 버리기 확인의 ±수 — 헝크 본문의 +/− 줄만 센다 (헤더는 hunk.header 에 따로). */
function diffCounts(file: DiffFile): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  }
  return { added, removed };
}

/**
 * The workspace's right column: the connected repo clone rendered by its own
 * preview server, plus the three words over it — 저장, 개발자에게
 * 넘기기, and the status the cycle has reached (변경 있음 / 넘김 / 반영됨,
 * read mechanically off the repo). It owns repo readiness, both
 * dialogs, and knows nothing about sessions — a machine turn is handed up to
 * the shell, which decides which thread it lands in. The pins live in the
 * workspace's `usePins`; this panel only re-anchors their badges.
 *
 * It is also where the pin envelopes land: the pins the repo's overlay
 * posts come up through `Preview` and stay here — feeding the address
 * bar's proposals and the 넘기기 proposal — and the screen the planner
 * should be looking at lives here too, as `target`, set by the toolbar
 * alone.
 */
export function ScreenPanel({
  barSlot,
  daemon,
  onOpenSettings,
  onMachineTurn,
  pins,
  onPin,
  onPinFocus,
  turnState,
  sessionId = null,
  commentsOn,
  onCommentsMode,
  onCycleAction,
  cycleRequest,
  reviewsTick,
}: {
  /** 프레임 헤더가 내준 자리 — 사이클 바는 여기로 올라가 프로젝트 이름 옆에
      선다. null 이면 바는 그려지지 않는다(헤더가 없는 호출은 없다). */
  barSlot: HTMLDivElement | null;
  daemon: Daemon;
  onOpenSettings: (category?: SettingsCategory) => void;
  /**
   * Forward a machine-authored turn — the error banner's 고치기, a review's
   * 고치기, 화면 보여 주기, a failing gate's brief — into the working screen
   * thread. The panel does not know which thread that is; the shell resolves
   * it, creating one named after the ask if there is none yet. `attachments`
   * rides along: the look's frame. 이 길이 실은 화면은 게이트의 입력이 된다 —
   * 턴이 끝나면 기계가 그 화면을 다시 열어 본다 (게이트 재배선).
   *
   * Resolves true when the turn reached the thread; false when it did not
   * (the daemon refused it).
   */
  onMachineTurn: (
    turn: string,
    name?: string,
    attachments?: Array<{ name: string; mediaType: string; data: string }>,
    pins?: Array<{ screen: string; state: string | null }>,
  ) => Promise<boolean>;
  pins: Pins;
  /**
   * A pin landed from the overlay: the workspace files it and
   * waves the memo row's caret over — one gesture ends in typing, a second
   * click to reach the box is a second click for every pin they ever make.
   */
  onPin: (pin: ColoDesignPinEnvelope["pin"]) => void;
  /** 배지 클릭 — the workspace focuses that pin's memo input. */
  onPinFocus: (id: string) => void;
  /** State of the thread the machine turns went to. */
  turnState: SessionState;
  /**
   * The live thread a failing gate briefs: a failed check or build hands its
   * output to the agent as the next Korean turn, so a failed 저장 or 넘기기 is
   * not a dead end. Null when no thread is open — there is nobody to brief.
   */
  sessionId?: string | null;
  /**
   * 핀 모드 — the toggle's truth lives in the workspace now, so
   * ⌘⇧P and this toolbar write the same state. The panel draws and relays.
   */
  commentsOn: boolean;
  onCommentsMode: (on: boolean) => void;
  /**
   * 사이클 동작의 단일 통로 (PageWorkspace): 저장·넘기기·상태 확인 버튼은
   * 모달을 열지 않고 이 콜백으로 올라간다 — 저장·넘기기는 대화 안 카드가
   * 응답하고, 상태 확인은 아래 cycleRequest 로 되돌아온다.
   */
  onCycleAction: (kind: "save" | "handoff" | "check") => void;
  /** PageWorkspace 가 내린 사이클 요청 — 이 패널은 `check` 만 집는다. */
  cycleRequest: { kind: "save" | "handoff" | "check"; nonce: number } | null;
  /** 대화 열에서 처리된 개발자 코멘트 — 배지의 수를 다시 읽는 신호. */
  reviewsTick: number;
}) {
  const { connection, repo, api, projects, activeSlug } = daemon;
  const phase = repo?.phase ?? null;
  const ready = phase === "ready";
  const connectionLost = connection === "closed" || connection === "error";
  /**
   * A failed repo.sync is answered in this column, right above the preview
   * it could not bring up — the rail and the chat stay usable while it runs.
   */
  const syncError = useFoldNotice();
  /**
   * The turn's echo on the preview: while the agent works the column
   * wears a live hairline and the bar says 다시 그리는 중; the moment the turn
   * settles the stage pulses once — an answer's arrival is an event, not a
   * silent repaint.
   */
  const working = ready && turnState === "running";
  const [settleFlash, setSettleFlash] = useState(false);
  const wasWorking = useRef(false);
  useEffect(() => {
    if (wasWorking.current && !working) {
      setSettleFlash(true);
      const timer = setTimeout(() => setSettleFlash(false), 1100);
      wasWorking.current = working;
      return () => clearTimeout(timer);
    }
    wasWorking.current = working;
  }, [working]);
  /**
   * Which screen and state the preview shows. The toolbar is the pins'
   * only door, so the ask lives here beside it; the address bar's free
   * paths are asks too.
   */
  const [target, setTarget] = useState<PreviewTarget | null>(null);
  /**
   * Where the native view actually is — its own reports, not the ask.
   * The picker and the chips follow this, so an in-app link click moves them
   * too. Null on the browser path (the iframe cannot be asked).
   */
  const [location, setLocation] = useState<PreviewLocation | null>(null);
  /**
   * The ask and the view's word are facts about ONE preview. A project
   * switch changes `repo.root` in the same message that changes the url, so
   * both reset HERE, during render — before NativeHost's effects could
   * re-ride a stale ask onto the page of the project the planner switched
   * to. The page that comes back (kept by the desktop, exactly where it
   * was) reports its own location; nothing yanks it back to an older ask.
   */
  const previewRoot = repo?.root ?? null;
  const [askRoot, setAskRoot] = useState(previewRoot);
  if (askRoot !== previewRoot) {
    setAskRoot(previewRoot);
    setTarget(null);
    setLocation(null);
  }

  /** 저장 기록 도킹 패널 — 더 보기 ▾ 메뉴에서 열고 닫는다(토글). */
  const [historyOpen, setHistoryOpen] = useState(false);
  /** 도킹이 무대와 나란히 설 폭 — 좁으면 패널이 무대를 덮는 폴백(cover)으로. */
  const [historyCover, setHistoryCover] = useState(false);
  // 무대 줄은 콜백 참조로 받는다 — 패널이 준비 화면으로 먼저 뜨면(ref 를 한
  // 번 읽고 마는 효과) 줄이 나중에 그려져도 관측이 영영 안 달렸다. 줄이
  // 그려지는 순간 상태로 올라와 효과가 다시 달린다.
  const [stageRow, setStageRow] = useState<HTMLDivElement | null>(null);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  // The stage floor is ~320px and the pane ~348px — below ~700px of row the
  // two cannot stand side by side, and the pane joins the cover convention
  // instead: data-cover-stage freezes the view, honestly, like a modal did.
  useEffect(() => {
    if (!stageRow) return;
    const measure = () => setHistoryCover(stageRow.clientWidth < 700);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stageRow);
    return () => observer.disconnect();
  }, [stageRow]);
  /** 더 보기 ▾ 메뉴 — 점검·기록·버리기의 자리. */
  const [menuOpen, setMenuOpen] = useState(false);
  /** 변경 버리기 확인 — this app's dialog, with the file list it names. */
  const [discardConfirm, setDiscardConfirm] = useState(false);
  /** Paths the discard would throw away, read when the dialog opens. */
  const [discardFiles, setDiscardFiles] = useState<DiffFile[] | null>(null);
  // --- 개발자 코멘트: 상태 확인 이 읽어 온 개발자의 말 ----------
  const [devReviews, setDevReviews] = useState<DeveloperReview[] | null>(null);
  const [devPanelOpen, setDevPanelOpen] = useState(false);
  /** The row with an open 답하기 input. */
  const [devReplyFor, setDevReplyFor] = useState<number | null>(null);
  const [devReplyText, setDevReplyText] = useState("");
  useEffect(() => {
    // 초안은 행 하나의 것이지 패널의 것이 아니다 — 답하는 행을 옮기면 그 행의
    // 초안이 다른 행의 입력칸에 앉아 있으면 안 된다.
    setDevReplyText("");
  }, [devReplyFor]);
  /** The 답하기 that still owes the planner the GitHub-writes confirmation. */
  const [replyConfirmFor, setReplyConfirmFor] = useState<number | null>(null);
  const [devBusy, setDevBusy] = useState(false);
  const devPanelRef = useRef<HTMLDivElement>(null);
  useModalFocus(devPanelRef, devPanelOpen);
  // Escape 는 최상단 오버레이의 몫이다 — 위에 대화상자나 팔레트가 떠 있으면
  // 이 패널은 닫지 않는다. GitHub 쓰기 확인이 떠 있는 동안엔 아예 귀를 닫는다:
  // 그 확인의 Escape 다.
  useModalEscape(
    devPanelRef,
    () => setDevPanelOpen(false),
    devPanelOpen && replyConfirmFor === null,
  );
  useEffect(() => {
    if (!devPanelOpen) return;
    devPanelRef.current?.focus();
  }, [devPanelOpen]);
  // 기록이 거절당해도 침묵하지 않는다. 트레이는
  // 이미 비었고 턴은 나갔다(전달 우선) — 이 띠만이 왜 이번 사이클의 핀들이
  // 풀 리퀘스트 본문의 `### 수정 요청` 에서 빠지는지 말해 준다.
  useEffect(() => {
    if (pins.recordError) syncError.show(pins.recordError);
    // 띠는 사용자가 닫는다 — 여는 조건만 본다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins.recordError]);

  // The 더 보기 menu answers Escape; the backdrop under it takes missed clicks.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const sync = useCallback(() => {
    syncError.clear();
    void api.repoSync().catch((e: Error) => syncError.show(e.message));
  }, [api]);

  // 오버레이의 핀 그릇은 렌더마다 새로 만들지 않는다 — NativeHost 는 이
  // sync 객체가 바뀔 때마다 preview.pins 를 쏜다. 매 렌더의 새 배열은
  // 바뀌지 않아도 될 IPC 를 매번 일으킨다.
  const pinsFrame = useMemo(() => pinsSync(pins.ghosts, pins.list), [pins.ghosts, pins.list]);

  /**
   * The stopped screen's 다시 시작. Every bring-up reclaims the declared port
   * for the active project now, so a restart is a plain sync — the button
   * remains because the planner's next move after a stopped screen should
   * not depend on knowing that.
   */
  const restart = useCallback(() => {
    syncError.clear();
    void api.repoSync(true).catch((e: Error) => syncError.show(e.message));
  }, [api]);

  /**
   * 실패 카드의 AI 요청. 준비가 멈춘 자리는 다시 시도로는 같은 자리를
   * 도는 경우가 많으므로 해결의 문은 대화다: 카드가 실패를 읽은 표
   * (repo-guidance 의 agentAsk)를 브리프로 실어 대화에 넘긴다. 최신화
   * 충돌만 다르다 — 열려 있는 대화에는 repoRefresh 가 데몬의 충돌 브리프를
   * 실어 보내고(최신화와 같은 회선), 없으면 새 대화를 만들어 요청을 보낸다 —
   * 새 대화가 태어날 때의 준비 pull 이 충돌을 첫 과제로 넣는다. 정리 턴이
   * 끝나면 준비를 한 번 다시 시도한다 — 고침 턴 뒤의 자동 재시도와 같은
   * 형태로, 중지로 끊긴 턴 뒤에는 재시도가 없다.
   */
  const [askNote, setAskNote] = useState<string | null>(null);
  const askArmed = useRef(false);
  const askTurnRan = useRef(false);
  const askBusy = useRef(false);
  const askAgent = async () => {
    // 연타는 막는다 — 보내는 동안의 다시 누름은 겹친 요청이 거절로 돌아와
    // 앞 요청이 세워 둔 표식을 지우는 낙차를 남긴다(lookBusy 와 같은 규칙).
    if (askBusy.current) return;
    askBusy.current = true;
    try {
      const live = sessionId ? (daemon.sessions[sessionId]?.live ?? false) : false;
      const agent = guidanceFor(errorKind, repo?.detail ?? null).agent;
      if (!agent) return;
      setAskNote("AI에게 정리를 요청했습니다 — 대화에서 정리합니다.");
      if (errorKind === "conflict" && live) {
        void api.repoRefresh(sessionId).catch((e: Error) => syncError.show(e.message));
      } else {
        const delivered = await onMachineTurn(
          markTurn({ kind: "gate", step: agent.step }, agent.brief),
          agent.thread,
        );
        // 거절(클론 뿌리가 아예 없어 대화를 못 여는 경우 등)의 말은 이미
        // 대화쪽 오류 스트립이 한다 — 카드의 표식이 가지 않은 요청을 갔다고
        // 말하게 두지 않는다.
        if (!delivered) {
          setAskNote(null);
          return;
        }
      }
      askArmed.current = true;
    } finally {
      askBusy.current = false;
    }
  };
  useEffect(() => {
    if (phase === "ready") {
      // 첫 준비가 끝난 기기다 — 다음 준비부터 대기 카드는 이름만 말한다.
      markRepoPrepSeen();
      askArmed.current = false;
      setAskNote(null);
      return;
    }
    if (turnState === "running") {
      askTurnRan.current = true;
      return;
    }
    // 아직 살아 있는 턴 — 승인·질문 대기도 턴의 중간이다. 포트 정리나
    // pnpm 설치처럼 허가를 기다리는 고침 위로 준비 재시도를 쏘지 않는다.
    if (
      turnState === "starting" ||
      turnState === "waiting_permission" ||
      turnState === "waiting_question"
    ) {
      return;
    }
    if (!askArmed.current || !askTurnRan.current) return;
    askTurnRan.current = false;
    askArmed.current = false;
    const blocks = sessionId ? (daemon.sessions[sessionId]?.blocks ?? []) : [];
    const last = blocks[blocks.length - 1];
    if (last?.type === "turn" && last.subtype === "interrupted") {
      setAskNote(null);
      return;
    }
    setAskNote("정리가 끝났습니다 — 준비를 다시 시도합니다…");
    void api
      .repoSync()
      .catch((e: Error) => syncError.show(e.message))
      .finally(() => setAskNote(null));
    // The gate retry's own shape: refs and the daemon's session views are
    // read live; the settles this answers are what the deps carry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnState, phase, sessionId]);

  /**
   * 레포 최신화: the planner's pull of the developer's side, pressed from
   * this bar. Unsaved changes are the daemon's to carry; a conflict is
   * the agent.s, briefed into the open thread like a failing gate.
   */
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(() => {
    setRefreshing(true);
    void api
      .repoRefresh(sessionId)
      .catch((e: Error) => syncError.show(e.message))
      .finally(() => setRefreshing(false));
  }, [api, sessionId]);
  /** 상태 확인의 빈 답 — 내용 영역의 띠 대신 누른 버튼 곁의 한 줄. 같은
   * 말을 다시 싣으면 이전 타이머를 지운다 — 답이 온전히 6 초를 살게. */
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const checkNoteTimer = useRef<number | null>(null);
  const showCheckNote = useCallback((text: string) => {
    setCheckNote(text);
    if (checkNoteTimer.current !== null) window.clearTimeout(checkNoteTimer.current);
    checkNoteTimer.current = window.setTimeout(() => setCheckNote(null), 6_000);
  }, []);

  /** 넘기기 단계의 상태 다시 확인: GitHub 의 답을 다시 읽어 칩과 스테퍼에
   * 반영한다. quiet 재사용: 데이터만 갱신하고
   * 패널은 열지 않는다 — 프로젝트가 활성화될 때 조용히 한 번 읽어, 며칠
   * 전 넘긴 요청의 칩이 마지막 클릭에 묶여 "개발자 검토 중"에 멈춰
   * 있지 않게 한다. 열린 넘김이 없으면 데몬이 바로 돌려준다. */
  const readHandoffState = useCallback(
    (quiet: boolean) => {
      const prevState = repo?.handoff?.state ?? null;
      void api
        .handoffStatus()
        .then(async (report) => {
          // 열린 넘김이 없으면 데몬의 답은 null 이다 — "확인할 것이 없다"까지가
          // 대답이지 확인의 실패가 아니다. null 을 그대로 읽으면 이 읽기는 매번
          // 예외로 끝나고, 조용한 재사용(마운트·포커스)은 예외를 삼키므로 마지막
          // 확인 시각이 영영 비게 된다 — 넘기기 없는 프로젝트의 칩 메뉴가
          // "이 창에서는 아직 확인하지 않았습니다"를 못 빠져 나온 이유다.
          const reviews = report?.reviews ?? [];
          const state = report?.state ?? null;
          setDevReviews(reviews);
          setLastCheckAt(new Date());
          setHandledTick((tick) => tick + 1);
          if (!quiet) {
            // 빈 확인: 읽을 코멘트가 없고 상태도
            // 그대로면 모달을 열지 않는다 — 빈 모달은 "내가 뭘 잘못 눌렀나"로
            // 읽힌다. 병합 착지는 여전히 이 버튼(과 데몬의 handoffStatus)이
            // 수행한다; 여기서 줄어드는 것은 패널을 여는 일뿐이다.
            const prKey = reviews[0]?.pr;
            const handled =
              prKey !== undefined
                ? new Set(loadHandledReviews(prKey).map((id) => Number(id)))
                : new Set<number>();
            const unhandled = reviews.filter((review) => !handled.has(review.id)).length;
            if (unhandled > 0) {
              // 읽을 말이 있을 때만 방이 열린다 — 상태 확인의 답이 코멘트라면
              // 모달이 곧 답이다.
              setDevPanelOpen(true);
            } else if (state !== prevState) {
              // 상태만의 이동 — 방은 열지 않는다. 새 말은 칩이 입고
              // (role=status 라이브 리전), 이 노트는 어디를 보라는지만 말한다.
              showCheckNote("상태가 바뀌었습니다 — 왼쪽 상태 칩을 확인해 주세요");
            } else {
              showCheckNote("방금 확인함 · 변화 없음");
            }
          }
          await api.repoStatus();
        })
        .catch((e: Error) => {
          if (!quiet) syncError.show(e.message);
        });
    },
    [api, repo?.handoff?.state, showCheckNote],
  );
  useEffect(() => {
    readHandoffState(true);
  }, [readHandoffState, daemon.activeSlug]);

  // PageWorkspace 의 사이클 요청 — 이 패널은 `check` 만 집는다
  // (저장·넘기기는 대화 안 카드의 몫). 마지막 nonce 를 기억해 재생을
  // 묵살한다 — 이 패널도 홈에서 내렸다 다시 타는데, 다시 탈 때마다
  // 조용하지 않은 확인(false)이 코멘트 모달까지 열어버리던 결함.
  const checkNonce = useRef(-1);
  useEffect(() => {
    if (cycleRequest?.kind !== "check" || cycleRequest.nonce === checkNonce.current) return;
    checkNonce.current = cycleRequest.nonce;
    readHandoffState(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycleRequest]);

  // 상태 판정은 이른 계산이다 — 훅들이 early
  // return 보다 먼저 이 값을 본다(merged 펄스·강조 이동). 순수 계산이라
  // 위치를 옮기는 것 외에 달라지는 것이 없다.
  const handoff = repo?.handoff ?? null;
  const delivery = deriveDelivery({
    pendingChanges: repo?.pendingChanges ?? 0,
    branch: repo?.branch ?? null,
    handoff,
    running: turnState === "running",
    phase,
    shelf: repo?.shelf ?? null,
  });
  // --- 보낸 화면 동결 (preview.md §1-E) ----------------
  // 넘긴 사이클이 서 있는 동안 스테이지는 얼린 얼굴을 쓴다 — PreviewHost 는
  // 입히기만 하고, 무엇을 얼리는지는 delivery 를 소유한 이 패널이 정한다.
  // 샷의 존재 여부는 따로 묻지 않는다: `handoffShot` 의 null 답이 곧
  // "이 화면은 보낸 캡처가 없다" 이다 — 넘긴 화면 목록은 데몬의
  // captureTargets(코멘트 경로)이 만들고, 웹은 지금 보는 화면의 route·state
  // 로 한 장씩 묻는다.
  const handoffState = handoff?.state ?? null;
  const frozenCycle =
    handoffState === "open" ||
    handoffState === "changes_requested" ||
    handoffState === "merged" ||
    handoffState === "closed";
  const frozenWhere = location?.path ?? (target?.kind === "path" ? target.path : "/");
  const [frozenRoute = "/", frozenQuery = ""] = frozenWhere.split("?");
  const frozenState = new URLSearchParams(frozenQuery).get("state");
  const [frozenShot, setFrozenShot] = useState<{ mediaType: string; data: string } | null>(null);
  const frozenShotKey = `${handoff?.number ?? ""}|${frozenRoute}|${frozenState ?? ""}`;
  useEffect(() => {
    if (!frozenCycle) {
      setFrozenShot(null);
      return;
    }
    let cancelled = false;
    setFrozenShot(null);
    void api
      .handoffShot(frozenRoute, frozenState)
      .then((shot) => {
        if (!cancelled) setFrozenShot(shot);
      })
      .catch(() => {
        if (!cancelled) setFrozenShot(null);
      });
    return () => {
      cancelled = true;
    };
    // frozenShotKey 가 route·state·PR 번호를 다 품는다 — 셋은 읽기 편의로
    // 나란히 둔다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, frozenCycle, frozenShotKey]);
  // 얼굴의 기본값: 넘기고 손 안 댄 사이클은 보낸 화면이 먼저다. 새 작업이
  // 시작되면(pendingChanges > 0) 얼린 화면을 보여 주는 것은 거짓말이라
  // 지금 화면으로 돌아온다 — 되돌아가는 것은 세그먼트의 몫이다.
  const [frozenMode, setFrozenMode] = useState<"sent" | "live">("live");
  const [frozenStampGone, setFrozenStampGone] = useState(false);
  const frozenCycleKeyRef = useRef<string | null>(null);
  const frozenCycleKey = `${handoff?.number ?? ""}|${handoffState ?? ""}`;
  if (frozenCycleKeyRef.current !== frozenCycleKey) {
    frozenCycleKeyRef.current = frozenCycleKey;
    setFrozenMode(
      (handoffState === "open" || handoffState === "changes_requested") &&
        (repo?.pendingChanges ?? 0) === 0
        ? "sent"
        : "live",
    );
    setFrozenStampGone(false);
  }
  useEffect(() => {
    if (frozenCycle && (repo?.pendingChanges ?? 0) > 0) setFrozenMode("live");
  }, [frozenCycle, repo?.pendingChanges]);
  // 도장의 시각: 테이프의 cycle.handed 마일스톤이 PR 번호로 찾는 유일한
  // 원천이다 — HandoffStatus 에 handedAt 이 없다(설계의 새 필드, 미구현).
  // 못 찾으면 시각 없는 도장으로 떨어진다.
  const handedAt = useMemo(() => {
    if (!handoff) return null;
    for (const view of Object.values(daemon.sessions)) {
      for (const block of view.blocks) {
        if (
          block.type === "milestone" &&
          block.subtype === "handed" &&
          block.pr === handoff.number
        ) {
          return block.at;
        }
      }
    }
    return null;
  }, [daemon.sessions, handoff]);
  const sentAgo = handedAt ? timeAgo(Date.parse(handedAt)) : "";
  const frozenStamp =
    handoffState === "merged"
      ? "실제 앱 · 반영된 화면"
      : handoffState === "closed"
        ? "반려된 화면"
        : sentAgo === ""
          ? "보낸 화면"
          : sentAgo === "방금"
            ? "방금 보낸 화면"
            : `${sentAgo}에 보낸 화면`;
  const frozenTone: "info" | "ok" | "warn" =
    handoffState === "merged" ? "ok" : handoffState === "closed" ? "warn" : "info";
  // 반영됨 도장은 6 초만 산다 — 종착의 인사지 새 상태가 아니다.
  useEffect(() => {
    if (handoffState !== "merged") return;
    const timer = window.setTimeout(() => setFrozenStampGone(true), 6_000);
    return () => window.clearTimeout(timer);
  }, [handoffState]);
  const frozen =
    frozenCycle && !frozenStampGone
      ? {
          shot: frozenShot,
          stamp: frozenStamp,
          tone: frozenTone,
          mode: frozenMode,
          // 눌러도 없는 것은 버튼이 아니다 — 샷이 있을 때만 왕복 손잡이를 단다.
          ...(frozenShot !== null ? { onMode: setFrozenMode } : {}),
        }
      : null;

  // 되돌릴 수 없는 동작의 행선 — 회사가
  // 부르는 이름(owner/repo)로, git 어휘는 아니다.
  const activeProject = projects.find((project) => project.slug === activeSlug) ?? null;
  const destination = ownerRepoOf(activeProject?.repoUrl ?? null);

  // --- 하루 한 프로젝트에 머무는 창도 본다 ---
  // 활성화 트리거는 프로젝트를 바꿀 때만 오므로, 같은 프로젝트에 하루 종일
  // 앉은 창은 며칠 전 병합을 알 방법이 없었다. 돌아온 창(focus·다시 보임)은
  // 5분 스로틀로 조용히 다시 읽는다 — 도는 턴·받아오기 중에는 손대지 않는다
  // (handoffStatus 는 병합이 보이면 체크아웃까지 하는 능동적 읽기다).
  const lastQuietRead = useRef(0);
  useEffect(() => {
    const reread = () => {
      if (document.visibilityState !== "visible") return;
      if (turnState === "running" || refreshing) return;
      if (Date.now() - lastQuietRead.current < 5 * 60_000) return;
      lastQuietRead.current = Date.now();
      readHandoffState(true);
    };
    window.addEventListener("focus", reread);
    document.addEventListener("visibilitychange", reread);
    return () => {
      window.removeEventListener("focus", reread);
      document.removeEventListener("visibilitychange", reread);
    };
  }, [readHandoffState, turnState, refreshing]);

  // --- 종착의 한 박자, 강조의 이동 목격 -------------
  // 펄스의 키는 state 다 — tone 은 도는 동안 pending 으로 덮어 쓰이므로 tone
  // 을 보면 병합된 사이클의 매 턴 끝마다 다시 운다. 강조 이동은 막대에 아무
  // 것도 더하지 않는다: 이미 옮겨 다니던 primary 를 목격시킬 뿐.
  const [mergedFlash, setMergedFlash] = useState(false);
  const [beatPrimary, setBeatPrimary] = useState<Delivery["primary"]>(null);
  const prevCycle = useRef<{ state: string | null; primary: Delivery["primary"] }>({
    state: null,
    primary: null,
  });
  useEffect(() => {
    const state = delivery?.state ?? null;
    const primary = delivery?.primary ?? null;
    const prev = prevCycle.current;
    prevCycle.current = { state, primary };
    if (state === null || prev.state === null) return;
    if (state === "merged" && prev.state !== "merged") {
      setMergedFlash(true);
      // 사이드바 배지(다른 컴포넌트)도 같은 박자로 — 데이터는 소켓이 이미
      // 옮겼고, 이 이벤트는 오직 리듬을 맞추는 신호다.
      window.dispatchEvent(new CustomEvent("colo-design:merged", { detail: { slug: activeSlug } }));
      const timer = window.setTimeout(() => setMergedFlash(false), 1200);
      return () => clearTimeout(timer);
    }
    if (primary !== null && primary !== prev.primary) {
      setBeatPrimary(primary);
      const timer = window.setTimeout(() => setBeatPrimary(null), 1100);
      return () => clearTimeout(timer);
    }
  }, [delivery?.state, delivery?.primary, activeSlug]);

  // --- 칩 옆의 지도 — 물어볼 때만 나온다 ------------
  // 칩 자체는 role="status" 라이브 리전으로 남는다(갱신 낭독 보존). 지도 버튼은
  // 그 옆의 조용한 트리거다.
  const [statusOpen, setStatusOpen] = useState(false);
  const [lastCheckAt, setLastCheckAt] = useState<Date | null>(null);
  useEffect(() => {
    if (!statusOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setStatusOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [statusOpen]);

  // --- 개발자 코멘트의 동작 ---------------------------------------
  // 고치기 는 마커 턴(리뷰 카드)으로, 답하기 는 GitHub 의 스레드/이슈로.
  // 처리한 것은 표식이 남어 배지가 조용해진다.
  const [handledTick, setHandledTick] = useState(0);
  /** 펼쳐 읽은 개발자 코멘트: "모두 AI에게"는
   * 전부 읽은 뒤에만 눌린다 — 개발자의 말에 "이 방향은 접자"가 섞여 있으므로. */
  const [readReviews, setReadReviews] = useState<Set<number>>(new Set());
  const handledIds = new Set(
    devReviews && devReviews.length > 0 && devReviews[0]
      ? loadHandledReviews(devReviews[0].pr).map((id) => Number(id))
      : [],
  );
  void handledTick;
  // 대화 열의 고치기·답하기가 처리한 코멘트도 같은 표식을 쓴다 —
  // reviewsTick 이 오르면 배지의 수를 다시 읽는다.
  void reviewsTick;
  const unhandledDevReviews = (devReviews ?? []).filter((review) => !handledIds.has(review.id));
  const unreadReviews = unhandledDevReviews.filter((review) => !readReviews.has(review.id));

  const handleReview = async (reviews: DeveloperReview[]) => {
    const delivered = await onMachineTurn(reviewToTurn(reviews));
    // 거절(아직 대화가 없어 열지 못한 경우 등)에는 표식을 찍지 않는다 —
    // askAgent 의 규칙과 같다. 표식이 먼저 가면 배지는 줄고 행은 'AI에게
    // 보냄'으로 읽히는데 정작 나간 것이 없다.
    if (!delivered) return;
    for (const review of reviews) saveHandledReview(review.pr, review.id);
    setHandledTick((tick) => tick + 1);
  };

  const sendDevReply = async (review: DeveloperReview) => {
    const text = devReplyText.trim();
    if (!text || devBusy) return;
    setDevBusy(true);
    try {
      await api.replyToReview(review.id, text);
      saveHandledReview(review.pr, review.id);
      setHandledTick((tick) => tick + 1);
      setDevReplyFor(null);
      setDevReplyText("");
    } catch (e) {
      syncError.show(e instanceof Error ? e.message : String(e));
    } finally {
      setDevBusy(false);
    }
  };

  /** 버리기: the confirm dialog's only action — the menu item only opens it. */
  const discard = useCallback(() => {
    setDiscardConfirm(false);
    void api
      .discard()
      .then(() => api.repoStatus())
      .catch((e: Error) => syncError.show(e.message));
  }, [api]);

  /**
   * The menu item: opens the dialog and reads the diff beside it, so the
   * planner sees the list of files the 버리기 would throw away —
   * not just a count.
   */
  const askDiscard = useCallback(() => {
    setDiscardFiles(null);
    setDiscardConfirm(true);
    void api
      .diff()
      .then((files) => setDiscardFiles(files))
      .catch(() => setDiscardFiles(null));
  }, [api]);

  /**
   * 잠깐 치워두기 · 꺼내기: the third door's two
   * turns — the same error surface 버리기 uses, so a refusal (slot full ·
   * nothing unsaved · dirty desk) reads as one sentence, not a dead button.
   */
  const putAway = useCallback(() => {
    void api
      .shelve()
      .then(() => api.repoStatus())
      .catch((e: Error) => syncError.show(e.message));
  }, [api]);
  // 꺼내기의 충돌은 이 대화의 첫 과제다 — sessionId 를 함께 보내는 것이
  // 브리프가 갈 곳을 만든다(server.ts briefTo). 빠뜨리면 데몬은 거절 문장만
  // 돌려주고 충돌한 파일은 아무도 손대지 않은 채 남는다.
  const takeOut = useCallback(() => {
    void api
      .unshelve(sessionId)
      .then(() => api.repoStatus())
      .catch((e: Error) => syncError.show(e.message));
  }, [api, sessionId]);

  /**
   * Mounting the panel is what readies the repo. `repoSync` is idempotent
   * daemon-side, so it runs at most once per mount — never per render — and
   * unmounting deliberately does nothing: the preview server keeps running
   * so coming back is instant.
   */
  useEffect(() => {
    if (connection !== "open") return;
    sync();
  }, [connection, sync]);

  /**
   * The error banner's button: the same channel the pins use, so
   * the shell resolves the thread — the panel never learns which one is
   * open. the agent gets the message itself as the turn body. The same
   * message twice in a row is marked on the card (아직 같은 오류 · N번째).
   */
  const forwardError = (error: PreviewError) => {
    const key = `${error.route}|${error.state}|${error.kind}|${error.message}`;
    const count = lastErrorKey.current === key ? lastErrorCount.current + 1 : 1;
    lastErrorKey.current = key;
    lastErrorCount.current = count;
    void onMachineTurn(errorToTurn(error, count));
    // 멈춘 서버 카드의 고치기 요청 — 고침 턴이 끝나면 준비를 한 번 다시
    // 시도한다 (다른 실패 카드의 AI 요청과 같은 형태). 살아 있는
    // 미리보기의 화면 오류에는 재시도할 준비가 없다.
    if (previewStopped) askArmed.current = true;
  };

  // --- 화면 보여 주기 -------------------------------------------------
  // 오류도 핀도 아닌 화면 — 흰 화면, 무한 로딩 — 를 AI 에게 통째로 보여
  // 준다: 프레임 캡처 한 장 + 콘솔 마지막 20줄 + 사용자의 한 줄(선택).
  // 같은 라우트·상태의 연타는 `N번째 요청` 표식을 얹고, 턴이 도는 동안의
  // 연타는 막는다(같은 턴이 겹치니까).
  const [lookBusy, setLookBusy] = useState(false);
  const [lookBlocked, setLookBlocked] = useState<string | null>(null);
  const lookKey = useRef<string | null>(null);
  const lookCount = useRef(0);
  const lookSentThisTurn = useRef(false);
  const lastErrorKey = useRef<string | null>(null);
  const lastErrorCount = useRef(0);
  useEffect(() => {
    // The 연타 mark lives for ONE turn: armed when a look goes up, cleared
    // when the turn settles. (Arming happens in sendLook; clearing here on
    // settle — never on running, or the arm itself would be wiped by the
    // state flip the send just caused.)
    if (turnState !== "running") lookSentThisTurn.current = false;
  }, [turnState]);

  const sendLook = async (note: string) => {
    // A press while the snapshot pipeline is still up is still a repeat
    // intent — the words already went up with this turn. The same toast
    // answers it, not silence.
    if (lookBusy && turnState === "running" && lookSentThisTurn.current) {
      setLookBlocked("이미 보냈습니다 — 답을 기다려 주세요");
      window.setTimeout(() => setLookBlocked(null), 2500);
      return;
    }
    if (lookBusy) return;
    if (turnState === "running" && lookSentThisTurn.current) {
      setLookBlocked("이미 보냈습니다 — 답을 기다려 주세요");
      window.setTimeout(() => setLookBlocked(null), 2500);
      return;
    }
    const where = location?.path ?? (target?.kind === "path" ? target.path : "/");
    const [route = "/", query = ""] = where.split("?");
    const state = new URLSearchParams(query).get("state");
    setLookBusy(true);
    try {
      const snapshot = await window.coloDesignDesktop?.preview?.snapshot?.();
      const key = `${route}|${state ?? ""}`;
      const count = lookKey.current === key ? lookCount.current + 1 : 1;
      lookKey.current = key;
      lookCount.current = count;
      const attachments = snapshot?.jpeg
        ? [{ name: "화면 캡처.jpeg", mediaType: "image/jpeg", data: snapshot.jpeg }]
        : undefined;
      const lines = [
        "이 화면이 이렇게 보입니다. 무엇이 잘못됐는지 보고 고쳐 주세요.",
        note.trim() ? `사용자의 말: ${note.trim()}` : "",
        snapshot && snapshot.console.length > 0
          ? `콘솔 마지막 기록:\n${snapshot.console.join("\n")}`
          : "",
      ].filter(Boolean);
      const delivered = await onMachineTurn(
        lookToTurn(route, state ?? "default", lines.join("\n\n"), count),
        undefined,
        attachments,
        // 게이트 재배선: 이 캡처가 가리킨 화면이 턴의 게이트 입력이다.
        [{ screen: route, state: state ?? null }],
      );
      // 거절당한 요청은 '보냈습니다'로 기억하지 않는다 — 다시 누를 수 있어야.
      lookSentThisTurn.current = delivered;
    } catch (e) {
      // 스냅샷 IPC 가 죽거나 턴이 거절돼도 조용히 삼키지 않는다 — try/finally
      // 만이던 이전 몸은 거절을 창 밖으로 흘려 아무 표시도 남기지 않았다.
      syncError.show(e instanceof Error ? e.message : String(e));
    } finally {
      setLookBusy(false);
    }
  };

  // --- 선예열 ----------------------------------------
  // 초안을 묻는 시점을 버튼 클릭에서 저장의 끝으로 옮긴다. 데몬 캐시(초안은
  // 브랜치 tip)가 나머지를 하므로 넘기기 카드를 여는 속도가 곧 체감 속도다.
  const daemonRef = useRef(daemon);
  daemonRef.current = daemon;
  // 초안 예열: 저장이 끝날 때마다(published) 한 번 — 이어지는 넘기기 복도의
  // 캐시 미스(tip이 방금 움직였다)를 미리 채운다.
  const prewarmStage = useRef<string | null>(null);
  useEffect(() => {
    const stage = daemonRef.current.diffStatus?.stage ?? null;
    if (prewarmStage.current === stage) return;
    prewarmStage.current = stage;
    if (stage !== "published") return;
    void daemonRef.current.api.handoffDraft().catch(() => undefined);
  });

  const errorKind = errorKindOf(repo);
  // Only a named preview death takes over the preview frame; anything else
  // (a failed clone or pull, say) is answered by the retry panel, because the
  // preview may still be alive and worth looking at.
  const previewStopped = phase === "error" && errorKind === "preview";
  // 준비 실패가 worktree 까지 삼킨 경우만 컬럼 전체가 진행 판이 된다. 클론이
  // 살아 있는 실패(포트 · 설치 · 충돌 · 승인)는 배송 바(칩 · 저장 · 넘기기)를
  // 지킬 자격이 있다 — 저장과 넘기기는 worktree 와 원격의 일이지 미리보기의
  // 일이 아니므로 (실사 결함: 포트 충돌 카드가 "변경 4" 채 넘길 길을 가렸다).
  // 재시도 판은 그 경우 미리보기 자리만 대신한다.
  const bringUpFailedWithoutWorktree =
    !repo ||
    phase === "missing" ||
    phase === "cloning" ||
    (phase === "error" && (errorKind === "clone" || errorKind === "unknown"));
  const showProgress = bringUpFailedWithoutWorktree;
  // 살아 있는 준비 단계(최신화 · 설치 · 미리보기 띄우기)도 같은 슬롯의
  // 진행 판을 쓴다 — 레일과 명령 출력 줄은 ProgressPanel 에만 있고, 맨 힌트
  // 한 줄은 첫 준비의 가장 긴 구간(설치)을 죽은 칸으로 읽게 했다 (실사: 레일이
  // 1단계 내려받기에서 사라졌다).
  const bringUpCardInPreview =
    (phase === "error" && !previewStopped && !showProgress) ||
    phase === "pulling" ||
    phase === "installing" ||
    phase === "starting";
  // Progress renders inside this column, not over the whole planner: the rail
  // and the chat stay usable while the clone runs.
  if (showProgress) {
    return (
      <div className="planner__previewcol">
        <ProgressPanel
          phase={phase ?? "missing"}
          detail={repo?.detail ?? null}
          errorKind={errorKind}
          note={askNote}
          connectionLost={connectionLost}
          onRetry={sync}
          onAskAgent={() => void askAgent()}
          onApproveCommands={
            activeSlug
              ? () =>
                  void api
                    .projectUpdate(activeSlug, { approveCommands: true })
                    .catch(() => undefined)
              : undefined
          }
          onOpenSettings={onOpenSettings}
        />
      </div>
    );
  }

  // The clone is checked out and installed, whatever the dev server is doing.
  // 저장 and 넘기기 act on the worktree and the remote, so gating them on a
  // preview that cannot bind a port would strand work that is already done.
  const workable = phase === "ready" || phase === "error";
  const refreshLocked = refreshing || phase !== "ready";

  return (
    <div className={`planner__previewcol${working ? " planner__previewcol--live" : ""}`}>
      {/* 사이클 바는 프레임 헤더의 슬롯으로 올라간다 — 프로젝트 이름 옆에서
          상태 → 행동이 한 줄로 읽힌다. 상태는 전부 이 패널의 것이라
          끌어올리는 대신 포털로 그린다. */}
      {barSlot
        ? createPortal(
            <div className="screenpanel__bar">
              {delivery ? (
                <span className="selector screenpanel__statuswrap">
                  {statusOpen && (
                    <button
                      type="button"
                      className="selector__backdrop"
                      aria-label="사이클 상태 닫기"
                      onClick={() => setStatusOpen(false)}
                    />
                  )}
                  <Tip label={delivery.chip.title} side="bottom" align="start">
                    <span
                      className={`screenpanel__status screenpanel__status--${delivery.chip.tone}${
                        mergedFlash ? " screenpanel__status--mergedflash" : ""
                      }`}
                      role="status"
                    >
                      {chipGlyph(delivery.chip.tone)}
                      {delivery.chip.label}
                    </span>
                  </Tip>
                  {/* 칩은 라이브 리전으로 남고, 지도는 옆의 조용한 트리거. */}
                  <Tip
                    label={statusOpen ? undefined : "지금 상태와 다음 할 일을 봅니다"}
                    side="bottom"
                  >
                    <button
                      type="button"
                      className="ghost screenpanel__statusmore"
                      aria-haspopup="dialog"
                      aria-expanded={statusOpen}
                      aria-label="사이클 상태 더 보기"
                      onClick={() => setStatusOpen((open) => !open)}
                    >
                      <ChevronDownIcon />
                    </button>
                  </Tip>
                  {statusOpen && (
                    <span
                      className="selector__menu screenpanel__statusmenu"
                      role="dialog"
                      aria-label="사이클 상태"
                    >
                      <span className="screenpanel__statusline">{delivery.next.line}</span>
                      {destination && (
                        <span className="screenpanel__destination">
                          이 프로젝트 →{" "}
                          {handoff?.url ? (
                            <a
                              className="screenpanel__destinationlink"
                              href={handoff.url}
                              target="_blank"
                              rel="noreferrer"
                              title="넘긴 요청 열기"
                              onClick={linkClick}
                            >
                              <span className="screenpanel__destinationname">{destination}</span>
                              <ExternalLinkIcon />
                            </a>
                          ) : (
                            destination
                          )}
                        </span>
                      )}
                      <span className="screenpanel__statusrow">
                        <span className="hint">
                          {lastCheckAt
                            ? `마지막 확인 ${lastCheckAt.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`
                            : "이 창에서는 아직 확인하지 않았습니다"}
                        </span>
                        {delivery.actions.check?.enabled && (
                          <button
                            type="button"
                            className="primary"
                            onClick={() => {
                              setStatusOpen(false);
                              readHandoffState(false);
                            }}
                          >
                            지금 확인
                          </button>
                        )}
                      </span>
                    </span>
                  )}
                </span>
              ) : (
                <Tip
                  label="프로젝트 준비가 끝나면 저장 · 넘기기가 열립니다"
                  side="bottom"
                  align="start"
                >
                  <span className="screenpanel__status screenpanel__status--none">
                    화면 대기 중
                  </span>
                </Tip>
              )}
              {working && (
                <span className="screenpanel__working">
                  <span className="spinner" />
                  다시 그리는 중
                </span>
              )}
              <span className="screenpanel__spacer" />
              {/* 동작은 상수다: 저장 · 넘기기는 언제나 그려지고 조건으로만
            잠긴다 — 잠긴 이유는 title 한 문장. 상태 확인은 PR 이 있을 때만.
            강조는 그 순간 가장 자연스러운 하나에만. 잠김은 aria-disabled: 진짜
            disabled 는 hover 도 포커스도 막아 title 이 도달할 길이 없었다. */}
              <span className="screenpanel__actions">
                {delivery ? (
                  <>
                    <Tip label={delivery.actions.save.reason} side="bottom">
                      <button
                        type="button"
                        className={`${
                          delivery.primary === "save" && delivery.actions.save.enabled
                            ? "primary screenpanel__action"
                            : "ghost screenpanel__action"
                        }${beatPrimary === "save" ? " screenpanel__action--beat" : ""}`}
                        aria-disabled={!delivery.actions.save.enabled}
                        onClick={() => {
                          if (delivery.actions.save.enabled) onCycleAction("save");
                        }}
                      >
                        <SaveIcon />
                        <span className="screenpanel__actionlabel">저장</span>
                      </button>
                    </Tip>
                    <Tip label={delivery.actions.handoff.reason} side="bottom">
                      <button
                        type="button"
                        className={`${
                          delivery.primary === "handoff" && delivery.actions.handoff.enabled
                            ? "primary screenpanel__action"
                            : "ghost screenpanel__action"
                        }${beatPrimary === "handoff" ? " screenpanel__action--beat" : ""}`}
                        aria-disabled={!delivery.actions.handoff.enabled}
                        onClick={() => {
                          if (delivery.actions.handoff.enabled) onCycleAction("handoff");
                        }}
                      >
                        <HandoffIcon />
                        <span className="screenpanel__actionlabel">개발자에게 넘기기</span>
                      </button>
                    </Tip>
                    {delivery.actions.check && (
                      <Tip
                        /* 빈 답( screenpanel__checknote )이 버튼 아래 서 있는
                          6 초 동안은 설명 tip 이 답을 덮는다 — 같은 자리다.
                          답이 말을 대신하므로 설명은 그 동안 눕혀 둔다. */
                        label={
                          checkNote
                            ? undefined
                            : "개발자의 판정과 코멘트를 GitHub에서 다시 읽어 옵니다"
                        }
                        side="bottom"
                      >
                        <button
                          type="button"
                          className={`${
                            delivery.primary === "check"
                              ? "primary screenpanel__action"
                              : "ghost screenpanel__action"
                          }${beatPrimary === "check" ? " screenpanel__action--beat" : ""}`}
                          data-testid="check-state"
                          onClick={() => onCycleAction("check")}
                        >
                          <EyeIcon />
                          <span className="screenpanel__actionlabel">
                            상태 확인
                            {unhandledDevReviews.length > 0
                              ? ` · 개발자 코멘트 ${unhandledDevReviews.length}`
                              : ""}
                          </span>
                        </button>
                      </Tip>
                    )}
                  </>
                ) : (
                  <>
                    {/* 답변이 끝나기 전: 동작은 상수라 버튼은 그려지고 잠긴다 —
                  잠긴 이유는 옆의 한 줄이 말한다 (tooltip 뒤에 숨기지 않는다). */}
                    <button
                      type="button"
                      className="ghost screenpanel__action"
                      aria-disabled="true"
                    >
                      <SaveIcon />
                      <span className="screenpanel__actionlabel">저장</span>
                    </button>
                    <button
                      type="button"
                      className="ghost screenpanel__action"
                      aria-disabled="true"
                    >
                      <HandoffIcon />
                      <span className="screenpanel__actionlabel">개발자에게 넘기기</span>
                    </button>
                    <span className="screenpanel__locknote">
                      저장·넘기기는 답변이 끝난 뒤 열립니다
                    </span>
                  </>
                )}
                {/* 상태 확인의 빈 답 — 누른 버튼 아래에서 대답한다. 내용
              영역의 띠가 아니라 여기인 이유: 원인(클릭)과 결과(말)가 같은
              자리에 있어야 눈이 옮겨 다니지 않고, 내용물은 위아래로
              흔들리지 않는다. role=status 는 띠의 낭독을 이어받는다. */}
                {checkNote && (
                  <span className="selector__menu screenpanel__checknote" role="status">
                    {checkNote}
                  </span>
                )}
              </span>
              <span className="screenpanel__divider" />
              <Tip
                label={
                  refreshing
                    ? "받아 오는 중…"
                    : refreshLocked
                      ? "미리보기가 준비되면 받아올 수 있습니다"
                      : "개발자가 반영한 최신 변경을 받아 옵니다 — 저장하지 않은 변경은 그대로 보존됩니다"
                }
                side="bottom"
                align="end"
              >
                <button
                  type="button"
                  className="ghost screenpanel__refresh"
                  aria-disabled={refreshLocked}
                  onClick={() => {
                    if (!refreshLocked) refresh();
                  }}
                >
                  <RefreshIcon />
                  <span className="screenpanel__refreshlabel">
                    {/* 최신화 is a coinage; the gate step and the progress rail already
                  say 최신 변경 받아오기 — the button is the odd one out. */}
                    {refreshing ? "받아 오는 중…" : "최신 변경 받아오기"}
                  </span>
                </button>
              </Tip>
              <span className="screenpanel__more">
                <Tip
                  label={menuOpen ? undefined : "저장 기록 · 변경 버리기"}
                  side="bottom"
                  align="end"
                >
                  <button
                    type="button"
                    className="ghost screenpanel__morebtn"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={() => setMenuOpen((open) => !open)}
                  >
                    <span className="screenpanel__morelabel">더 보기</span>
                    <ChevronDownIcon />
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
                    <span className="selector__menu screenpanel__menu" role="menu">
                      {/* 저장 · 넘기기는 더 보기에서 뺐다 — 상단 바의 상수 동작이
                  그 자리를 갖는다. 저장 기록 · 변경 버리기만 남는다.
                  잠긴 행도 aria-disabled: 진짜 disabled 는 hover 를 막아 title 의
                  잠긴 이유에 도달할 길이 없다 (상단 바와 같은 규칙). */}
                      <Tip label="이 사이클의 저장 차례를 보고 하나로 되돌립니다" side="left">
                        <button
                          type="button"
                          role="menuitem"
                          className="selector__row"
                          aria-disabled={!workable}
                          onClick={() => {
                            if (!workable) return;
                            setMenuOpen(false);
                            setHistoryOpen((value) => !value);
                          }}
                        >
                          <span className="ic ic--sm ic--quiet">
                            <HistoryIcon />
                          </span>
                          <span className="selector__text">
                            <span className="selector__label">저장 기록</span>
                            <span className="selector__desc">
                              이 사이클의 저장 차례를 보고 하나로 되돌립니다
                            </span>
                          </span>
                        </button>
                      </Tip>
                      <Tip
                        label={
                          (repo?.pendingChanges ?? 0) > 0
                            ? "저장하지 않은 변경을 모두 버립니다 — 되돌릴 수 없습니다"
                            : "버릴 저장하지 않은 변경이 없습니다"
                        }
                        side="left"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          className="selector__row"
                          aria-disabled={!workable || (repo?.pendingChanges ?? 0) === 0}
                          onClick={() => {
                            if (!workable || (repo?.pendingChanges ?? 0) === 0) return;
                            setMenuOpen(false);
                            askDiscard();
                          }}
                        >
                          <span className="ic ic--sm ic--danger">
                            <TrashIcon />
                          </span>
                          <span className="selector__text">
                            <span className="selector__label">변경 버리기</span>
                            <span className="selector__desc">
                              저장하지 않은 변경을 모두 버립니다 — 되돌릴 수 없습니다
                            </span>
                          </span>
                        </button>
                      </Tip>
                      <Tip
                        label={
                          repo?.shelf
                            ? turnState === "running"
                              ? "AI가 고치는 중 — 끝나면 꺼낼 수 있습니다"
                              : "치워둔 작업을 지금 화면에 다시 얹습니다"
                            : (repo?.pendingChanges ?? 0) === 0
                              ? "치워둘 저장하지 않은 변경이 없습니다"
                              : turnState === "running"
                                ? "AI가 고치는 중 — 끝나면 치워둘 수 있습니다"
                                : "지금 작업을 치워 두고 화면을 저장 전 상태로 되돌립니다 — 다시 꺼내 이어합니다"
                        }
                        side="left"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          className="selector__row"
                          aria-disabled={
                            !workable ||
                            turnState === "running" ||
                            (repo?.shelf ? false : (repo?.pendingChanges ?? 0) === 0)
                          }
                          onClick={() => {
                            if (
                              !workable ||
                              turnState === "running" ||
                              (repo?.shelf ? false : (repo?.pendingChanges ?? 0) === 0)
                            )
                              return;
                            setMenuOpen(false);
                            if (repo?.shelf) takeOut();
                            else putAway();
                          }}
                        >
                          <span className="ic ic--sm ic--quiet">
                            <ArchiveIcon />
                          </span>
                          <span className="selector__text">
                            <span className="selector__label">
                              {repo?.shelf ? "치워둔 작업 꺼내기" : "잠깐 치워두기"}
                            </span>
                            <span className="selector__desc">
                              {repo?.shelf
                                ? "치워둔 작업을 지금 화면에 다시 얹습니다"
                                : "치워둔 작업을 나중에 다시 얹습니다"}
                            </span>
                          </span>
                        </button>
                      </Tip>
                      {repo?.handoff?.url && (
                        <Tip label="개발자가 검토하는 넘긴 요청을 엽니다" side="left">
                          <button
                            type="button"
                            role="menuitem"
                            className="selector__row"
                            onClick={() => {
                              setMenuOpen(false);
                              openLink(repo?.handoff?.url ?? "");
                            }}
                          >
                            <span className="ic ic--quiet">
                              <ExternalLinkIcon />
                            </span>
                            <span className="selector__text">
                              <span className="selector__label">넘긴 내용 열기</span>
                              <span className="selector__desc">
                                개발자가 검토하는 넘긴 요청을 엽니다
                              </span>
                            </span>
                          </button>
                        </Tip>
                      )}
                    </span>
                  </>
                )}
              </span>
            </div>,
            barSlot,
          )
        : null}
      {syncError.text && (
        <Fold closing={syncError.closing} onCollapsed={syncError.clear}>
          <div className="notice notice--error">
            <span className="notice__text">{syncError.text}</span>
            <button
              type="button"
              className="notice__close"
              aria-label="오류 닫기"
              disabled={syncError.closing}
              onClick={syncError.close}
            >
              ×
            </button>
          </div>
        </Fold>
      )}
      {lookBlocked && (
        <div className="notice notice--info" role="status">
          <span className="notice__text">{lookBlocked}</span>
        </div>
      )}
      {/* The row lets the history pane stand BESIDE the stage — docking
          (not overlaying) is how a DOM layer shares the column with the
          native view: the slot's rect shrinks and the view's bounds follow.
          The stage wrapper gives the PiP its coordinates: the
          thumbnail lives in this iframe's corner, and the enlarged look
          covers exactly this iframe — not the bars around it. */}
      <div
        ref={setStageRow}
        className={`previewcol__row${historyCover ? " previewcol__row--cover" : ""}`}
      >
        <div className={`previewcol__stage${settleFlash ? " previewcol__stage--settled" : ""}`}>
          {bringUpCardInPreview ? (
            <ProgressPanel
              phase={phase ?? "missing"}
              detail={repo?.detail ?? null}
              errorKind={errorKind}
              note={askNote}
              connectionLost={connectionLost}
              onRetry={sync}
              onAskAgent={() => void askAgent()}
              onApproveCommands={
                activeSlug
                  ? () =>
                      void api
                        .projectUpdate(activeSlug, { approveCommands: true })
                        .catch(() => undefined)
                  : undefined
              }
              onOpenSettings={onOpenSettings}
            />
          ) : (
            <PreviewHost
              url={repo?.previewUrl ?? null}
              epoch={repo?.previewEpoch ?? null}
              stopped={previewStopped}
              stoppedDetail={repo?.detail ?? null}
              onRestart={restart}
              onPin={onPin}
              onPinFocus={onPinFocus}
              onFixError={forwardError}
              target={target}
              sync={pinsFrame}
              onNavigate={setTarget}
              onLocation={setLocation}
              location={location}
              commentsOn={commentsOn}
              onCommentsMode={onCommentsMode}
              onLook={(note) => void sendLook(note)}
              lookBusy={lookBusy}
              driving={daemon.browserDriving}
              frozen={frozen}
              frozenApi={frozen ? { api, sessionId: sessionId ?? null } : null}
            />
          )}
          {historyOpen && (
            <HistoryDrawer open onClose={closeHistory} daemon={daemon} cover={historyCover} />
          )}
        </div>
        {discardConfirm && (
          <ConfirmDialog
            title="변경 버리기"
            body={
              <>
                <span className="ic ic--danger">
                  <WarnIcon />
                </span>{" "}
                저장하지 않은 변경 <strong>{repo?.pendingChanges ?? 0}개</strong>를 모두 버릴까요?
              </>
            }
            hint="버린 변경은 되돌릴 수 없습니다."
            confirmLabel="버리기"
            alt={
              repo?.shelf
                ? undefined
                : {
                    label: "잠깐 치워두기",
                    onAlt: () => {
                      setDiscardConfirm(false);
                      putAway();
                    },
                  }
            }
            onConfirm={discard}
            onClose={() => setDiscardConfirm(false)}
          >
            {discardFiles && discardFiles.length > 0 && (
              <ul className="discard__files">
                {discardFiles.map((file) => {
                  const { added, removed } = diffCounts(file);
                  return (
                    <li className="dfile" key={file.path}>
                      <span className={`dfile__tag dfile__tag--${file.status}`}>
                        {FILE_STATUS_LABEL[file.status]}
                      </span>
                      <span className="dfile__name">{file.path}</span>
                      {(added > 0 || removed > 0) && (
                        <span className="discard__count">
                          {added > 0 && <span className="plus">+{added}</span>}
                          {removed > 0 && <span className="minus">−{removed}</span>}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </ConfirmDialog>
        )}
        {devPanelOpen && (
          <div
            className="modal"
            onMouseDown={(e) => e.target === e.currentTarget && setDevPanelOpen(false)}
          >
            <div
              className="modal__panel"
              role="dialog"
              aria-modal="true"
              aria-label="개발자 코멘트"
              tabIndex={-1}
              ref={devPanelRef}
            >
              <header className="modal__head">
                <h2 className="modal__title">개발자 코멘트</h2>
                <button
                  type="button"
                  className="ghost"
                  aria-label="개발자 코멘트 닫기"
                  onClick={() => setDevPanelOpen(false)}
                >
                  <CloseIcon />
                </button>
              </header>
              <div className="modal__body">
                <p className="hint">
                  {devReviews === null
                    ? "개발자의 말을 읽어 오는 중…"
                    : unhandledDevReviews.length > 0
                      ? "고치기는 AI에게 화면을 고쳐 달라는 뜻이고, 답하기는 개발자에게 답을 남기는 뜻입니다."
                      : "모두 처리한 목록입니다."}
                </p>
                {devReviews !== null && unhandledDevReviews.length > 0 && (
                  <Tip
                    label={
                      unreadReviews.length > 0
                        ? "먼저 각 코멘트를 펼쳐 읽어 주세요 — 개발자의 말에 '이 방향은 접자'가 섞여 있을 수 있습니다"
                        : undefined
                    }
                    side="bottom"
                  >
                    <button
                      type="button"
                      className="ghost dev__all"
                      aria-disabled={devBusy || unreadReviews.length > 0}
                      onClick={() => {
                        if (devBusy || unreadReviews.length > 0) return;
                        void handleReview(unhandledDevReviews);
                        setDevPanelOpen(false);
                      }}
                    >
                      모두 AI에게 ({unhandledDevReviews.length})
                    </button>
                  </Tip>
                )}
                <ul className="diff__files">
                  {(devReviews ?? []).map((review) => {
                    const handled = handledIds.has(review.id);
                    return (
                      <li
                        key={review.id}
                        className={`diff__file${handled ? " diff__file--resolved" : ""}`}
                      >
                        <div className="diff__filerow">
                          <span className="diff__path">
                            {review.author}
                            {review.path
                              ? ` · ${review.path}${review.line ? `:${review.line}` : ""}`
                              : ""}
                          </span>
                          {!handled && (
                            <>
                              <Tip label="이 코멘트를 AI에게 넘겨 화면을 고칩니다">
                                <button
                                  type="button"
                                  className="primary"
                                  disabled={devBusy}
                                  onClick={() => {
                                    void handleReview([review]);
                                    setDevPanelOpen(false);
                                  }}
                                >
                                  고치기
                                </button>
                              </Tip>
                              <button
                                type="button"
                                className="ghost"
                                onClick={() => {
                                  if (!isReplyConfirmed()) {
                                    setReplyConfirmFor(review.id);
                                    return;
                                  }
                                  setDevReplyFor(devReplyFor === review.id ? null : review.id);
                                }}
                              >
                                답하기
                              </button>
                            </>
                          )}
                          {handled && <span className="hint">AI에게 보냄</span>}
                        </div>
                        {(handled || readReviews.has(review.id)) && (
                          <p className="hint">{review.body}</p>
                        )}
                        {!handled && !readReviews.has(review.id) && (
                          <Tip label="개발자가 남긴 말을 펼쳐 읽습니다">
                            <button
                              type="button"
                              className="ghost dev__read"
                              onClick={() => setReadReviews((prev) => new Set(prev).add(review.id))}
                            >
                              펼쳐 읽기
                            </button>
                          </Tip>
                        )}
                        {devReplyFor === review.id && (
                          <form
                            className="dev__reply"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void sendDevReply(review);
                            }}
                          >
                            <input
                              type="text"
                              aria-label="답변"
                              placeholder="개발자에게 남길 말을 한 줄 적어 주세요"
                              value={devReplyText}
                              autoFocus
                              onChange={(event) => setDevReplyText(event.target.value)}
                            />
                            <button
                              type="submit"
                              className="primary"
                              disabled={devBusy || devReplyText.trim() === ""}
                            >
                              보내기
                            </button>
                          </form>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {devReviews !== null && devReviews.length === 0 && (
                  <p className="hint">아직 개발자 코멘트가 없습니다.</p>
                )}
              </div>
            </div>
          </div>
        )}
        {replyConfirmFor !== null && (
          <ConfirmDialog
            title="GitHub에 답하기"
            body={
              <>
                이 도구가 <strong>사용자의 이름</strong>으로 GitHub에 답을 남깁니다.
              </>
            }
            hint="한 번 확인하면 다음부터 묻지 않습니다. 취소하려면 취소를 누르세요."
            confirmLabel="확인했어요"
            onConfirm={() => {
              markReplyConfirmed();
              const review = (devReviews ?? []).find((entry) => entry.id === replyConfirmFor);
              setReplyConfirmFor(null);
              if (review) setDevReplyFor(review.id);
            }}
            onClose={() => setReplyConfirmFor(null)}
          />
        )}
      </div>
      {/* 변경 점 — the column's floor (mockup 03 · 분할). Below the row, so
          the stage yields height to it and the native view's bounds follow
          the slot's rect: docking, never overlaying. */}
      <ChangedFiles files={repo?.changedFiles ?? NO_CHANGED_FILES} />
    </div>
  );
}
