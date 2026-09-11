import { deleteSession, getSessionInfo, getSessionMessages, listSessions, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent, SessionSummary, ThreadSummary } from "@cds-design/protocol";
import { NEW_SESSION_TITLE, Session, type SessionEvents, type SessionOptions } from "./session.js";
import { replayHistory } from "./translate.js";

/**
 * A transcript's summary can be the conversation's own first line — and the
 * tool's machine-authored turns open with the `<!-- cds-design:… -->` marker
 * (protocol turn-marker), so without this the raw marker leaks into the tree
 * and the palette as a conversation name. Marker lines are dropped, the first
 * human line wins, and whatever survives is collapsed to one clean line.
 */
function presentableTitle(summary: string | undefined | null): string {
  if (!summary) return "";
  const human = summary
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("<!--"));
  return (human ?? "").replace(/\s+/g, " ").trim();
}

export class SessionManager {
  private readonly live = new Map<string, Session>();
  /**
   * Session ids whose last state change was a turn ending (PLAN D59): the
   * tree's `답이 왔습니다`. A send clears the mark, a turn's end sets it —
   * so a live thread sitting idle after its answer reads as finished while
   * one nobody has spoken to since launch reads as idle. Closing a thread
   * takes the mark with it: the planner ended that conversation on purpose.
   */
  private readonly settledTurns = new Set<string>();
  /**
   * The per-clone thread cache (PLAN D59). The sidebar tree shows every
   * project's conversations at once, but `projectSummaries()` is a
   * synchronous read — so the answers of the SDK scan (`listSessions`) are
   * kept per clone and re-served until a session event marks the clone
   * stale. `disk` is the scan itself (shared with `list`), `threads` the
   * merged, tree-shaped result a summary can read synchronously.
   */
  private readonly disk = new Map<string, SDKSessionInfo[]>();
  private readonly diskStale = new Set<string>();
  private readonly threadCache = new Map<string, ThreadSummary[]>();
  private readonly events: SessionEvents;

  constructor(events: SessionEvents) {
    this.events = {
      ...events,
      onState: (sessionId, state, detail) => {
        if (state === "running" || state === "starting") this.settledTurns.delete(sessionId);
        else if (state !== "waiting_permission" && state !== "waiting_question") {
          this.settledTurns.add(sessionId);
        }
        events.onState(sessionId, state, detail);
      },
    };
  }

  create(options: SessionOptions): Session {
    const session = new Session(options, this.events);
    this.live.set(session.id, session);

    // A resumed or forked session should keep the name of the thread it came
    // from, otherwise it shows up in the list as an untitled new session until
    // the next message happens to rename it.
    if (options.resume) {
      void getSessionInfo(options.resume, { dir: options.cwd })
        .then((info) => {
          const inherited = info?.customTitle || presentableTitle(info?.summary);
          const untouched = session.title === NEW_SESSION_TITLE;
          if (inherited && untouched) session.title = inherited;
        })
        .catch(() => undefined);
    }

    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.live.get(sessionId);
  }

  /**
   * Every session this daemon is currently running. A live thread has no
   * transcript on disk until its first turn lands, so anything reconciling
   * against stored sessions has to count these too or it will forget a thread
   * that was created seconds ago.
   */
  all(): Iterable<Session> {
    return this.live.values();
  }

  require(sessionId: string): Session {
    const session = this.live.get(sessionId);
    if (!session) throw new Error(`no live session ${sessionId}`);
    return session;
  }

  /** Find whichever live session is holding a given pending approval. */
  findByRequest(requestId: string): Session | undefined {
    for (const session of this.live.values()) {
      if (session.hasPending(requestId)) return session;
    }
    return undefined;
  }

  async close(sessionId: string): Promise<void> {
    const session = this.live.get(sessionId);
    if (!session) return;
    await session.close();
    this.live.delete(sessionId);
    this.settledTurns.delete(sessionId);
  }

