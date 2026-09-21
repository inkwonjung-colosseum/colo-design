import type {
  ColoDesignPinEnvelope,
  DeveloperReview,
  DiffFile,
  SessionState,
} from "@colo-design/protocol";
import { markTurn } from "@colo-design/protocol";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CallDeveloper, Fold, useFoldNotice } from "../../components";
import { useModalEscape, useModalFocus } from "../../hooks/use-modal-focus";
import { type Pins, pinsSync } from "../../hooks/usePins";
import type { Daemon } from "../../lib/daemon-client";
import { type Delivery, deriveDelivery } from "../../lib/delivery";
import { ownerRepoOf, timeAgo } from "../../lib/format";
import { linkClick, openLink } from "../../lib/open-link";
import { errorToTurn, lookToTurn } from "../../lib/preview-turns";
import { guidanceFor } from "../../lib/repo-guidance";
import {
  isReplyConfirmed,
  loadHandledReviews,
  markReplyConfirmed,
  markRepoPrepSeen,
  saveHandledReview,
} from "../../lib/settings";
import { advanceTour, useTourStep } from "../../lib/tour";
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
import { StateBanner } from "../StateBanner";
import { HistoryDrawer } from "../shell/HistoryDrawer";
import { Tip } from "../shell/Tip";
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

/** 한 오류 키가 사람 손 없이 쓸 수 있는 기계 고침 발사 수. 카드는 그다음 문이다. */
const MAX_AUTO_FIXES = 2;
/** 보류 목록의 상한 — 판정 창 하나가 몇 초씩이므로 정산이 무한히 늘지 않게 묶는다. */
const MAX_PENDING_ERRORS = 6;
/**
 * 성공 턴 뒤의 조용한 창(결함 2, 실사 2026-09-20). 데몬은 게이트 전체
 * 통과를 방송하지 않으므로(게이트는 문제를 찾았을 때만 말한다), 웹이 혼자
 * 보는 증거로 해소한다: 성공 턴이 끝난 뒤 이 창 동안 새 오류 보고도 새
 * 턴도 없으면 미리보기가 오류 없이 이어져 온 것이므로, 확인 불능으로 남은
 * 보고를 거둔다.
 */
