import type {
  ColoDesignPinEnvelope,
  ColoDesignScreen,
  DeveloperReview,
  DiffFile,
  SessionState,
} from "@colo-design/protocol";
import { markTurn } from "@colo-design/protocol";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Fold, useFoldNotice } from "../../components";
import { useModalFocus } from "../../hooks/use-modal-focus";
import { type Pins, pinsSync } from "../../hooks/usePins";
import type { Daemon } from "../../lib/daemon-client";
import { type Delivery, deriveDelivery } from "../../lib/delivery";
import { ownerRepoOf } from "../../lib/format";
import { linkClick, openLink } from "../../lib/open-link";
import { errorToTurn, lookToTurn, reviewToTurn } from "../../lib/preview-turns";
import { guidanceFor } from "../../lib/repo-guidance";
import {
  isReplyConfirmed,
  loadHandledReviews,
  markReplyConfirmed,
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

/**
 * The workspace's right column: the connected repo clone rendered by its own
 * preview server, plus the three words over it — 저장, 개발자에게
 * 넘기기, and the status the cycle has reached (변경 있음 / 넘김 / 반영됨,
 * read mechanically off the repo). It owns repo readiness, both
 * dialogs, and knows nothing about sessions — a machine turn is handed up to
 * the shell, which decides which thread it lands in. The pins live in the
 * workspace's `usePins`; this panel only re-anchors their badges.
 *
 * It is also where the screen envelopes land: the screens the repo declared
 * come up through `Preview` and stay here — feeding the address bar's
 * proposals, the state chips and the 넘기기 proposal — and the screen the
 * planner should be looking at lives here too, as `target`, set by the
 * toolbar alone.
 */
export function ScreenPanel({
  daemon,
  onOpenSettings,
  onMachineTurn,
  pins,
  onPin,
  onPinFocus,
  turnState,
  sessionId = null,
  screens,
  onScreens,
  commentsOn,
  onCommentsMode,
  jumpRequest,
  onCycleAction,
  cycleRequest,
  reviewsTick,
}: {
  daemon: Daemon;
  onOpenSettings: (category?: SettingsCategory) => void;
  /**
   * Forward a machine-authored turn — the error banner's 고치기, a review's
   * 고치기, 화면 보여 주기, a failing gate's brief — into the working screen
   * thread. The panel does not know which thread that is; the shell resolves
   * it, creating one named after the ask if there is none yet. `images` rides
   * along: the look's frame. 이 길이 실은 화면은 게이트의 입력이 된다 —
   * 턴이 끝나면 기계가 그 화면을 다시 열어 본다 (게이트 재배선).
   *
   * Resolves true when the turn reached the thread; false when it did not
   * (the daemon refused it).
   */
  onMachineTurn: (
    turn: string,
    name?: string,
    images?: Array<{ mediaType: string; data: string }>,
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
   * The screens the repo declared, owned by the workspace now: the
   * chat's starter chips and the palette's screen rows read the same list the
   * picker here renders — one declaration, three doors.
   */
  screens: ColoDesignScreen[];
  onScreens: (screens: ColoDesignScreen[]) => void;
  /**
   * 핀 모드 — the toggle's truth lives in the workspace now, so
   * ⌘⇧P and this toolbar write the same state. The panel draws and relays.
   */
  commentsOn: boolean;
  onCommentsMode: (on: boolean) => void;
  /**
   * A screen the palette picked: a change in this prop navigates the preview
   * there. The panel keeps owning `target` — the request is an ask, not a
   * takeover (the toolbar and 따라가기 still move it on their own).
   */
  jumpRequest?: PreviewTarget | null;
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
   * Which screen and state the preview shows. The toolbar is the screens'
   * only door, so the ask lives here beside it; the address bar's free paths
   * are asks too.
   */
  const [target, setTarget] = useState<PreviewTarget | null>(null);
  /**
   * Where the native view actually is — its own reports, not the ask.
   * The picker and the chips follow this, so an in-app link click moves them
   * too. Null on the browser path (the iframe cannot be asked).
   */
  const [location, setLocation] = useState<PreviewLocation | null>(null);
  /**
   * 본 곳 표식: 이번 수정 이후
   * 기획자의 눈이 닿은 화면·상태. 위치 보고(onLocation)가 이미 흐르고 있으니
   * 표식은 공짜다 — 파일을 쓴 턴이 끝나면(pendingChanges 가 움직이면) 전부
   * 비운다. 칸이 말하는 것은 "존재한다"가 아니라 "이 수정 이후로 내 눈이
   * 닿았다"다. 영속 상태는 없다(세션 동안만 산다).
   */
  const [visited, setVisited] = useState<Set<string>>(new Set());
  // 확인할 곳 목록: 토스트가 접혀도 사서 칩이 순회하는 몸통 — 토스트·칩은
  // 모두 이 한 목록의 뷰다. 핀이 없던 턴은 목록조차 없다(채팅의 답이 기록).
  const [followSpots, setFollowSpots] = useState<Array<{ screen: string; state: string }>>([]);
  const pendingNow = repo?.pendingChanges ?? 0;
  const pendingWas = useRef(pendingNow);
  if (pendingWas.current !== pendingNow) {
    pendingWas.current = pendingNow;
    setVisited(new Set());
    // 저장·넘기기로 변경이 비워지면 직전 턴의 확인 목록도 소비된 것이다.
    if (pendingNow === 0) setFollowSpots([]);
  }
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

  // 칸 표식: 뷰가 보고하는 곳마다 찍고, pendingChanges 가 움직이는 순간(파일을
  // 쓴 턴의 끝 · 저장) 전부 비운다 — 렌더 중 재설정은 위 askRoot 패턴과 같다.
  // 링크로 연 외부 페이지(external)는 미리보기의 화면이 아니니 찍지 않는다.
  const visitPath = location && !location.external ? location.path : null;
  useEffect(() => {
    if (!visitPath) return;
    const [route, query = ""] = visitPath.split("?");
    const state = new URLSearchParams(query).get("state") ?? "default";
    setVisited((prev) => {
      const key = `${route}|${state}`;
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, [visitPath]);
  /** 저장·넘기기는 대화 안 카드로 갔다 — 이 패널이 여는 모달은 없다. */
  // The palette's ask: every pick hands a NEW object, so the effect re-runs
  // and the preview turns once per pick — the panel's own toolbar keeps
  // steering `target` on its own in between.
  useEffect(() => {
    if (jumpRequest?.kind !== "screen") return;
    setTarget({ kind: "screen", route: jumpRequest.route, state: jumpRequest.state });
  }, [jumpRequest]);
  /** 저장 기록 드로어 — 더 보기 ▾ 메뉴에서 연다. */
  const [historyOpen, setHistoryOpen] = useState(false);
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
  /** The 답하기 that still owes the planner the GitHub-writes confirmation. */
  const [replyConfirmFor, setReplyConfirmFor] = useState<number | null>(null);
  const [devBusy, setDevBusy] = useState(false);
  const devPanelRef = useRef<HTMLDivElement>(null);
  useModalFocus(devPanelRef, devPanelOpen);
  useEffect(() => {
    if (!devPanelOpen) return;
    devPanelRef.current?.focus();
    const onKeydown = (event: KeyboardEvent) => {
      // GitHub 쓰기 확인이 위에 떠 있으면 Escape 는 그 확인의 몫이다.
      if (replyConfirmFor !== null) return;
      if (event.key === "Escape") setDevPanelOpen(false);
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [devPanelOpen, replyConfirmFor]);
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
  const askAgent = async () => {
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
  };
  useEffect(() => {
    if (phase === "ready") {
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
          setDevReviews(report.reviews ?? []);
          setLastCheckAt(new Date());
          setHandledTick((tick) => tick + 1);
          if (!quiet) {
            // 빈 확인: 읽을 코멘트가 없고 상태도
            // 그대로면 모달을 열지 않는다 — 빈 모달은 "내가 뭘 잘못 눌렀나"로
            // 읽힌다. 병합 착지는 여전히 이 버튼(과 데몬의 handoffStatus)이
            // 수행한다; 여기서 줄어드는 것은 패널을 여는 일뿐이다.
            const prKey = report.reviews?.[0]?.pr;
            const handled =
              prKey !== undefined
                ? new Set(loadHandledReviews(prKey).map((id) => Number(id)))
                : new Set<number>();
            const unhandled = (report.reviews ?? []).filter(
              (review) => !handled.has(review.id),
            ).length;
            if (unhandled > 0 || report.state !== prevState) setDevPanelOpen(true);
            else {
              setCheckNote("방금 확인함 · 변화 없음");
              window.setTimeout(() => setCheckNote(null), 6_000);
            }
          }
          await api.repoStatus();
        })
        .catch((e: Error) => {
          if (!quiet) syncError.show(e.message);
        });
    },
    [api, repo?.handoff?.state],
  );
  useEffect(() => {
    readHandoffState(true);
  }, [readHandoffState, daemon.activeSlug]);

  // PageWorkspace 의 사이클 요청 — 이 패널은 `check` 만 집는다
  // (저장·넘기기는 대화 안 카드의 몫).
  useEffect(() => {
    if (cycleRequest?.kind === "check") readHandoffState(false);
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
  /** 빈 상태 확인의 한 줄 — 모달 대신. */
  const [checkNote, setCheckNote] = useState<string | null>(null);
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

  const handleReview = (reviews: DeveloperReview[]) => {
    for (const review of reviews) saveHandledReview(review.pr, review.id);
    setHandledTick((tick) => tick + 1);
    void onMachineTurn(reviewToTurn(reviews));
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
    const where =
      location?.path ??
      (target?.kind === "path"
        ? target.path
        : target?.kind === "screen"
          ? target.state
            ? `${target.route}?state=${target.state}`
            : target.route
          : "/");
    const [route = "/", query = ""] = where.split("?");
    const state = new URLSearchParams(query).get("state");
    setLookBusy(true);
    try {
      const snapshot = await window.coloDesignDesktop?.preview?.snapshot?.();
      const key = `${route}|${state ?? ""}`;
      const count = lookKey.current === key ? lookCount.current + 1 : 1;
      lookKey.current = key;
      lookCount.current = count;
      lookSentThisTurn.current = true;
      const images = snapshot?.jpeg
        ? [{ mediaType: "image/jpeg", data: snapshot.jpeg }]
        : undefined;
      const lines = [
        "이 화면이 이렇게 보입니다. 무엇이 잘못됐는지 보고 고쳐 주세요.",
        note.trim() ? `사용자의 말: ${note.trim()}` : "",
        snapshot && snapshot.console.length > 0
          ? `콘솔 마지막 기록:\n${snapshot.console.join("\n")}`
          : "",
      ].filter(Boolean);
      await onMachineTurn(
        lookToTurn(route, state ?? "default", lines.join("\n\n"), count),
        undefined,
        images,
        // 게이트 재배선: 이 캡처가 가리킨 화면이 턴의 게이트 입력이다.
        [{ screen: route, state: state ?? null }],
      );
    } finally {
      setLookBusy(false);
    }
  };

  // --- 확인할 곳: 이번 턴이 가리킨 화면들 --------------------------------
  // 핀·캡처가 실은 화면들 — 턴이 끝나면 칩이 순회한다. 고스트 배지는 턴이
  // 끝나면 사라지므로 도는 동안 여기 붙잡아 두고, 끝나는 순간 칩이 읽는
  // 목록으로 바꾼다. 핀의 크롭이 곧 기획자가 지목한 '고치기 전' 그림이다.
  const ghostSpotsRef = useRef<Array<{ screen: string; state: string }>>([]);
  if (turnState === "running") {
    ghostSpotsRef.current = pins.ghosts.map((ghost) => ({
      screen: ghost.screen,
      state: ghost.state,
    }));
  }

  /** 칩의 분자: 이번 목록 가운데 눈이 닿은 자리 수. */
  const followDone = followSpots.filter((spot) =>
    visited.has(`${spot.screen}|${spot.state}`),
  ).length;
  /** 칩 순회: 아직 안 본 첫 자리로 옮긴다 — 전부 보면 칩이 먼저 사라진다. */
  const cycleFollowSpot = useCallback(() => {
    const next = followSpots.find((spot) => !visited.has(`${spot.screen}|${spot.state}`));
    if (next) setTarget({ kind: "screen", route: `/${next.screen}`, state: next.state });
  }, [followSpots, visited]);

  /** The planner's own moves are marked — a turn's end may not steal them. */
  const handleNavigate = useCallback((ask: PreviewTarget) => {
    setTarget(ask);
  }, []);

  useEffect(() => {
    if (turnState === "running") {
      setFollowSpots([]);
      return;
    }
    const spots: Array<{ screen: string; state: string }> = [];
    const seenSpots = new Set<string>();
    for (const spot of ghostSpotsRef.current) {
      const key = `${spot.screen}|${spot.state}`;
      if (seenSpots.has(key)) continue;
      seenSpots.add(key);
      spots.push(spot);
    }
    ghostSpotsRef.current = [];
    // 목록은 칩이 순회하는 몸통이다. 핀이 없던 턴은 빈 목록으로 끝난다.
    setFollowSpots(spots);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnState]);

  // --- 선예열 ----------------------------------------
  // 요약·초안을 묻는 시점을 버튼 클릭에서 턴의 끝으로 옮긴다. 데몬 캐시(요약은
  // diff 해시, 초안은 브랜치 tip)가 나머지를 하므로 검토 화면을 여는 속도가
  // 곧 8단계의 체감 속도다. 요약 캐시는 diff 해시 키라 기획자가 이어서 고치는
  // 동안의 예열은 대부분 버려진다 — 턴이 끝나고 새 턴 없이 20초 뒤에 묻는다.
  // 저장하지 않을 턴에는 아예 돌지 않는다(pendingChanges 0 게이트).
  const daemonRef = useRef(daemon);
  daemonRef.current = daemon;
  const prewarmWasRunning = useRef(false);
  const summarizeTimer = useRef<number | null>(null);
  useEffect(() => {
    if (turnState === "running") {
      prewarmWasRunning.current = true;
      if (summarizeTimer.current !== null) window.clearTimeout(summarizeTimer.current);
      summarizeTimer.current = null;
      return;
    }
    const settledNow = prewarmWasRunning.current;
    prewarmWasRunning.current = false;
    if (!settledNow) return;
    summarizeTimer.current = window.setTimeout(() => {
      summarizeTimer.current = null;
      if ((daemonRef.current.repo?.pendingChanges ?? 0) > 0) {
        void daemonRef.current.api.summarizeDiff().catch(() => undefined);
      }
    }, 20_000);
    return () => {
      if (summarizeTimer.current !== null) {
        window.clearTimeout(summarizeTimer.current);
        summarizeTimer.current = null;
      }
    };
  }, [turnState]);
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
          onRetry={sync}
          onForceRestart={restart}
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
            <Tip label={statusOpen ? undefined : "지금 상태와 다음 할 일을 봅니다"} side="bottom">
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
          <Tip label="프로젝트 준비가 끝나면 저장 · 넘기기가 열립니다" side="bottom" align="start">
            <span className="screenpanel__status screenpanel__status--none">화면 대기 중</span>
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
                <Tip label="개발자의 판정과 코멘트를 GitHub에서 다시 읽어 옵니다" side="bottom">
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
              <button type="button" className="ghost screenpanel__action" aria-disabled="true">
                <SaveIcon />
                <span className="screenpanel__actionlabel">저장</span>
              </button>
              <button type="button" className="ghost screenpanel__action" aria-disabled="true">
                <HandoffIcon />
                <span className="screenpanel__actionlabel">개발자에게 넘기기</span>
              </button>
              <span className="screenpanel__locknote">저장·넘기기는 답변이 끝난 뒤 열립니다</span>
            </>
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
        {followSpots.length > 0 && followDone < followSpots.length && (
          <Tip label="이번 수정에서 아직 안 본 화면으로 옮겨 갑니다" side="bottom" align="end">
            <button
              type="button"
              className="ghost screenpanel__followchip"
              onClick={cycleFollowSpot}
            >
              확인 {followDone}/{followSpots.length}
            </button>
          </Tip>
        )}
        <span className="screenpanel__more">
          <Tip label={menuOpen ? undefined : "저장 기록 · 변경 버리기"} side="bottom" align="end">
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
                      setHistoryOpen(true);
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
                        <span className="selector__desc">개발자가 검토하는 넘긴 요청을 엽니다</span>
                      </span>
                    </button>
                  </Tip>
                )}
              </span>
            </>
          )}
        </span>
      </div>
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
      {checkNote && (
        <div className="notice notice--info" role="status">
          <span className="notice__text">{checkNote}</span>
        </div>
      )}
      {/* The stage wrapper gives the PiP its coordinates: the
          thumbnail lives in this iframe's corner, and the enlarged look
          covers exactly this iframe — not the bars around it. */}
      <div className={`previewcol__stage${settleFlash ? " previewcol__stage--settled" : ""}`}>
        {bringUpCardInPreview ? (
          <ProgressPanel
            phase={phase ?? "missing"}
            detail={repo?.detail ?? null}
            errorKind={errorKind}
            note={askNote}
            onRetry={sync}
            onForceRestart={restart}
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
            origins={repo?.previewOrigins ?? []}
            stopped={previewStopped}
            stoppedDetail={repo?.detail ?? null}
            onRestart={restart}
            onPin={onPin}
            onPinFocus={onPinFocus}
            onFixError={forwardError}
            screens={screens}
            onScreens={onScreens}
            target={target}
            sync={pinsSync(pins.ghosts, pins.list)}
            onNavigate={handleNavigate}
            onLocation={setLocation}
            location={location}
            visitedCells={visited}
            commentsOn={commentsOn}
            onCommentsMode={onCommentsMode}
            onLook={(note) => void sendLook(note)}
            lookBusy={lookBusy}
          />
        )}
      </div>
      {historyOpen && <HistoryDrawer open onClose={() => setHistoryOpen(false)} daemon={daemon} />}
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
                      handleReview(unhandledDevReviews);
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
                                  handleReview([review]);
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
  );
}
