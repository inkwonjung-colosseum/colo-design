import type { ColoDesignPinEnvelope, SessionState } from "@colo-design/protocol";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Fold, useFoldNotice } from "../../components";
import { type Pins, pinsSync } from "../../hooks/usePins";
import type { Daemon } from "../../lib/daemon-client";
import { type Delivery, deriveDelivery } from "../../lib/delivery";
import { plainErrorTitle } from "../../lib/error-words";
import { timeAgo } from "../../lib/format";
import { openLink } from "../../lib/open-link";
import { errorToTurn, lookToTurn } from "../../lib/preview-turns";
import { focusReadDue } from "../../lib/quiet-read";
import { previewPathOf, registerScreenOpener } from "../../lib/screen-link";
import { markRepoPrepSeen } from "../../lib/settings";
import { advanceTour, useTourStep } from "../../lib/tour";
import { lastTurnScreens, screenKey, type TurnScreen, threadScreens } from "../../lib/turn-screens";
import type { SettingsCategory } from "../dialogs/SettingsDialog";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  ExternalLinkIcon,
  EyeIcon,
  HandoffIcon,
  HistoryIcon,
  MinusIcon,
  PencilIcon,
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
      // git 브랜치 모양은 개발자의 어휘다(PLAN 단계 10) — 같은 연필을 조용한
      // 색으로 쓴다: 이제 막 지어낸 화면이 있다는 뜻이다.
      return (
        <span className="ic ic--quiet">
          <PencilIcon />
        </span>
      );
    case "handed":
      return (
        <span className="ic ic--quiet">
          <EyeIcon />
        </span>
      );
  }
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
  submitBusy = false,
}: {
  /** 프레임 헤더가 내준 자리 — 사이클 바는 여기로 올라가 프로젝트 이름 옆에
      선다. null 이면 바는 그려지지 않는다(헤더가 없는 호출은 없다). */
  barSlot: HTMLDivElement | null;
  daemon: Daemon;
  onOpenSettings: (category?: SettingsCategory) => void;
  /**
   * Forward a machine-authored turn — a preview error's fix turn, a review's
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
   * 사이클 동작의 단일 통로 (PageWorkspace): 상단 바의 제출이 이 콜백으로
   * 올라가고 대화 안 카드가 응답한다(PLAN 단계 10 — 상태 확인 버튼은 없다).
   */
  onCycleAction: (kind: "submit") => void;
  /** PageWorkspace 가 내린 사이클 요청 — 이 패널은 `history` 만 집는다. */
  cycleRequest: { kind: "submit" | "history"; nonce: number } | null;
  /** 대화 열의 제출이 도는 중 — 제출 버튼이 `보내는 중…` 으로 답한다. */
  submitBusy?: boolean;
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
  // 개발 실행 판정 — 원문 오류 문장의 노출을 가른다(PLAN L8).
  const devMachine = daemon.status?.dev === true;
  // 원문(영어일 수 있다)은 기록으로 — 화면은 한국어 한 줄만 그린다(L8).
  useEffect(() => {
    if (syncError.text && !devMachine) {
      console.warn("[colo-design] 동기화 오류:", syncError.text);
    }
  }, [syncError.text, devMachine]);
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

  /**
   * 답변의 화면 링크 · 핀 카드의 행이 이 칸을 옮기는 손 — 주소창에 경로를
   * 친 것과 같은 target 이다. 서버 주소가 아직 없으면 등록하지 않는다:
   * 판정할 origin 이 없고, 그 링크는 원래대로 브라우저가 연다. 새 객체를
   * 세우므로 같은 경로를 다시 눌러도 칸이 다시 그 화면으로 간다.
   */
  const previewUrl = repo?.previewUrl ?? null;
  useEffect(() => {
    if (!previewUrl) return;
    return registerScreenOpener({
      previewUrl,
      open: (path) => setTarget({ kind: "path", path }),
    });
  }, [previewUrl]);

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
  // --- 개발자 코멘트 창은 없다(PLAN 단계 10) — 코멘트는 대화록의 개발자
  // 메시지로 이미 선다(review.arrived), 답하기도 대화록에서 한다(HumanMessage).
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

  useEffect(() => {
    if (phase === "ready") {
      // 첫 준비가 끝난 기기다 — 다음 준비부터 대기 카드는 이름만 말한다.
      markRepoPrepSeen();
    }
  }, [phase]);

  /** 상태 확인의 빈 답 — 내용 영역의 띠 대신 누른 버튼 곁의 한 줄. 같은
   * 말을 다시 싣으면 이전 타이머를 지운다 — 답이 온전히 6 초를 살게. */
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const checkNoteTimer = useRef<number | null>(null);
  const showCheckNote = useCallback((text: string) => {
    setCheckNote(text);
    if (checkNoteTimer.current !== null) window.clearTimeout(checkNoteTimer.current);
    checkNoteTimer.current = window.setTimeout(() => setCheckNote(null), 6_000);
  }, []);

  /** 조용한 상태 읽기(PLAN 단계 10): GitHub 의 답을 다시 읽어 칩에 반영하고
   * 마지막 확인 시각을 갱신한다. `repo.handoffStatus` 는 감독자의 틱을 깨우는
   * 길이기도 하다(dispatch 가 tick("manual") 을 돌린다) — 마운트 · 프로젝트
   * 전환 · 창 포커스가 부른다. 사람이 누르는 `상태 확인` 버튼은 없다:
   * 감독자가 확인한다. 열린 넘김이 없으면 데몬이 바로 돌려준다(null 도
   * 대답이다). 코멘트 목록은 이제 읽지 않는다 — 대화록이 원천이다. */
  const readHandoffState = useCallback(() => {
    void api
      .handoffStatus()
      .then(async () => {
        setLastCheckAt(new Date());
        await api.repoStatus();
      })
      .catch((error) => {
        // 원문은 기록으로 — 칩은 다음 읽기가 스스로 고친다.
        console.error("[colo-design] 상태 읽기", error);
      });
  }, [api]);
  useEffect(() => {
    readHandoffState();
  }, [readHandoffState, daemon.activeSlug]);

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
  // 얼굴의 기본값은 언제나 지금 화면이다. 제출 직후 무대를 캡처로 덮으면
  // 비개발자에게는 "화면이 멈췄다" 로 읽히고, 화면의 버튼도 눌리지 않는다.
  // 보낸 화면은 도장 옆 세그먼트로 한 번 누르면 닿는다. 새 작업이
  // 시작되면(pendingChanges > 0) 얼린 화면은 거짓말이라 지금 화면으로
  // 돌아온다.
  const [frozenMode, setFrozenMode] = useState<"sent" | "live">("live");
  const [frozenStampGone, setFrozenStampGone] = useState(false);
  const frozenCycleKeyRef = useRef<string | null>(null);
  const frozenCycleKey = `${handoff?.number ?? ""}|${handoffState ?? ""}`;
  if (frozenCycleKeyRef.current !== frozenCycleKey) {
    frozenCycleKeyRef.current = frozenCycleKey;
    setFrozenMode("live");
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
          // 실제로 열기(시점 빌드 재현)는 개발 실행의 손이다 — 단계 10.
          dev: daemon.status?.dev === true,
        }
      : null;

  // --- 하루 한 프로젝트에 머무는 창도 본다 ---
  // 활성화 트리거는 프로젝트를 바꿀 때만 오므로, 같은 프로젝트에 하루 종일
  // 앉은 창은 며칠 전 병합을 알 방법이 없었다. 돌아온 창(focus·다시 보임)은
  // 조용히 다시 읽어 감독자의 틱을 깨운다(PLAN 단계 10) — 시간당 몇 번을
  // 넘지 않게 20분 스로틀로 억제한다. 도는 턴 중에는 손대지 않는다
  // (handoffStatus 는 병합이 보이면 착지까지 하는 능동적 읽이다).
  const lastQuietRead = useRef(0);
  useEffect(() => {
    const reread = () => {
      if (document.visibilityState !== "visible") return;
      if (turnState === "running") return;
      const now = Date.now();
      if (!focusReadDue(lastQuietRead.current, now)) return;
      lastQuietRead.current = now;
      readHandoffState();
    };
    window.addEventListener("focus", reread);
    document.addEventListener("visibilitychange", reread);
    return () => {
      window.removeEventListener("focus", reread);
      document.removeEventListener("visibilitychange", reread);
    };
  }, [readHandoffState, turnState]);

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

  // --- 미리보기 오류의 판정 ---------------------------------------------
  // 연결 레포의 오류는 사람에게 올리지 않는다(2026-09-23) — 카드도, "AI에게
  // 고쳐 달라고 하기" 단추도 없다. 보고는 전부 이 파이프를 지나 AI 의 고침
  // 턴이 되거나, 조용히 거둬진다.
  //
  // 오류 보고는 두 갈래로 온다. 턴이 도는 동안의 보고는 대부분 HMR 의 깨진
  // 중간 상태다 — 곧바로 판정하지 않고 들어 두었다가, 턴이 끝나면 데몬의
  // 검증 창(preview.screenCheck — 게이트와 같은 드라이버·같은 판정)으로 그
  // 화면을 다시 열어 본다. 깨끗하면 조용히 거둔다(이미 고쳐진 것), 살아
  // 있으면 고침 턴을 스스로 내려놓는다. 못 건 보고(예산이 말랐다 · 한 발이
  // 이미 나가 있다 · 대화가 거절했다)는 보류로 남아 다음 정산이 다시 본다.
  // 발사가 무한하면 기계 둘이 서로 답하며 구독을 태운다(게이트의
  // `gatedSessions` 와 같은 이유다). 한 번만 발사하는 것도 답이 못 된다 —
  // 턴 도중의 파문이 한 발을 삼킨다. 그래서 예산은 키별 둘이고, 회복된다:
  // 깨끗한 판정(고침이 성공한 것 — 다음 오류는 새 오류다)·새 미리보기
  // 서버(지난 시절의 오류는 전부 낡은 말이다)가 각각 새 예산을 산다. 예산이
  // 마른 오류는 AI 가 두 번 고쳐 본 것이다 — 그 설명은 대화에 이미 있다.
  //
  // 결함 2(실사 2026-09-20): 이전 몸은 정산에서 보고 하나만 심사했다 —
  // 턴 도중의 보고는 덮어 쓰였다. 그래서 한쪽 라우트의 보고는 성공 턴을 몇 번
  // 견뎌도 해소되지 않았다. 지금은 보고를 목록으로 들고, 턴의 종착에서 보류된
  // 전부를 같은 파이프로 심사한다. 데몬이 게이트 전체 통과의 방송을 주지
  // 않으므로, 확인 불능으로 남은 보고에는 웹만의 해소 길을 더한다 — 성공
  // 턴(idle) 뒤의 조용한 창(CONVERGE_WINDOW_MS)이다.
  /** 아직 거둬지지 않은 보고 전부 — 턴 도중에 들어 둔 것과 못 건 것. */
  const pendingErrors = useRef<PreviewError[]>([]);
  /** 오류 키별로 기계가 쓴 고침 발사 수 — MAX_AUTO_FIXES 가 한도다. */
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
  /**
   * 한 번에 한 발 — 판정은 판정 창 하나에 몇 초씩 걸리므로, 발사 직전의 진실은
   * 판정을 시작할 때의 렌더가 아니라 지금의 것이어야 한다. 턴이 돌고 있으면
   * 쏘지 않는다(그 턴의 종착이 보류된 전부를 다시 심사한다). `fixOut` 은 전달된
   * 고침 턴이 아직 정산되지 않았다는 표식이다 — 상태 방송이 닿기 전의 틈에
   * 같은 파문의 다른 보고가 두 번째 고침 턴을 싣지 않게 한다.
   */
  const turnLiveNow = useRef(turnLive);
  turnLiveNow.current = turnLive;
  const fixOut = useRef(false);
  /** 확인 불능의 뜻은 데몬이 서버를 어떻게 보는지에 달렸다 — 판정 시점의 레포. */
  const repoNow = useRef(repo);
  repoNow.current = repo;

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

  /** The verdict pipeline, serialized — together-arriving reports are
      judged in order, and at most one of them becomes a fix turn. */
  const adjudicateAll = (reports: PreviewError[]): void => {
    verdicts.current = verdicts.current.then(async () => {
      // 한 정산의 발사는 하나다 — 같은 파문이 여러 라우트에서 보고됐을 때
      // 발사 수만큼 고침 턴이 늘면 기계 둘이 서로 답한다(게이트의
      // gatedSessions 와 같은 이유다). 나머지 보고는 다음 정산이 심사한다.
      let fired = false;
      for (const error of reports) {
        const key = errorKey(error);
        // 앞 판정(같은 파이프의 이전 통과)이 이미 거둔 보고다.
        if (!pendingErrors.current.some((e) => errorKey(e) === key)) continue;
        // 웹뷰는 루트를 빈 경로("")로 보고하지만 선로는 빈 route 를 거절한다 —
        // 그 거절이 루트 화면의 모든 오류를 확인 불능으로 만들었다(ENOENT 실사).
        const report = await api.screenCheck(error.route || "/").catch(() => null);
        if (report === null) {
          // 확인 불능 — 판정이 아니라 못 본 것이다. 성공 턴 뒤의 조용한 창이
          // 이 키를 거둔다. 콘솔 한 줄의 보고는 그것만으로 고칠 까닭이 못
          // 된다(로드 중에 스스로 주소를 옮기는 화면도 검증 창에선 못 연 것으로
          // 읽힌다). 멈춤(stalled)은 다르다 — 패인이 제 눈으로 못 띄운 화면을
          // 검증 창도 못 열었다면 그것이 곧 확인이다. 다만 서버가 없는
          // 순간(재기동 · 준비 실패)의 복구는 데몬의 몫(C5 재기동 → D4
          // 브리프)이라 여기서 또 부르지 않는다 — 같은 사고에 AI 가 두 번 불린다.
          unverifiable.current.add(key);
          if (!error.stalled || repoNow.current?.phase !== "ready") continue;
        } else if (report.settled && report.errors.length === 0) {
          // 이미 고쳐졌다(혹은 일시적 파문이었다) — 조용히 거둔다. 이 화면의
          // 예산도 돌려준다: 고침이 성공을 냈으면 다음 오류는 새 오류다.
          retireError(key);
          for (const budget of [...autoFires.current.keys()]) {
            if (budget.startsWith(`${error.route}|`)) autoFires.current.delete(budget);
          }
          continue;
        } else {
          unverifiable.current.delete(key);
        }
        const spent = autoFires.current.get(key) ?? 0;
        // 못 거는 보고는 보류로 남는다 — 다음 정산(그 턴의 종착 · 새 이동 ·
        // 새 보고)이 다시 본다. 사람에게 올리는 문은 없다.
        if (fired || fixOut.current || turnLiveNow.current || spent >= MAX_AUTO_FIXES) continue;
        const delivered = await onMachineTurn(errorToTurn(error, spent + 1));
        if (delivered) {
          // 고침 턴이 뛰었다. 예산은 전달된 발사만 쓴다: 거절은 판정의
          // 실패가 아니라 못 건 것이다.
          autoFires.current.set(key, spent + 1);
          fixOut.current = true;
          fired = true;
        }
      }
    });
  };

  /** Single-report convenience — the pipeline judges one report through the
      same body the settle pass uses. */
  const adjudicate = (error: PreviewError): void => adjudicateAll([error]);

  /** 웹만의 해소 창 — 결함 2의 후반. 성공 턴이 끝난 뒤 이 창 동안 새 보고도
      새 턴도 없으면 미리보기가 오류 없이 이어져 온 것이므로, 확인 불능으로
      남은 보고를 거둔다. 검증이 살아 있다고 확인한 보고는 거두지 않는다 —
      그것은 다음 정산의 몫이다. 판정 창이 창금보다 오래 걸려도 해롭지
      않다 — 표식은 끝난 판정에만 붙는다. */
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
      for (const error of pendingErrors.current) {
        if (unverifiable.current.has(errorKey(error))) retireError(errorKey(error));
      }
    }, CONVERGE_WINDOW_MS);
  };

  /** The webview's report: held while a turn runs, judged at once otherwise. */
  const handlePreviewError = (payload: {
    kind: "runtime" | "build";
    message: string;
    route: string;
    stalled?: true;
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
    // 예산이 마른 오류의 재보고(렌더마다 같은 콘솔 오류)는 판정 창을 또 열
    // 까닭이 없다 — 다음 턴의 종착이 목록째 다시 본다.
    if ((autoFires.current.get(errorKey(reported)) ?? 0) >= MAX_AUTO_FIXES) return;
    adjudicate(reported);
  };

  // 턴의 종착이 곧 판정의 자리다(결함 2): 들어 둔 보고(이번 턴의 HMR 파문)와
  // 못 건 채 남은 보고(예전 턴이 남긴 것, 다른 라우트의 것 포함)를 전부 같은
  // 파이프로 내려보낸다 — 화면이 깨끗하게 수렴했으면 목록은 저절로 빈다.
  // 나가 있던 고침 턴도 여기서 정산된다(fixOut). 성공 턴(idle)의 뒤에는
  // 조용한 창까지 연다 — 확인 불능으로 남은 보고의 해소 길이다.
  useEffect(() => {
    if (turnLive) {
      disarmConverge();
      return;
    }
    fixOut.current = false;
    const queue = [...pendingErrors.current];
    if (queue.length > 0) adjudicateAll(queue);
    if (turnState === "idle") armConverge();
    // verdicts·adjudicate 는 겉모습일 뿐이다 — state 만 본다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnState]);

  // 창의 뒷정리 — 프로젝트를 떠나는 창이 타이머를 남기지 않게 한다.
  useEffect(() => disarmConverge, []);

  // 서버가 새로 떠오르면 지난 시절의 오류는 전부 낡은 말이다. 주소만 보면
  // 같은 포트로 다시 뜬 서버(C5 재기동)를 놓친다 — 죽은 서버 시절의 보고가
  // 새 서버 위에 남았다(실사 2026-09-23, ENOENT). 서버마다 새 번호인 에포크가
  // 진실이다. 핫 리로드는 여전히 보고된 오류를 지우지 못한다. 발사 예산도
  // 서버와 함께 새로 산다.
  useEffect(() => {
    disarmConverge();
    pendingErrors.current = [];
    unverifiable.current.clear();
    autoFires.current.clear();
  }, [repo?.previewUrl, repo?.previewEpoch]);

  // 새 이동 — 화면이 다시 열렸다는 것은 새 증거다. 보류된 보고 중 마지막 것을
  // 다시 본다(판정 창 하나의 값): 서버가 돌아왔으면 스스로 걷히고, 아직 살아
  // 있으면 남은 예산만큼 기계가 다시 달려든다. 예산이 마른 보고는 턴의 종착에
  // 맡긴다. 턴이 도는 동안에는 판정하지 않는다 — 그 보고는 턴의 종착이 심사한다.
  useEffect(() => {
    if (turnLive) return;
    const newest = pendingErrors.current[pendingErrors.current.length - 1];
    if (!newest || (autoFires.current.get(errorKey(newest)) ?? 0) >= MAX_AUTO_FIXES) return;
    adjudicate(newest);
    // verdicts·adjudicate 는 겉모습일 뿐이다 — location 이 새 증거다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  // --- 대화가 말한 화면들 ---------------------------------------------
  // 답변 끝의 `[제목](주소)` 가 원천이다(turn-screens.ts — 공통 규칙이 AI 에게
  // 그 링크를 남기게 한다). 두 곳이 읽는다: 턴이 끝나면 미리보기가 그 턴이
  // 고친 화면으로 옮겨 가고, 주소창은 이 대화의 화면을 제목으로 나열한다.
  // 도는 턴의 글은 흐르는 중이라 목록은 턴이 쉬는 순간에만 다시 읽는다 —
  // 흐름의 조각마다 대화 전체를 훑지 않게.
  const toPath = useCallback((href: string) => previewPathOf(href, previewUrl), [previewUrl]);
  const activeBlocks = sessionId ? (daemon.sessions[sessionId]?.blocks ?? null) : null;
  const [conversationScreens, setConversationScreens] = useState<TurnScreen[]>([]);
  const screensOf = useRef<string | null>(null);
  useEffect(() => {
    // 대화를 옮겨 탔으면 도는 중이라도 새 대화의 목록을 읽는다 — 옛 대화의
    // 화면이 주소창에 남으면 안 된다.
    if (turnLive && screensOf.current === sessionId) return;
    screensOf.current = sessionId;
    setConversationScreens(activeBlocks ? threadScreens(activeBlocks, toPath) : []);
  }, [turnLive, sessionId, activeBlocks, toPath]);

  // 턴이 끝나면 그 턴이 고친 화면으로 — "AI 가 끝났다는데 화면이 그대로다"
  // 의 대부분은 다른 화면을 보고 있어서다. 지금 화면이 그 턴의 화면 중
  // 하나면 옮기지 않는다(이미 보고 있다). 옮긴 뒤 돌아가는 길은 미리보기의
  // 뒤로 버튼이다 — 이동은 보통의 이동이라 기록에 남는다.
  const liveBefore = useRef<{ live: boolean; sessionId: string | null }>({
    live: turnLive,
    sessionId,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: 턴의 끝(상태 전이)만 본다 — 위치·블록이 움직일 때마다 다시 끌면 사람이 옮겨 간 화면을 도로 빼앗는다.
  useEffect(() => {
    const before = liveBefore.current;
    liveBefore.current = { live: turnLive, sessionId };
    // 같은 대화의 턴이 방금 끝났을 때만 — 도는 대화에서 쉬는 대화로 옮겨 탄
    // 것은 턴의 끝이 아니다.
    if (!before.live || turnLive || !sessionId || before.sessionId !== sessionId) return;
    // 외부 페이지를 보는 중이면 사람이 일부러 나간 것이다 — 끌어오지 않는다.
    if (location?.kind === "web") return;
    const blocks = daemon.sessions[sessionId]?.blocks;
    if (!blocks) return;
    const screens = lastTurnScreens(blocks, toPath);
    const first = screens[0];
    if (!first) return;
    const here = location?.path ?? (target?.kind === "path" ? target.path : null);
    if (here !== null && screens.some((screen) => screenKey(screen.path) === screenKey(here))) {
      return;
    }
    setTarget({ kind: "path", path: first.path });
  }, [turnLive, sessionId]);

  // --- 제출 버튼의 얼굴 -----------------------------------------------
  // 누른 제출은 누른 자리에서 답한다: 도는 동안 `보내는 중…`, 끝나면 몇 초
  // `제출됐어요`. 영수증은 여전히 대화의 카드가 들고 있지만, 누른 손이 눈을
  // 옮기지 않아도 결과를 안다. 진행 채널(diff.status)은 턴마다의 자동 보관도
  // 쓰므로 "누른 제출" 은 대화 열이 알린 submitBusy 가 정한다. `handing-off`
  // 는 자동 보관에 없는 단계라, 다른 창이 누른 제출이라도 넘기는 중이 맞다.
  const submitting = submitBusy || daemon.diffStatus?.stage === "handing-off";
  const [submitDone, setSubmitDone] = useState(false);
  const wasSubmitting = useRef(submitting);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 누름의 시작과 끝만 본다 — 진행 단계는 그 순간의 사실로 한 번 읽는다.
  useEffect(() => {
    const ended = wasSubmitting.current && !submitting;
    wasSubmitting.current = submitting;
    if (submitting) {
      setSubmitDone(false);
      return;
    }
    // 실패는 대화의 실패 배너가 말한다 — 버튼은 원래 얼굴로 돌아올 뿐이다.
    if (!ended || daemon.diffStatus?.stage !== "handed-off") return;
    setSubmitDone(true);
    const timer = window.setTimeout(() => setSubmitDone(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [submitting]);

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
  // 준비 실패는 데몬(D4)이 이미 AI 에게 넘겼다 — 그 대화가 지금 도는지가 진행
  // 판의 한 줄(고치는 중 / 맡겼다)을 가른다.
  const aiWorking = projects.find((project) => project.slug === activeSlug)?.working === true;
  // Progress renders inside this column, not over the whole planner: the rail
  // and the chat stay usable while the clone runs.
  if (showProgress) {
    return (
      <div className="planner__previewcol">
        <ProgressPanel
          phase={phase ?? "missing"}
          detail={repo?.detail ?? null}
          errorKind={errorKind}
          connectionLost={connectionLost}
          aiWorking={aiWorking}
          onRetry={sync}
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
                  {statusOpen && (
                    <span
                      className="selector__menu screenpanel__statusmenu"
                      role="dialog"
                      aria-label="사이클 상태"
                    >
                      {/* 다음 할 일 문장 — 바에 서 있던 때는 42자에서 잘렸다.
                          칩은 단어를 낭독하는 라이브 리전으로 남고, 문장은 칩을
                          열었을 때 온전히 읽힌다. */}
                      <span className="screenpanel__statusline">{delivery.next.line}</span>
                      {/* 개발자 이름(리뷰를 부탁한 사람들) — 저장소 이름과 요청
                          번호는 개발자의 어휘라 뺀다(PLAN 단계 10). */}
                      {handoff?.reviewers !== undefined && handoff.reviewers.length > 0 && (
                        <span className="screenpanel__destination">
                          개발자 {handoff.reviewers.length}명이 보고 있어요 ·{" "}
                          {handoff.reviewers.join(" · ")}
                        </span>
                      )}
                      <span className="screenpanel__statusrow">
                        <span className="hint">
                          {lastCheckAt ? `마지막 확인 ${timeAgo(lastCheckAt.getTime())}` : null}
                        </span>
                      </span>
                    </span>
                  )}
                </span>
              ) : (
                <Tip label="프로젝트 준비가 끝나면 제출이 열립니다" side="bottom" align="start">
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
                        ) : submitting ? (
                          "개발자에게 보내는 중이에요 — 끝나면 대화에 영수증이 떠요"
                        ) : submitDone ? (
                          "개발자에게 보냈어요 — 대화의 영수증에서 누구에게 갔는지 볼 수 있어요"
                        ) : checkNote ? undefined : (
                          // 잠긴 이유가 버튼 아래 한 줄로 서 있는 동안은 같은 말을
                          // 두 번 띄우지 않는다.
                          delivery.actions.submit.reason
                        )
                      }
                      side="bottom"
                      open={coachSubmit}
                    >
                      <button
                        type="button"
                        className={`${
                          delivery.primary === "submit" &&
                          delivery.actions.submit.enabled &&
                          !submitting &&
                          !submitDone
                            ? "primary screenpanel__action"
                            : "ghost screenpanel__action"
                        }${submitDone ? " screenpanel__action--done" : ""}${
                          beatPrimary === "submit" ? " screenpanel__action--beat" : ""
                        }`}
                        aria-disabled={!delivery.actions.submit.enabled || submitting}
                        aria-busy={submitting || undefined}
                        onClick={() => {
                          dismissSubmitCoach();
                          if (submitting) return;
                          // 잠긴 버튼도 누르면 답한다 — 마우스를 올려야만 읽히는
                          // 이유는 누른 손에게 닿지 않는다(상태 확인의 빈 답과
                          // 같은 자리, 같은 수명).
                          if (!delivery.actions.submit.enabled) {
                            if (delivery.actions.submit.reason) {
                              showCheckNote(delivery.actions.submit.reason);
                            }
                            return;
                          }
                          onCycleAction("submit");
                        }}
                      >
                        {submitting ? (
                          <span className="spinner" aria-hidden="true" />
                        ) : submitDone ? (
                          <CheckIcon />
                        ) : (
                          <HandoffIcon />
                        )}
                        <span className="screenpanel__actionlabel">
                          {submitting ? "보내는 중…" : submitDone ? "제출됐어요" : "제출"}
                        </span>
                      </button>
                    </Tip>
                    {/* 상태 확인 버튼은 없다(PLAN 단계 10) — 감독자가 확인하고,
                        창이 앞으로 오면 조용히 틱을 깨운다(위의 reread). */}
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
                <Tip label={menuOpen ? undefined : "작업 기록"} side="bottom" align="end">
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
                      {/* 저장 · 넘기기 · 받아오기는 이 메뉴에 없다 — 받아오기는
                  도구가 먼저 하고(E1), 저장은 답을 낸 턴마다 스스로 된다.
                  작업 기록 · 넘긴 내용 열기가 남는다. 잠긴 행도 aria-disabled:
                  진짜 disabled 는 hover 를 막아 title 의 잠긴 이유에 도달할
                  길이 없다 (상단 바와 같은 규칙). */}
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
                      {repo?.handoff?.url && (
                        <Tip label="개발자가 검토하는 제출한 요청을 엽니다" side="left">
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
                              <span className="selector__label">보낸 내용 열기</span>
                              <span className="selector__desc">
                                개발자가 검토하는 제출한 요청을 엽니다
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
            title={plainErrorTitle(syncError.text, devMachine)}
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
              connectionLost={connectionLost}
              aiWorking={aiWorking}
              onRetry={sync}
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
              onPin={onPin}
              onPinFocus={onPinFocus}
              onPreviewError={handlePreviewError}
              target={target}
              sync={pinsFrame}
              onNavigate={setTarget}
              onLocation={setLocation}
              location={location}
              commentsOn={commentsOn}
              onCommentsMode={onCommentsMode}
              onLook={(note) => void sendLook(note)}
              lookBusy={lookBusy}
              screens={conversationScreens}
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
        {/* 개발자 코멘트 창(모달)은 없다(PLAN 단계 10) — 코멘트는 대화록의
            개발자 메시지로 이미 선고 답하기도 거기서 한다. */}
      </div>
    </div>
  );
}
