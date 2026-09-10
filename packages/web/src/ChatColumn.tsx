import { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "@cds-design/protocol";
import type { Daemon } from "./daemon-client";
import type { Sessions } from "./useSessions";
import { PermissionCard, QuestionCard, Transcript } from "./components";
import { ChevronDownIcon } from "./icons";
import { Composer } from "./Composer";
import type { SendKey } from "./settings";

/**
 * The middle column: one transcript, the cards that interrupt it, and the
 * composer under it. Everything about the session arrives as one `Sessions`.
 */
export function ChatColumn({
  daemon,
  sessions,
  sendKey,
  placeholder,
  disabled,
  titleFor,
  onRenameSession,
  onArchiveSession,
}: {
  daemon: Daemon;
  sessions: Sessions;
  sendKey: SendKey;
  placeholder: string;
  disabled: boolean;
  /** The name a thread wears: the planner's rename, else the daemon's summary. */
  titleFor: (session: SessionSummary) => string;
  /** 더블클릭 · F2 이름 바꾸기 (PLAN D59) — 설정's store keeps it. */
  onRenameSession: (sessionId: string, title: string) => void;
  /** The head's `···` → 보관 (PLAN D54): the thread leaves the list. */
  onArchiveSession: (session: SessionSummary) => void;
}) {
  const { api, pending, resolvePending } = daemon;
  const bottom = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLElement>(null);
  const { active, activeId, error, setError } = sessions;
  const visiblePending = pending.filter((request) => request.sessionId === activeId);
  /** Whether the newest message is what the planner is looking at. */
  const pinned = useRef(true);
  /** Mirror of `pinned` for rendering — the pill is the scrolled-up reader's way back. */
  const [unpinned, setUnpinned] = useState(false);
  /** The head's `···` menu, and the rename it can open (PLAN D59). */
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  /** The open thread's summary — the head renders only when one is open. */
  const activeSummary = activeId
    ? (sessions.list.find((session) => session.sessionId === activeId) ?? null)
    : null;
  const beginRename = () => {
    if (!activeSummary) return;
    setMenuOpen(false);
    setDraft(titleFor(activeSummary));
    setRenaming(true);
  };
  const commitRename = () => {
    setRenaming(false);
    if (!activeSummary) return;
    const name = draft.trim();
    if (!name || titleFor(activeSummary) === name) return;
    onRenameSession(activeSummary.sessionId, name);
  };

  // Within one row of the bottom counts as watching the stream come in.
  const rememberPin = () => {
    const el = scroll.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    pinned.current = atBottom;
    setUnpinned(!atBottom);
  };

  // Deltas fold into the last block without changing its count, so keying on
  // the length lets a long answer stream in below the fold — the exact case
  // this follow exists for. The blocks array itself changes on every event;
  // the scroll is instant because a tail that animates keeps losing the
  // race against its own deltas.
  useEffect(() => {
    if (pinned.current) bottom.current?.scrollIntoView();
  }, [active?.blocks]);

  // A reader who scrolled up owns the scroll position; the transcript takes
  // it back only when they return to the bottom. Opening another thread is
  // a fresh look — its newest message is where a reader starts.
  useEffect(() => {
    pinned.current = true;
    setUnpinned(false);
  }, [activeId]);
  // The pill jumps instantly, like the follow: an animated tail would race
  // the very deltas it is trying to catch up on.
  const jumpToLatest = () => {
    pinned.current = true;
    setUnpinned(false);
    bottom.current?.scrollIntoView();
  };
  return (
    <main className="planner__chat">
      {activeSummary && (
        <header className="thread">
          {renaming ? (
            <input
              className="thread__rename"
              value={draft}
              autoFocus
              aria-label="대화 이름"
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitRename();
                if (event.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <button
              type="button"
              className="thread__title"
              title={titleFor(activeSummary)}
              onDoubleClick={beginRename}
              onKeyDown={(event) => {
                if (event.key === "F2") {
                  event.preventDefault();
                  beginRename();
                }
              }}
            >
              {titleFor(activeSummary)}
            </button>
          )}
          {/* 이 대화가 만든 화면 칩 (D59) waits for the data: nothing on the
              wire says which screens a thread made. Title and menu ship. */}
          <span className="thread__spacer" />
          <button
            type="button"
            className="ghost thread__more"
            aria-label="대화 메뉴"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            ···
          </button>
          {menuOpen && (
            <span className="selector__menu thread__menu" role="menu">
              <button type="button" role="menuitem" className="selector__row" onClick={beginRename}>
                <span className="selector__label">이름 바꾸기</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="selector__row"
                onClick={() => {
                  setMenuOpen(false);
                  onArchiveSession(activeSummary);
                }}
              >
                <span className="selector__label">보관</span>
              </button>
            </span>
          )}
        </header>
      )}
      <div className="chatstack">
        <section className="scroll" ref={scroll} onScroll={rememberPin}>
          {error && (
            <div className="notice notice--error">
              <span className="notice__text">{error}</span>
              <button
                type="button"
                className="notice__close"
                aria-label="오류 닫기"
                onClick={() => setError(null)}
              >
                ×
              </button>
            </div>
          )}
          <Transcript
            blocks={active?.blocks ?? []}
            live={sessions.running}
            commands={daemon.repo?.commands}
            onRetry={(text) => void sessions.submit(text, [])}
          />
        {/* A turn's first seconds: the tape holds only the planner's words,
            so the start says itself — spinner + shimmer until blocks land.
            The tape speaks for itself the moment any Claude block exists. */}
        {sessions.running && !(active?.blocks ?? []).some((block) => block.type !== "user") && (
          <div className="turnlive">
            <span className="spinner" />
            작업 중…
          </div>
        )}
          {visiblePending.map((request) =>
            request.kind === "permission" ? (
              <PermissionCard
                key={request.requestId}
                request={request}
                onRespond={(decision, message) => {
                  void api.respondPermission(request.requestId, decision, message);
                  resolvePending(request.requestId);
                }}
              />
            ) : (
              <QuestionCard
                key={request.requestId}
                request={request}
                onRespond={(answers) => {
                  void api.respondQuestion(request.requestId, answers);
                  resolvePending(request.requestId);
                }}
              />
            ),
          )}
          <div ref={bottom} />
        </section>
        {/* The scrolled-up reader's way back. It floats here, outside the
            scrolling element — inside it, it would drift away with the very
            content it covers. While a turn streams, the pill names what keeps
            landing below the fold instead of pointing at a place. */}
        {unpinned && (
          <button
            type="button"
            className={sessions.running ? "chatstack__pill chatstack__pill--live" : "chatstack__pill"}
            onClick={jumpToLatest}
          >
            {sessions.running ? "새 내용" : "맨 아래로"}
            <ChevronDownIcon />
          </button>
        )}
      </div>

      <Composer
        disabled={disabled}
        draftKey={sessions.activeId ?? `new:${daemon.activeSlug ?? "none"}`}
        placeholder={placeholder}
        usage={sessions.usage}
        plan={daemon.status?.planUsage ?? null}
        quickActions={daemon.status?.quickActions ?? null}
        selector={sessions.selector}
        commands={sessions.commands}
        onSetModel={(model) => void sessions.setModel(model)}
        onSetEffort={(effort) => void sessions.setEffort(effort)}
        onSetPermissionMode={(mode) => void sessions.setPermissionMode(mode)}
        running={sessions.running}
        sendKey={sendKey}
        onSend={(text, attachments) => sessions.submit(text, attachments)}
        onInterrupt={() => activeId && void api.interrupt(activeId)}
        onFindFiles={(query) => api.findFiles(query)}
      />
    </main>
  );
}

