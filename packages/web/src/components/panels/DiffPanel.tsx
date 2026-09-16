import type { DiffFile, DiffStatus } from "@colo-design/protocol";
import { useEffect, useRef, useState } from "react";
import { useModalFocus } from "../../hooks/use-modal-focus";
import type { Daemon, DiffSummary } from "../../lib/daemon-client";
import { ChevronRightIcon, CloseIcon, DiffIcon, MinusIcon, PlusIcon, SparkIcon } from "../icons";
import { Tip } from "../shell/Tip";

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "추가",
  modified: "수정",
  deleted: "삭제",
  renamed: "이름 변경",
};

const STAGE_LABEL: Record<DiffStatus["stage"], string> = {
  computing: "변경사항을 모으는 중",
  pushing: "변경사항을 저장하는 중",
  published: "저장했습니다",
  "handing-off": "개발자에게 넘기는 중",
  "handed-off": "개발자에게 넘겼습니다",
  failed: "끝내지 못했습니다",
};

/**
 * Gates arrive as the daemon's own identifiers — `commit`, `push`, `pr`. Read
 * out raw they put git's vocabulary back on the planner's screen one word at
 * a time, so each names the step it actually is instead. The words
 * a repo's own command goes by (`레포 검사`) come from labels.ts — the
 * same job must not wear two names between the transcript and this line.
 */
const GATE_LABEL: Record<NonNullable<DiffStatus["gate"]>, string> = {
  commit: "변경사항 정리",
  push: "변경사항 올리기",
  diff: "변경사항 확인",
  pr: "개발자에게 넘기기",
};

/** In flight: neither a 저장 nor a 넘기기 can be started on top of this. */
export const RUNNING: DiffStatus["stage"][] = ["computing", "pushing", "handing-off"];

/**
 * The one progress line both panels read. 저장 and 넘기기 stream on the same
 * `diff.status` channel, so a second reading of it would only be a second
 * place to forget a stage. A failed stage names the step it stopped at —
 * "끝내지 못했습니다 · 개발자에게 전달" 처럼 실패와 완료가 한 줄에 공존하는
 * 문장이 아니라 (실사 결함), 어느 단계까지 갔는지가 그 자체로 읽힌다.
 */
export function stageLine(status: DiffStatus | null): string {
  if (!status) return "";
  if (status.stage === "failed") {
    return `${GATE_LABEL[status.gate ?? "diff"]}에서 멈췄습니다`;
  }
  const label = STAGE_LABEL[status.stage];
  // A settled stage names itself; which gate ran matters only while one is
  // running, or when it is the one that failed.
  const settled = status.stage === "published" || status.stage === "handed-off";
  if (!status.gate || settled) return label;
  return `${label} · ${GATE_LABEL[status.gate]}`;
}

/**
 * 저장의 세 걸음 (비개발자 저장 검토): the rail the panel shows while a save
 * moves — 모으기 → 올리기 → 완료. A failed stage marks the step it stopped
 * at instead of ending at "멈췄습니다": `diff` failures never left the
 * review, `commit`/`push` died on the way up. The 넘기기 stages share this
 * channel but this panel hands off to HandoffPanel before they arrive.
 */
const SAVE_STEPS = ["바뀐 점 모으기", "저장소에 올리기", "완료"] as const;

/** Which rail step a status stands on; -1 when the status is not a save's. */
function saveStep(status: DiffStatus): { index: number; failed: boolean } {
  if (status.stage === "computing") return { index: 0, failed: false };
  if (status.stage === "pushing") return { index: 1, failed: false };
  if (status.stage === "published") return { index: 2, failed: false };
  if (status.stage === "failed") {
    const index = status.gate === "commit" || status.gate === "push" ? 1 : 0;
    return { index, failed: true };
  }
  return { index: -1, failed: false };
}