  /**
   * Close the live query, if any, and permanently delete the stored
   * transcript. Throws when the local store has no such session.
   * transcript. Throws when the local store has no such session.
   */
  async remove(sessionId: string, cwd: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (live) await this.close(sessionId);
    try {
      await deleteSession(sessionId, { dir: cwd });
    } catch (error) {
      // A live session that never sent a message wrote no transcript, so
      // closing it above already removed every trace.
      if (live) return;
      const stored = await listSessions({ dir: cwd, limit: 200 }).catch(() => []);
      // Deleting an id the store has already forgotten is a no-op, not a
      // failure — this also covers phantom rows left over from a daemon
      // restart. A real store error still surfaces.
      if (!stored.some((s) => s.sessionId === sessionId)) return;
      throw error;
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.close(id)));
  }

  get liveCount(): number {
    return this.live.size;
  }

  /** A Claude turn is running in this clone right now — the sidebar's 작업 중 (PLAN D15). */
  anyRunning(cwd: string): boolean {
    for (const session of this.live.values()) {
      if (session.cwd === cwd && session.state === "running") return true;
    }
    return false;
  }

  /** Closes every live session rooted at a clone — a removed project's threads (PLAN D21). */
  async closeWhere(cwd: string): Promise<void> {
    const ids = [...this.live.values()].filter((session) => session.cwd === cwd).map((s) => s.id);
    await Promise.all(ids.map((id) => this.close(id)));
  }

  get pendingCount(): number {
    let total = 0;
    for (const session of this.live.values()) total += session.pendingCount;
    return total;
  }

  /**
   * Merge sessions this daemon is running with transcripts already on disk, so
   * conversations started in the terminal show up in the UI and can be resumed.
   * The SDK stores transcripts per directory, so the active project's repo
   * clone is exactly the session list. The disk half is the per-clone cache
   * (PLAN D59) — the scan is what `projectSummaries` cannot afford per
   * announce, so it runs once and again only after a session event marks the
   * clone stale. The live half merges fresh on every read, so states and
   * titles are never served stale.
   */
  async list(cwd: string, limit = 50): Promise<SessionSummary[]> {
    let onDisk = this.disk.get(cwd);
    if (!onDisk || this.diskStale.has(cwd)) {
      onDisk = await listSessions({ dir: cwd, limit }).catch(() => []);
      this.disk.set(cwd, onDisk);
      this.diskStale.delete(cwd);
    }
    const summaries = new Map<string, SessionSummary>();
    const untitled = "제목 없는 대화";

    for (const info of onDisk) {
      summaries.set(info.sessionId, {
        sessionId: info.sessionId,
        title: info.customTitle || presentableTitle(info.summary) || untitled,
        lastModified: info.lastModified,
        live: false,
        state: "closed",
      });
    }

    for (const session of this.live.values()) {
      // A session of another project must not surface here: its transcript
      // and its turns belong to a different clone, and listing it let a tab
      // from the previous project survive a project switch.
      if (session.cwd !== cwd) continue;
      const stored = summaries.get(session.id);
      // Prefer the transcript's own summary. Claude Code keeps it current as the
      // conversation moves, so using it for live and stored sessions alike stops
      // a session from being labelled one way while open and another once closed.
      const title = stored && stored.title !== untitled ? stored.title : session.title;
      summaries.set(session.id, {
        sessionId: session.id,
        title,
        lastModified: session.lastActivity,
        live: true,
        state: session.state,
      });
    }

    return [...summaries.values()].sort((a, b) => b.lastModified - a.lastModified);
  }

  /**
   * One clone's conversations, tree-shaped (PLAN D59). The session state maps
   * onto the four words a child row draws: a turn on → `running`; a permission
   * or question up → `awaiting`; a turn that ended with nothing after it →
   * `finished`; everything else — old stored threads mostly — `idle`.
   */
  async refreshThreads(cwd: string, limit = 50): Promise<ThreadSummary[]> {
    const threads = (await this.list(cwd, limit)).map((summary): ThreadSummary => {
      const state: ThreadSummary["state"] =
        summary.state === "running" || summary.state === "starting"
          ? "running"
          : summary.state === "waiting_permission" || summary.state === "waiting_question"
            ? "awaiting"
            : summary.live && this.settledTurns.has(summary.sessionId)
              ? "finished"
              : "idle";
      return {
        id: summary.sessionId,
        title: summary.title,
        state,
        updatedAt: new Date(summary.lastModified).toISOString(),
      };
    });
    this.threadCache.set(cwd, threads);
    return threads;
  }

  /** The last computed threads of a clone, for the synchronous summaries.
   * Null until the first scan ran; the field stays omitted on the wire so
   * "never looked" cannot read as "no conversations". */
  cachedThreads(cwd: string): ThreadSummary[] | null {
    return this.threadCache.get(cwd) ?? null;
  }

  /**
   * A session event landed in this clone (created, closed, deleted, or a
   * turn changed state) — the next refresh rescans it. What is already
   * computed keeps flowing: dropping it would blink the tree blank between
   * the event and the rescan.
   */
  invalidateThreads(cwd: string): void {
    this.diskStale.add(cwd);
  }

  /** Stored transcript, already shaped as the events the UI renders. */
  async history(sessionId: string, cwd: string): Promise<ChatEvent[]> {
    const messages = await getSessionMessages(sessionId, { dir: cwd, limit: 1000 }).catch(() => []);
    return replayHistory(messages);
  }
}
