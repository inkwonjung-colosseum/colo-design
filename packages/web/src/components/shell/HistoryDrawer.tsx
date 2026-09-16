import { useEffect, useRef, useState } from "react";
import { useModalFocus } from "../../hooks/use-modal-focus";
import type { Daemon, SaveHistoryEntry } from "../../lib/daemon-client";
import { timeAgo } from "../../lib/format";
import { CloseIcon, HistoryIcon } from "../icons";
import { RUNNING, stageLine } from "../panels/DiffPanel";
import { Tip } from "./Tip";

/**
 * 저장 기록: the saved commits of this cycle, and — per entry —
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
  // The STABLE api object, not the daemon prop: the client hands out a fresh
  // wrapper every render, and with the prop in these deps every websocket
  // message while the drawer is open re-read the whole history — the list
  // collapsing back to "읽어 오는 중…" each time.
  const { api } = daemon;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setEntries(null);
    setError(null);
    api
      .saveHistory()
      .then((next) => !cancelled && setEntries(next.entries))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [open, api]);

  useEffect(() => {
    if (!open) return;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [open, onClose]);

  /** Opening hands focus to the panel, so Tab and a screen reader start inside. */
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef, open);
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  /** 새 커밋으로 되돌린다 — then the chip and the save review read the moved worktree.
   *
   * A refused restore does NOT throw: the call resolves with a failed
   * DiffStatus (실사 결함 — the drawer used to close on it, so the
   * "저장하지 않은 변경이 있습니다" refusal never reached the planner). */
  const restore = async (entry: SaveHistoryEntry) => {
    setError(null);
    setRestoring(entry.sha);
    try {
      const result = await daemon.api.restore(entry.sha);
      if (result.stage === "failed") {
        setError(result.detail ?? "되돌리지 못했습니다 — 잠시 후 다시 시도해 주세요.");
        return;
      }
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
          <h2 className="modal__title">
            <span className="ic ic--quiet">
              <HistoryIcon />
            </span>{" "}
            저장 기록
          </h2>
          <Tip label="저장 기록 닫기" side="left">
            <button type="button" className="ghost" aria-label="저장 기록 닫기" onClick={onClose}>
              <CloseIcon />
            </button>
          </Tip>
        </header>

        <div className="modal__body">
          {/* The stage line is for work IN flight — a 저장 or the 되돌리기 this
              drawer started. A settled outcome (saved / handed off / failed)
              already told its story in the flow that produced it; repeating it
              here made every later visit to the history open on an old
              "넘기기에서 멈췄습니다" nobody was asking about. */}
          {busy && diffStatus && (
            <div className="diff__stage">
              <span className="notice__text">{stageLine(diffStatus)}</span>
              <span className="spinner" />
            </div>
          )}

          {entries === null && !error && <p className="hint">기록을 읽어 오는 중…</p>}
          {entries !== null && entries.length === 0 && (
            <p className="hint">
              <span className="ic ic--lg">
                <HistoryIcon />
              </span>{" "}
              아직 저장한 것이 없습니다. 저장하면 여기에 쌓입니다.
            </p>
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
