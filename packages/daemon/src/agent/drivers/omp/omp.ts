import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentDriver,
  AgentSession,
  Diagnostic,
  DriverHooks,
  LaunchConfig,
  ProviderDescriptor,
  TranscriptStore,
} from "../../driver.js";
import { OmpAgentSession } from "./session.js";
import {
  deleteStoredSession,
  listStoredSessions,
  ompAgentDir,
  replayOmpSession,
  resolveOmpRewindCutoff,
  storedPromptCount,
  storedSessionTitle,
} from "./store.js";

const run = promisify(execFile);

/** Where omp installers put the binary, in the order we trust them. */
function candidates(home: string): string[] {
  return [
    join(home, ".bun", "bin", "omp"),
    join(home, ".local", "bin", "omp"),
    "/opt/homebrew/bin/omp",
    "/usr/local/bin/omp",
  ];
}

function resolveExecutable(): string | null {
  const home = homedir();
  for (const candidate of candidates(home)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * omp — Oh My Pi. Speaks a JSONL command/event RPC over `omp --mode rpc`
 * and keeps a JSONL session store under `~/.omp/agent/sessions/`.
 */
export class OmpDriver implements AgentDriver {
  readonly id = "omp";
  private executable: string | null | undefined;

  describe(): ProviderDescriptor {
    return {
      id: this.id,
      label: "Oh My Pi",
      // No permission modes — tools run as the CLI is configured.
      modes: [{ id: "default", label: "Default", tier: "moderate" }],
      defaultModeId: "default",
      capabilities: {
        steer: true,
        rewind: true,
        usage: false,
        contextUsage: true,
        fastMode: true,
        effort: true,
        modelSelect: true,
        slashCommands: true,
        mcpServers: false,
        inProcessMcp: false,
        planMode: null,
        subtasks: false,
      },
    };
  }

  private exe(): string | null {
    if (this.executable === undefined) this.executable = resolveExecutable();
    return this.executable;
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
    // omp keeps credentials in its own store; binary presence is the check.
    return { ok: true, executable, ...(version ? { version } : {}) };
  }

  createSession(launch: LaunchConfig, hooks: DriverHooks): AgentSession {
    const executable = this.exe();
    if (!executable) throw new Error("Oh My Pi CLI 를 찾지 못했습니다.");
    return new OmpAgentSession(executable, launch, hooks);
  }

  // -------------------------------------------------------------------------
  // The transcript store — the CLI's own JSONL session files.
  // -------------------------------------------------------------------------
  readonly store: TranscriptStore = {
    list: async (cwd, limit = 50) => listStoredSessions(ompAgentDir(), "omp", cwd, limit),
    title: async (id, cwd) => storedSessionTitle(ompAgentDir(), cwd, id),
    import: async (id, cwd) => replayOmpSession(ompAgentDir(), cwd, id),
    promptCount: async (id, cwd) => storedPromptCount(ompAgentDir(), cwd, id),
    rewind: async (id, cwd, turn) => resolveOmpRewindCutoff(ompAgentDir(), cwd, id, turn),
    delete: async (id, cwd) => {
      deleteStoredSession(ompAgentDir(), cwd, id);
    },
  };
}
