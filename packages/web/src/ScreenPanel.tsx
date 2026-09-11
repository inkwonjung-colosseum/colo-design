import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CdsDesignCommentsEnvelope,
  CdsDesignScreen,
  DiffFile,
  RepoPhase,
  RepoStatus,
  SessionState,
  TurnMarker,
} from "@cds-design/protocol";
import { markTurn } from "@cds-design/protocol";
import type { CommentItem, Daemon } from "./daemon-client";
import { daemonLine, stateLabel } from "./format";
import { PreviewHost, type PreviewError, type PreviewLocation, type PreviewTarget } from "./PreviewHost";
import { StageBar } from "./StageBar";
import { HistoryDrawer } from "./HistoryDrawer";
import { deriveStage } from "./stage";
import { DiffPanel } from "./DiffPanel";
import { CommentsPopover } from "./CommentsPopover";
import { ConfirmDialog } from "./ConfirmDialog";
import { HandoffPanel } from "./HandoffPanel";
import { handoffDraft } from "./handoff-draft";
import {
  CheckIcon,
  CloseIcon,
  CopyIcon,
  RefreshIcon,
  RestartIcon,
} from "./icons";

const PHASE_LABEL: Record<RepoPhase, string> = {
  missing: "연결 레포를 연결해 주세요",
  cloning: "연결 레포를 내려받는 중",
  pulling: "연결 레포의 최신 변경사항을 받아 오는 중",
  installing: "의존성 설치 중 — 처음 한 번만, 1~2분 걸립니다",
  starting: "미리보기 서버를 켜는 중",
  ready: "준비 완료",
  error: "준비하지 못했습니다",
};
/** The three steps a first clone walks through, in the order a planner waits. */
const PROGRESS_RAIL: Array<{ id: string; label: string; phases: RepoPhase[] }> = [
  { id: "download", label: "내려받기", phases: ["cloning", "pulling"] },
  { id: "install", label: "설치", phases: ["installing"] },
  { id: "preview", label: "미리보기", phases: ["starting"] },
];

interface Guidance {
  title: string;
  body: string;
  /** A command the planner can paste into a terminal, if one would fix this. */
  command?: string;
}

/**
 * Which failure this is. A dead preview server still leaves the screen worth
 * looking at, so it is answered inside the preview itself; everything else
 * takes over the 화면 column. The daemon NAMES the failure at the throw site
 * (`RepoStatus.errorKind`, PLAN D41) — the text sniffing this used to do broke
 * silently whenever a daemon message was reworded, so it only survives as a
 * fallback for a payload that predates the field.
 */
type ErrorKind = "auth" | "pnpm" | "preview" | "unknown";

function errorKindOf(repo: RepoStatus | null | undefined): ErrorKind {
  const kind = repo?.errorKind;
  if (kind === "registry-auth") return "auth";
  if (kind === "pnpm-missing") return "pnpm";
  if (kind === "preview") return "preview";
  if (!kind) {
    const detail = repo?.detail ?? null;
    if (detail?.includes("GitHub 패키지 인증")) return "auth";
    if (detail?.includes("pnpm이 없습니다")) return "pnpm";
    if (detail?.includes("미리보기")) return "preview";
  }
  return "unknown";
}

function guidanceFor(kind: ErrorKind, detail: string | null): Guidance {
  if (kind === "auth") {
    return {
      title: "GitHub 패키지 인증이 필요합니다",
      body: "연결 레포의 의존성을 사내 GitHub 패키지에서 받아옵니다. 설정의 개인 액세스 토큰(read:packages 권한)을 확인한 뒤 다시 시도해 주세요.",
      command: "pnpm config set //npm.pkg.github.com/:_authToken <PAT>",
    };
  }
  if (kind === "pnpm") {
    return {
      title: "pnpm이 설치되어 있지 않습니다",
      body: "연결 레포의 설치·미리보기에 pnpm이 필요합니다. 터미널에 아래 명령을 실행한 뒤 다시 시도해 주세요.",
      command: "corepack enable",
    };
  }
  return {
    title: "준비하지 못했습니다",
    body: detail ?? "원인을 알 수 없습니다. 다시 시도해 주세요.",
  };
}

