import type { DiffFile, DiffStatus } from "@colo-design/protocol";
import { useEffect, useRef, useState } from "react";
import type { Daemon, DiffSummary } from "./daemon-client";
import { CloseIcon } from "./icons";
import { useModalFocus } from "./use-modal-focus";

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
 * a time, so each names the step it actually is instead (PLAN D5). The words
 * a repo's own command goes by (`레포 검사`) come from tool-names.ts — the
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

function FileRow({ file }: { file: DiffFile }) {
  // Even a single hunk stays folded until the row is pressed: the row —
  // status, path, how much moved — is the reading unit (비개발자 저장
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

  return (
    <li className="diff__file">
      <button type="button" className="diff__filerow" onClick={() => setOpen((v) => !v)}>
        <span className={`diff__badge diff__badge--${file.status}`}>
          {STATUS_LABEL[file.status]}
        </span>
        <span className="diff__path">{file.path}</span>
        <span className="diff__count">{file.binary ? "바이너리" : `+${added} −${removed}`}</span>
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
 * Fallback summary (PLAN D51): paths grouped by their second folder, with
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
 * The summary is asked once per diff, not once per open of the panel (PLAN
 * D51) — each mount is a fresh component, so the cache outlives it here.
 * Claude-sourced answers only: the fallback is a local count, never worth
 * remembering over a real summary.
 */
const summaryCache = new Map<string, DiffSummary & { source: "claude" }>();

/**
 * The 저장 review (PLAN D51): a summary to read first, a save note prefilled
 * from it, and the raw files · hunks folded away under `자세히 보기`. Nothing
 * leaves the machine without a person clicking 저장 here.
 */
export function DiffPanel({
  daemon,
  sessionId,
  onClose,
  summaryLines,
  branch,
  onOpenSettings,
}: {
  daemon: Daemon;
  /** The live planning thread; a failed gate lands in it as Claude's next task. */
  sessionId: string | null;
  onClose: () => void;
  /**
   * The screen turns' own end-of-turn summaries (`<!-- colo-design:summary -->`),
   * when the caller has them. Present, they are the whole summary — no daemon
   * round trip. Absent (the usual mount), the panel asks `repo.summarize`.
   */
  summaryLines?: string[];
  /**
   * The cycle branch 저장 pushes to — shown on the settled line so the
   * planner sees WHERE the work went, not just that it happened.
   */
  branch?: string | null;
  /** A push refused over credentials is the planner's to fix, in 설정. */
  onOpenSettings?: () => void;
}) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [summarizing, setSummarizing] = useState(false);
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

  // The turn-end summary and the asked-for one differ only in provenance; key
  // the effect on the joined text so a caller-side array identity cannot loop it.
  const turnSummaryText = summaryLines && summaryLines.length > 0 ? summaryLines.join("\n") : null;

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

  // The summary follows the diff: turn-end lines when the caller has them,
  // else one `repo.summarize` ask, cached by what the diff was. Three seconds
  // in, the planner reads the local fallback — a slow answer still replaces
  // it when it lands (PLAN D51's 폴백 is a display floor, not a cancel).
  useEffect(() => {
    if (turnSummaryText !== null) {
      setSummary({ lines: turnSummaryText.split("\n"), source: "claude" });
      setSummarizing(false);
      return;
    }
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
          summaryCache.set(key, { lines: next.lines, source: "claude" });
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
  }, [api, files, turnSummaryText]);
  // The note opens filled with the summary's first line (PLAN D51) — but
  // only a Claude-written one: a fallback grouping (`screens: 수정 1`) is a
  // count, not a memo, and an empty note now means Claude writes the memo
  // at 저장 (비개발자 저장). Their own keystrokes win from then on.
  useEffect(() => {
    if (memoTouched.current) return;
    if (summary?.source !== "claude") return;
    const first = summary.lines[0];
    if (first) setMessage(first);
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

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal__panel modal__panel--diff"
        role="dialog"
        aria-modal="true"
        aria-label="저장 검토"
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="modal__head">
          <h2 className="modal__title">저장 검토</h2>
          <button type="button" className="ghost" aria-label="저장 검토 닫기" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <div className="modal__body">
          {diffStatus && (
            <div
              className={
                published ? "notice notice--info" : failed ? "notice notice--error" : "diff__stage"
              }
              role={published || failed ? "status" : undefined}
            >
              <span
                className="notice__text"
                title={published && branch ? `저장 위치: ${branch}` : undefined}
              >
                {stageLine(diffStatus)}
                {/* 어디에 저장됐는지는 제품의 약속 그 자체다 (실사 결함):
                    다만 브랜치명 원문은 기획자의 어휘가 아니므로 사람 말로
                    말하고 위치는 툴팁에 남는다 (비개발자 리뷰 D4). */}
                {published && branch ? " — 회사 GitHub에 올렸습니다" : ""}
              </span>
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
          {/* The gate's own output is a developer's text (PLAN D51): the stage
              line above already says what failed, the raw transcript waits. */}
          {failed && diffStatus?.detail && (
            <details className="settings__fold">
              <summary>자세히</summary>
              <pre className="diff__fail">
                <code>{diffStatus.detail}</code>
              </pre>
            </details>
          )}
          {/* 리뷰 C5: a push refused over credentials will never fix itself in
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

          {summarizing && <p className="hint">요약을 만드는 중…</p>}
          {summary && summary.lines.length > 0 && (
            <div>
              {summary.lines.map((line, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 렌더마다 전체를 다시 그리는 정적 줄 목록이다.
                <p className="hint" key={index}>
                  · {line}
                </p>
              ))}
              {summary.source === "claude" && <p className="hint">요약은 Claude가 썼습니다</p>}
            </div>
          )}

          {files === null && !error && <p className="hint">변경사항을 읽어 오는 중…</p>}
          {files !== null && files.length === 0 && !published && (
            <p className="hint">저장할 변경사항이 없습니다. 먼저 화면을 만들거나 고쳐 주세요.</p>
          )}
          {/* Paths and +/- lines live behind the fold — the first screen of
              the review reads as sentences, not as a diff (PLAN D51). The
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

          <label className="setting setting--wide">
            <span className="setting__text">
              <span className="setting__label">저장 메모</span>
              <span className="setting__hint">
                비워 두면 Claude가 바뀐 점을 읽고 저장 메모를 씁니다
              </span>
            </span>
            <span className="setting__control">
              <input
                value={message}
                placeholder="예: 회원 관리 화면 추가"
                aria-label="저장 메모"
                disabled={running}
                onChange={(e) => {
                  memoTouched.current = true;
                  setMessage(e.target.value);
                }}
              />
            </span>
          </label>

          <div className="settings__row">
            {published ? (
              <button type="button" className="primary" onClick={onClose}>
                닫기
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="primary"
                  disabled={running || !files || files.length === 0}
                  onClick={() => void save()}
                >
                  {running ? "저장 중…" : "저장"}
                </button>
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