function FileRow({ file }: { file: DiffFile }) {
  // Even a single hunk stays folded until the row is pressed: the row —
  // status, name, how much moved — is the reading unit (비개발자 저장
  // 검토), and raw code is one click away, never the first thing shown.
  const [open, setOpen] = useState(false);
  const added = file.hunks.reduce(
    (total, hunk) =>
      total + hunk.lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    0,
  );
  const removed = file.hunks.reduce(
    (total, hunk) =>
      total + hunk.lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
    0,
  );
  // The planner reads names, not paths: the file's own name leads and the
  // folder it lives in follows muted — the full path stays on the tooltip.
  const slash = file.path.lastIndexOf("/");
  const basename = slash === -1 ? file.path : file.path.slice(slash + 1);
  const dir = slash === -1 ? null : file.path.slice(0, slash);

  return (
    <li className="diff__file">
      <button
        type="button"
        className="diff__filerow"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`ic ic--quiet ic--sm diff__chevron${open ? " diff__chevron--open" : ""}`}>
          <ChevronRightIcon />
        </span>
        <span className={`diff__badge diff__badge--${file.status}`}>
          {STATUS_LABEL[file.status]}
        </span>
        <span className="diff__path" title={file.path}>
          <span className="diff__basename">{basename}</span>
          {dir && <span className="diff__dir">{dir}</span>}
        </span>
        <Tip
          label={
            file.binary
              ? "내용을 글로 보여 줄 수 없는 파일입니다"
              : `${added}줄이 더해지고 ${removed}줄이 지워집니다`
          }
        >
          <span className="diff__count">
            {file.binary ? (
              "바이너리"
            ) : added === 0 && removed === 0 ? (
              "—"
            ) : (
              <>
                {added > 0 && (
                  <>
                    <span className="ic ic--ok ic--sm">
                      <PlusIcon />
                    </span>
                    {added}{" "}
                  </>
                )}
                {removed > 0 && (
                  <>
                    <span className="ic ic--danger ic--sm">
                      <MinusIcon />
                    </span>
                    {removed}
                  </>
                )}
              </>
            )}
          </span>
        </Tip>
      </button>
      {open && !file.binary && (
        <div className="diff__hunks">
          {file.hunks.map((hunk, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: hunk 의 index 가 곧 문서 순서다 — 매 렌더 전체가 다시 그려진다.
            <pre key={index} className="diff__hunk">
              <code>{[hunk.header, ...hunk.lines].join("\n")}</code>
            </pre>
          ))}
        </div>
      )}
    </li>
  );
}

/**
 * Fallback summary: paths grouped by their second folder, with
 * counts. It cuts strings — it does not pretend to read the repo's layout.
 */
function fallbackLines(files: DiffFile[]): string[] {
  const counts = new Map<string, Record<DiffFile["status"], number>>();
  for (const file of files) {
    const segment = file.path.split("/");
    // `src/screens/Pay.tsx` groups under `screens`; a file sitting directly
    // in a top folder groups under that folder, not under its own name.
    const folder =
      segment.length > 2
        ? (segment[1] ?? "(루트)")
        : segment.length === 2
          ? (segment[0] ?? "(루트)")
          : "(루트)";
    const bucket = counts.get(folder) ?? {
      added: 0,
      modified: 0,
      deleted: 0,
      renamed: 0,
    };
    bucket[file.status] += 1;
    counts.set(folder, bucket);
  }
  return [...counts.entries()].map(([folder, bucket]) => {
    const parts = (["modified", "added", "deleted", "renamed"] as const)
      .filter((status) => bucket[status] > 0)
      .map((status) => `${STATUS_LABEL[status]} ${bucket[status]}`);
    return `${folder}: ${parts.join(" · ")}`;
  });
}

/** What a diff was when its summary was written — path, kind, and how much moved. */
function diffKey(files: DiffFile[]): string {
  return files
    .map((file) => {
      const added = file.hunks.reduce(
        (total, hunk) =>
          total +
          hunk.lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
        0,
      );
      const removed = file.hunks.reduce(
        (total, hunk) =>
          total +
          hunk.lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
        0,
      );
      return `${file.status}:${file.path}:+${added}:-${removed}`;
    })
    .join("|");
}

/**
 * The summary is asked once per diff, not once per open of the panel — each
 * mount is a fresh component, so the cache outlives it here.
 * Claude-sourced answers only: the fallback is a local count, never worth
 * remembering over a real summary.
 */
const summaryCache = new Map<string, DiffSummary & { source: "claude" }>();

/**
 * The 저장 review: a summary to read first, a save note prefilled
 * from it, and the raw files · hunks folded away under `자세히 보기`. Nothing
 * leaves the machine without a person clicking 저장 here.
 */
