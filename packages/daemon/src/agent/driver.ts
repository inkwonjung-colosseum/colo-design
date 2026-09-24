import type {
  ChatEvent,
  ContextUsage,
  EffortLevel,
  PlanUsage,
  SessionCommand,
  SessionModelInfo,
} from "@colo-design/protocol";
import type { BrowserMcpEntry } from "../browser-launch.js";

/**
 * The normalized tool classes the core session and UI understand. Drivers
 * translate their native tool names into these kinds so the core's policy
 * (writePolicy, git-write refusal) and the UI's cards stay
 * provider-agnostic.
 */
type ToolKind = "edit" | "exec" | "read" | "question" | "mcp" | "other";

export interface ToolClass {
  kind: ToolKind;
  /** The provider's own tool name, for display, signatures, and logging. */
  name: string;
  /** Every file path the call touches (edit-kind tools may carry several). */
  paths?: string[];
  /** The shell command for exec-kind tools. */
  command?: string;
  /** The MCP server name for mcp-kind tools. */
  mcpServer?: string;
}

/**
 * What a provider can do, surfaced to the UI so it can hide or degrade
 * features the driver cannot honor.
 */
export interface Capabilities {
  /**
   * 대화 분기: a NEW conversation that keeps this answer's memory
   * (truncating fork of the same machinery). Providers without a
   * truncating fork keep this false — a branch advertised where the
   * memory cannot survive would be a silent lie.
   */
  branch: boolean;
  /** Plan/subscription usage windows (Claude only). */
  usage: boolean;
  /** Context-window usage ring. */
  contextUsage: boolean;
  /** Fast-mode toggle. */
  fastMode: boolean;
  /** Reasoning-effort selector. */
  effort: boolean;
  /** Model picker. */
  modelSelect: boolean;
  /** Slash-command palette. */
  slashCommands: boolean;
  /** stopTask/backgroundTask subagent controls. */
  subtasks: boolean;
  /** Mid-turn input — the driver can fold a send into the running turn. */
  steer: boolean;
  /**
   * 브라우저 도구(`browser_*`)를 와이어에 주입할 수 있는 공급자인가 — 네
   * 공급자 모두 true다(claude·codex는 각자의 mcpServers 필드, ACP 에이전트는
   * session/new의 mcpServers). 공급자 선언일 뿐 실제 제공 여부는 host의
   * browserDriverFactory 주입이 정하고, UI에는 server의 status가 둘을
   * AND해 보인다.
   */
  browserTools: boolean;
}

export interface ProviderDescriptor {
  id: string;
  label: string;
  capabilities: Capabilities;
}

export interface Diagnostic {
  ok: boolean;
  executable?: string;
  version?: string;
  loggedIn?: boolean;
  /**
   * Why the provider cannot run, in the planner's language — the settings
   * list shows it instead of a bare "설치 필요". Absent when `ok`, or when
   * the driver has nothing more specific to say.
   */
  reason?: string;
}

export interface ImportableSession {
  id: string;
  title: string;
  lastModified: number;
  /** Which provider's store the row came from — resume/history route by it. */
  provider?: string;
}

/**
 * The provider's on-disk transcript store — the CLI's own session files or
 * commands. A driver whose vendor keeps resumable transcripts exposes one.
 */
export interface TranscriptStore {
  /** Sessions stored on disk that this provider can resume. */
  list(cwd: string, limit?: number): Promise<ImportableSession[]>;
  /** A stored session's display title (customTitle or first human line). */
  title?(id: string, cwd: string): Promise<string | null>;
  /** A stored transcript replayed as ChatEvents. */
  import?(id: string, cwd: string, limit?: number): Promise<ChatEvent[]>;
  /** 대화록에 이미 있는 프롬프트 수 — 사이클 테이프 행의 afterTurn 셈. */
  promptCount?(id: string, cwd: string): Promise<number>;
  /**
   * Where a branch at the k-th answer cuts, or null when it cannot
   * (no transcript, or the provider's store cannot cut at all). The
   * k-th answer STAYS: `cut` keeps the conversation up to and
   * including that answer, and null `cut` means keep everything — a full
   * fork of the last turn.
   */
  branchCut?(id: string, cwd: string, turn: number): Promise<CutCutoff | null>;
  /** Whether this store holds the id — a targeted check for resume routing. */
  has?(id: string, cwd: string): Promise<boolean>;
  delete?(id: string, cwd: string): Promise<void>;
  /**
   * Every transcript this store holds for a clone, gone at once — a removed
   * project's sweep. Stores that key sessions by cwd directory can drop the
   * whole directory instead of listing then deleting one id at a time.
   */
  deleteAll?(cwd: string): Promise<void>;
}

export interface Turn {
  text: string;
  /**
   * Everything the planner attached. `mediaType` decides the delivery:
   * `image/*` becomes a vision block, decodable text is inlined into the
   * turn's words, and anything else is staged on disk for the agent to
   * read — no SDK accepts arbitrary binary content blocks.
   */
  attachments?: Array<{ name: string; mediaType: string; data: string }>;
}

interface CutCutoff {
  /** The chain uuid the truncated resume keeps up to; null = keep nothing. */
  cut: string | null;
  /** The discarded turn's prompt uuid. */
  drops?: string | null;
  /** How many answers the transcript holds — the caller's range check. */
  answerCount?: number;
}

/**
 * The provider-neutral verdict the core hands back to a driver. Structurally
 * identical to each SDK's own permission result; the driver casts.
 */
export type PermissionVerdict =
  | { behavior: "allow"; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string };

/**
 * The launch-time configuration a driver needs to start a session. The core
 * session owns the rest (writePolicy, queueDiskFor, title, …). Provider
 * drivers declare their own extension of this for vendor fields.
 */