function ProgressPanel({
  phase,
  detail,
  errorKind,
  onRetry,
  onOpenSettings,
}: {
  phase: RepoPhase;
  detail: string | null;
  errorKind: ErrorKind;
  onRetry: () => void;
  onOpenSettings: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const failed = phase === "error";
  const guidance = failed ? guidanceFor(errorKind, detail) : null;
  const progressLine = daemonLine(detail);
  const needsSetup = phase === "missing";
  /** Where the wait sits on the rail; -1 for the setup and failure states. */
  const railIndex = PROGRESS_RAIL.findIndex((entry) => entry.phases.includes(phase));

  const copy = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked; the command is visible to retype anyway.
    }
  };

  return (
    <div className={failed ? "progress progress--error" : "progress"}>
      <div className="progress__card">
        <div className="progress__head">
          {!failed && <span className="spinner" />}
          <h2>{guidance ? guidance.title : PHASE_LABEL[phase]}</h2>
        </div>
        {!failed && railIndex >= 0 && (
          <div className="progress__rail" aria-hidden="true">
            {PROGRESS_RAIL.map((entry, index) => (
              <span
                key={entry.id}
                className={`progress__step${
                  index < railIndex ? " progress__step--done" : index === railIndex ? " progress__step--now" : ""
                }`}
              >
                <span className="progress__dot">{index < railIndex ? "✓" : ""}</span>
                {entry.label}
              </span>
            ))}
          </div>
        )}
        <p className="progress__body">
          {guidance
            ? guidance.body
            : needsSetup
              ? "설정에서 연결 레포 주소와 개인 액세스 토큰을 입력해 주세요."
              : "처음 한 번만 준비하면, 다음부터는 바로 시작합니다."}
        </p>
        {guidance?.command && (
          <pre className="progress__cmd">
            <code>{guidance.command}</code>
            <button type="button" className="ghost" onClick={() => void copy(guidance.command!)}>
              {copied ? (
                <>
                  <CheckIcon size={11} /> 복사됨
                </>
              ) : (
                <>
                  <CopyIcon size={12} /> 복사
                </>
              )}
            </button>
          </pre>
        )}
        {!failed && progressLine && <div className="progress__detail">{progressLine}</div>}
        {failed && (
          <button type="button" className="primary" onClick={onRetry}>
            <RestartIcon />
            다시 시도
          </button>
        )}
        {!failed && needsSetup && (
          <button type="button" className="primary" onClick={onOpenSettings}>
            설정 열기
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The workspace's right column: the connected repo clone rendered by its own
 * preview server, plus the three words of PLAN D5 over it — 저장, 개발자에게
 * 넘기기, and the status the cycle has reached (변경 있음 / 넘김 / 반영됨,
 * read mechanically off the repo — PLAN D4). It owns repo readiness, both
 * dialogs and the comment pins, and knows nothing about sessions — a comment
 * bundle is handed up to the shell, which decides which thread it lands in.
 *
 * It is also where PLAN D7's envelopes land: the screens the repo declared
 * come up through `Preview` and stay here — feeding the picker, the state
 * chips and the 넘기기 proposal — and the screen the planner should be
 * looking at lives here too, as `target`, set by the toolbar alone.
 */
export function ScreenPanel({
  daemon,
  onOpenSettings,
  onComments,
  turnState,
  sessionId = null,
  onPrecheck,
  onNewSession,
  showPip,
}: {
  daemon: Daemon;
  onOpenSettings: () => void;
  /**
   * Forward a comment bundle as a turn in the working screen thread. The panel
   * does not know which thread that is; the shell resolves it, creating one
   * named after the screen if there is none yet.
   */
  onComments: (turn: string, name?: string) => Promise<void>;
  /** State of the thread the comments went to, so pins clear when it settles. */
  turnState: SessionState;
  /**
   * The live thread a failing gate briefs: a failed check or build hands its
   * output to Claude as the next Korean turn, so a failed 저장 or 넘기기 is
   * not a dead end. Null when no thread is open — there is nobody to brief.
   */
  sessionId?: string | null;
  /**
   * Sends one Korean turn into the CURRENT thread (PLAN D5): whether the
   * screens cover their 기획서 is a judgement the tool refuses to make —
   * the 기획서 lives in the thread's specs/, so Claude is the one who can
   * read it. The shell supplies the sender; the panel composes the words.
   */
  onPrecheck: (turn: string) => void;
  /** 화면 만들기 단계의 주 버튼 — 새 대화를 열어 컴포저로 보낸다. */
  onNewSession: () => void;
  /** Claude 시점 보기(PLAN D63) — 설정의 `Claude가 보는 화면 표시`. */
  showPip: boolean;
}) {
  const { connection, repo, api, projects, activeSlug } = daemon;
  const phase = repo?.phase ?? null;
  const ready = phase === "ready";
  /**
   * A failed repo.sync is answered in this column, right above the preview
   * it could not bring up — the rail and the chat stay usable while it runs.
   */
  const [syncError, setSyncError] = useState<string | null>(null);
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
  /** Preview comment pins waiting for Claude's turn to settle (DESIGN §6). */
  const [commentPins, setCommentPins] = useState<CdsDesignCommentsEnvelope | null>(null);
  /** True once the carrying turn actually ran; pins clear when it settles. */
  const [commentTurnRan, setCommentTurnRan] = useState(false);
  /**
   * What the repo said it can render (PLAN D7). Empty until its overlay
   * speaks, which is why the toolbar's picker is absent rather than empty: an
   * old repo that declares nothing and an app that has not booted yet look
   * identical from here.
   */
  const [screens, setScreens] = useState<CdsDesignScreen[]>([]);

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
  /** The two dialogs of the cycle: 저장 and 개발자에게 넘기기. */
  const [saveOpen, setSaveOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  /** 저장 기록 드로어 (PLAN D53) — 더 보기 ▾ 메뉴에서 연다. */
  const [historyOpen, setHistoryOpen] = useState(false);
  /** 더 보기 ▾ 메뉴 — 사이클 동작이 항상 있는 자리 (PLAN D44). */
  const [menuOpen, setMenuOpen] = useState(false);
  /** 변경 버리기 확인 — this app's dialog (결함③), with the file list it names. */
  const [discardConfirm, setDiscardConfirm] = useState(false);
  /** Paths the discard would throw away, read when the dialog opens. */
  const [discardFiles, setDiscardFiles] = useState<DiffFile[] | null>(null);

  /**
   * 코멘트 모드(PLAN D58) — the truth the preview toolbar's 💬 toggle draws
   * and the frame is re-told. ScreenPanel owns it because the popover and
   * the badge below read the same comments story.
   */
  const [commentsOn, setCommentsOn] = useState(false);
  /**
   * 코멘트 기록(PLAN D57): every comment the pins left behind, resolved ones
   * in. Null until the first read returns; the badge, the stepper's why and
   * the popover all count from this one list.
   */
  const [commentItems, setCommentItems] = useState<CommentItem[] | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  /** The row whose resolve toggle is in flight. */
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  /** Lists answered out of order must not paint over a newer one. */
  const listNonce = useRef(0);

  /**
   * 코멘트 기록 다시 읽기: asked on connect, when a pin batch lands (the
   * daemon just replaced that screen·state's unresolved set), when the
   * popover opens, and after a resolve toggle. Nothing polls — the list only
   * moves when this planner acts.
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
    setSyncError(null);
    void api.repoSync().catch((e: Error) => setSyncError(e.message));
  }, [api]);

  /**
   * The stopped screen's 다시 시작: the only caller that may kill. The busy
   * port's error names a program holding it; this restart force-frees the
   * declared port and boots the preview over it. Mounting keeps the plain
   * sync — readying a repo must never kill a program the planner never named.
   */
  const restart = useCallback(() => {
    setSyncError(null);
    void api.repoSync(true).catch((e: Error) => setSyncError(e.message));
  }, [api]);

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
      .catch((e: Error) => setSyncError(e.message))
      .finally(() => setRefreshing(false));
  }, [api, sessionId]);
  /** 넘기기 단계의 상태 다시 확인: GitHub 의 답을 다시 읽어 칩과 스테퍼에 반영한다. */
  const checkHandoffState = useCallback(() => {
    void api
      .handoffStatus()
      .then(() => api.repoStatus())
      .catch((e: Error) => setSyncError(e.message));
  }, [api]);

  /** 버리기: the confirm dialog's only action — the menu item only opens it. */
  const discard = useCallback(() => {
    setDiscardConfirm(false);
    void api
      .discard()
      .then(() => api.repoStatus())
      .catch((e: Error) => setSyncError(e.message));
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

  // The pins live until the turn that carries them settles — including the
  // case where the session had already settled before the bundle arrived.
  useEffect(() => {
    if (commentPins && turnState === "running") setCommentTurnRan(true);
  }, [commentPins, turnState]);
  useEffect(() => {
    // The turn ran, then settled: hot reload happened, the pins go.
    if (commentPins && commentTurnRan && turnState !== "running") {
      setCommentPins(null);
      setCommentTurnRan(false);
    }
  }, [commentPins, commentTurnRan, turnState]);
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
    const subscribe = window.cdsDesignDesktop?.preview?.onFrame;
    if (typeof subscribe !== "function") return;
    subscribe((jpeg: string) => setPipFrame(jpeg));
  }, []);
  useEffect(() => {
    if (turnState !== "running") setPipLarge(false);
  }, [turnState]);
  /**
   * A comment batch from the preview overlay: shown as pins and forwarded as
   * one structured Korean turn — the same wire a typed message uses, so Claude
   * sees it as the planner's own words (DESIGN §6). Pins stay while the turn
   * runs and clear when it settles.
   */
  const forwardComments = async (envelope: CdsDesignCommentsEnvelope) => {
    setCommentPins(envelope);
    setCommentTurnRan(false);
    // The envelope names the screen the way the app routes to it; the card
    // wants the title the repo gave it. Falling back to the raw id keeps a
    // screen the registry no longer declares from losing its card entirely.
    const named = screens.find((screen) => screen.route === `/${envelope.screen}`);
    // PLAN D57: the batch is recorded at send time — the daemon replaces
    // this screen·state's UNRESOLVED items with it, so sending the same pins
    // twice never duplicates, and the popover's list outlives the pins. A
    // failed record never blocks the planner's turn; the list just reads
    // stale until the next one.
    await api
      .recordComments({
        screen: envelope.screen,
        state: envelope.state,
        items: envelope.items.map((item) => ({
          text: item.comment,
          elementText: item.element.text || item.element.component,
        })),
      })
      .then(() => refreshComments())
      .catch(() => undefined);
    // A thread the TOOL opens is named by the tool (the M5 lesson): naming it
    // after the screen the pins came from is the honest one-line answer to
    // "where did this tab come from".
    await onComments(commentsToTurn(envelope, named?.title ?? envelope.screen), named?.title);
  };

  /** The popover's 해결 toggle: one daemon write, then the list re-reads. */
  const resolveComment = (id: string, resolved: boolean) => {
    setResolvingId(id);
    api
      .resolveComment(id, resolved)
      .then(() => refreshComments())
      .catch((e: Error) => setCommentsError(e.message))
      .finally(() => setResolvingId(null));
  };

  /**
   * The error banner's button (PLAN D49): the same channel the pins use, so
   * the shell resolves the thread — the panel never learns which one is
   * open. Claude gets the message itself as the turn body.
   */
  const forwardError = (error: PreviewError) => {
    void onComments(errorToTurn(error));
  };
  /**
   * 다시 보내기 (PLAN D57): one recorded comment rides the same channel the
   * pins used — the shell resolves the thread, creating one named after the
   * screen when none is open. The comment stays as it is; resending is not
   * re-recording.
   */
  const resendComment = (item: CommentItem) => {
    const named = screens.find((screen) => screen.route === `/${item.screen}`);
    void onComments(commentToTurn(item, named?.title ?? item.screen), named?.title);
  };

  const errorKind = errorKindOf(repo);
  // Only a named preview death takes over the preview frame; anything else
  // (a failed clone or pull, say) is answered by the retry panel, because the
  // preview may still be alive and worth looking at.
  const previewStopped = phase === "error" && errorKind === "preview";
  const showProgress = !repo || (!ready && !previewStopped);
  // Progress renders inside this column, not over the whole planner: the rail
  // and the chat stay usable while the clone runs.
  if (showProgress) {
    return (
      <div className="planner__previewcol">
        <ProgressPanel
          phase={phase ?? "missing"}
          detail={repo?.detail ?? null}
          errorKind={errorKind}
          onRetry={sync}
          onOpenSettings={onOpenSettings}
        />
      </div>
    );
  }

  const projectName = projects.find((project) => project.slug === activeSlug)?.name ?? "";
  const { title: proposedTitle, body: proposedBody } = handoffDraft(projectName, screens);
  /**
   * Where the cycle stands, read off the repo alone (PLAN D4): a merged pull
   * request is 반영됨, an open one is 넘김, worktree changes are 변경 있음.
   * Clicking it is the planner's refresh of the developer's answer — nothing
   * polls a state that only moves when a human acts.
   */
  const handoff = repo?.handoff ?? null;
  const status =
    handoff?.state === "merged"
      ? { label: "반영됨", tone: "merged" }
      : handoff
        ? { label: "넘김", tone: "handed" }
        : (repo?.pendingChanges ?? 0) > 0
          ? { label: "변경 있음", tone: "pending" }
          : null;

  // The clone is checked out and installed, whatever the dev server is doing.
  // 저장 and 넘기기 act on the worktree and the remote, so gating them on a
  // preview that cannot bind a port would strand work that is already done.
  const workable = phase === "ready" || phase === "error";
  /**
   * The stepper's judgement (PLAN D45): read mechanically off the repo and
   * the open thread, the same words a sidebar row badge borrows.
   */
  const stage = deriveStage({
    screens,
    pendingChanges: repo?.pendingChanges ?? 0,
    branch: repo?.branch ?? null,
    handoff,
    running: turnState === "running",
    phase,
  });

  /**
   * PiP 라벨(PLAN D63): `Claude가 보는 중 · <화면> · <상태>` — read off where
   * the view is (D66), falling back to the ask before the first report.
   */
  const pipActive =
    location?.path ??
    (target?.kind === "screen"
      ? target.state
        ? `${target.route}?state=${target.state}`
        : target.route
      : target?.kind === "path"
        ? target.path
        : null);
  const pipRoute = pipActive ? pipActive.split("?")[0] : null;
  const pipState = pipActive ? new URLSearchParams(pipActive.split("?")[1] ?? "").get("state") : null;
  const pipScreen = pipRoute
    ? (screens.find((screen) => screen.route === pipRoute)?.title ?? pipRoute)
    : null;
  const pipLabel = ["Claude가 보는 중", pipScreen, pipState]
    .filter(Boolean)
    .join(" · ");

  /** The number the toolbar badge, the stepper's why and the popover share. */
  const unresolvedComments = (commentItems ?? []).filter((item) => !item.resolved).length;

  return (
    <div className={`planner__previewcol${working ? " planner__previewcol--live" : ""}`}>
      <div className="screenpanel__bar">
        {status ? (
          <span className={`screenpanel__status screenpanel__status--${status.tone}`}>
            {status.label}
          </span>
        ) : (
          <span className="screenpanel__status screenpanel__status--none">화면 대기 중</span>
        )}
        {working && (
          <span className="screenpanel__working">
            <span className="spinner" />
            다시 그리는 중
          </span>
        )}
        <span className="screenpanel__spacer" />
        <button
          type="button"
          className="ghost"
          disabled={refreshing || phase !== "ready"}
          title="개발자가 반영한 최신 변경을 받아 옵니다 — 저장하지 않은 변경은 그대로 보존됩니다"
          onClick={refresh}
        >
          <RefreshIcon />
          {refreshing ? "받아 오는 중…" : "최신화"}
        </button>
        <span className="screenpanel__more">
          <button
            type="button"
            className="ghost"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            더 보기 ▾
          </button>
          {menuOpen && (
            <>
              <button type="button" className="selector__backdrop" aria-label="메뉴 닫기" onClick={() => setMenuOpen(false)} />
              <span className="selector__menu screenpanel__menu" role="menu">
              <button
                type="button"
                role="menuitem"
                className="selector__row"
                disabled={!workable}
                onClick={() => {
                  setMenuOpen(false);
                  setSaveOpen(true);
                }}
              >
                <span className="selector__label">저장</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="selector__row"
                disabled={!workable || !repo?.branch}
                title={repo?.branch ? undefined : "아직 저장한 변경이 없습니다. 먼저 저장해 주세요"}
                onClick={() => {
                  setMenuOpen(false);
                  setHandoffOpen(true);
                }}
              >
                <span className="selector__label">개발자에게 넘기기</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="selector__row"
                disabled={!sessionId}
                title={sessionId ? "열려 있는 대화에서 기획서와 화면을 맞춰 봅니다" : "먼저 대화를 열어 주세요"}
                onClick={() => {
                  setMenuOpen(false);
                  onPrecheck(
                    "넘기기 전 점검: 이 화면이 근거 기획서(specs/ 첨부)와 맞는지 확인하고, 다른 점·비어 있는 점을 목록으로 답해 주세요.",
                  );
                }}
              >
                <span className="selector__label">넘기기 전 점검</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="selector__row"
                disabled={!workable}
                title="이 사이클의 저장 차례를 보고 하나로 되돌립니다"
                onClick={() => {
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
                disabled={!workable || (repo?.pendingChanges ?? 0) === 0}
                title={
                  (repo?.pendingChanges ?? 0) > 0
                    ? "저장하지 않은 변경을 모두 버립니다 — 되돌릴 수 없습니다"
                    : "버릴 저장하지 않은 변경이 없습니다"
                }
                onClick={() => {
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
      {syncError && (
        <div className="notice notice--error">
          <span className="notice__text">{syncError}</span>
          <button type="button" className="notice__close" aria-label="오류 닫기" onClick={() => setSyncError(null)}>
            ×
          </button>
        </div>
      )}
      {commentPins && <CommentPinsSummary envelope={commentPins} />}
      {/* The stage wrapper gives the PiP (PLAN D63) its coordinates: the
          thumbnail lives in this iframe's corner, and the enlarged look
          covers exactly this iframe — not the bars around it. */}
      <div className={`previewcol__stage${settleFlash ? " previewcol__stage--settled" : ""}`}>
        <PreviewHost
          url={repo?.previewUrl ?? null}
          stopped={previewStopped}
          stoppedDetail={repo?.detail ?? null}
          onRestart={restart}
          onComments={(envelope) => void forwardComments(envelope)}
          onFixError={forwardError}
          screens={screens}
          target={target}
          onNavigate={setTarget}
          onScreens={setScreens}
          onLocation={setLocation}
          location={location}
          commentsOn={commentsOn}
          onCommentsMode={setCommentsOn}
          unresolvedComments={unresolvedComments}
          pip={showPip && pipFrame && !pipLarge ? { frame: pipFrame, label: pipLabel } : null}
          pipLarge={pipLarge}
          onPipToggle={() => setPipLarge((open) => !open)}
        />
        {showPip && pipFrame && pipLarge && (
          <div className="pip pip--large">
            <button
              type="button"
              className="pip__view"
              aria-expanded
              title="접기"
              onClick={() => setPipLarge(false)}
            >
              <img
                className="pip__frame"
                src={`data:image/jpeg;base64,${pipFrame}`}
                alt=""
              />
            </button>
            <span className="pip__label">{pipLabel}</span>
          </div>
        )}
      </div>
      <StageBar
        stage={stage}
        onNewSession={onNewSession}
        onSave={() => setSaveOpen(true)}
        onHandoff={() => setHandoffOpen(true)}
        onCheckState={checkHandoffState}
        onPrecheck={() =>
          onPrecheck(
            "넘기기 전 점검: 이 화면이 근거 기획서(specs/ 첨부)와 맞는지 확인하고, 다른 점·비어 있는 점을 목록으로 답해 주세요.",
          )
        }
        precheckDisabled={!sessionId}
        unresolvedComments={unresolvedComments}
      />
      {saveOpen && <DiffPanel daemon={daemon} sessionId={sessionId} onClose={() => setSaveOpen(false)} />}
      {handoffOpen && (
        <HandoffPanel
          daemon={daemon}
          proposedTitle={proposedTitle}
          proposedBody={proposedBody}
          sessionId={sessionId}
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
        busyId={resolvingId}
        onClose={() => setCommentsOpen(false)}
        onResolve={resolveComment}
        onResend={resendComment}
      />
    </div>
  );
}

/** Pins summary shown above the preview until the turn settles. */
function CommentPinsSummary({ envelope }: { envelope: CdsDesignCommentsEnvelope }) {
  return (
    <div className="pins" data-testid="pins-summary">
      <div className="pins__head">
        <strong>수정 요청 {envelope.items.length}건</strong>
        <span className="hint">
          {envelope.screen} · {envelope.state} — Claude 수정 중, 마치면 핀이 사라집니다.
        </span>
      </div>
      <ol className="pins__list">
        {envelope.items.map((item, index) => (
          <li key={index}>
            <span className="pins__component">{item.element.text || "화면의 요소"}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The structured turn: readable Korean first, machine shape in a json fence,
 * and a marker so the planner's own chat shows what they asked for rather than
 * the CSS paths Claude needs (PLAN D9).
 *
 * `screenTitle` is what the repo called the screen; the envelope only carries
 * its route-shaped id, and a card is the wrong place to meet one.
 */
function commentsToTurn(envelope: CdsDesignCommentsEnvelope, screenTitle: string): string {
  const marker: TurnMarker = {
    kind: "comments",
    screen: screenTitle,
    state: stateLabel(envelope.state),
    items: envelope.items.map((item) => ({
      // The element's own text is what the planner clicked and recognises;
      // its component name is the fallback nobody should normally read.
      label: item.element.text || item.element.component,
      comment: item.comment,
    })),
  };
  const lines = [
    `화면 수정 요청 ${envelope.items.length}건 — ${envelope.screen} (${envelope.state} 상태)`,
    "미리보기에서 핀으로 찍은 요소들입니다. 화면을 고친 뒤 다시 보여 주세요.",
    "",
  ];
  envelope.items.forEach((item, index) => {
    const target = item.element;
    lines.push(
      `${index + 1}. ${target.component}${target.text ? ` — "${target.text}"` : ""}`,
      `   요청: ${item.comment}`,
      `   위치: ${target.path} (rect ${target.rect.x},${target.rect.y} ${target.rect.width}×${target.rect.height})`,
      "",
    );
  });
  lines.push("```json", JSON.stringify(envelope, null, 2), "```");
  return markTurn(marker, lines.join("\n"));
}

/**
 * One recorded comment, sent again (PLAN D57): the same comments marker the
 * pin batch uses, so the planner's chat shows it as the card it is. The
 * stored words and the element's text are what Claude gets — the pin's
 * position was never recorded, and a fabricated one in the json fence would
 * only misdirect the fix.
 */
function commentToTurn(item: CommentItem, screenTitle: string): string {
  const marker: TurnMarker = {
    kind: "comments",
    screen: screenTitle,
    state: stateLabel(item.state),
    items: [{ label: item.elementText || "화면의 요소", comment: item.text }],
  };
  return markTurn(
    marker,
    [
      `코멘트를 다시 보냅니다 — ${screenTitle} (${item.state} 상태)`,
      `${item.elementText ? `"${item.elementText}" 요소: ` : ""}${item.text}`,
    ].join("\n"),
  );
}

/**
 * The error banner's structured turn (PLAN D49): the marker names where it
 * happened, and the body is the message itself — the stack or build output
 * is what Claude fixes from; prose around it would only be in the way.
 */
function errorToTurn(error: PreviewError): string {
  const marker: TurnMarker = {
    kind: "error",
    route: error.route,
    state: error.state,
    errorKind: error.kind,
  };
  return markTurn(marker, error.message);
}
