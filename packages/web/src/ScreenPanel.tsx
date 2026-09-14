import type {
  ColoDesignCommentsEnvelope,
  ColoDesignScreen,
  DeveloperReview,
  DiffFile,
  SessionState,
} from "@colo-design/protocol";
import { markTurn } from "@colo-design/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { CommentsPopover } from "./CommentsPopover";
import { ConfirmDialog } from "./ConfirmDialog";
import { Fold, useFoldNotice } from "./components";
import { DiffPanel } from "./DiffPanel";
import type { CommentItem, Daemon } from "./daemon-client";
import { deriveDelivery } from "./delivery";
import { stateLabel } from "./format";
import { HandoffPanel } from "./HandoffPanel";
import { HistoryDrawer } from "./HistoryDrawer";
import { handoffDraft } from "./handoff-draft";
import { ChevronDownIcon, CloseIcon, RefreshIcon } from "./icons";
import {
  type PreviewError,
  PreviewHost,
  type PreviewLocation,
  type PreviewTarget,
} from "./PreviewHost";
import { commentsToTurn, errorToTurn, lookToTurn, reviewToTurn } from "./preview-turns";
import { errorKindOf, ProgressPanel } from "./RepoProgress";
import {
  isReplyConfirmed,
  loadHandledReviews,
  markReplyConfirmed,
  saveHandledReview,
} from "./settings";
import { objectParticle } from "./tool-names";
import { useModalFocus } from "./use-modal-focus";

/**
 * The workspace's right column: the connected repo clone rendered by its own
 * preview server, plus the three words of PLAN D5 over it — 저장, 개발자에게
 * 넘기기, and the status the cycle has reached (변경 있음 / 넘김 / 반영됨,
 * read mechanically off the repo — PLAN D4). It owns repo readiness, both
 * dialogs and the comment pins, and knows nothing about sessions — a comment
 * bundle is handed up to the shell, which decides which thread it lands in.
 *
 * It is also where PLAN D7's envelopes land: the screens the repo declared
 * come up through `Preview` and stay here — feeding the address bar's
 * proposals, the state chips and the 넘기기 proposal — and the screen the
 * planner should be looking at lives here too, as `target`, set by the
 * toolbar alone.
 */
