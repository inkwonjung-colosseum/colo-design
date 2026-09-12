import { useEffect, useRef, useState } from "react";
import type { Daemon, SaveHistoryEntry } from "./daemon-client";
import { RUNNING, stageLine } from "./DiffPanel";
import { timeAgo } from "./format";
import { CloseIcon } from "./icons";

/**
 * 저장 기록 (PLAN D53): the saved commits of this cycle, and — per entry —
 * going back to that moment as a NEW commit. No reset, no force-push: a
 * developer may be reading the branch on the other side. The words are
 * `저장 기록 · 되돌리기`; commit and reset never surface.
 */
export function HistoryDrawer({
  open,
  onClose,
  daemon,
}: {
  open: boolean;
  onClose: () => void;
  daemon: Daemon;
}) {
  const [entries, setEntries] = useState<SaveHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const diffStatus = daemon.diffStatus;
  // A 저장 or 넘기기 owns the worktree; a 되돌리기 streams on the same
  // `diff.status` channel, so the two can never race.
  const busy = diffStatus !== null && RUNNING.includes(diffStatus.stage);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setEntries(null);
    setError(null);
    daemon.api
      .saveHistory()
      .then((next) => !cancelled && setEntries(next.entries))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [open, daemon]);

  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, onClose]);

  /** Opening hands focus to the panel, so Tab and a screen reader start inside. */
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  /** 새 커밋으로 되돌린다 (PLAN D53) — then the chip and the save review read the moved worktree. */
  const restore = async (entry: SaveHistoryEntry) => {
    setError(null);
    setRestoring(entry.sha);
    try {
      await daemon.api.restore(entry.sha);
      await daemon.api.repoStatus().catch(() => undefined);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal__panel modal__panel--diff"
        role="dialog"
        aria-modal="true"
        aria-label="저장 기록"
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="modal__head">
          <h2 className="modal__title">저장 기록</h2>
          <button type="button" className="ghost" aria-label="저장 기록 닫기" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <div className="modal__body">
          {diffStatus && (
            <div className={diffStatus?.stage === "failed" ? "notice notice--error" : "diff__stage"}>
              <span className="notice__text">{stageLine(diffStatus)}</span>
              {busy && <span className="spinner" />}
            </div>
          )}

          {entries === null && !error && <p className="hint">기록을 읽어 오는 중…</p>}
          {entries !== null && entries.length === 0 && (
            <p className="hint">아직 저장한 것이 없습니다. 저장하면 여기에 쌓입니다.</p>
          )}
          {entries !== null && entries.length > 0 && (
            <ul className="diff__files">
              {entries.map((entry) => (
                <li className="diff__file" key={entry.sha}>
                  <div className="diff__filerow">
                    <span className="diff__path" title={entry.message}>
                      {entry.message.split("\n")[0]}
                    </span>
                    <span className="diff__count">
                      {timeAgo(Date.parse(entry.at))} · 파일 {entry.files.length}개
                    </span>
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy || restoring !== null}
                      onClick={() => void restore(entry)}
                    >
                      {restoring === entry.sha ? "되돌리는 중…" : "이 시점으로 되돌리기"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {error && (
            <div className="notice notice--error">
              <span className="notice__text">{error}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

