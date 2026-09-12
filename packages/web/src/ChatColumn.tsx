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
  onDeleteSession,
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
  /** The head's `···` → 지우기 (PLAN D76): the transcript goes for good, one
      unconditional confirm on the way. */
  onDeleteSession: (session: SessionSummary) => void;
}) {
  const { api, pending, resolvePending } = daemon;
  /** This thread's turn-start snapshots (PLAN D52), refetched when a turn ends. */
  const [checkpoints, setCheckpoints] = useState<Array<{ id: string; turn: number }>>([]);
  const [restoring, setRestoring] = useState(false);
  // 고쳐서 다시 보내기 (PLAN D95): the planner's own words return to the
  // composer for an edit; the nonce re-fires the seed on every click.
  const [seed, setSeed] = useState<{ text: string; nonce: number }>({ text: "", nonce: 0 });
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

  // The head's menu answers Escape like every menu in the app, and the
  // backdrop under it takes any click that misses the menu — the same rules
  // the composer's selector chips already keep.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // Checkpoints exist per completed turn (PLAN D52): refetch when a turn
  // settles or the thread changes, and offer the matching snapshot on each
  // answer. A failed fetch just leaves the buttons off.
  useEffect(() => {
    if (!activeId || sessions.running) return;
    let cancelled = false;
    void api
      .checkpoints()
      .then((list) => {
        if (!cancelled) {
          setCheckpoints(list.entries.filter((entry) => entry.sessionId === activeId));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeId, sessions.running, api]);

  const restoreCheckpoint = (id: string) => {
    if (restoring) return;
    setRestoring(true);
    void api
      .restoreCheckpoint(id)
      .then(() => api.checkpoints())
      .then((list) => {
        setCheckpoints(list.entries.filter((entry) => entry.sessionId === activeId));
        setRestoring(false);
      })
      .catch((e: Error) => {
        setRestoring(false);
        setError(e.message);
      });
  };
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
          {/* A turn in flight announces itself as light, not words: the lamp
              exists only while the daemon is streaming this thread's turn. */}
          {sessions.running && <span className="thread__lamp" aria-hidden />}
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
            <>
              <button type="button" className="selector__backdrop" aria-label="메뉴 닫기" onClick={() => setMenuOpen(false)} />
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
                  onDeleteSession(activeSummary);
                }}
              >
                <span className="selector__label">지우기</span>
              </button>
              </span>
            </>
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
            live={sessions.running || restoring}
            commands={daemon.repo?.commands}
            onRetry={(text) => void sessions.submit(text, [])}
            onRewind={(turn, text) => void sessions.rewindAnswer(turn, text)}
            onResendEdit={(text) => setSeed({ text, nonce: seed.nonce + 1 })}
            onStarter={(text) => setSeed({ text, nonce: seed.nonce + 1 })}
            checkpoints={checkpoints}
            onRestoreCheckpoint={restoreCheckpoint}
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
        onRefreshUsage={sessions.refreshUsage}
        selector={sessions.selector}
        commands={sessions.commands}
        onSetModel={(model) => void sessions.setModel(model)}
        onSetEffort={(effort) => void sessions.setEffort(effort)}
        onSetPermissionMode={(mode) => void sessions.setPermissionMode(mode)}
        running={sessions.running}
        queued={sessions.queued}
        seed={seed}
        sendKey={sendKey}
        onSend={(text, attachments) => sessions.submit(text, attachments)}
        onInterrupt={() => activeId && void api.interrupt(activeId)}
        onFindFiles={(query) => api.findFiles(query)}
      />
    </main>
  );
}

