import { useEffect, useState } from "react";
import type { DiffFile, DiffStatus } from "@cds-design/protocol";
import type { Daemon } from "./daemon-client";
import { CloseIcon } from "./icons";

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
    (total, hunk) => total + hunk.lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    0,
  );
  const removed = file.hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
    0,
  );

  return (
    <li className="diff__file">
      <button type="button" className="diff__filerow" onClick={() => setOpen((v) => !v)}>
        <span className={`diff__badge diff__badge--${file.status}`}>{STATUS_LABEL[file.status]}</span>
        <span className="diff__path">{file.path}</span>
        <span className="diff__count">
          {file.binary ? "바이너리" : `+${added} −${removed}`}
        </span>
      </button>
      {open && !file.binary && (
        <div className="diff__hunks">
          {file.hunks.map((hunk, index) => (
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
 * The 저장 review: what changed, the repo's own gates, then a save the planner
 * explicitly approves. Nothing leaves the machine without a person clicking
 * 저장 here.
 */
export function DiffPanel({
  daemon,
  sessionId,
  onClose,
}: {
  daemon: Daemon;
  /** The live planning thread; a failed gate lands in it as Claude's next task. */
  sessionId: string | null;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const diffStatus = daemon.diffStatus;
  const running = diffStatus !== null && RUNNING.includes(diffStatus.stage);
  const published = diffStatus?.stage === "published";
  const failed = diffStatus?.stage === "failed";

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
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
      <div className="modal__panel modal__panel--diff" role="dialog" aria-modal="true" aria-label="저장 검토">
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
                published
                  ? "notice notice--info"
                  : failed
                    ? "notice notice--error"
                    : "diff__stage"
              }
            >
              <span className="notice__text">{stageLine(diffStatus)}</span>
              {running && <span className="spinner" />}
            </div>
          )}
          {failed && diffStatus?.detail && (
            <pre className="diff__fail">
              <code>{diffStatus.detail}</code>
            </pre>
          )}

          {files === null && !error && <p className="hint">변경사항을 읽어 오는 중…</p>}
          {files !== null && files.length === 0 && !published && (
            <p className="hint">저장할 변경사항이 없습니다. 먼저 화면을 만들거나 고쳐 주세요.</p>
          )}
          {files !== null && files.length > 0 && (
            <ul className="diff__files">
              {files.map((file) => (
                <FileRow key={file.path} file={file} />
              ))}
            </ul>
          )}

          {error && (
            <div className="notice notice--error">
              <span className="notice__text">{error}</span>
            </div>
          )}

          <label className="setting setting--wide">
            <span className="setting__text">
              <span className="setting__label">저장 메모</span>
              <span className="setting__hint">비워 두면 자동으로 채워집니다</span>
            </span>
            <span className="setting__control">
              <input
                value={message}
                placeholder="예: 회원 관리 화면 추가"
                aria-label="저장 메모"
                disabled={running}
                onChange={(e) => setMessage(e.target.value)}
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
