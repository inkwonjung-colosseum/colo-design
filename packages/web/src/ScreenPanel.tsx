import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DrafthouseCommentsEnvelope,
  DrafthouseScreen,
  HandoffStatus,
  RepoPhase,
  SessionState,
  TurnMarker,
} from "@drafthouse/protocol";
import { markTurn } from "@drafthouse/protocol";
import type { Daemon } from "./daemon-client";
import { stateLabel } from "./format";
import { Preview, type PreviewTarget } from "./Preview";
import { DiffPanel } from "./DiffPanel";
import { HANDOFF_STATE_LABEL, HandoffPanel } from "./HandoffPanel";
import { handoffDraft } from "./handoff-draft";

const PHASE_LABEL: Record<RepoPhase, string> = {
  missing: "연결 레포를 연결해 주세요",
  cloning: "연결 레포를 내려받는 중",
  pulling: "연결 레포의 최신 변경사항을 받아 오는 중",
  installing: "의존성 설치 중 — 처음 한 번만, 1~2분 걸립니다",
  starting: "미리보기 서버를 켜는 중",
  ready: "준비 완료",
  error: "준비하지 못했습니다",
};

interface Guidance {
  title: string;
  body: string;
  /** A command the planner can paste into a terminal, if one would fix this. */
  command?: string;
}

/**
 * Which failure this is. A dead preview server still leaves the screen worth
 * looking at, so it is answered inside the preview itself; everything else
 * takes over the 화면 column.
 */
type ErrorKind = "auth" | "pnpm" | "preview" | "unknown";

function classifyError(detail: string | null): ErrorKind {
  // The two credential/toolchain failures name themselves first; whatever is
  // left that mentions the preview is a preview failure, however it died. The
  // distinction is load-bearing: 저장 and 넘기기 sit in this column and need no
  // preview at all, so a dev server that cannot bind a port must not take the
  // planner's finished work hostage.
  if (detail?.includes("GitHub 패키지 인증")) return "auth";
  if (detail?.includes("pnpm이 없습니다")) return "pnpm";
  if (detail?.includes("미리보기")) return "preview";
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
  /**
   * The daemon streams the raw output of whatever it is running. A planner
   * should never meet terminal colour codes or the command line itself, so
   * only the last human-readable line survives.
   */
  const progressLine =
    (detail ?? "")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("$"))
      .at(-1) ?? "";
  const needsSetup = phase === "missing";

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
      <div className="progress__head">
        {!failed && <span className="spinner" />}
        <h2>{guidance ? guidance.title : PHASE_LABEL[phase]}</h2>
      </div>
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
            {copied ? "복사됨 ✓" : "복사"}
          </button>
        </pre>
      )}
      {!failed && progressLine && <div className="progress__detail">{progressLine}</div>}
      {failed && (
        <button type="button" className="primary" onClick={onRetry}>
          다시 시도
        </button>
      )}
      {!failed && needsSetup && (
        <button type="button" className="primary" onClick={onOpenSettings}>
          설정 열기
        </button>
      )}
    </div>
  );
}

/**
 * The 화면 segment: the connected repo clone rendered by its own preview
 * server, plus the three words of PLAN D5 over it — 저장, 개발자에게 넘기기,
 * and the state the developer left behind. It owns repo readiness, both
 * dialogs and the comment pins, and knows nothing about sessions — a comment
 * bundle is handed up to the shell, which decides which screen thread of the
 * open page it belongs to (PLAN D1/D2).
 *
 * It is also where PLAN D7's two envelopes meet: the screens the repo declared
 * come up through `Preview` and land here, and the screen the planner should
 * be looking at goes back down as `target`. This panel is the only side that
 * can decide that, because it is the only one that knows both the declared
 * screens and the 기획서 the shell has open.
 */