export function DiffPanel({
  daemon,
  sessionId,
  onClose,
  branch,
  handoffNext,
  openHandoffNumber,
  destination,
  onHandoff,
  onOpenSettings,
}: {
  daemon: Daemon;
  /** The live planning thread; a failed gate lands in it as Claude's next task. */
  sessionId: string | null;
  onClose: () => void;
  /**
   * The cycle branch 저장 pushes to — shown on the settled line so the
   * planner sees WHERE the work went, not just that it happened.
   */
  branch?: string | null;
  /**
   * 게이트 사이의 복도: 이 순간 넘기기가 열려 있다는
   * 렌더 시점의 판정 — 저장 리뷰의 끝에서 바로 넘기기 리뷰로 이어가는
   * 버튼이 그린다. 부르는 쪽(ScreenPanel)이 웹소켓 갱신마다 다시 계산해
   * 내린다. 클릭 수도 게이트 수도 줄지 않는다 — 줄어드는 것은 왕복뿐.
   */
  handoffNext?: boolean;
  /**
   * 열린 넘김의 번호 — 성공 문장이 "요청에
   * 함께 담았다"로 바뀐다. null 이면 이번 저장이 첫발이다.
   */
  openHandoffNumber?: number | null;
  /** 목적지: 이 저장이 향할 회사 저장소의 이름(owner/repo). */
  destination?: string | null;
  /** 저장 리뷰의 끝에서 바로 넘기기 리뷰로. */
  onHandoff?: () => void;
  /** A push refused over credentials is the planner's to fix, in 설정. */
  onOpenSettings?: () => void;
}) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  /** The memo on screen is Claude's suggestion until the planner types. */
  const [memoAi, setMemoAi] = useState(false);
  /** Once the planner edits the note, the summary stops filling it. */
  const memoTouched = useRef(false);
  const diffStatus = daemon.diffStatus;
  /**
   * The calls ride the STABLE `api` object, not the `daemon` prop: the client
   * hands out a fresh wrapper every render, and a websocket message landing
   * while this dialog is open would otherwise cancel an in-flight summarize —
   * a real Claude turn, paid for again — and ask it from scratch.
   */
  const { api } = daemon;
  const running = diffStatus !== null && RUNNING.includes(diffStatus.stage);
  const published = diffStatus?.stage === "published";
  const failed = diffStatus?.stage === "failed";

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      // A save in flight keeps its progress line: ESC only leaves when the
      // daemon is done telling the story.
      if (event.key === "Escape" && !running) onClose();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [onClose, running]);

  // The list is a snapshot of what a 저장 would write; reload it whenever one
  // settles, because a success means the worktree is clean now.
  useEffect(() => {
    if (running) return;
    let cancelled = false;
    void api
      .diff()
      .then((next) => !cancelled && setFiles(next))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [api, running]);

  // The summary follows the diff: one `repo.summarize` ask, cached by what the
  // diff was. Three seconds in, the planner reads the local fallback — a slow
  // answer still replaces it when it lands (the 폴백 is a display
  // floor, not a cancel).
  useEffect(() => {
    if (!files || files.length === 0) {
      setSummary(null);
      setSummarizing(false);
      return;
    }
    const key = diffKey(files);
    const cached = summaryCache.get(key);
    if (cached) {
      setSummary(cached);
      setSummarizing(false);
      return;
    }
    let cancelled = false;
    setSummary(null);
    setSummarizing(true);
    const fallbackTimer = window.setTimeout(() => {
      if (!cancelled) setSummary({ lines: fallbackLines(files), source: "fallback" });
    }, 3_000);
    api
      .summarizeDiff()
      .then((next) => {
        if (cancelled) return;
        setSummary(next);
        if (next.source === "claude") {
          summaryCache.set(key, {
            lines: next.lines,
            ...(next.memo ? { memo: next.memo } : {}),
            source: "claude",
          });
          // A save review is opened, not surfed; a bounded cache is enough.
          if (summaryCache.size > 16) {
            const oldest = summaryCache.keys().next().value;
            if (oldest !== undefined) summaryCache.delete(oldest);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setSummary({ lines: fallbackLines(files), source: "fallback" });
      })
      .finally(() => {
        clearTimeout(fallbackTimer);
        if (!cancelled) setSummarizing(false);
      });
    return () => {
      cancelled = true;
      clearTimeout(fallbackTimer);
    };
  }, [api, files]);
  // The note opens filled with the memo the summary turn proposed (비개발자
  // 저장 검토) — a sentence written to be a memo, not the summary's first
  // line borrowed into the job. An answer without one still opens on the
  // first line, the pre-memo behaviour. Only Claude's words fill it: a
  // fallback grouping (`screens: 수정 1`) is a count, not a memo, and an
  // empty note means Claude writes the memo at 저장. Their own keystrokes
  // win from then on.
  useEffect(() => {
    if (memoTouched.current) return;
    if (summary?.source !== "claude") return;
    const suggestion = summary.memo ?? summary.lines[0];
    if (suggestion) {
      setMessage(suggestion);
      setMemoAi(true);
    }
  }, [summary]);
  /** 폴백 요약은 숫자 묶음일 뿐 메모가 못 된다 — 프리필은
   *  하지 않는 현 규칙 그대로, 대신 커서를 직접 메모로 옮긴다. 사람의 한
   *  줄이 기본 문약("화면 변경")보다 낫다. */
  const memoRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (summary?.source === "fallback" && !memoTouched.current) memoRef.current?.focus();
  }, [summary]);

  /** Opening hands focus to the panel, so Tab and a screen reader start inside. */
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const save = async () => {
    setError(null);
    try {
      await daemon.api.save(message.trim() || undefined, sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // The rail only tells a save's story — 넘기기 stages belong to the other
  // panel, and a settled save reads better as the notice below than as a
  // rail with every light lit.
  const step = diffStatus ? saveStep(diffStatus) : { index: -1, failed: false };
  const showRail = step.index >= 0 && !published;
  /** 삭제는 되돌리기 어려운 변경 — 요약이 말하지 않아도 패널이 말한다. */
  const deletedCount = files?.filter((file) => file.status === "deleted").length ?? 0;
  /** commit·push 실패는 대화로 넘어간다 — 멈춘 게 아니라 고쳐지는 중. */
  const handedToClaude =
    failed &&
    diffStatus?.reason !== "push-auth" &&
    (diffStatus?.gate === "commit" || diffStatus?.gate === "push");
  /**
   * 묶기는 끝났고 올리기에서 멈춘 저장 (비개발자 저장 검토): the commit
   * landed, so the worktree is clean and the diff is empty — and the empty
   * review's own line ("먼저 화면을 만들거나 고쳐 주세요") would tell the
   * planner their finished work never happened. 저장 is a push retry in
   * that state (repo.ts runSave), so the button stays pressable.
   */
  const pushStalled = failed && files !== null && files.length === 0;

  return (
    <div
      className="modal"
      onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}
    >
      <div
        className="modal__panel modal__panel--diff"
        role="dialog"
        aria-modal="true"
        aria-label="저장 검토"
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="modal__head">
          <h2 className="modal__title">
            <span className="ic ic--quiet">
              <DiffIcon />
            </span>{" "}
            저장 검토
            {destination ? <span className="modal__destination">→ {destination}</span> : null}
          </h2>
          <Tip
            label={running ? "저장이 진행 중입니다 — 끝나면 닫을 수 있습니다" : "저장 검토 닫기"}
            side="left"
          >
            <button
              type="button"
              className="ghost"
              aria-label="저장 검토 닫기"
              aria-disabled={running}
              onClick={() => {
                if (!running) onClose();
              }}
            >
              <CloseIcon />
            </button>
          </Tip>
        </header>

        <div className="modal__body">
          {/* 처음 여는 사람의 한 줄: 저장은 아직 개발자에게 가지 않는다. */}
          {!diffStatus && (
            <p className="hint">
              Claude가 바꾼 내용을 확인하고 저장합니다 — 저장해도 아직 개발자에게는 가지 않습니다.
            </p>
          )}

          {showRail && (
            <div
              className="progress__rail diff__rail"
              role="status"
              aria-label={stageLine(diffStatus)}
            >
              {SAVE_STEPS.map((label, index) => (
                <span
                  key={label}
                  className={`progress__step${
                    step.failed && index === step.index
                      ? " progress__step--failed"
                      : index < step.index || (step.failed && index < step.index)
                        ? " progress__step--done"
                        : index === step.index
                          ? " progress__step--now"
                          : ""
                  }`}
                >
                  <span className="progress__dot">
                    {step.failed && index === step.index ? "✕" : index < step.index ? "✓" : ""}
                  </span>
                  {label}
                </span>
              ))}
            </div>
          )}

          {diffStatus &&
            (published ||
              diffStatus.stage === "handing-off" ||
              diffStatus.stage === "handed-off") && (
              <div className={published ? "notice notice--info" : "diff__stage"} role="status">
                <Tip
                  label={published && branch ? `저장 위치: ${branch}` : undefined}
                  side="bottom"
                  align="start"
                >
                  <span className="notice__text">
                    {stageLine(diffStatus)}
                    {/* 어디에 저장됐는지는 제품의 약속 그 자체다 (실사 결함):
                      다만 브랜치명 원문은 사용자의 어휘가 아니므로 사람 말로
                      말하고 위치는 툴팁에 남는다. 열린 넘김이
                      있으면 이번 저장이 첫발이 아니라는 사실이 더 중요하다. */}
                    {published && branch
                      ? openHandoffNumber
                        ? ` — 넘긴 요청 ${openHandoffNumber}번에 함께 담았습니다`
                        : " — 회사 GitHub에 올렸습니다"
                      : ""}
                  </span>
                </Tip>
                {running && <span className="spinner" />}
              </div>
            )}
          {/* What the save wrote in the planner's name (비개발자 저장): an
              empty memo is Claude's sentence now, so the settled line shows
              it — theirs to read, correct, or 되돌리기 away. */}
          {published && diffStatus.message && (
            <p className="hint" data-testid="committed-memo">
              저장 메모: {diffStatus.message}
            </p>
          )}
          {published && (
            <p className="hint">잘못 저장했다면 더 보기 → 저장 기록에서 되돌릴 수 있습니다.</p>
          )}
          {/* The gate's own output is a developer's text: the rail
              above already says where it stopped, the raw transcript waits. */}
          {failed && diffStatus?.detail && (
            <details className="settings__fold">
              <summary>자세히</summary>
              <pre className="diff__fail">
                <code>{diffStatus.detail}</code>
              </pre>
            </details>
          )}
          {/* A push refused over credentials will never fix itself in
              a turn — the next move is the planner's token, so the card names
              it instead of ending at "멈췄습니다". */}
          {failed && diffStatus?.reason === "push-auth" && (
            <div className="notice notice--error" data-testid="push-auth-failure">
              <span className="notice__text">
                변경사항 정리까지 끝냈고, 올리기에서 멈췄습니다 — 설정에서 GitHub 토큰을 확인한 뒤
                다시 저장해 주세요.
              </span>
              {onOpenSettings && (
                <button type="button" className="ghost" onClick={onOpenSettings}>
                  설정 열기
                </button>
              )}
            </div>
          )}
          {/* 멈춘 게 아니라 넘어간 것 (비개발자 저장 검토): commit·push 실패는
              이미 대화의 다음 과제다 — 패널이 "멈췄습니다"로 끝내면 기획자는
              아무도 고치지 않는 줄 안다. */}
          {handedToClaude && (
            <p className="hint">
              문제는 대화로 넘겼습니다 — Claude가 고치는 모습을 대화에서 볼 수 있습니다.
            </p>
          )}

          {/* 요약은 검토의 본문이다 — 각주가 아니라 카드 (비개발자 저장
              검토). Claude가 쓰는 동안은 자리만 흐리게 채운다. */}
          {files !== null && files.length > 0 && (
            <div className="diff__summary" data-testid="diff-summary">
              <p className="diff__summarycap">
                <span className="ic ic--sm">
                  <SparkIcon />
                </span>
                {summary?.source === "claude"
                  ? "Claude가 바뀐 점을 읽고 적었습니다"
                  : summary
                    ? "바뀐 파일을 묶어 적었습니다"
                    : "Claude가 바뀐 점을 읽는 중…"}
              </p>
              {summary && summary.lines.length > 0 ? (
                <ul className="diff__summarylines">
                  {summary.lines.map((line, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 렌더마다 전체를 다시 그리는 정적 줄 목록이다.
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              ) : (
                summarizing && (
                  // 뼈대는 요약의 줄이 아니다 — 같은 선택자를 쓰면 "요약이
                  // 떴다"는 판정이 기다림에 걸려 참이 된다(검사까지 속는다).
                  <ul className="diff__summaryskel" aria-hidden="true">
                    <li className="diff__skel" />
                    <li className="diff__skel diff__skel--short" />
                  </ul>
                )
              )}
            </div>
          )}

          {deletedCount > 0 && !published && (
            <div className="notice notice--warn">
              <span className="notice__text">
                이번 저장에서 파일 {deletedCount}개가 삭제됩니다 — 아래 자세히 보기에서 확인해
                주세요.
              </span>
            </div>
          )}

          {files === null && !error && <p className="hint">변경사항을 읽어 오는 중…</p>}
          {/* 묶기는 끝난 저장에게 "먼저 화면을 만들거나 고쳐 주세요" 는
              거짓말이다 (비개발자 저장 검토): 바뀐 점은 이번 작업에 이미
              묶였고, 남은 것은 올리기뿐이다. */}
          {pushStalled && (
            <p className="hint">
              바뀐 점은 이번 작업에 묶었습니다 — 남은 것은 회사 GitHub에 올리는 일이니, 다시 저장을
              누르면 그 한 걸음만 다시 시도합니다.
            </p>
          )}
          {files !== null && files.length === 0 && !published && !pushStalled && (
            <p className="hint">저장할 변경사항이 없습니다. 먼저 화면을 만들거나 고쳐 주세요.</p>
          )}
          {/* Paths and +/- lines live behind the fold — the first screen of
              the review reads as sentences, not as a diff. The
              fold now stays shut until the planner asks, at every size:
              even one file of raw code read as noise (비개발자 저장 검토),
              and the summary above is the review. */}
          {files !== null && files.length > 0 && (
            <details className="settings__fold">
              <summary>자세히 보기 (파일 {files.length}개)</summary>
              <ul className="diff__files">
                {files.map((file) => (
                  <FileRow key={file.path} file={file} />
                ))}
              </ul>
            </details>
          )}

          {error && (
            <div className="notice notice--error">
              <span className="notice__text">{error}</span>
            </div>
          )}

          {/* 메모 칸은 저장이 그것을 쓸 수 있을 때만 선다: 올리기의 재시도는
              커밋을 쓰지 않고(repo.ts runSave), 끝난 저장의 메모는 이미
              커밋에 실려 위의 `저장 메모:` 줄로 읽힌다 — 어느 쪽이든 고쳐도
              닿을 곳이 없는 칸이다. */}
          {!pushStalled && !published && (
            <label className="setting setting--wide diff__memo">
              <span className="setting__text">
                <span className="setting__label">저장 메모</span>
                <span className="setting__hint">
                  {memoAi
                    ? "Claude가 제안한 메모입니다 — 그대로 저장하거나 고쳐 주세요"
                    : '비워 두면 Claude가 바뀐 점을 읽고 저장 메모를 씁니다 — 못 쓰면 "화면 변경"으로 저장됩니다'}
                </span>
              </span>
              <span className="setting__control">
                <input
                  ref={memoRef}
                  value={message}
                  placeholder="예: 회원 관리 화면 추가"
                  aria-label="저장 메모"
                  disabled={running}
                  onChange={(e) => {
                    memoTouched.current = true;
                    setMemoAi(false);
                    setMessage(e.target.value);
                  }}
                />
              </span>
            </label>
          )}

          <div className="settings__row">
            {published ? (
              <>
                {handoffNext && onHandoff && (
                  <button type="button" className="primary" onClick={onHandoff}>
                    개발자에게 넘기기 →
                  </button>
                )}
                <button
                  type="button"
                  className={handoffNext && onHandoff ? "ghost" : "primary"}
                  onClick={onClose}
                >
                  닫기
                </button>
              </>
            ) : (
              <>
                <Tip
                  label={
                    pushStalled
                      ? "이미 묶은 변경을 회사 GitHub에 올리는 일만 다시 시도합니다"
                      : "검토한 변경을 이번 작업 보관함에 저장하고 회사 GitHub에 올립니다"
                  }
                >
                  <button
                    type="button"
                    className="primary"
                    // 올리기에서 멈춘 저장은 diff 가 비어 있어도 누를 수 있다 —
                    // 그때의 저장은 올리기의 재시도이기 때문이다.
                    disabled={running || (!pushStalled && (!files || files.length === 0))}
                    onClick={() => void save()}
                  >
                    {running ? "저장 중…" : failed ? "다시 저장" : "저장"}
                  </button>
                </Tip>
                <button type="button" className="ghost" disabled={running} onClick={onClose}>
                  취소
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
