import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AgentDriver,
  AgentSession,
  Capabilities,
  Diagnostic,
  DriverHooks,
  LaunchConfig,
  ProviderDescriptor,
  TranscriptStore,
} from "../../driver.js";
import { AcpAgentSession } from "./session.js";

const run = promisify(execFile);

/**
 * One row per ACP-speaking agent. Adding a provider is a config object, not
 * a class: the wire handshake, permission flow, and event translation all
 * live in `AcpAgentSession`; only the vendor-specific edges — where the
 * binary hides, whether it is logged in, how its transcript store answers —
 * ride the config.
 */
export interface AcpDriverConfig {
  /** Provider id — sessions and stored transcripts route by it. */
  id: string;
  label: string;
  /** Static mode rows; [] when the agent names its modes dynamically. */
  modes: ProviderDescriptor["modes"];
  /** The mode a fresh session starts on; "" when the agent decides. */
  defaultModeId: string;
  capabilities: Capabilities;
  /** Where the binary lives — env override, installer candidates, PATH. */
  resolveExecutable(): string | null;
  /** The argv that puts the binary into ACP mode — usually `["acp"]`. */
  acpArgs: string[];
  /** The vendor's own credential check; absent = no login state reported. */
  loggedIn?(): boolean;
  /** The transcript store, bound to the resolved executable. */
  store?(executable: string): TranscriptStore;
}

/**
 * The generic ACP driver: one `acp`-mode subprocess per session, plus the
 * vendor's own transcript store when the config declares one.
 */
export class AcpDriver implements AgentDriver {
  readonly id: string;
  private executable: string | null | undefined;
  private boundStore: TranscriptStore | null | undefined;

  constructor(private readonly config: AcpDriverConfig) {
    this.id = config.id;
  }

  describe(): ProviderDescriptor {
    return {
      id: this.id,
      label: this.config.label,
      modes: this.config.modes,
      defaultModeId: this.config.defaultModeId,
      capabilities: { ...this.config.capabilities },
    };
  }

  private exe(): string | null {
    if (this.executable === undefined) this.executable = this.config.resolveExecutable();
    return this.executable;
  }

  get store(): TranscriptStore | undefined {
    if (this.boundStore === undefined) {
      const executable = this.exe();
      this.boundStore = executable && this.config.store ? this.config.store(executable) : null;
    }
    return this.boundStore ?? undefined;
  }

  async isAvailable(): Promise<Diagnostic> {
    const executable = this.exe();
    if (!executable) {
      return { ok: false };
    }
    let version: string | null = null;
    try {
      const { stdout } = await run(executable, ["--version"], { timeout: 10_000 });
      version = stdout.trim() || null;
    } catch {
      version = null;
    }
    const loggedIn = this.config.loggedIn?.();
    return {
      ok: true,
      executable,
      ...(version ? { version } : {}),
      ...(loggedIn !== undefined ? { loggedIn } : {}),
    };
  }

  createSession(launch: LaunchConfig, hooks: DriverHooks): AgentSession {
    const executable = this.exe();
    if (!executable) throw new Error(`${this.config.label} CLI 를 찾지 못했습니다.`);
    return new AcpAgentSession(this.id, executable, this.config.acpArgs, launch, hooks);
  }
}