export function ScreenPanel({
  daemon,
  onOpenSettings,
  onComments,
  turnState,
  publishSessionId = null,
  specPath = null,
  onScreens,
  pageIdOf,
  onPrecheck,
  saveOpen,
  handoffOpen,
  onCloseSave,
  onCloseHandoff,
}: {
  daemon: Daemon;
  onOpenSettings: () => void;
  /**
   * Forward a comment bundle as a turn in the page's screen thread. The panel
   * does not know which thread that is; the shell resolves it, creating one if
   * the page has none yet.
   */
  onComments: (turn: string) => Promise<void>;
  /** State of the thread the comments went to, so pins clear when it settles. */
  turnState: SessionState;
  /**
   * The 화면 thread a failing gate briefs, resolved by the shell: a failed
   * check or build hands its output to Claude as the next Korean turn, so a
   * failed 저장 or 넘기기 is not a dead end. Null when the page has no screen
   * thread yet — there is simply nobody to brief.
   */
  publishSessionId?: string | null;
  /**
   * The mirror-relative path of the 기획서 the shell has open, e.g.
   * `ENG/회원 관리 기획서.md`. This is the whole of PLAN D1 on this side: pick
   * a 기획서 on the left, see its screen on the right.
   */
  specPath?: string | null;
  /** The repo's declared screens, so the shell can badge the page tree (§2.4). */
  onScreens: (screens: DrafthouseScreen[]) => void;
  /**
   * The page behind a `spec` path, or null when the project does not carry
   * that 기획서. The panel holds mirror paths and the shell holds pageIds; only
   * the shell can join them, and the 넘기기 proposal needs the ids.
   */
  pageIdOf: (specPath: string) => string | null;
  /**
   * Asks the 화면 thread whether these screens cover their 기획서. Offered in
   * the 넘기기 dialog, because that is the moment the question is worth
   * asking; the shell composes the turn and owns the thread.
   */
  onPrecheck?: () => void;
  /**
   * The two dialogs of the cycle, opened by the stepper above the document
   * (PLAN D8). They render here because this is where the declared screens
   * are, and the 넘기기 proposal is composed from them — but WHEN they open is
   * the stepper's decision, not the preview's.
   */
  saveOpen: boolean;
  handoffOpen: boolean;
  onCloseSave: () => void;
  onCloseHandoff: () => void;
}) {
  const { connection, repo, api, projects, activeSlug } = daemon;
  const phase = repo?.phase ?? null;
  const ready = phase === "ready";
  /**
   * A failed repo.sync used to be shown in the chat column's error banner.
   * The panel no longer reaches the chat, so it answers its own failure in
   * its own column — right above the preview it could not bring up.
   */
  const [syncError, setSyncError] = useState<string | null>(null);
  /** Preview comment pins waiting for Claude's turn to settle (DESIGN §6). */
  const [commentPins, setCommentPins] = useState<DrafthouseCommentsEnvelope | null>(null);
  /** True once the carrying turn actually ran; pins clear when it settles. */
  const [commentTurnRan, setCommentTurnRan] = useState(false);
  /**
   * What the repo said it can render (PLAN D7). Empty until its overlay
   * speaks, which is why the toolbar's picker is absent rather than empty: an
   * old repo that declares nothing and an app that has not booted yet look
   * identical from here.
   */
  const [screens, setScreens] = useState<DrafthouseScreen[]>([]);
  /** The screen and state the preview has been asked to show, or null. */
  const [target, setTarget] = useState<PreviewTarget | null>(null);
  /**
   * The 기획서 the last automatic navigation answered. Without it every
   * re-post of the screen list — one lands on each hot reload — would yank the
   * planner back to the page's screen after they had picked another from the
   * toolbar. Selecting a different 기획서 changes this and moves them again,
   * which is the only time they asked to be moved.
   */
  const autoNavigatedFor = useRef<string | null>(null);

  const sync = useCallback(() => {
    setSyncError(null);
    void api.repoSync().catch((e: Error) => setSyncError(e.message));
  }, [api]);

  /**
   * Mounting the 화면 segment is what readies the repo. `repoSync` is
   * idempotent daemon-side, so flipping between 문서 and 화면 re-runs it at
   * most once per mount — never per render — and unmounting deliberately does
   * nothing: the preview server keeps running so coming back is instant.
   */
  useEffect(() => {
    if (connection !== "open") return;
    sync();
  }, [connection, sync]);

  /**
   * PLAN D1, the whole of it on this side: the 기획서 on the left decides the
   * screen on the right. Runs when the list arrives (the planner can pick a
   * page while the repo is still cloning) and when the page changes.
   *
   * FIRST declared match wins. A 기획서 that specifies 목록 + 상세 is the normal
   * shape, not an edge case, so a rule that goes blank whenever a page has
   * more than one screen would go blank on the common case. Registry order is
   * the repo's own declared order, so "first" is a choice the repo made rather
   * than one made here, and the 화면 picker carries the rest. No match at all
   * navigates nowhere: whatever the planner was looking at is better than an
   * empty frame.
   */
  useEffect(() => {
    if (!specPath || autoNavigatedFor.current === specPath) return;
    const match = screens.find((screen) => screen.spec === specPath);
    if (!match) return;
    autoNavigatedFor.current = specPath;
    setTarget({ route: match.route, state: null });
  }, [specPath, screens]);

  /**
   * The list is needed in two places at once: here, for the picker and the
   * 넘기기 proposal, and up in the shell, which badges a page ◐ 화면 있음 the
   * moment some screen names it (§2.4).
   */
  const receiveScreens = useCallback(
    (next: DrafthouseScreen[]) => {
      setScreens(next);
      onScreens(next);
    },
    [onScreens],
  );

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
   * A comment batch from the preview overlay: shown as pins and forwarded as
   * one structured Korean turn — the same wire a typed message uses, so Claude
   * sees it as the planner's own words (DESIGN §6). Pins stay while the turn
   * runs and clear when it settles.
   */
  const forwardComments = async (envelope: DrafthouseCommentsEnvelope) => {
    setCommentPins(envelope);
    setCommentTurnRan(false);
    // The envelope names the screen the way the app routes to it; the card
    // wants the title the repo gave it. Falling back to the raw id keeps a
    // screen the registry no longer declares from losing its card entirely.
    const named = screens.find((screen) => screen.route === `/${envelope.screen}`);
    await onComments(commentsToTurn(envelope, named?.title ?? envelope.screen));
  };

  const errorKind = classifyError(repo?.detail ?? null);
  // Only a named preview death takes over the preview frame; anything else
  // (a failed clone or pull, say) is answered by the retry panel, because the
  // preview may still be alive and worth looking at.
  const previewStopped = phase === "error" && errorKind === "preview";
  const showProgress = !repo || (!ready && !previewStopped);
  // Progress renders inside this column, not over the whole planner: the tree
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
  const { title: proposedTitle, body: proposedBody } = handoffDraft(projectName, screens, pageIdOf);

  return (
    <div className="planner__previewcol">
      {syncError && <p className="hint">{syncError}</p>}
      {commentPins && <CommentPinsSummary envelope={commentPins} />}
      <Preview
        url={repo?.previewUrl ?? null}
        stopped={previewStopped}
        stoppedDetail={repo?.detail ?? null}
        onRestart={sync}
        onComments={(envelope) => void forwardComments(envelope)}
        screens={screens}
        target={target}
        onNavigate={(route, state) => setTarget({ route, state })}
        onScreens={receiveScreens}
      />
      {saveOpen && (
        <DiffPanel daemon={daemon} sessionId={publishSessionId} onClose={onCloseSave} />
      )}
      {handoffOpen && (
        <HandoffPanel
          daemon={daemon}
          proposedTitle={proposedTitle}
          proposedBody={proposedBody}
          sessionId={publishSessionId}
          {...(onPrecheck
            ? {
                onPrecheck: () => {
                  onCloseHandoff();
                  onPrecheck();
                },
              }
            : {})}
          onClose={onCloseHandoff}
        />
      )}
    </div>
  );
}

/** Pins summary shown above the preview until the turn settles. */
function CommentPinsSummary({ envelope }: { envelope: DrafthouseCommentsEnvelope }) {
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
            <span className="pins__component">{item.element.component}</span>
            <span className="pins__comment">{item.comment}</span>
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
function commentsToTurn(envelope: DrafthouseCommentsEnvelope, screenTitle: string): string {
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
