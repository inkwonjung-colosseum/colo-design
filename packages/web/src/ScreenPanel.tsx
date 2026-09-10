import { useCallback, useEffect, useState } from "react";
import type {
  CdsDesignCommentsEnvelope,
  CdsDesignScreen,
  RepoPhase,
  SessionState,
  TurnMarker,
} from "@cds-design/protocol";
import { markTurn } from "@cds-design/protocol";
import type { Daemon } from "./daemon-client";
import { stateLabel } from "./format";
import { Preview, type PreviewTarget } from "./Preview";
import { DiffPanel } from "./DiffPanel";
import { HandoffPanel } from "./HandoffPanel";
import { handoffDraft } from "./handoff-draft";
import {
  CheckIcon,
  ClipboardCheckIcon,
  CopyIcon,
  HandoffIcon,
  RefreshIcon,
  RestartIcon,
  SaveIcon,
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
}) {
  const { connection, repo, api, projects, activeSlug } = daemon;
  const phase = repo?.phase ?? null;
  const ready = phase === "ready";
  /**
   * A failed repo.sync is answered in this column, right above the preview
   * it could not bring up — the rail and the chat stay usable while it runs.
   */
  const [syncError, setSyncError] = useState<string | null>(null);
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
   * only door now, so the target lives here, beside it.
   */
  const [target, setTarget] = useState<PreviewTarget | null>(null);
  /** The two dialogs of the cycle: 저장 and 개발자에게 넘기기. */
  const [saveOpen, setSaveOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);

  const sync = useCallback(() => {
    setSyncError(null);
    void api.repoSync().catch((e: Error) => setSyncError(e.message));
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
    // A thread the TOOL opens is named by the tool (the M5 lesson): naming it
    // after the screen the pins came from is the honest one-line answer to
    // "where did this tab come from".
    await onComments(commentsToTurn(envelope, named?.title ?? envelope.screen), named?.title);
  };

  const errorKind = classifyError(repo?.detail ?? null);
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

  return (
    <div className="planner__previewcol">
      <div className="screenpanel__bar">
        {status ? (
          <span className={`screenpanel__status screenpanel__status--${status.tone}`}>
            {status.label}
          </span>
        ) : (
          <span className="screenpanel__status screenpanel__status--none">화면 대기 중</span>
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
        <button
          type="button"
          className="ghost"
          disabled={!sessionId}
          title={sessionId ? "열려 있는 대화에서 기획서와 화면을 맞춰 봅니다" : "먼저 대화를 열어 주세요"}
          onClick={() =>
            onPrecheck(
              "넘기기 전 점검: 이 화면이 근거 기획서(specs/ 첨부)와 맞는지 확인하고, 다른 점·비어 있는 점을 목록으로 답해 주세요.",
            )
          }
        >
          <ClipboardCheckIcon />
          넘기기 전 점검
        </button>
        <button
          type="button"
          className="ghost"
          disabled={!workable}
          title="검토한 변경을 이 프로젝트의 작업 위치에 저장합니다"
          onClick={() => setSaveOpen(true)}
        >
          <SaveIcon />
          저장
        </button>
        <button
          type="button"
          className="primary"
          disabled={!workable || !repo?.branch}
          title={repo?.branch ? undefined : "아직 저장한 변경이 없습니다. 먼저 저장해 주세요"}
          onClick={() => setHandoffOpen(true)}
        >
          <HandoffIcon />
          개발자에게 넘기기
        </button>
      </div>
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
        onScreens={setScreens}
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
