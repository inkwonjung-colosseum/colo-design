import { useCallback, useEffect, useRef, useState } from "react";
import type { Daemon, SaveHistoryEntry } from "../../lib/daemon-client";
import { timeAgo } from "../../lib/format";
import { CloseIcon, HistoryIcon } from "../icons";
import { RUNNING, stageLine } from "../panels/DiffPanel";

/**
 * 저장 기록: the saved commits of this cycle, and — per entry —
 * going back to that moment as a NEW commit. No reset, no force-push: a
 * developer may be reading the branch on the other side. The words are
 * `저장 기록 · 되돌리기`; commit and reset never surface.
 *
 * 도킹, 덮지 않는다. This surface's whole job is comparing "이 시점" against
 * "지금" — a centered modal froze the very thing being compared. So the
 * pane stands BESIDE the stage (`.previewcol__row`), and the live preview
 * yields width instead of vanishing. The rule is TalkSheet's: the native
 * view draws above every DOM layer, so docking (not overlaying) is what
 * shrinks the view's bounds honestly — the slot's ResizeObserver follows.
 *
 * 좁은 열의 폴백: when the row cannot hold stage + pane, the pane covers
 * the stage instead — `data-cover-stage` joins the cover convention
 * (cover-reconciler.ts), the stage freezes, and the pane reads like the
 * old modal minus the scrim. Escape answers only when the planner's
 * attention is inside the pane; a focus in the chat or the preview keeps
 * its own Escape.
 */
export function HistoryDrawer({
  open,
  onClose,
  daemon,
  cover = false,
}: {
  open: boolean;
  onClose: () => void;
  daemon: Daemon;
  /** 좁은 열 — 무대를 얼려 덮는다(나란히 놓을 폭이 없을 때의 폴백). */
  cover?: boolean;
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

  // A 되돌리기 moves the worktree — the list grows a new top row ("지금
  // 상태" moves), so it asks for one re-read. The bump rides the effect's
  // deps instead of a second fetch path: one reader, one loading grammar.
  const [readTick, setReadTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: readTick 은 되돌리기 뒤 같은 읽기를 다시 돌리는 손잡이다 — 이 효과 안에서 쓰이지 않는다.
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
  }, [open, api, readTick]);

  /** Opening hands focus to the pane, so a screen reader starts inside.
      Tab is NOT trapped — the dock is a neighbour, not a gate; the
      planner may reach the stage or the composer while it stands. */
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKeydown = (event: KeyboardEvent) => {
      if (!panelRef.current?.contains(document.activeElement)) return;
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [open, onClose]);

  const restore = useCallback(
    async (entry: SaveHistoryEntry) => {
      setError(null);
      setRestoring(entry.sha);
      try {
        const result = await daemon.api.restore(entry.sha);
        if (result.stage === "failed") {
          setError(result.detail ?? "되돌리지 못했습니다 — 잠시 후 다시 시도해 주세요.");
          return;
        }
        await daemon.api.repoStatus().catch(() => undefined);
        // 닫지 않는다 — the pane's point is watching the moved worktree
        // answer beside it. The chip and the save review read the new
        // state; the list re-reads and the accent dot names the row.
        setReadTick((tick) => tick + 1);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRestoring(null);
      }
    },
    [daemon.api],
  );

  if (!open) return null;

  return (
    <aside
      className={`histdock${cover ? " histdock--cover" : ""}`}
      aria-label="저장 기록"
      tabIndex={-1}
      ref={panelRef}
      {...(cover ? { "data-cover-stage": "" } : {})}
    >
      <header className="histdock__head">
        <h2 className="histdock__title">
          <span className="ic ic--quiet">
            <HistoryIcon />
          </span>{" "}
          저장 기록
        </h2>
        <button type="button" className="ghost" aria-label="저장 기록 닫기" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>

      <div className="histdock__body">
        <p className="hint">
          이 사이클의 저장 차례입니다. 되돌리기는 그 시점을 새 저장으로 얹습니다 — 지우지 않습니다.
        </p>
        {/* The stage line is for work IN flight — a 저장 or the 되돌리기 this
            pane started. A settled outcome (saved / handed off / failed)
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
            {entries.map((entry, index) => {
              /* git log 순서 — 첫 행이 최신. 최신은 되돌릴 곳이 아니라 지금
                 서 있는 곳이라 accent 점과 `지금 상태`가 말하고 버튼은 없다. */
              const now = index === 0;
              return (
                <li className={`diff__file${now ? " hist--now" : ""}`} key={entry.sha}>
                  <div className="diff__filerow">
                    <span className="diff__path" title={entry.message}>
                      {entry.message.split("\n")[0]}
                    </span>
                    <span className="diff__count">
                      {timeAgo(Date.parse(entry.at))} · 파일 {entry.files.length}개
                      {now ? " · 지금 상태" : ""}
                    </span>
                    {!now && (
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy || restoring !== null}
                        onClick={() => void restore(entry)}
                      >
                        {restoring === entry.sha ? "되돌리는 중…" : "이 시점으로 되돌리기"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {error && (
          <div className="notice notice--error">
            <span className="notice__text">{error}</span>
          </div>
        )}
      </div>
    </aside>
  );
}