export interface LaunchConfig {
  cwd: string;
  /** The session's own id — minted by the core before the driver starts. */
  sessionId: string;
  model: string | null;
  effort: EffortLevel | null;
  appendSystemPrompt: string | null;
  /** Resume an existing transcript (the provider's stored session id). */
  resume?: string;
  forkSession?: boolean;
  /** D95: with `resume` — the point the truncated resume keeps up to. */
  resumeSessionAt?: string;
  /** D95: with `resumeSessionAt` — the discarded turn's prompt id. */
  resumeDropsTurn?: string;
  /**
   * 브라우저 MCP 서버의 기동 명세(browser-launch.ts, 3단계). session-manager가
   * host의 browserDriverFactory 주입 여부를 보고 채운다 — 받은 세션은 이걸
   * 각자 와이어 형태로 바꿔 넣는다.
   */
  browserMcp?: BrowserMcpEntry;
  /** Provider-specific extras (Claude: executable/…). */
  [key: string]: unknown;
}

/**
 * What the driver reports back to the core session. The core owns policy and
 * state; the driver owns the transport and the translation of its wire
 * messages into ChatEvents.
 */
export interface DriverHooks {
  /** One UI-shaped event, already translated. */
  onEvent(event: ChatEvent): void;
  /**
   * The transport's stream ended on its own (clean or crashed). The core
   * decides what that means — a running turn makes it a crash, an idle one a
   * close. `shutdownReason` is the provider's announced exit reason, if any.
   */
  onTransportEnd(shutdownReason: string | null): void;
  /** The transport threw — the consume loop's exception path. */
  onTransportError(detail: string): void;
  /**
   * The provider asks whether a tool call may run. The core applies
   * writePolicy, the git-write refusal, 항상 허용 memory, and the card flow,
   * and resolves with the verdict the driver returns to its transport.
   */
  decidePermission(
    tool: ToolClass,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: unknown[] },
  ): Promise<PermissionVerdict>;
  /** The provider reported its own fast-mode state (Claude: fast_mode_state). */
  onFastMode?(on: boolean, blocked: string | null): void;
}

/**
 * The transport a driver owns: the live query/connection to the agent. The
 * core session drives it through this interface and receives events back
 * through the hooks. `createSession` is synchronous — a driver whose
 * handshake is async buffers calls behind an internal ready promise.
 */
export interface AgentSession {
  /**
   * The transcript id the PROVIDER named for this session, when it differs
   * from the session id (an ACP `session/new` answer names the agent's own
   * uuid). Every store lookup for a live session must ask with this id —
   * the transcript on disk is keyed by it. Null/absent = the ids match.
   */
  readonly vendorId?: string | null;
  /**
   * Whether the transport can still carry a send. False once the stream
   * ended or the process died — a send pushed past this point is swallowed
   * silently, so callers must resurrect instead.
   */
  readonly alive: boolean;
  send(turn: Turn): Promise<void>;
  /**
   * 바로 실어 보내기 — fold a mid-turn send into the turn now running
   * (codex `turn/steer`). Absent on drivers whose protocol has no such
   * road; the core then keeps the send in the wait room instead.
   */
  steer?(turn: Turn): Promise<void>;
  interrupt(): Promise<"answered" | "timeout" | "dead">;
  setModel?(id: string | null): Promise<void>;
  setEffort?(e: EffortLevel | null): Promise<void>;
  setFastMode?(on: boolean): Promise<void>;
  usage?(): Promise<PlanUsage | null>;
  contextUsage?(): Promise<ContextUsage | null>;
  /** The composer's /command palette rows from the provider's own CLI. */
  commands?(): Promise<SessionCommand[]>;
  models?(): Promise<SessionModelInfo[]>;
  stopTask?(id: string): Promise<void>;
  backgroundTask?(id: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface AgentDriver {
  id: string;
  describe(): ProviderDescriptor;
  isAvailable(): Promise<Diagnostic>;
  createSession(launch: LaunchConfig, hooks: DriverHooks): AgentSession;
  /** The vendor's transcript store; absent when the provider keeps none. */
  store?: TranscriptStore;
  /**
   * The CLI's model rows without a thread — a driver whose CLI can list
   * models on its own (`omp models --json`) answers here, so the
   * daemon's per-provider cache fills before any session exists. Absent = a
   * live session is the only source (Claude, Codex); the cache then waits
   * for the first session's report as before.
   */
  listModels?(): Promise<SessionModelInfo[]>;
  /**
   * 기계 잔일의 단답 턴 (저장 메모 · 넘기기 초안) — machine-provider.ts 가
   * 담당을 골라 여기로 온다. 계약의 전부는 세 보장이다: ① 도구는 절대
   * 돌리지 않는다 ② 프롬프트 하나에 답 하나 ③ 시간 안에 못 내면 null —
   * 호출자의 폴백이 그 빈칸을 쓴다. 이 보장을 자기 CLI 로 내리지 못하는
   * 드라이버는 이 메서드를 생략한다 — 담당 후보에서 자동으로 빠진다.
   */
  oneShot?(prompt: string, opts: { cwd: string; timeoutMs: number }): Promise<string | null>;
  /**
   * 이 드라이버의 로그인 명령 (P1-1) — 데몬이 stdio 파이프로 띄워 대신
   * 몬다: 주소는 stdout·stderr 어느 쪽에서 와도 첫 https URL 로 잡히고,
   * 코드를 stdin 으로 받는 CLI 는 프롬프트가 확인되면 붙여넣기 칸이 열린다.
   * CLI 가 없으면 null. 선언하지 않은 드라이버는 앱이 대신 시작할 수 없는
   * 로그인이다 — 고침 안내가 터미널을 말한다.
   */
  loginCommand?(): { command: string; args: string[] } | null;
}
