import { useState } from "react";
import type { SessionSummary } from "@cds-design/protocol";
import { CloseIcon, PlusIcon } from "./icons";
import type { Sessions } from "./useSessions";

/**
 * A tab shows what the thread is about, not the whole first message: the
 * strip gets one line per thread, and a first turn written by the tool would
 * otherwise spend it on a sentence the planner never asked to read. The full
 * text stays one hover away in the button's title.
 */
function tabTitle(title: string): string {
  const text = title.trim();
  return text.length > 28 ? `${text.slice(0, 28)}…` : text;
}

/**
 * The session strip above the transcript: every thread of the one workspace,
 * plus the one way to start another.
 *
 * Presentational but for the rename: double-click or F2 trades a tab for an
 * input, and committing lands in 설정's store through `onRename` — the daemon
 * keeps its own summary, the planner's name rides on top. `onClose` lands in
 * `Sessions.remove`, which already asks before deleting; a second prompt
 * here would make the planner answer twice.
 */
export function SessionTabs({
  sessions,
  titleFor,
  onRename,
  onSelect,
  onCreate,
  onClose,
}: {
  sessions: Sessions;
  /** The name a thread wears: the planner's rename, else the daemon's summary. */
  titleFor: (session: SessionSummary) => string;
  onRename: (sessionId: string, title: string) => void;
  onSelect: (session: SessionSummary) => void;
  onCreate: () => void;
  onClose: (session: SessionSummary) => void;
}) {
  /** The tab being renamed, and the draft while it is — transient; the
      committed name lives in the settings store. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const beginRename = (session: SessionSummary) => {
    setRenaming(session.sessionId);
    setDraft(titleFor(session));
  };
  const commitRename = () => {
    const id = renaming;
    setRenaming(null);
    if (!id) return;
    const name = draft.trim();
    const session = sessions.list.find((s) => s.sessionId === id);
    if (!name || !session || titleFor(session) === name) return;
    onRename(id, name);
  };

  return (
    <div className="sessiontabs">
      {/* Each tab is an ordinary focusable button, like the header's 작업 탭:
          Tab walks the strip, Enter/Space opens. No roving tabindex, so the
          two conventions in the app do not disagree. */}
      <div className="sessiontabs__strip" role="tablist" aria-label="세션 탭">
        {sessions.list.map((session) => {
          const on = sessions.activeId === session.sessionId;
          const title = titleFor(session);
          return (
            <div key={session.sessionId} role="presentation" className="sessiontab-wrap">
              {renaming === session.sessionId ? (
                <input
                  className="sessiontab__rename"
                  value={draft}
                  autoFocus
                  aria-label="대화 이름"
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitRename();
                    if (event.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={on}
                    data-session-id={session.sessionId}
                    className={on ? "sessiontab sessiontab--on" : "sessiontab"}
                    title={title}
                    onClick={() => onSelect(session)}
                    onDoubleClick={() => beginRename(session)}
                    onKeyDown={(event) => {
                      if (event.key === "F2") {
                        event.preventDefault();
                        beginRename(session);
                      }
                    }}
                  >
                    <span className="sessiontab__title">{tabTitle(title)}</span>
                    {session.live && <span className="dot dot--live" />}
                    {/* Finished while the planner was elsewhere. A live dot that
                        just disappears reads the same as a thread that never
                        ran, and the whole point of the strip is that a turn can
                        keep going while another tab is open. */}
                    {!session.live && sessions.finished.includes(session.sessionId) && (
                      <span className="dot dot--done" title="답이 왔습니다" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="sessiontab__close"
                    aria-label={`${title} 삭제`}
                    title="대화 삭제 (대화 기록이 영구히 사라집니다)"
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(session);
                    }}
                  >
                    <CloseIcon size={9} />
                  </button>
                </>
              )}
            </div>
          );
        })}
        {sessions.list.length === 0 && <p className="hint">아래에서 새 대화를 시작해 주세요.</p>}
      </div>
      <span className="sessiontabs__spacer" />
      <button type="button" className="ghost" title="새 화면 대화를 시작합니다" onClick={onCreate}>
        <PlusIcon /> 새 대화
      </button>
    </div>
  );
}
