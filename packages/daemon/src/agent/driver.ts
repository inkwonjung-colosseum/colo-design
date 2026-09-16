import type {
  ChatEvent,
  ContextUsage,
  EffortLevel,
  PlanUsage,
  SessionCommand,
  SessionModelInfo,
} from "@colo-design/protocol";

/**
 * The normalized tool classes the core session and UI understand. Drivers
 * translate their native tool names into these kinds so the core's policy
 * (writePolicy, git-write refusal, plan-mode gate) and the UI's cards stay
 * provider-agnostic.
 */
type ToolKind = "edit" | "exec" | "read" | "question" | "plan" | "mcp" | "other";

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
  /** Mid-turn user input injection (Claude: PushQueue). */
  steer: boolean;
  /** D95 truncating fork (Claude: forkSession+resumeSessionAt). */
  rewind: boolean;
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
  /** MCP server injection (preview tools over HTTP). */
  mcpServers: boolean;
  /** Can host the daemon's own in-process MCP server (SDK transports only). */
  inProcessMcp: boolean;
  /** Plan-mode id, or null when the provider has no plan mode. */
  planMode: string | null;
  /** stopTask/backgroundTask subagent controls. */
  subtasks: boolean;
}

export interface ProviderDescriptor {
  id: string;
  label: string;
  modes: Array<{ id: string; label: string; tier: "safe" | "moderate" | "planning" | "dangerous" }>;
  defaultModeId: string;
  capabilities: Capabilities;
}

export interface Diagnostic {
  ok: boolean;
  executable?: string;
  version?: string;
  loggedIn?: boolean;
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
 * commands. A driver whose vendor keeps resumable transcripts exposes one;
 * `capabilities.rewind` must agree with `rewind`'s presence.
 */
export interface TranscriptStore {
  /** Sessions stored on disk that this provider can resume. */
  list(cwd: string, limit?: number): Promise<ImportableSession[]>;
  /** A stored session's display title (customTitle or first human line). */
  title?(id: string, cwd: string): Promise<string | null>;
  /** A stored transcript replayed as ChatEvents. */
  import?(id: string, cwd: string, limit?: number): Promise<ChatEvent[]>;
  /** 대화록에 이미 있는 프롬프트 수 — 재시작 뒤 턴 번호의 밑값. */
  promptCount?(id: string, cwd: string): Promise<number>;
  /** Where the k-th answer's rewind cuts, or null when it cannot. */
  rewind?(id: string, cwd: string, turn: number): Promise<RewindCutoff | null>;
  delete?(id: string, cwd: string): Promise<void>;
}

export interface SessionHandle {
  provider: string;
  vendorSessionId: string;
}

export interface Turn {
  text: string;
  images?: Array<{ mediaType: string; data: string }>;
}

export interface RewindCutoff {
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
  modeId: string;
  appendSystemPrompt: string | null;
  mcpServers: Record<string, { type: "http"; url: string; headers?: Record<string, string> }>;
  /** Provider-specific extras (Claude: resume/forkSession/claudeExecutable/…). */
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
  handle(): SessionHandle;
  send(turn: Turn): Promise<void>;
  /** Mid-turn steer; only when capabilities.steer. */
  steer?(turn: Turn): Promise<void>;
  interrupt(): Promise<"answered" | "timeout" | "dead">;
  setMode(modeId: string): Promise<void>;
  setModel?(id: string | null): Promise<void>;
  setEffort?(e: EffortLevel | null): Promise<void>;
  setFastMode?(on: boolean): Promise<void>;
  usage?(): Promise<PlanUsage | null>;
  contextUsage?(): Promise<ContextUsage | null>;
  /**
   * The provider's own mode rows for the composer chip (ACP agents name
   * their own modes). Null/absent = the UI's built-in mode list applies.
   */
  modes?(): Promise<Array<{ id: string; label: string; description?: string }> | null>;
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
}
