import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SessionModelInfo } from "@colo-design/protocol";
import type {
  AgentDriver,
  AgentSession,
  Diagnostic,
  DriverHooks,
  LaunchConfig,
  ProviderDescriptor,
  TranscriptStore,
} from "../../driver.js";
import { ompModelRows } from "./catalog.js";
import { OMP_MODE_ROWS, OmpAgentSession } from "./session.js";
import {
  deleteAllStoredSessions,
  deleteStoredSession,
  findFile,
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
      modes: OMP_MODE_ROWS.map(({ id, label, tier }) => ({ id, label, tier })),
      defaultModeId: "default",
      capabilities: {
        rewind: true,
        usage: false,
        contextUsage: true,
        fastMode: true,
        effort: true,
        modelSelect: true,
        slashCommands: true,
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
      return {
        ok: false,
        reason: "Oh My Pi CLI 를 찾지 못했습니다 — 설치한 뒤 다시 확인해 주세요.",
      };
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

  /**
   * `omp models --json` — the CLI's own catalog, no session needed. This is
   * what fills the daemon's per-provider cache before any thread exists, so
   * a fresh planner picking omp sees real rows (and omp's `provider/id`
   * selectors ride the same vocabulary a live session reports).
   */
  async listModels(): Promise<SessionModelInfo[]> {
    const executable = this.exe();
    if (!executable) return [];
    try {
      const { stdout } = await run(executable, ["models", "--json"], {
        // The catalog spans every provider omp knows — the payload is the
        // big part, the spawn the slow part. Once per run, off the status path.
        timeout: 20_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      const wire = JSON.parse(stdout) as { models?: unknown };
      const rows = Array.isArray(wire.models) ? wire.models : [];
      return ompModelRows(rows as Record<string, unknown>[]);
    } catch {
      // No catalog is better than a wrong one — the cache keeps serving
      // whatever a live session last reported.
      return [];
    }
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
    has: async (id, cwd) => (await findFile(ompAgentDir(), cwd, id)) !== null,
    delete: async (id, cwd) => {
      await deleteStoredSession(ompAgentDir(), cwd, id);
    },
    deleteAll: async (cwd) => {
      await deleteAllStoredSessions(ompAgentDir(), cwd);
    },
  };
}