export function ScreenPanel({
  daemon,
  onOpenSettings,
  onComments,
  turnState,
  sessionId = null,
  showPip,
  followClaude,
  screens,
  onScreens,
  jumpRequest,
}: {
  daemon: Daemon;
  onOpenSettings: () => void;
  /**
   * Forward a comment bundle as a turn in the working screen thread. The panel
   * does not know which thread that is; the shell resolves it, creating one
   * named after the screen if there is none yet. `images` rides along (D87):
   * the crops the view took of the pinned elements.
   */
  onComments: (
    turn: string,
    name?: string,
    images?: Array<{ mediaType: string; data: string }>,
  ) => Promise<void>;
  /** State of the thread the comments went to, so pins clear when it settles. */
  turnState: SessionState;
  /**
   * The live thread a failing gate briefs: a failed check or build hands its
   * output to Claude as the next Korean turn, so a failed 저장 or 넘기기 is
   * not a dead end. Null when no thread is open — there is nobody to brief.
   */
  sessionId?: string | null;
  /** Claude 시점 보기(PLAN D63) — 설정의 `Claude가 보는 화면 표시`. */
  showPip: boolean;
  /** 턴이 끝나면 Claude 가 본 화면으로 (PLAN D91) — 설정의 따라가기. */
  followClaude: boolean;
  /**
   * The screens the repo declared (PLAN D7), owned by the workspace now: the
   * chat's starter chips and the palette's screen rows read the same list the
   * picker here renders — one declaration, three doors.
   */
  screens: ColoDesignScreen[];
  onScreens: (screens: ColoDesignScreen[]) => void;
  /**
   * A screen the palette picked: a change in this prop navigates the preview
   * there. The panel keeps owning `target` — the request is an ask, not a
   * takeover (the toolbar and 따라가기 still move it on their own).
   */
  jumpRequest?: PreviewTarget | null;
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
   * The turn's echo on the preview: while Claude works the column
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
   * are asks too (D66).
   */
  const [target, setTarget] = useState<PreviewTarget | null>(null);
  /**
   * Where the native view actually is (D66) — its own reports, not the ask.
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
  /** The two dialogs of the cycle: 저장 and 개발자에게 넘기기. */
  const [saveOpen, setSaveOpen] = useState(false);
  // The palette's ask: every pick hands a NEW object, so the effect re-runs
  // and the preview turns once per pick — the panel's own toolbar keeps
  // steering `target` on its own in between.
  useEffect(() => {
    if (!jumpRequest) return;
    setTarget(jumpRequest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpRequest]);
  const [handoffOpen, setHandoffOpen] = useState(false);
  /** 저장 기록 드로어 (PLAN D53) — 더 보기 ▾ 메뉴에서 연다. */
  const [historyOpen, setHistoryOpen] = useState(false);
  /** 더 보기 ▾ 메뉴 — 점검·기록·버리기·목록의 자리 (PLAN D82). */
  const [menuOpen, setMenuOpen] = useState(false);
  /** 변경 버리기 확인 — this app's dialog (결함③), with the file list it names. */
  const [discardConfirm, setDiscardConfirm] = useState(false);
  /** Paths the discard would throw away, read when the dialog opens. */
  const [discardFiles, setDiscardFiles] = useState<DiffFile[] | null>(null);

  /**
   * 코멘트 모드(PLAN D58 → D79) — 핀만 찍는 좁은 뜻의 토글; the preview toolbar's 💬 toggle draws
   * and the frame is re-told.
   */
  const [commentsOn, setCommentsOn] = useState(false);
  /**
   * 코멘트 기록(PLAN D57): the log of what the pins asked Claude. Null until
   * the first read returns; the popover reads this one list.
   */
  const [commentItems, setCommentItems] = useState<CommentItem[] | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  // --- 개발자 코멘트 (PLAN D88): 상태 확인 이 읽어 온 개발자의 말 ----------
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
      if (event.key === "Escape") setDevPanelOpen(false);
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [devPanelOpen]);
  /** Lists answered out of order must not paint over a newer one. */
  const listNonce = useRef(0);

  /**
   * 코멘트 기록 다시 읽기: asked on connect, when a pin batch lands, and when
   * the popover opens. Nothing polls — the list only moves when this planner
   * acts.
   */
  const refreshComments = useCallback(() => {
    const nonce = ++listNonce.current;
    return api
      .listComments()
      .then((list) => {
        if (nonce !== listNonce.current) return;
        setCommentItems(list.items);
        setCommentsError(null);
      })
      .catch((e: Error) => {
        if (nonce !== listNonce.current) return;
        setCommentsError(e.message);
      });
  }, [api]);

  useEffect(() => {
    if (connection !== "open") return;
    refreshComments();
  }, [connection, refreshComments]);

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
   * 충돌 오류 카드의 Claude 요청 (D96). 준비가 충돌로 멈춘 상태는 다시 시도로는
   * 같은 자리를 도는 것이므로 해결의 문은 대화다: 열려 있는 대화에는
   * repoRefresh 가 데몬의 충돌 브리프를 실어 보내고(최신화와 같은 회선),
   * 없으면 새 대화를 만들어 요청을 보낸다 — 새 대화가 태어날 때의 준비 pull 이
   * 충돌을 첫 과제로 넣는다. 정리 턴이 끝나면 준비를 한 번 다시 시도한다 — 고침
   * 턴 뒤의 자동 재시도와 같은 형태로, 중지로 끊긴 턴 뒤에는 재시도가 없다.
   */
  const [askNote, setAskNote] = useState<string | null>(null);
  const askArmed = useRef(false);
  const askTurnRan = useRef(false);
  const askClaude = async () => {
    const live = sessionId ? (daemon.sessions[sessionId]?.live ?? false) : false;
    setAskNote("Claude에게 정리를 요청했습니다 — 대화에서 정리합니다.");
    if (live) {
      void api.repoRefresh(sessionId).catch((e: Error) => syncError.show(e.message));
    } else {
      await onComments(
        markTurn(
          { kind: "gate", step: "최신 변경 받아오기" },
          `준비가 최신화 충돌로 멈춰 있습니다. 충돌을 정리해 저장 전 상태로 돌려 놓고, 미리보기가 다시 뜨도록 준비를 마쳐 주세요.\n\n${repo?.detail ?? ""}`,
        ),
        "최신화 충돌 정리",
      );
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
   * Claude's, briefed into the open thread like a failing gate.
   */
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(() => {
    setRefreshing(true);
    void api
      .repoRefresh(sessionId)
      .catch((e: Error) => syncError.show(e.message))
      .finally(() => setRefreshing(false));
  }, [api, sessionId]);
  /** 넘기기 단계의 상태 다시 확인: GitHub 의 답을 다시 읽어 칩과 스테퍼에 반영한다. */
  const checkHandoffState = useCallback(() => {
    void api
      .handoffStatus()
      .then(async (report) => {
        setDevReviews(report.reviews ?? []);
        setHandledTick((tick) => tick + 1);
        setDevPanelOpen(true);
        await api.repoStatus();
      })
      .catch((e: Error) => syncError.show(e.message));
  }, [api]);

  // --- 개발자 코멘트의 동작 (PLAN D88) ---------------------------------------
  // 고치기 는 마커 턴(리뷰 카드)으로, 답하기 는 GitHub 의 스레드/이슈로.
  // 처리한 것은 표식이 남어 배지가 조용해진다.
  const [handledTick, setHandledTick] = useState(0);
  const handledIds = new Set(
    devReviews && devReviews.length > 0 && devReviews[0]
      ? loadHandledReviews(devReviews[0].pr).map((id) => Number(id))
      : [],
  );
  void handledTick;
  const unhandledDevReviews = (devReviews ?? []).filter((review) => !handledIds.has(review.id));

  const handleReview = (reviews: DeveloperReview[]) => {
    for (const review of reviews) saveHandledReview(review.pr, review.id);
    setHandledTick((tick) => tick + 1);
    void onComments(reviewToTurn(reviews));
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
      setCommentsError(e instanceof Error ? e.message : String(e));
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
   * planner sees the list of files the 버리기 would throw away (결함③) —
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
   * Claude 시점 보기(PLAN D63): the desktop bridge streams the offscreen
   * Claude window as 8fps JPEG frames. A plain browser has no bridge and
   * this panel renders nothing — 기능 부재를 말하지 않는다(PLAN D61).
   * Subscribe-only: the newest frame simply overwrites the last, and the
   * final frame of a turn stays as the thumbnail until a newer one lands.
   */
  const [pipFrame, setPipFrame] = useState<string | null>(null);
  /** 크게 보기 — 클릭하면 기획자 iframe 위에 겹치고, 턴이 끝나면 접힌다. */
  const [pipLarge, setPipLarge] = useState(false);
  useEffect(() => {
    const subscribe = window.coloDesignDesktop?.preview?.onFrame;
    if (typeof subscribe !== "function") return;
    subscribe((jpeg: string) => setPipFrame(jpeg));
  }, []);
  /**
   * A comment batch from the preview overlay: recorded with WHERE the pin
   * sat (`element`, D78) and forwarded as one structured Korean turn — the
   * same wire a typed message uses, so Claude sees it as the planner's own
   * words (DESIGN §6). 자동 정리: the record IS the delivery — the rows are
   * born resolved, the pins leave the screen with the send, and anything
   * further is a re-request typed in the thread.
   */
  const forwardComments = async (envelope: ColoDesignCommentsEnvelope) => {
    // D87: the crops the view took of each pin ride the turn as images —
    // what the planner SAW, Claude sees too.
    const images = envelope.items
      .map((item) => item.shot)
      .filter((shot): shot is { mediaType: string; data: string } => Boolean(shot))
      .map(({ mediaType, data }) => ({ mediaType, data }));
    // The envelope names the screen the way the app routes to it; the card
    // wants the title the repo gave it. Falling back to the raw id keeps a
    // screen the registry no longer declares from losing its card entirely.
    const named = screens.find((screen) => screen.route === `/${envelope.screen}`);
    // PLAN D57: the batch is recorded at send time, delivered at once. A
    // failed record never blocks the planner's turn; the list just reads
    // stale until the next one.
    await api
      .recordComments({
        screen: envelope.screen,
        state: envelope.state,
        items: envelope.items.map((item) => ({
          text: item.comment,
          elementText: item.element.text || item.element.component,
          element: {
            component: item.element.component,
            path: item.element.path,
            rect: item.element.rect,
          },
        })),
      })
      .then(() => refreshComments())
      .catch(() => undefined);
    // A thread the TOOL opens is named by the tool (the M5 lesson): naming it
    // after the screen the pins came from is the honest one-line answer to
    // "where did this tab come from".
    await onComments(
      commentsToTurn(envelope, named?.title ?? envelope.screen),
      named?.title,
      images,
    );
  };

  /**
   * The error banner's button (PLAN D49): the same channel the pins use, so
   * the shell resolves the thread — the panel never learns which one is
   * open. Claude gets the message itself as the turn body. D89: the same
   * message twice in a row is marked on the card (아직 같은 오류 · N번째).
   */
  const forwardError = (error: PreviewError) => {
    const key = `${error.route}|${error.state}|${error.kind}|${error.message}`;
    const count = lastErrorKey.current === key ? lastErrorCount.current + 1 : 1;
    lastErrorKey.current = key;
    lastErrorCount.current = count;
    void onComments(errorToTurn(error, count));
  };

  // --- 화면 보여 주기 (D89) -------------------------------------------------
  // 오류도 핀도 아닌 화면 — 흰 화면, 무한 로딩 — 를 Claude 에게 통째로 보여
  // 준다: 프레임 캡처 한 장 + 콘솔 마지막 20줄 + 기획자의 한 줄(선택).
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
        note.trim() ? `기획자의 말: ${note.trim()}` : "",
        snapshot && snapshot.console.length > 0
          ? `콘솔 마지막 기록:\n${snapshot.console.join("\n")}`
          : "",
      ].filter(Boolean);
      await onComments(
        lookToTurn(route, state ?? "default", lines.join("\n\n"), count),
        undefined,
        images,
      );
    } finally {
      setLookBusy(false);
    }
  };

  // --- 턴 실행 중 표식 (D86): the overlay's send-toast reads the room -----
  useEffect(() => {
    void window.coloDesignDesktop?.preview?.busy?.(turnState === "running");
  }, [turnState]);

  // --- 따라가기 (D91): Claude 가 본 화면으로 --------------------------------
  // The daemon reports every screen_open as `preview.opened`; the panel keeps
  // the session's lastOpened and, when the carrying turn settles and the
  // planner has not moved the preview themselves, follows it. Otherwise only
  // a toast with a 보기 button — the planner's gaze is never stolen twice.
  const followToast = useFoldNotice();
  const [followTarget, setFollowTarget] = useState<PreviewTarget | null>(null);
  const plannerMoved = useRef(false);
  const wasRunning = useRef(false);
  const lastOpened = sessionId ? daemon.sessions[sessionId]?.lastOpened : undefined;
  const lastOpenedRef = useRef(lastOpened);
  lastOpenedRef.current = lastOpened;

  const followNow = useCallback(() => {
    if (followTarget) setTarget(followTarget);
    followToast.clear();
    setFollowTarget(null);
  }, [followTarget]);

  /** The planner's own moves are marked — a turn's end may not steal them. */
  const handleNavigate = useCallback(
    (ask: PreviewTarget) => {
      if (turnState === "running") plannerMoved.current = true;
      setTarget(ask);
    },
    [turnState],
  );

  useEffect(() => {
    if (turnState === "running") {
      wasRunning.current = true;
      plannerMoved.current = false;
      followToast.clear();
      setFollowTarget(null);
      return;
    }
    if (!wasRunning.current) return;
    wasRunning.current = false;
    const opened = lastOpenedRef.current;
    if (!opened) return;
    const ask: PreviewTarget = {
      kind: "screen",
      route: opened.route,
      state: opened.state,
    };
    if (plannerMoved.current || !followClaude) {
      const title = screens.find((screen) => screen.route === opened.route)?.title ?? opened.route;
      const subject = `${title}${opened.state ? ` · ${stateLabel(opened.state)}` : ""}`;
      followToast.show(`Claude가 ${subject}${objectParticle(subject)} 고쳤습니다.`);
      setFollowTarget(ask);
    } else {
      setTarget(ask);
    }
    // `screens` feeds the toast's title only; the follow itself reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnState, followClaude]);

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
  // 살아 있는 준비 단계(준비 · 최신화 · 설치 · 미리보기 띄우기)도 같은 슬롯의
  // 진행 판을 쓴다 — 레일과 명령 출력 줄은 ProgressPanel 에만 있고, 맨 힌트
  // 한 줄은 첫 준비의 가장 긴 구간(설치)을 죽은 칸으로 읽게 했다 (실사: 레일이
  // 1단계 내려받기에서 사라졌다).
  const bringUpCardInPreview =
    (phase === "error" && !previewStopped && !showProgress) ||
    phase === "preparing" ||
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
          onAskClaude={() => void askClaude()}
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

  const projectName = projects.find((project) => project.slug === activeSlug)?.name ?? "";
  const { title: proposedTitle, body: proposedBody } = handoffDraft(projectName, screens);
  /**
   * Where the cycle stands, read mechanically off the repo (PLAN D81 · D82):
   * one chip, one action set. 저장과 넘기기는 언제나 그려지고 조건으로만
   * 잠긴다 — 잠긴 이유는 title 한 문장. 상태 확인은 PR 이 있을 때만 그린다.
   */
  const handoff = repo?.handoff ?? null;
  const delivery = deriveDelivery({
    pendingChanges: repo?.pendingChanges ?? 0,
    branch: repo?.branch ?? null,
    handoff,
    running: turnState === "running",
    phase,
  });
  // The clone is checked out and installed, whatever the dev server is doing.
  // 저장 and 넘기기 act on the worktree and the remote, so gating them on a
  // preview that cannot bind a port would strand work that is already done.
  const workable = phase === "ready" || phase === "error";
  const refreshLocked = refreshing || phase !== "ready";

  /**
   * PiP 라벨(PLAN D63 → D91): `Claude가 보는 중 · <화면> · <상태>` — read off
   * what Claude ACTUALLY opened (`preview.opened`, D91), falling back to the
   * view's position before the first report. The label was a lie before D91:
   * it named the planner's own view.
   */
  const claudeActive = lastOpened
    ? `${lastOpened.route}${lastOpened.state ? `?state=${lastOpened.state}` : ""}`
    : (location?.path ??
      (target?.kind === "screen"
        ? target.state
          ? `${target.route}?state=${target.state}`
          : target.route
        : target?.kind === "path"
          ? target.path
          : null));
  const pipRoute = claudeActive ? claudeActive.split("?")[0] : null;
  const pipState = claudeActive
    ? new URLSearchParams(claudeActive.split("?")[1] ?? "").get("state")
    : null;
  const pipScreen = pipRoute
    ? (screens.find((screen) => screen.route === pipRoute)?.title ?? pipRoute)
    : null;
  const pipLabel = ["Claude가 보는 중", pipScreen, pipState].filter(Boolean).join(" · ");

  return (
    <div className={`planner__previewcol${working ? " planner__previewcol--live" : ""}`}>
      <div className="screenpanel__bar">
        {delivery ? (
          <span
            className={`screenpanel__status screenpanel__status--${delivery.chip.tone}`}
            title={delivery.chip.title}
            role="status"
          >
            {delivery.chip.label}
          </span>
        ) : (
          <span
            className="screenpanel__status screenpanel__status--none"
            title="프로젝트 준비가 끝나면 저장 · 넘기기가 열립니다"
          >
            화면 대기 중
          </span>
        )}
        {working && (
          <span className="screenpanel__working">
            <span className="spinner" />
            다시 그리는 중
          </span>
        )}
        <span className="screenpanel__spacer" />
        {/* 동작은 상수다 (PLAN D82): 저장 · 넘기기는 언제나 그려지고 조건으로만
            잠긴다 — 잠긴 이유는 title 한 문장. 상태 확인은 PR 이 있을 때만.
            강조는 그 순간 가장 자연스러운 하나에만. 잠김은 aria-disabled: 진짜
            disabled 는 hover 도 포커스도 막아 title 이 도달할 길이 없었다. */}
        {delivery && (
          <span className="screenpanel__actions">
            <button
              type="button"
              className={
                delivery.actions.save.enabled
                  ? "primary screenpanel__action"
                  : "ghost screenpanel__action"
              }
              aria-disabled={!delivery.actions.save.enabled}
              title={delivery.actions.save.reason}
              onClick={() => {
                if (delivery.actions.save.enabled) setSaveOpen(true);
              }}
            >
              저장
            </button>
            <button
              type="button"
              className={
                !delivery.actions.save.enabled && delivery.actions.handoff.enabled
                  ? "primary screenpanel__action"
                  : "ghost screenpanel__action"
              }
              aria-disabled={!delivery.actions.handoff.enabled}
              title={delivery.actions.handoff.reason}
              onClick={() => {
                if (delivery.actions.handoff.enabled) setHandoffOpen(true);
              }}
            >
              개발자에게 넘기기
            </button>
            {delivery.actions.check && (
              <button
                type="button"
                className="ghost screenpanel__action"
                data-testid="check-state"
                title="개발자의 판정과 코멘트를 GitHub에서 다시 읽어 옵니다"
                onClick={checkHandoffState}
              >
                상태 확인
                {unhandledDevReviews.length > 0
                  ? ` · 개발자 코멘트 ${unhandledDevReviews.length}`
                  : ""}
              </button>
            )}
          </span>
        )}
        {delivery && <span className="screenpanel__divider" />}
        <button
          type="button"
          className="ghost screenpanel__refresh"
          aria-disabled={refreshLocked}
          title={
            refreshing
              ? "받아 오는 중…"
              : refreshLocked
                ? "미리보기가 준비되면 받아올 수 있습니다"
                : "개발자가 반영한 최신 변경을 받아 옵니다 — 저장하지 않은 변경은 그대로 보존됩니다"
          }
          onClick={() => {
            if (!refreshLocked) refresh();
          }}
        >
          <RefreshIcon />
          <span className="screenpanel__refreshlabel">
            {/* 최신화 is a coinage; the gate step and the progress rail already
                say 최신 변경 받아오기 — the button is the odd one out (리뷰 D7). */}
            {refreshing ? "받아 오는 중…" : "최신 변경 받아오기"}
          </span>
        </button>
        <span className="screenpanel__more">
          <button
            type="button"
            className="ghost screenpanel__morebtn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="저장 기록 · 변경 버리기 · 코멘트 목록"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="screenpanel__morelabel">더 보기</span>
            <ChevronDownIcon />
          </button>
          {menuOpen && (
            <>
              <button
                type="button"
                className="selector__backdrop"
                aria-label="메뉴 닫기"
                onClick={() => setMenuOpen(false)}
              />
              <span className="selector__menu screenpanel__menu" role="menu">
                {/* D82: 저장 · 넘기기는 더 보기에서 뺐다 — 상단 바의 상수 동작이
                  그 자리를 갖는다. 저장 기록 · 변경 버리기 · 코멘트 목록만 남는다.
                  잠긴 행도 aria-disabled: 진짜 disabled 는 hover 를 막아 title 의
                  잠긴 이유에 도달할 길이 없다 (상단 바와 같은 규칙). */}
                <button
                  type="button"
                  role="menuitem"
                  className="selector__row"
                  aria-disabled={!workable}
                  title="이 사이클의 저장 차례를 보고 하나로 되돌립니다"
                  onClick={() => {
                    if (!workable) return;
                    setMenuOpen(false);
                    setHistoryOpen(true);
                  }}
                >
                  <span className="selector__label">저장 기록</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="selector__row"
                  aria-disabled={!workable || (repo?.pendingChanges ?? 0) === 0}
                  title={
                    (repo?.pendingChanges ?? 0) > 0
                      ? "저장하지 않은 변경을 모두 버립니다 — 되돌릴 수 없습니다"
                      : "버릴 저장하지 않은 변경이 없습니다"
                  }
                  onClick={() => {
                    if (!workable || (repo?.pendingChanges ?? 0) === 0) return;
                    setMenuOpen(false);
                    askDiscard();
                  }}
                >
                  <span className="selector__label">변경 버리기</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="selector__row"
                  onClick={() => {
                    setMenuOpen(false);
                    refreshComments();
                    setCommentsOpen(true);
                  }}
                >
                  <span className="selector__label">코멘트 목록</span>
                </button>
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
      {followToast.text && (
        <Fold closing={followToast.closing} onCollapsed={followToast.clear}>
          <div className="notice notice--info" role="status">
            <span className="notice__text">{followToast.text}</span>
            {followTarget && (
              <button type="button" className="ghost" onClick={followNow}>
                보기
              </button>
            )}
            <button
              type="button"
              className="notice__close"
              aria-label="알림 닫기"
              disabled={followToast.closing}
              onClick={followToast.close}
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
      {/* The stage wrapper gives the PiP (PLAN D63) its coordinates: the
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
            onAskClaude={() => void askClaude()}
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
            onComments={(envelope) => void forwardComments(envelope)}
            onFixError={forwardError}
            screens={screens}
            onScreens={onScreens}
            target={target}
            onNavigate={handleNavigate}
            onLocation={setLocation}
            location={location}
            commentsOn={commentsOn}
            onCommentsMode={setCommentsOn}
            onLook={(note) => void sendLook(note)}
            lookBusy={lookBusy}
            pip={showPip && pipFrame && !pipLarge ? { frame: pipFrame, label: pipLabel } : null}
            pipLarge={pipLarge}
            onPipToggle={() => setPipLarge((open) => !open)}
          />
        )}
        {showPip && pipFrame && pipLarge && (
          <div className="pip pip--large">
            <button
              type="button"
              className="pip__view"
              aria-expanded
              title="접기"
              onClick={() => setPipLarge(false)}
            >
              <img className="pip__frame" src={`data:image/jpeg;base64,${pipFrame}`} alt="" />
            </button>
            <span className="pip__label">{pipLabel}</span>
          </div>
        )}
      </div>
      {saveOpen && (
        <DiffPanel
          daemon={daemon}
          sessionId={sessionId}
          branch={repo?.branch ?? null}
          onOpenSettings={onOpenSettings}
          onClose={() => setSaveOpen(false)}
        />
      )}
      {handoffOpen && (
        <HandoffPanel
          daemon={daemon}
          proposedTitle={proposedTitle}
          proposedBody={proposedBody}
          sessionId={sessionId}
          onOpenSettings={onOpenSettings}
          onClose={() => setHandoffOpen(false)}
        />
      )}
      {historyOpen && <HistoryDrawer open onClose={() => setHistoryOpen(false)} daemon={daemon} />}
      {discardConfirm && (
        <ConfirmDialog
          title="변경 버리기"
          body={
            <>
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
              {discardFiles.map((file) => (
                <li key={file.path}>{file.path}</li>
              ))}
            </ul>
          )}
        </ConfirmDialog>
      )}
      <CommentsPopover
        open={commentsOpen}
        items={commentItems}
        error={commentsError}
        native={Boolean(window.coloDesignDesktop?.preview?.native)}
        onClose={() => setCommentsOpen(false)}
      />
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
                    ? "읽지 않아도 되는 버튼은 둘 — 고치기는 Claude에게, 답하기는 개발자에게."
                    : "모두 처리한 목록입니다."}
              </p>
              {devReviews !== null && unhandledDevReviews.length > 0 && (
                <button
                  type="button"
                  className="primary dev__all"
                  disabled={devBusy}
                  onClick={() => {
                    handleReview(unhandledDevReviews);
                    setDevPanelOpen(false);
                  }}
                >
                  모두 Claude에게 ({unhandledDevReviews.length})
                </button>
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
                            <button
                              type="button"
                              className="primary"
                              disabled={devBusy}
                              title="이 코멘트를 Claude에게 넘겨 화면을 고칩니다"
                              onClick={() => {
                                handleReview([review]);
                                setDevPanelOpen(false);
                              }}
                            >
                              고치기
                            </button>
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
                        {handled && <span className="hint">처리함</span>}
                      </div>
                      <p className="hint">{review.body}</p>
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
              이 도구가 <strong>기획자의 이름</strong>으로 GitHub에 답을 남깁니다.
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
