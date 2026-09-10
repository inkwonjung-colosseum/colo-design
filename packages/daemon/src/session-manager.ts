import { deleteSession, getSessionInfo, getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent, SessionSummary } from "@cds-design/protocol";
import { NEW_SESSION_TITLE, Session, type SessionEvents, type SessionOptions } from "./session.js";
import { replayHistory } from "./translate.js";

export class SessionManager {
  private readonly live = new Map<string, Session>();

  constructor(private readonly events: SessionEvents) {}

  create(options: SessionOptions): Session {
    const session = new Session(options, this.events);
    this.live.set(session.id, session);

    // A resumed or forked session should keep the name of the thread it came
    // from, otherwise it shows up in the list as an untitled new session until
    // the next message happens to rename it.
    if (options.resume) {
      void getSessionInfo(options.resume, { dir: options.cwd })
        .then((info) => {
          const inherited = info?.customTitle || info?.summary;
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
   * clone is exactly the session list.
   */
  async list(cwd: string, limit = 50): Promise<SessionSummary[]> {
    const onDisk = await listSessions({ dir: cwd, limit }).catch(() => []);
    const summaries = new Map<string, SessionSummary>();
    const untitled = "제목 없는 대화";

    for (const info of onDisk) {
      summaries.set(info.sessionId, {
        sessionId: info.sessionId,
        title: info.customTitle || info.summary || untitled,
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

  /** Stored transcript, already shaped as the events the UI renders. */
  async history(sessionId: string, cwd: string): Promise<ChatEvent[]> {
    const messages = await getSessionMessages(sessionId, { dir: cwd, limit: 1000 }).catch(() => []);
    return replayHistory(messages);
  }
}