const CONVERGE_WINDOW_MS = 10_000;

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
    pins?: Array<{ screen: string }>,
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
  onCycleAction: (kind: "submit" | "handoff" | "check") => void;
  /** PageWorkspace 가 내린 사이클 요청 — 이 패널은 `check` 만 집는다. */
  cycleRequest: { kind: "submit" | "handoff" | "check" | "history"; nonce: number } | null;
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
   * Which path the preview shows. The toolbar is the pins'
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
   * both reset HERE, during render — before PreviewFrame's effects could
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

  /** 작업 기록 도킹 패널 — 더 보기 ▾ 메뉴에서 열고 닫는다(토글). */
  const [historyOpen, setHistoryOpen] = useState(false);
  /**
   * 제출 코치(P2-1): 저장 카드 밑에 서던 복도(`개발자에게 넘기기로 이어가기`)
   * 가 옮겨 온 자리다. 자동 저장 뒤로 저장은 사람이 누른 순간이 아니라 매 턴
   * 일어나므로, 그 복도를 그대로 두면 다음 걸음을 턴마다 권하는 잔소리가 된다.
   * 한 번만 — 핀 코치와 같은 localStorage 패턴(HandoffCard 의 선례).
   */
  const tour = useTourStep();
  const [submitCoach, setSubmitCoach] = useState(() => {
    try {
      return localStorage.getItem("colo-design.submit-coach-seen") !== "1";
    } catch {
      return true;
    }
  });
  const dismissSubmitCoach = () => {
    setSubmitCoach(false);
    advanceTour("submit");
    try {
      localStorage.setItem("colo-design.submit-coach-seen", "1");
    } catch {
      // 저장소가 없어도 이 창에서는 조용해진다 — 그것으로 충분하다.
    }
  };
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
  // 미리보기 무대(게스트 webview) 안의 클릭은 배경에 닿지 않으므로, 게스트가
  // 포커스를 가져가는 순간을 "밖"으로 본다 — 상태 팝오버와 같은 규칙.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setMenuOpen(false);
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if ((event.target as HTMLElement | null)?.tagName === "WEBVIEW") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [menuOpen]);

  const sync = useCallback(() => {
    syncError.clear();
    void api.repoSync().catch((e: Error) => syncError.show(e.message));
  }, [api]);

  // 오버레이의 핀 그릇은 렌더마다 새로 만들지 않는다 — PreviewFrame 은 이
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
  // P2-2: 정산 줄의 `작업 기록에서 되돌리기` — 드로어는 이 패널이 쥐고
  // 있으므로 대화 열의 요청이 같은 통로로 건너온다.
  const historyNonce = useRef(-1);
  useEffect(() => {
    if (cycleRequest?.kind !== "history" || cycleRequest.nonce === historyNonce.current) return;
    historyNonce.current = cycleRequest.nonce;
    setHistoryOpen(true);
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
  });
  // --- 보낸 화면 동결 (preview.md §1-E) ----------------
  // 넘긴 사이클이 서 있는 동안 스테이지는 얼린 얼굴을 쓴다 — PreviewHost 는
  // 입히기만 하고, 무엇을 얼리는지는 delivery 를 소유한 이 패널이 정한다.
  // 샷의 존재 여부는 따로 묻지 않는다: `handoffShot` 의 null 답이 곧
  // "이 화면은 보낸 캡처가 없다" 이다 — 넘긴 화면 목록은 데몬의
  // captureTargets(코멘트 경로)이 만들고, 웹은 지금 보는 화면의 route 로
  // 한 장씩 묻는다(2026-09-21 상태 축 철거 — 주소는 route 하나다).
  /**
   * 코치가 서는 자리: 넘길 것이 실제로 있고(제출이 열려 있고) 아직 넘긴
   * 요청이 없는 첫 순간. 복도가 섰던 조건 그대로다 — 이미 넘겨 본 사람에게는
   * 소음이므로 한 번 보이면 끝이다.
   */
  const coachSubmit =
    submitCoach &&
    // 투어의 마지막 걸음(P3-2) — 앞의 둘이 끝난 뒤에야 이 자리가 선다.
    tour === "submit" &&
    delivery?.actions.submit.enabled === true &&
    delivery.primary === "submit" &&
    // 핀 코치와 달리 이 자리는 아래로 펼쳐지는 면들과 겹친다 — 고정된 말풍선은
    // 포인터를 먹으므로(Tip 의 open 계약), 다른 면이 열려 있으면 물러난다.
    !menuOpen &&
    !historyOpen;
  const handoffState = handoff?.state ?? null;
  const frozenCycle =
    handoffState === "open" ||
    handoffState === "changes_requested" ||
    handoffState === "merged" ||
    handoffState === "closed";
  const frozenWhere = location?.path ?? (target?.kind === "path" ? target.path : "/");
  const frozenRoute = frozenWhere.split("?")[0] ?? "/";
  const [frozenShot, setFrozenShot] = useState<{ mediaType: string; data: string } | null>(null);
  const frozenShotKey = `${handoff?.number ?? ""}|${frozenRoute}`;
  useEffect(() => {
    if (!frozenCycle) {
      setFrozenShot(null);
      return;
    }
    let cancelled = false;
    setFrozenShot(null);
    void api
      .handoffShot(frozenRoute)
      .then((shot) => {
        if (!cancelled) setFrozenShot(shot);
      })
      .catch(() => {
        if (!cancelled) setFrozenShot(null);
      });
    return () => {
      cancelled = true;
    };
    // frozenShotKey 가 route·PR 번호를 다 품는다 — 둘은 읽기 편의로 나란히
    // 둔다.
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
  // 반영됨 도장은 6 초만 산다 — 종착의 인사지 새 상태가 아니다. 도장만
  // 거둔다: 실제로 열기로 띄운 실빌드(몇십 초 걸린다)와 보낸↔지금 왕복은
  // 얼려 둔 무대 위에 살아 있어야 한다 — 열린 넘김과 같은 계약이다.
  useEffect(() => {
    if (handoffState !== "merged") return;
    const timer = window.setTimeout(() => setFrozenStampGone(true), 6_000);
    return () => window.clearTimeout(timer);
  }, [handoffState]);
  const frozen =
    frozenCycle && (frozenShot !== null || !frozenStampGone)
      ? {
          shot: frozenShot,
          stamp: frozenStamp,
          stampGone: frozenStampGone,
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
    // window 캡처 단계 — 다른 오버레이의 document 버블 핸들러보다 먼저 와야
    // 이 팝오버의 Escape 가 삼켜지지 않는다.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setStatusOpen(false);
      }
    };
    // 미리보기 무대(게스트 webview)는 DOM 위에 얹힌 별도 문서다 — 무대
    // 안의 클릭은 뒷배경(button)에 닿지 않는다. 게스트가 포커스를 가져간
    // 순간이 곧 "밖을 눌렀다"다.
    const onFocusIn = (event: FocusEvent) => {
      if ((event.target as HTMLElement | null)?.tagName === "WEBVIEW") setStatusOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocusIn);
    };
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
    // 사람의 클릭은 고리에 끼었다 — 이 키의 기계 예산도 새로 산다. 다만
    // 무한하진 않다: 예산이 다시 마르면 카드가 다시 마지막 문이 된다.
    const key = `${error.route}|${error.kind}|${error.message}`;
    autoFires.current.delete(key);
    const count = lastErrorKey.current === key ? lastErrorCount.current + 1 : 1;
    lastErrorKey.current = key;
    lastErrorCount.current = count;
    void onMachineTurn(errorToTurn(error, count));
    // 멈춘 서버 카드의 고치기 요청 — 고침 턴이 끝나면 준비를 한 번 다시
    // 시도한다 (다른 실패 카드의 AI 요청과 같은 형태). 살아 있는
    // 미리보기의 화면 오류에는 재시도할 준비가 없다.
    if (previewStopped) askArmed.current = true;
    // 클릭은 판정을 지난 말이다 — 카드를 치우는 것도 클릭의 몫이다. 눌린
    // 보고는 보류 목록에서도 내려온다(사람이 끼었다), 다른 라우트의 살아
    // 남은 보고는 다음 정산이 다시 심사한다.
    retireError(errorKey(error));
    shownError.current = null;
    setPreviewError(null);
  };

  // --- 미리보기 오류의 판정 ---------------------------------------------
  // 오류 보고는 두 갈래로 온다. 턴이 도는 동안의 보고는 대부분 HMR 의 깨진
  // 중간 상태다 — 카드로 승격시키지 않고 들어 두었다가, 턴이 끝나면 데몬의
  // 검증 창(preview.screenCheck — 게이트와 같은 드라이버·같은 판정)으로 그
  // 화면을 다시 열어 본다. 깨끗하면 조용히 거둔다(이미 고쳐진 것), 살아
  // 있으면 고침 턴을 스스로 내려놓고, 예산이 다 달랐을 때만 비로소 카드가
  // 된다 — 사람의 클릭은 마지막 문이고, 확인 불능은 언제나 카드다.
  // 발사가 무한하면 기계 둘이 서로 답하며 구독을 태운다(게이트의
  // `gatedSessions` 와 같은 이유다). 한 번만 발사하는 것도 답이 못 된다 —
  // 턴 도중의 파문이 한 발을 삼키고, 진짜 재발이 사람의 클릭을 기다린다.
  // 그래서 예산은 키별 둘이고, 회복된다: 깨끗한 판정(고침이 성공한 것 —
  // 다음 오류는 새 오류다)·사람의 클릭(고리에 사람이 끼었다)·새 미리보기
  // 서버(지난 시절의 오류는 전부 낡은 말이다)가 각각 새 예산을 산다.
  //
  // 결함 2(실사 2026-09-20): 이전 몸은 정산에서 보고 하나만 심사했다 —
  // 턴 도중의 보고는 덮어 쓰이고, 서 있는 카드는 새 보고에 밀려났다. 그래서
  // 한쪽 라우트의 보고는 성공 턴을 몇 번 견뎌도 해소되지 않았다. 지금은
  // 보고를 목록으로 들고, 턴의 종착에서 보류된 전부를 같은 파이프로
  // 심사한다. 데몬이 게이트 전체 통과의 방송을 주지 않으므로, 확인 불능으로
  // 남은 보고에는 웹만의 해소 길을 더한다 — 성공 턴(idle) 뒤의 조용한 창
  // (CONVERGE_WINDOW_MS)이다.
  const [previewError, setPreviewError] = useState<PreviewError | null>(null);
  /** 아직 거둬지지 않은 보고 전부 — 턴 도중에 들어 둔 것과 살아 남은 카드. */
  const pendingErrors = useRef<PreviewError[]>([]);
  /** 지금 그려진 카드 — 파이프가 갱신할 때의 기준점(state 를 읽으면 늦는다). */
  const shownError = useRef<PreviewError | null>(null);
  /** 오류 키별로 기계가 쓴 고침 발사 수 — 카드가 마지막 문이 되는 잣대다. */
  const autoFires = useRef<Map<string, number>>(new Map());
  /** 마지막 판정이 확인 불능이었던 보고의 키 — 성공 턴 뒤의 조용한 창이 거둔다. */
  const unverifiable = useRef<Set<string>>(new Set());
  const convergeTimer = useRef<number | null>(null);
  const verdicts = useRef<Promise<void>>(Promise.resolve());
  const turnLive =
    turnState === "starting" ||
    turnState === "running" ||
    turnState === "waiting_permission" ||
    turnState === "waiting_question";

  const errorKey = (error: PreviewError): string => `${error.route}|${error.kind}|${error.message}`;

  /** 보류 목록에 하나 얹는다 — 같은 보고의 재파문은 하나로 접고, 목록은
      상한 안에 묶어 둔다(오래된 것부터 내린다). */
  const holdError = (error: PreviewError): void => {
    pendingErrors.current = [
      ...pendingErrors.current.filter((e) => errorKey(e) !== errorKey(error)),
      error,
    ].slice(-MAX_PENDING_ERRORS);
  };

  /** 판정이 끝난 보고를 거둔다 — 목록에서도, 확인 불능 표식에서도. */
  const retireError = (key: string): void => {
    pendingErrors.current = pendingErrors.current.filter((e) => errorKey(e) !== key);
    unverifiable.current.delete(key);
  };

  /** 이번 판정이 끝난 뒤의 그림을 정한다. 산파(살아 남은 보고)가 있으면
      마지막 것이 선다. 없을 때는 이번 판정이 서 있던 카드를 거뒀는지 본다 —
      거뒀다면 남은 보고의 마지막이, 목록이 비었으면 아무것도 그려지지
      않는다. 이번 판정과 무관한 카드는 손대지 않는다. */
  const repaintAfter = (survivor: PreviewError | null, judgedShown: boolean): void => {
    if (survivor) {
      shownError.current = survivor;
      setPreviewError(survivor);
      return;
    }
    if (!judgedShown) return;
    const last = pendingErrors.current[pendingErrors.current.length - 1] ?? null;
    shownError.current = last;
    setPreviewError(last);
  };

  /** The verdict pipeline, serialized — together-arriving reports are
      judged in order and the last verdict wins the paint. */
  const adjudicateAll = (reports: PreviewError[]): void => {
    verdicts.current = verdicts.current.then(async () => {
      const shownKey = shownError.current ? errorKey(shownError.current) : null;
      // 한 정산의 발사는 하나다 — 같은 파문이 여러 라우트에서 보고됐을 때
      // 발사 수만큼 고침 턴이 늘면 기계 둘이 서로 답한다(게이트의
      // gatedSessions 와 같은 이유다). 나머지 보고는 다음 정산이 심사한다.
      let fired = false;
      let survivor: PreviewError | null = null;
      let judgedShown = false;
      for (const error of reports) {
        const key = errorKey(error);
        // 앞 판정(같은 파이프의 이전 통과)이 이미 거둔 보고다.
        if (!pendingErrors.current.some((e) => errorKey(e) === key)) continue;
        if (key === shownKey) judgedShown = true;
        const report = await api.screenCheck(error.route).catch(() => null);
        if (report === null) {
          // 확인 불능 — 판정이 아니라 못 본 것이다. 카드가 안전한 쪽이고,
          // 성공 턴 뒤의 조용한 창이 이 키를 거둔다.
          unverifiable.current.add(key);
          survivor = error;
          continue;
        }
        const broken = !report.settled || report.errors.length > 0;
        if (!broken) {
          // 이미 고쳐졌다(혹은 일시적 파문이었다) — 조용히 거둔다. 이 화면의
          // 예산도 돌려준다: 고침이 성공을 냈으면 다음 오류는 새 오류다.
          retireError(key);
          for (const budget of [...autoFires.current.keys()]) {
            if (budget.startsWith(`${error.route}|`)) autoFires.current.delete(budget);
          }
          continue;
        }
        unverifiable.current.delete(key);
        const spent = autoFires.current.get(key) ?? 0;
        if (!fired && spent < MAX_AUTO_FIXES) {
          const delivered = await onMachineTurn(errorToTurn(error, spent + 1));
          if (delivered) {
            // 고침 턴이 뛰었다 — 카드 대신 턴의 말이 간다. 예산은 전달된
            // 발사만 쓴다: 거절은 판정의 실패가 아니라 못 건 것이다.
            autoFires.current.set(key, spent + 1);
            fired = true;
            continue;
          }
        }
        survivor = error;
      }
      repaintAfter(survivor, judgedShown);
    });
  };

  /** Single-report convenience — the pipeline judges one report through the
      same body the settle pass uses. */
  const adjudicate = (error: PreviewError): void => adjudicateAll([error]);

  /** 웹만의 해소 창 — 결함 2의 후반. 성공 턴이 끝난 뒤 이 창 동안 새 보고도
      새 턴도 없으면 미리보기가 오류 없이 이어져 온 것이므로, 확인 불능으로
      남은 보고를 거둔다. 검증이 살아 있다고 확인한 보고는 거두지 않는다 —
      카드는 살아 있는 오류의 마지막 문이어야 한다. 판정 창이 창금보다
      오래 걸려도 해롭지 않다 — 표식은 끝난 판정에만 붙는다. */
  const disarmConverge = (): void => {
    if (convergeTimer.current !== null) {
      window.clearTimeout(convergeTimer.current);
      convergeTimer.current = null;
    }
  };
  const armConverge = (): void => {
    disarmConverge();
    if (pendingErrors.current.length === 0) return;
    convergeTimer.current = window.setTimeout(() => {
      convergeTimer.current = null;
      const quiet = pendingErrors.current.filter((e) => unverifiable.current.has(errorKey(e)));
      if (quiet.length === 0) return;
      const shownKey = shownError.current ? errorKey(shownError.current) : null;
      for (const error of quiet) retireError(errorKey(error));
      // 그려진 카드가 거둬졌다면 남은 보고의 마지막이, 없으면 조용함이 선다.
      if (shownKey !== null && quiet.some((e) => errorKey(e) === shownKey)) {
        const last = pendingErrors.current[pendingErrors.current.length - 1] ?? null;
        shownError.current = last;
        setPreviewError(last);
      }
    }, CONVERGE_WINDOW_MS);
  };

  /** The webview's report: held while a turn runs, judged at once otherwise. */
  const handlePreviewError = (payload: {
    kind: "runtime" | "build";
    message: string;
    route: string;
  }) => {
    const reported: PreviewError = {
      ...payload,
      kind: payload.kind === "build" ? "build" : "runtime",
    };
    // 새 보고는 새 증거다 — 조용한 창이 기다리던 보고보다 이것이 우선이므로
    // 창은 닫는다(실패의 재확인이 해소를 이긴다).
    disarmConverge();
    holdError(reported);
    if (turnLive) return;
    adjudicate(reported);
  };

  // 턴의 종착이 곧 판정의 자리다(결함 2): 들어 둔 보고(이번 턴의 HMR 파문)와
  // 살아 남은 카드(예전 턴이 남긴 것, 다른 라우트의 것 포함)를 전부 같은
  // 파이프로 내려보낸다 — 화면이 깨끗하게 수렴했으면 카드는 저절로 사라진다.
  // 이전 몸은 이 자리에서 보고 하나만 심사했으므로 다른 라우트의 보고가
  // 성공 턴 뒤에도 남았다. 성공 턴(idle)의 뒤에는 조용한 창까지 연다 —
  // 확인 불능으로 남은 보고의 해소 길이다.
  useEffect(() => {
    if (turnLive) {
      disarmConverge();
      return;
    }
    const queue = [...pendingErrors.current];
    if (queue.length > 0) adjudicateAll(queue);
    if (turnState === "idle") armConverge();
    // verdicts·adjudicate 는 겉모습일 뿐이다 — state 만 본다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnState]);

  // 창의 뒷정리 — 프로젝트를 떠나는 창이 타이머를 남기지 않게 한다.
  useEffect(() => disarmConverge, []);

  // 서버가 새로 떠오르면(미리보기 주소가 바뀌면) 지난 시절의 오류는 전부
  // 낡은 말이다 — PreviewHost 가 url 로 지우던 규약이 판정자와 함께 패널로
  // 옮겨 온 것뿐이다. 핫 리로드는 여전히 보고된 오류를 지우지 못한다.
  // 발사 예산도 서버와 함께 새로 산다.
  useEffect(() => {
    disarmConverge();
    pendingErrors.current = [];
    unverifiable.current.clear();
    autoFires.current.clear();
    shownError.current = null;
    setPreviewError(null);
  }, [repo?.previewUrl]);

  // 서다 있는 카드와 새 이동 — 화면이 다시 열렸다는 것은 새 증거다. 확인
  // 불능으로 서 있던 카드는 서버가 돌아오면 이 판정에서 스스로 걷히고,
  // 아직 살아 있는 오류는 남은 예산만큼 기계가 다시 달려든다. 턴이 도는
  // 동안에는 판정하지 않는다 — 그 보고는 턴의 종착이 심사한다.
  useEffect(() => {
    if (turnLive || !previewError) return;
    adjudicate(previewError);
    // verdicts·adjudicate 는 겉모습일 뿐이다 — location 이 새 증거다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  // --- 화면 보여 주기 -------------------------------------------------
  // 오류도 핀도 아닌 화면 — 흰 화면, 무한 로딩 — 를 AI 에게 통째로 보여
  // 준다: 프레임 캡처 한 장 + 콘솔 마지막 20줄 + 사용자의 한 줄(선택).
  // 같은 라우트의 연타는 `N번째 요청` 표식을 얹고, 턴이 도는 동안의
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
    // 주소의 쿼리는 주소의 일부다 — route 에 통째로 실린다(상태 축 철거).
    const route = location?.path ?? (target?.kind === "path" ? target.path : "/");
    setLookBusy(true);
    try {
      const snapshot = await window.coloDesignDesktop?.preview?.snapshot?.();
      const key = route;
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
        lookToTurn(route, lines.join("\n\n"), count),
        undefined,
        attachments,
        // 게이트 재배선: 이 캡처가 가리킨 화면이 턴의 게이트 입력이다.
        [{ screen: route }],
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
          callDeveloper={
            <CallDeveloper
              daemon={daemon}
              what={`화면 준비가 멈췄습니다 — ${guidanceFor(errorKind, repo?.detail ?? null).title}`}
              detail={repo?.detail ?? null}
            />
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
                  <Tip
                    label={statusOpen ? undefined : delivery.chip.title}
                    side="bottom"
                    align="start"
                  >
                    <button
                      type="button"
                      className="screenpanel__statusbtn"
                      aria-haspopup="dialog"
                      aria-expanded={statusOpen}
                      onClick={() => setStatusOpen((open) => !open)}
                    >
                      <span
                        className={`screenpanel__status screenpanel__status--${delivery.chip.tone}${
                          mergedFlash ? " screenpanel__status--mergedflash" : ""
                        }`}
                        role="status"
                      >
                        {chipGlyph(delivery.chip.tone)}
                        {delivery.chip.label}
                        <ChevronDownIcon />
                      </span>
                    </button>
                  </Tip>
                  {/* 다음 할 일 문장 — 칩 팝오버에서 올라온 것(E′). 칩은 단어를
                      낭독하는 라이브 리전으로 남고, 문장은 시각 보강이다. */}
                  <span className="screenpanel__nextline">{delivery.next.line}</span>
                  {statusOpen && (
                    <span
                      className="selector__menu screenpanel__statusmenu"
                      role="dialog"
                      aria-label="사이클 상태"
                    >
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
              {/* 동작은 상수다: 제출 · 상태 확인은 언제나 그려지고 조건으로만
            잠긴다(슬라이스 3 — 저장과 넘기기를 묶은 계획자의 한 손).
            잠김은 aria-disabled: 진짜 disabled 는 hover 도 포커스도 막아
            title 이 도달할 길이 없었다. */}
              <span className="screenpanel__actions">
                {delivery ? (
                  <>
                    <Tip
                      label={
                        coachSubmit ? (
                          <>
                            만든 것을 개발자에게 보내려면 제출을 누르세요
                            <button
                              type="button"
                              className="notice__close"
                              aria-label="제출 안내 닫기"
                              style={{ marginLeft: 6 }}
                              onClick={dismissSubmitCoach}
                            >
                              ×
                            </button>
                          </>
                        ) : (
                          delivery.actions.submit.reason
                        )
                      }
                      side="bottom"
                      open={coachSubmit}
                    >
                      <button
                        type="button"
                        className={`${
                          delivery.primary === "submit" && delivery.actions.submit.enabled
                            ? "primary screenpanel__action"
                            : "ghost screenpanel__action"
                        }${beatPrimary === "submit" ? " screenpanel__action--beat" : ""}`}
                        aria-disabled={!delivery.actions.submit.enabled}
                        onClick={() => {
                          dismissSubmitCoach();
                          if (delivery.actions.submit.enabled) onCycleAction("submit");
                        }}
                      >
                        <HandoffIcon />
                        <span className="screenpanel__actionlabel">제출</span>
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
                      <HandoffIcon />
                      <span className="screenpanel__actionlabel">제출</span>
                    </button>
                    <span className="screenpanel__locknote">제출은 답변이 끝난 뒤 열립니다</span>
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
              <span className="screenpanel__more">
                <Tip
                  label={menuOpen ? undefined : "최신 변경 받아오기 · 작업 기록"}
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
                  그 자리를 갖는다. 최신 변경 · 작업 기록 · 변경 버리기가 남는다.
                  잠긴 행도 aria-disabled: 진짜 disabled 는 hover 를 막아 title 의
                  잠긴 이유에 도달할 길이 없다 (상단 바와 같은 규칙). */}
                      <Tip
                        label={
                          refreshing
                            ? "받아 오는 중…"
                            : refreshLocked
                              ? "미리보기가 준비되면 받아올 수 있습니다"
                              : "개발자가 반영한 최신 변경을 받아 옵니다 — 저장하지 않은 변경은 그대로 보존됩니다"
                        }
                        side="left"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          className="selector__row screenpanel__refreshrow"
                          aria-disabled={refreshLocked}
                          onClick={() => {
                            if (refreshLocked) return;
                            // 행이 곧 진행을 말한다 — 받아 오는 중… 로.
                            refresh();
                          }}
                        >
                          <span className="ic ic--sm ic--quiet">
                            <RefreshIcon />
                          </span>
                          <span className="selector__text">
                            <span className="selector__label">
                              {refreshing ? "받아 오는 중…" : "최신 변경 받아오기"}
                            </span>
                            <span className="selector__desc">
                              개발자가 반영한 최신 변경을 받아 옵니다
                            </span>
                          </span>
                        </button>
                      </Tip>
                      <Tip label="이번 작업의 차례를 보고 하나로 되돌립니다" side="left">
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
                            <span className="selector__label">작업 기록</span>
                            <span className="selector__desc">
                              이번 작업의 차례를 보고 하나로 되돌립니다
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
          <StateBanner
            tone="danger"
            role="alert"
            title={syncError.text}
            closeLabel="오류 닫기"
            onClose={syncError.close}
          />
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
              callDeveloper={
                <CallDeveloper
                  daemon={daemon}
                  what={`화면 준비가 멈췄습니다 — ${guidanceFor(errorKind, repo?.detail ?? null).title}`}
                  detail={repo?.detail ?? null}
                />
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
              onPreviewError={handlePreviewError}
              error={previewError}
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
              turnRunning={turnState === "running"}
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
                      ? "도구가 코멘트를 읽고 AI에게 반영을 맡깁니다 — 끝나면 알려 드립니다. 답하기로 개발자에게 직접 답할 수 있습니다."
                      : "모두 처리한 목록입니다."}
                </p>
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
    </div>
  );
}
