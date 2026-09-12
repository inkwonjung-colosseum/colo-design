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
  gating: "레포 검사 통과 중",
  pushing: "변경사항을 저장하는 중",
  published: "저장했습니다",
  "handing-off": "개발자에게 넘기는 중",
  "handed-off": "개발자에게 넘겼습니다",
  failed: "끝내지 못했습니다",
};

/**
 * Gates arrive as the daemon's own identifiers — `commit`, `push`, `pr`. Read
 * out raw they put git's vocabulary back on the planner's screen one word at a
 * time, so each names the step it actually is instead (PLAN D5).
 */
const GATE_LABEL: Record<NonNullable<DiffStatus["gate"]>, string> = {
  check: "코드 검사",
  build: "빌드 검사",
  commit: "변경사항 정리",
  push: "변경사항 올리기",
  diff: "변경사항 확인",
  pr: "개발자에게 전달",
};

/** In flight: neither a 저장 nor a 넘기기 can be started on top of this. */
export const RUNNING: DiffStatus["stage"][] = ["computing", "gating", "pushing", "handing-off"];

/**
 * The one progress line both panels read. 저장 and 넘기기 stream on the same
 * `diff.status` channel, so a second reading of it would only be a second
 * place to forget a stage.
 */
export function stageLine(status: DiffStatus | null): string {
  if (!status) return "";
  const label = STAGE_LABEL[status.stage];
  // A settled stage names itself; which gate ran matters only while one is
  // running, or when it is the one that failed.
  const settled = status.stage === "published" || status.stage === "handed-off";
  if (!status.gate || settled) return label;
  return `${label} · ${GATE_LABEL[status.gate]}`;
}

function FileRow({ file }: { file: DiffFile }) {
  const [open, setOpen] = useState(file.hunks.length === 1);
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
}) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  /** Once the planner edits the note, the summary stops filling it. */
  const memoTouched = useRef(false);
  const diffStatus = daemon.diffStatus;
  const running = diffStatus !== null && RUNNING.includes(diffStatus.stage);
  const published = diffStatus?.stage === "published";
  const failed = diffStatus?.stage === "failed";

  // The turn-end summary and the asked-for one differ only in provenance; key
  // the effect on the joined text so a caller-side array identity cannot loop it.
  const turnSummaryText = summaryLines && summaryLines.length > 0 ? summaryLines.join("\n") : null;

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [onClose]);

  // The list is a snapshot of what a 저장 would write; reload it whenever one
  // settles, because a success means the worktree is clean now.
  useEffect(() => {
    if (running) return;
    let cancelled = false;
    void daemon.api
      .diff()
      .then((next) => !cancelled && setFiles(next))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [daemon, running]);

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
    daemon.api
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
  }, [daemon, files, turnSummaryText]);

  // The note opens filled with the summary's first line (PLAN D51) — the one
  // the planner would have typed anyway. Their own keystrokes win from then on.
  useEffect(() => {
    if (memoTouched.current) return;
    const first = summary?.lines[0];
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
            >
              <span className="notice__text">{stageLine(diffStatus)}</span>
              {running && <span className="spinner" />}
            </div>
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
              the review reads as sentences, not as a diff (PLAN D51). */}
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
                요약의 첫 줄이 채워져 있습니다 — 고칠 수 있습니다
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
