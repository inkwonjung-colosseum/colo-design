import { randomUUID } from "node:crypto";
import type { ChatEvent, SessionSummary, ThreadCycle, ThreadSummary } from "@colo-design/protocol";
import type { AgentDriver, ImportableSession } from "./agent/driver.js";
import type { DriverRegistry } from "./agent/registry.js";
import type { BrowserMcpEntry } from "./browser-launch.js";
import { NEW_SESSION_TITLE, Session, type SessionEvents, type SessionOptions } from "./session.js";

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
   * synchronous read — so the answers of the driver's store scan
   * (`listStored`) are kept per clone and re-served until a session event
   * marks the clone stale. `disk` is the scan itself (shared with `list`),
   * `threads` the merged, tree-shaped result a summary can read
   * synchronously.
   */
  private readonly disk = new Map<
    string,
    Array<{ id: string; title: string; lastModified: number; provider?: string }>
  >();
  private readonly diskStale = new Set<string>();
  private readonly threadCache = new Map<string, ThreadSummary[]>();
  /**
   * 스캔 겸침 (SCAN COALESCE): a session event marks the clone stale on every
   * turn edge, and a store sweep is not free — the codex rollout walk reads a
   * store that grows for years, and the opencode list spawns a CLI. Callers
   * arriving while one scan is in flight await the same promise instead of
   * stacking another identical sweep behind it. The entry carries the scan's
   * generation (scanEpoch): a removeWhere bumps the generation and drops the
   * entry, so nobody joins a scan whose answer is already deleted rows.
   */
  private readonly scanning = new Map<
    string,
    { epoch: number; scan: Promise<ImportableSession[]> }
  >();
  /**
   * 스캔 세대 (SCAN EPOCH): `removeWhere` 가 저장을 쓸어 버린 뒤에도 그 클론의
   * 스캔이 도는 중이었다면, 그 결과는 이미 지워진 대화를 `disk` 에 되살린다 —
   * 지웠는데 나무에 행이 남아 있는 최악의 그림. 지워질 때 세대를 올리고,
   * 스캔의 되돌아온 결과는 세대가 같을 때만 캐시에 적는다.
   */
  private readonly scanEpoch = new Map<string, number>();
  /**
   * Which provider's store a stored session id lives in — filled by every
   * `list` scan so history/resume/delete route to the right driver without
   * rescanning every store.
   */
  private readonly storedProvider = new Map<string, string>();
  private readonly events: SessionEvents;
  private readonly drivers: DriverRegistry;

  constructor(
    events: SessionEvents,
    drivers: DriverRegistry,
    /**
     * 세션별 브라우저 MCP 기동 명세를 만드는 훅(3단계). DaemonServer가
     * browserDriverFactory 주입 여부·시크릿 발급·바인딩 포트를 알고 있으므로
     * 클로저로 받는다 — 미주입 host(브라우저 개발 경로)에서는 undefined.
     */
    private readonly browserMcpFor?: (sessionId: string) => BrowserMcpEntry | null,
    /**
     * createSession 이 던졌을 때 발급된 시크릿을 회수하는 훅 — 세션이
     * 못 열렸는데 시크릿이 맵에 남으면 닫힌 세션의 자격이 살아남는다.
     */
    private readonly browserMcpRevoke?: (sessionId: string) => void,
  ) {
    this.drivers = drivers;
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

  /** The provider a session id belongs to — live sessions carry it; stored ones are looked up. */
  private driverFor(provider: string | undefined): AgentDriver {
    return this.drivers.require(provider ?? "claude");
  }
  /** The provider a stored session id belongs to, from the last list scan. */
  storedProviderOf(sessionId: string): string | undefined {
    return this.storedProvider.get(sessionId);
  }

  /**
   * Which provider's store holds a session id — the scan's answer first,
   * then a targeted sweep of every driver's store for an id no list has
   * surfaced yet (a resume that arrives before the first scan).
   */
  async findStoredProvider(sessionId: string, cwd: string): Promise<string | undefined> {
    const known = this.storedProvider.get(sessionId);
    if (known) return known;
    for (const driver of this.drivers.all()) {
      // A targeted `has` answers without the list's recency cap — a resume
      // must find a thread no scan has surfaced, however old it is.
      const found = driver.store?.has
        ? await driver.store.has(sessionId, cwd).catch(() => false)
        : (await driver.store?.list(cwd, 200).catch(() => []))?.some((s) => s.id === sessionId);
      if (found) {
        this.storedProvider.set(sessionId, driver.id);
        return driver.id;
      }
    }
    return undefined;
  }

  create(options: SessionOptions): Session {
    const driver = this.driverFor(options.provider);
    const descriptor = driver.describe();
    const session = new Session(
      {
        ...options,
        provider: driver.id,
        providerLabel: descriptor.label,
        planModeId: descriptor.capabilities.planMode,
        defaultModeId: descriptor.defaultModeId || "default",
      },
      this.events,
    );
    const launch = {
      cwd: session.cwd,
      sessionId: session.id,
      model: options.launch?.model ?? null,
      modeId: driver.describe().defaultModeId,
      effort: options.launch?.effort ?? null,
      appendSystemPrompt: options.launch?.appendSystemPrompt ?? null,
      ...options.launch,
      // 브라우저 도구 명세는 데몬이 세션별 시크릿과 함께 발급한다 — 호출자가
      // options.launch로 넣은 값이 있어도 덮는다(시크릿은 세션 소유).
      browserMcp: this.browserMcpFor?.(session.id) ?? undefined,
    };
    try {
      session.attach(driver.createSession(launch, session.driverHooks));
    } catch (error) {
      this.browserMcpRevoke?.(session.id);
      throw error;
    }
    this.live.set(session.id, session);

    // A resumed or forked session should keep the name of the thread it came
    // from, otherwise it shows up in the list as an untitled new session until
    // the next message happens to rename it.
    if (options.launch?.resume) {
      void driver.store
        ?.title?.(options.launch.resume, session.cwd)
        .then((inherited) => {
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
    // The id never reaches the planner's words — a closed thread is news, an
    // uuid is not.
    if (!session) throw new Error("대화가 이미 닫혔습니다 — 목록에서 다시 열면 이어갑니다.");
    return session;
  }

  /** Find whichever live session is holding a given pending approval. */
  findByRequest(requestId: string): Session | undefined {
    for (const session of this.live.values()) {
      if (session.hasPending(requestId)) return session;
    }
    return undefined;
  }

  async close(sessionId: string, reason: "user" | "shutdown" = "user"): Promise<void> {
    const session = this.live.get(sessionId);
    if (!session) return;
    await session.close(reason);
    this.live.delete(sessionId);
    this.settledTurns.delete(sessionId);
  }

  /**
   * Close the live query, if any, and permanently delete the stored
   * transcript. Throws when the local store has no such session.
   */
  async remove(sessionId: string, cwd: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (live) await this.close(sessionId);
    const provider = live?.provider ?? (await this.findStoredProvider(sessionId, cwd));
    this.storedProvider.delete(sessionId);
    if (provider === undefined) {
      // The id belongs to no store we know — sweep every driver's delete so
      // a phantom row still dies; a store that never held it no-ops.
      await Promise.all(
        this.drivers
          .all()
          .map((driver) => driver.store?.delete?.(sessionId, cwd).catch(() => undefined)),
      );
      return;
    }
    const driver = this.driverFor(provider);
    try {
      await driver.store?.delete?.(sessionId, cwd);
    } catch (error) {
      // A live session that never sent a message wrote no transcript, so
      // closing it above already removed every trace.
      if (live) return;
      const stored = await driver.store?.list(cwd, 200).catch(() => []);
      // Deleting an id the store has already forgotten is a no-op, not a
      // failure — this also covers phantom rows left over from a daemon
      // restart. A real store error still surfaces.
      if (!stored?.some((s) => s.id === sessionId)) return;
      throw error;
    }
  }

  async closeAll(): Promise<void> {
    // A daemon-wide stop is not the planner closing threads: the wait rooms
    // stay on disk and come back as the lost room after a restart.
    await Promise.all([...this.live.keys()].map((id) => this.close(id, "shutdown")));
  }

  get liveCount(): number {
    return this.live.size;
  }

  /**
   * A turn is running, or an answer is waited on, in ANY project (리뷰 B3).
   * The desktop's close guard reads it before quitting under the work —
   * quitting resolves pending prompts as denies and the turn dies silently.
   */
  anyBusy(): boolean {
    for (const session of this.live.values()) {
      if (
        session.state === "running" ||
        session.state === "starting" ||
        session.state === "waiting_permission" ||
        session.state === "waiting_question"
      ) {
        return true;
      }
    }
    return false;
  }

  /** A turn is running in this clone right now — the sidebar's 작업 중 (PLAN D15). */
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

  /**
   * A removed project's conversations go with its folder (PLAN D77). The
   * transcript store is keyed by the clone's path, so once the folder is
   * gone nothing can render these again — and a same-named re-add of the
   * repo would resurrect dead threads against an empty worktree. A session
   * that never sent a message wrote no transcript, and a store that has
   * already forgotten an id is a no-op, not a failure.
   */
  async removeWhere(cwd: string): Promise<void> {
    await this.closeWhere(cwd);
    // Every registered driver's store gets a sweep — a clone may hold
    // transcripts from more than one provider. `deleteAll` drops the clone's
    // whole store dir where the vendor keys by cwd; the list+delete fallback
    // stays for stores that cannot. All drivers run together — a slow store
    // must not serialize the rest behind it.
    await Promise.all(
      this.drivers.all().map(async (driver) => {
        if (driver.store?.deleteAll) {
          // A stale cache entry is harmless: `findStoredProvider` re-verifies
          // with `has` before a resume trusts it.
          await driver.store.deleteAll(cwd).catch(() => undefined);
          return;
        }
        const stored = await driver.store?.list(cwd, 200).catch(() => []);
        await Promise.all(
          (stored ?? []).map((info) => {
            this.storedProvider.delete(info.id);
            return driver.store?.delete?.(info.id, cwd).catch(() => undefined);
          }),
        );
      }),
    );
    this.disk.delete(cwd);
    this.diskStale.delete(cwd);
    // The tree-shaped cache dies with the store: a summary reading between
    // the sweep and the next refresh must not serve deleted rows as threads.
    this.threadCache.delete(cwd);
    // A sweep mid-scan must not let the in-flight result re-arm the cache
    // with the rows this sweep just deleted — see scanEpoch. Dropping the
    // entry also stops later callers from joining the poisoned scan.
    this.scanEpoch.set(cwd, (this.scanEpoch.get(cwd) ?? 0) + 1);
    this.scanning.delete(cwd);
  }

  get pendingCount(): number {
    let total = 0;
    for (const session of this.live.values()) total += session.pendingCount;
    return total;
  }

  /**
   * Every pending request across the live sessions, in wire shape (리뷰 B1).
   * `attach` hands these to a RECONNECTING socket only — the broadcast would
   * double the cards every already-connected window is showing.
   */
  pendingReplays(): ReturnType<Session["pendingReplays"]> {
    return [...this.live.values()].flatMap((session) => session.pendingReplays());
  }

  /**
   * Merge sessions this daemon is running with transcripts already on disk, so
   * conversations started in the terminal show up in the UI and can be resumed.
   * The store is keyed by directory, so the active project's repo clone is
   * exactly the session list. The disk half is the per-clone cache (PLAN D59)
   * — the scan is what `projectSummaries` cannot afford per announce, so it
   * runs once and again only after a session event marks the clone stale.
   * The live half merges fresh on every read, so states and titles are never
   * served stale.
   */
  async list(cwd: string, limit = 50): Promise<SessionSummary[]> {
    let onDisk = this.disk.get(cwd);
    if (!onDisk || this.diskStale.has(cwd)) {
      // A failed scan is not an empty machine: swallowing it here cached "no
      // conversations" until some session event happened to invalidate it —
      // the planner's sidebar went blank (or stale) for no visible reason.
      // Failure keeps the previous answer and the staleness marker, so the
      // next call rescans instead of trusting the accident.
      // Every registered driver's store contributes — a clone may hold
      // threads from more than one provider. Concurrent readers share one
      // in-flight scan (this.scanning) instead of each stacking a sweep.
      let entry = this.scanning.get(cwd);
      const epoch = this.scanEpoch.get(cwd) ?? 0;
      if (!entry || entry.epoch !== epoch) {
        // The epoch snapshot must precede the sweep: a removeWhere that lands
        // mid-scan bumps the generation and this result then writes nothing.
        const scanEpoch = epoch;
        const scan = Promise.all(
          this.drivers.all().map((driver) => driver.store?.list(cwd, limit).catch(() => []) ?? []),
        ).then((groups) => {
          const rows = groups.flat();
          if ((this.scanEpoch.get(cwd) ?? 0) === scanEpoch) {
            this.disk.set(cwd, rows);
            this.diskStale.delete(cwd);
          }
          return rows;
        });
        scan.catch(() => undefined); // a rejected scan must not stay attached
        entry = { epoch: scanEpoch, scan };
        this.scanning.set(cwd, entry);
      }
      const scanned = await entry.scan;
      if (scanned.length > 0 || onDisk === undefined) {
        onDisk = scanned;
      } else {
        onDisk = onDisk ?? [];
      }
    }
    const summaries = new Map<string, SessionSummary>();
    const untitled = "제목 없는 대화";

    for (const info of onDisk) {
      if (info.provider) this.storedProvider.set(info.id, info.provider);
      summaries.set(info.id, {
        sessionId: info.id,
        title: info.title || untitled,
        lastModified: info.lastModified,
        live: false,
        state: "closed",
        turnStartedAt: null,
        ...(info.provider ? { provider: info.provider } : {}),
      });
    }

    for (const session of this.live.values()) {
      // A session of another project must not surface here: its transcript
      // and its turns belong to a different clone, and listing it let a tab
      // from the previous project survive a project switch.
      if (session.cwd !== cwd) continue;
      const stored = summaries.get(session.id);
      // Prefer the transcript's own summary. The store keeps it current as the
      // conversation moves, so using it for live and stored sessions alike stops
      // a session from being labelled one way while open and another once closed.
      const title = stored && stored.title !== untitled ? stored.title : session.title;
      summaries.set(session.id, {
        sessionId: session.id,
        title,
        lastModified: session.lastActivity,
        live: true,
        state: session.state,
        // 재접속한 창의 진행 시계가 0 부터 다시 세지 않도록 (없으면 null).
        turnStartedAt: session.turnStartedAt,
        provider: session.provider,
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
  async refreshThreads(
    cwd: string,
    limit = 50,
    cycles?: Map<string, ThreadCycle>,
  ): Promise<ThreadSummary[]> {
    const threads = (await this.list(cwd, limit)).map((summary): ThreadSummary => {
      const state: ThreadSummary["state"] =
        summary.state === "running" || summary.state === "starting"
          ? "running"
          : summary.state === "waiting_permission" || summary.state === "waiting_question"
            ? "awaiting"
            : summary.live && this.settledTurns.has(summary.sessionId)
              ? "finished"
              : "idle";
      const cycle = cycles?.get(summary.sessionId);
      return {
        id: summary.sessionId,
        title: summary.title,
        state,
        updatedAt: new Date(summary.lastModified).toISOString(),
        ...(cycle ? { cycle } : {}),
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
    // The live session's provider owns the store; a stored-only thread is
    // routed by the provider the last list scan recorded for its id.
    const provider =
      this.live.get(sessionId)?.provider ?? (await this.findStoredProvider(sessionId, cwd));
    const driver = this.driverFor(provider);
    return (await driver.store?.import?.(sessionId, cwd, 1000)) ?? [];
  }

  /**
   * 대화록에 이미 있는 프롬프트 수 — 재시작 뒤 턴 번호를 이어 셀 때의 밑값.
   * 읽기가 실패하면 0(빈 대화): 이전 동작과 같은 보수적 귀결이다.
   */
  async promptCount(sessionId: string, dir: string): Promise<number> {
    const provider =
      this.live.get(sessionId)?.provider ?? (await this.findStoredProvider(sessionId, dir));
    const driver = this.driverFor(provider);
    return (await driver.store?.promptCount?.(sessionId, dir)) ?? 0;
  }

  /**
   * 되감기 (PLAN D95): discard the k-th answer — files are ALREADY restored
   * by the caller — and carry on in a forked session whose memory stops
   * before that answer, re-sending `text`. When the provider refuses the
   * truncating fork (a deterministic refusal — never retried), the fallback
   * is a fresh conversation on the restored files, and `memoryKept` comes
   * back false so the card can say `AI 의 기억은 그대로입니다`.
   */
  async rewind(input: {
    sessionId: string;
    cwd: string;
    turn: number;
    text: string;
    images?: Array<{ mediaType: string; data: string }>;
    /** The new session's construction options (cwd · CLI · policy · title). */
    base: SessionOptions;
  }): Promise<{ sessionId: string; memoryKept: boolean }> {
    const old = this.live.get(input.sessionId);
    const title = old?.title ?? input.base.title ?? NEW_SESSION_TITLE;
    const driver = this.driverFor(old?.provider ?? input.base.provider);
    const cutoff = driver.store?.rewind
      ? await driver.store.rewind(input.sessionId, input.cwd, input.turn)
      : null;
    if (cutoff === null) {
      // 대화록이 비어 있어 어디를 남길지 모른다 — 기억을 못 찾은 것이니
      // 폴백이 정직한 답이다: 새 대화로 문장만 다시 보낸다(파일은 이미
      // 돌아갔다).
      await old?.close();
      this.live.delete(input.sessionId);
      this.settledTurns.delete(input.sessionId);
      const fresh = this.create({ ...input.base, title });
      fresh.send(input.text, input.images);
      return { sessionId: fresh.id, memoryKept: false };
    }

    await old?.close();
    this.live.delete(input.sessionId);
    this.settledTurns.delete(input.sessionId);

    if (cutoff.cut === null) {
      // k = 1: nothing to keep — a fresh conversation carries the title on.
      const fresh = this.create({ ...input.base, title });
      fresh.send(input.text, input.images);
      return { sessionId: fresh.id, memoryKept: false };
    }

    // The fork: keep the transcript up to `cut`, drop the turn whose prompt
    // is `drops`. The provider validates the range and refuses deterministically —
    // that refusal (or any first-turn failure) falls back, it never retries.
    const outcomeBox: {
      value: { type: "end"; subtype: string; resultText: string | null } | { type: "error" } | null;
    } = { value: null };
    // The fork's first event — the handshake's `init` — is the "healthy fork
    // sits idle" signal: a fresh Session is born `idle`, so the state alone
    // can never say the provider answered.
    let forkAnswered = false;
    const shim: SessionEvents = {
      ...this.events,
      onEvent: (id, event) => {
        forkAnswered = true;
        if (event.kind === "turn.end" && outcomeBox.value === null) {
          outcomeBox.value = {
            type: "end",
            subtype: event.subtype,
            resultText: event.resultText,
          };
        }
        this.events.onEvent(id, event);
      },
      onState: (id, state, detail) => {
        if (state === "error" && outcomeBox.value === null) outcomeBox.value = { type: "error" };
        this.events.onState(id, state, detail);
      },
    };
    const forkId = randomUUID();
    const forkDescriptor = driver.describe();
    const fork = new Session(
      {
        ...input.base,
        title,
        sessionId: forkId,
        provider: driver.id,
        providerLabel: forkDescriptor.label,
        planModeId: forkDescriptor.capabilities.planMode,
        defaultModeId: forkDescriptor.defaultModeId || "default",
        launch: {
          ...input.base.launch,
          resume: input.sessionId,
          forkSession: true,
          resumeSessionAt: cutoff.cut,
          resumeDropsTurn: cutoff.drops ?? cutoff.cut,
        },
      },
      shim,
    );
    try {
      fork.attach(
        driver.createSession(
          {
            cwd: fork.cwd,
            sessionId: fork.id,
            model: input.base.launch?.model ?? null,
            effort: input.base.launch?.effort ?? null,
            modeId: driver.describe().defaultModeId || "default",
            appendSystemPrompt: input.base.launch?.appendSystemPrompt ?? null,
            ...input.base.launch,
            resume: input.sessionId,
            forkSession: true,
            resumeSessionAt: cutoff.cut,
            resumeDropsTurn: cutoff.drops ?? cutoff.cut,
            browserMcp: this.browserMcpFor?.(fork.id) ?? undefined,
          },
          fork.driverHooks,
        ),
      );
    } catch (error) {
      this.browserMcpRevoke?.(fork.id);
      throw error;
    }
    this.live.set(fork.id, fork);
    // The refusal surfaces within the first exchange; a healthy fork answers
    // with its `init` and then sits idle waiting for input. `idle` itself is
    // no signal — a fresh Session starts there — so the wait ends on the
    // first event, a settled outcome, or a dead fork. Either way it is bounded.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (outcomeBox.value !== null || forkAnswered) break;
      if (fork.state === "closed" || fork.state === "error") break;
      await new Promise((ok) => setTimeout(ok, 250));
    }
    const outcome = outcomeBox.value;
    const rejected =
      outcome !== null &&
      (outcome.type === "error" ||
        (outcome.type === "end" &&
          outcome.subtype !== "success" &&
          (outcome.resultText ?? "").startsWith("Resume rejected")));
    if (outcome !== null && rejected) {
      // Deterministic refusal: close the failed fork, go fresh, keep the
      // evidence — the files are already back.
      await fork.close().catch(() => undefined);
      this.live.delete(fork.id);
      const fresh = this.create({ ...input.base, title });
      fresh.send(input.text, input.images);
      return { sessionId: fresh.id, memoryKept: false };
    }

    fork.send(input.text, input.images);
    // The fork won: the old transcript goes (D76's path) — the planner just
    // decided that answer never happened.
    await this.remove(input.sessionId, input.cwd).catch(() => undefined);
    return { sessionId: fork.id, memoryKept: true };
  }
}
