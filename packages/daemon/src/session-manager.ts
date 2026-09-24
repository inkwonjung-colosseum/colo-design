import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { ChatEvent, SessionSummary, ThreadSummary } from "@colo-design/protocol";
import type { AgentDriver, ImportableSession } from "./agent/driver.js";
import type { DriverRegistry } from "./agent/registry.js";
import type { BrowserMcpEntry } from "./browser-launch.js";
import { NEW_SESSION_TITLE, Session, type SessionEvents, type SessionOptions } from "./session.js";

/** A bounded handshake wait's tick — resolvers kept, no executor nesting. */
function pause(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** cwd 의 실제 경로 — 심볼릭 링크를 펴고, 없는 경로는 그대로 둔다. */
function realPathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
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
   * store that grows for years. Callers
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
   * Clones a 대화 모두 지우기 is still erasing (실사 결함). The erase takes
   * seconds — live sessions close under a grace, the store sweep retries —
   * and until it lands the caches still name the doomed rows. A window that
   * connected in that window (a reload, a second display) read them and the
   * deleted conversations stood in the tree until the sweep's own announce
   * corrected it. While a clone is marked, `list` answers empty: the planner
   * already said these threads are gone.
   */
  private readonly deleting = new Set<string>();
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
    // 같은 id 를 두 번 여는 요청(더블클릭, 두 창의 재개)은 새 세션이 아니라
    // 이미 살아 있는 그 세션이다 — 덮어쓰면 첫 Session 의 CLI 가 맵 밖에서
    // 살아남아 훅을 통해 계속 방송한다. id 는 Session 과 같은 규칙으로 잡는다
    // (sessionId → resume → 새 uuid).
    const wantedId = options.sessionId ?? options.launch?.resume;
    const existing = wantedId === undefined ? undefined : this.live.get(wantedId);
    if (existing) return existing;
    const driver = this.driverFor(options.provider);
    const descriptor = driver.describe();
    const session = new Session(
      {
        ...options,
        provider: driver.id,
        providerLabel: descriptor.label,
        // 요약(/compact) 재시도의 조건 (PLAN L12) — 드라이버가 선언한 능력이
        // 곧 세션의 길이다.
        canCompact: descriptor.capabilities.compact === true,
      },
      this.events,
    );
    const launch = {
      cwd: session.cwd,
      sessionId: session.id,
      model: options.launch?.model ?? null,
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
      // 재개는 활동이 아니다 — 저장된 대화록의 마지막 쓰임으로 되돌리지
      // 않으면 목록의 시간 라벨이 "방금"부터 다시 세어 나간다. 다만 재개
      // 직후의 대화록 재생 이벤트가 lastActivity 를 지금으로 밀어 내므로,
      // 재생이 가라앉은 뒤에 되돌린다(그 사이의 실제 전송은 backdate 가
      // 스스로 거절한다).
      void driver.store
        ?.list(session.cwd, 200)
        .catch(() => [])
        .then((rows) => {
          const row = rows.find((candidate) => candidate.id === options.launch?.resume);
          if (row) setTimeout(() => session.backdate(row.lastModified), 5_000);
        })
        .catch(() => undefined);
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
    // Resolve the store key BEFORE close(): the vendor names its own
    // transcript id (ACP), and close() tears the live session down.
    const storeId = live?.vendorSessionId ?? sessionId;
    if (live) await this.close(sessionId);
    const provider = live?.provider ?? (await this.findStoredProvider(sessionId, cwd));
    this.storedProvider.delete(sessionId);
    if (provider === undefined) {
      // The id belongs to no store we know — sweep every driver's delete so
      // a phantom row still dies; a store that never held it no-ops.
      await Promise.all(
        this.drivers
          .all()
          .map((driver) => driver.store?.delete?.(storeId, cwd).catch(() => undefined)),
      );
      return;
    }
    const driver = this.driverFor(provider);
    try {
      await driver.store?.delete?.(storeId, cwd);
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
      if (this.busyState(session)) return true;
    }
    return false;
  }

  /**
   * anyBusy 의 한 클론 판 (PLAN L1): 같은 판정을 cwd(realpath 비교)가 같은
   * 세션에만 적용한다. 폴러의 조기 반환 하나가 모든 프로젝트의 병합 감지를
   * 멈추던 것을 프로젝트별로 좁히는 잣대다. 심볼릭 링크(/var 따위) 로 같은
   * 폴더가 다르게 적히는 것까지 같게 본다.
   */
  busyIn(cwd: string): boolean {
    const real = realPathOf(cwd);
    for (const session of this.live.values()) {
      if (realPathOf(session.cwd) !== real) continue;
      if (this.busyState(session)) return true;
    }
    return false;
  }

  /** anyBusy · busyIn 이 공유하는 한 세션의 바쁨 판정. */
  private busyState(session: Session): boolean {
    // 유령 대기는 바쁨이 아니다 (E2E 2026-09-20) — 카드 없는 waiting_* 는
    // 정산 어긋남의 흔적일 뿐, 가드를 영원히 막아서는 안 된다.
    if (
      (session.state === "waiting_permission" || session.state === "waiting_question") &&
      session.pendingCount === 0
    ) {
      return false;
    }
    return (
      session.state === "running" ||
      session.state === "starting" ||
      session.state === "waiting_permission" ||
      session.state === "waiting_question"
    );
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
   * The synchronous half of `removeWhere` (실사 결함): the erase itself takes
   * seconds — live sessions close under a grace, the store sweep retries —
   * and the dispatcher answers 대화 모두 지우기 without waiting for it. From
   * this moment every read of the clone answers empty, so a window that
   * connects mid-erase (a reload, a second display) never sees the doomed
   * rows: the caches that carried them die here, and any in-flight scan's
   * result is a superseded generation.
   */
  beginRemoveWhere(cwd: string): void {
    this.deleting.add(cwd);
    this.threadCache.delete(cwd);
    this.disk.delete(cwd);
    this.diskStale.delete(cwd);
    this.scanEpoch.set(cwd, (this.scanEpoch.get(cwd) ?? 0) + 1);
    this.scanning.delete(cwd);
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
    this.beginRemoveWhere(cwd);
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
    // The erase has landed — reads see the swept store from here on.
    this.deleting.delete(cwd);
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
    // A clone mid-erase answers empty — the planner already said these
    // threads are gone, and a window that connected during the erase must
    // not read them back from the caches or the not-yet-swept store.
    if (this.deleting.has(cwd)) return [];
    // The resolution restarts when its scan's generation was superseded
    // mid-flight (removeWhere): the awaited rows may include conversations
    // the sweep just deleted, and returning them let a refresh re-arm the
    // thread cache with deleted rows — the tree resurrected them on the
    // next connect. Same rule the scan's own disk-write guard applies;
    // applied to the RETURN value too.
    for (;;) {
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
            this.drivers
              .all()
              .map((driver) => driver.store?.list(cwd, limit).catch(() => []) ?? []),
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
        // Superseded mid-scan — the answer may name rows the sweep deleted.
        // Restart: the fresh generation's scan reads the swept store.
        if ((this.scanEpoch.get(cwd) ?? 0) !== epoch) continue;
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
        // 유령 대기 판정 (E2E 2026-09-20): `waiting_*` 인데 기다리는 카드가
        // 없으면 정산·재생이 어긋난 흔적일 뿐 — 배지는 대기가 아니라 쉼으로 답한다.
        const liveState =
          (session.state === "waiting_permission" || session.state === "waiting_question") &&
          session.pendingCount === 0
            ? "idle"
            : session.state;
        summaries.set(session.id, {
          sessionId: session.id,
          title,
          lastModified: session.lastActivity,
          live: true,
          state: liveState,
          // 재접속한 창의 진행 시계가 0 부터 다시 세지 않도록 (없으면 null).
          turnStartedAt: session.turnStartedAt,
          provider: session.provider,
        });
      }

      return [...summaries.values()].sort((a, b) => b.lastModified - a.lastModified);
    }
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
    // The live session's provider owns the store; a stored-only thread is
    // routed by the provider the last list scan recorded for its id.
    const live = this.live.get(sessionId);
    const provider = live?.provider ?? (await this.findStoredProvider(sessionId, cwd));
    const driver = this.driverFor(provider);
    // An ACP session/new answer names the agent's own uuid — the transcript
    // on disk is keyed by THAT, so a live session's lookup asks with it.
    const storeId = live?.vendorSessionId ?? sessionId;
    return (await driver.store?.import?.(storeId, cwd, 1000)) ?? [];
  }

  /**
   * 대화록에 이미 있는 프롬프트 수 — 사이클 테이프 행의 afterTurn 셈.
   * 읽기가 실패하면 0(빈 대화): 보수적 귀결이다.
   */
  async promptCount(sessionId: string, dir: string): Promise<number> {
    const live = this.live.get(sessionId);
    const provider = live?.provider ?? (await this.findStoredProvider(sessionId, dir));
    const driver = this.driverFor(provider);
    // Same key as history(): the vendor names its own transcript id (ACP).
    const storeId = live?.vendorSessionId ?? sessionId;
    return (await driver.store?.promptCount?.(storeId, dir)) ?? 0;
  }

  /**
   * 대화 분기: keep this answer and everything before it as the memory of a
   * NEW conversation. The OLD thread survives — no close, no
   * transcript removal, no re-sent prompt — and the fork is born idle: the
   * next words are the user's. Files are nobody's business here — one
   * worktree cannot hold two file states, so the branch cuts memory only
   * and the worktree keeps its present state. A store that cannot cut
   * (ACP) or an empty transcript falls back to a fresh conversation with
   * `memoryKept: false` — the honest report.
   */
  async branch(input: {
    sessionId: string;
    cwd: string;
    turn: number;
    /** The new session's construction options (cwd · CLI · policy · title). */
    base: SessionOptions;
  }): Promise<{ sessionId: string; memoryKept: boolean }> {
    const old = this.live.get(input.sessionId);
    const title = old?.title ?? input.base.title ?? NEW_SESSION_TITLE;
    const driver = this.driverFor(old?.provider ?? input.base.provider);
    const cutoff = driver.store?.branchCut
      ? await driver.store.branchCut(input.sessionId, input.cwd, input.turn).catch(() => null)
      : null;
    if (cutoff === null) {
      // 어디를 남길지 모른다 — 기억 없는 새 대화가 정직한 분기다.
      const fresh = this.create({ ...input.base, title });
      return { sessionId: fresh.id, memoryKept: false };
    }

    const forkAnswered = { value: false };
    const outcomeBox: {
      value: { type: "end"; subtype: string; resultText: string | null } | { type: "error" } | null;
    } = { value: null };
    const shim: SessionEvents = {
      ...this.events,
      onEvent: (id, event) => {
        forkAnswered.value = true;
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
        launch: {
          ...input.base.launch,
          resume: input.sessionId,
          forkSession: true,
          ...(cutoff.cut
            ? { resumeSessionAt: cutoff.cut, resumeDropsTurn: cutoff.drops ?? cutoff.cut }
            : {}),
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
            appendSystemPrompt: input.base.launch?.appendSystemPrompt ?? null,
            ...input.base.launch,
            resume: input.sessionId,
            forkSession: true,
            ...(cutoff.cut
              ? { resumeSessionAt: cutoff.cut, resumeDropsTurn: cutoff.drops ?? cutoff.cut }
              : {}),
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
    // The handshake's `init` is the healthy-fork signal — a bounded
    // wait. A deterministic refusal (Resume rejected) here means
    // the provider refused the cut; the branch falls back fresh instead of
    // advertising a memory it does not have.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (forkAnswered.value || outcomeBox.value !== null) break;
      if (fork.state === "closed" || fork.state === "error") break;
      await pause(250);
    }
    const outcome = outcomeBox.value;
    const rejected =
      outcome !== null &&
      (outcome.type === "error" ||
        (outcome.type === "end" &&
          outcome.subtype !== "success" &&
          (outcome.resultText ?? "").startsWith("Resume rejected")));
    if (outcome !== null && rejected) {
      await fork.close().catch(() => undefined);
      this.live.delete(fork.id);
      const fresh = this.create({ ...input.base, title });
      return { sessionId: fresh.id, memoryKept: false };
    }
    // 분기는 옛 대화를 살려 둔다 — 닫지도, 지우지도, 말을 보내지도 않는다.
    return { sessionId: fork.id, memoryKept: true };
  }
}
