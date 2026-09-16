import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentDriver,
  AgentSession,
  Diagnostic,
  DriverHooks,
  ImportableSession,
  LaunchConfig,
  ProviderDescriptor,
  TranscriptStore,
} from "../../driver.js";
import { CodexAgentSession } from "./session.js";
import {
  codexHome,
  collectPrompts,
  findRollout,
  listRolloutFiles,
  readRolloutLines,
  readSessionMeta,
  replayRollout,
} from "./store.js";

const run = promisify(execFile);
const CODEX_CAPABILITIES = {
  steer: true,
  rewind: true,
  usage: true,
  contextUsage: true,
  fastMode: false,
  effort: true,
  modelSelect: true,
  slashCommands: true,
  mcpServers: false,
  inProcessMcp: false,
  planMode: "plan",
  subtasks: false,
} as const;

/** Where the installers put the binary, in the order we trust them. */
function codexCandidates(home: string): string[] {
  return [
    join(home, ".local", "bin", "codex"),
    join(home, ".codex", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/usr/bin/codex",
  ];
}

function resolveCodexExecutable(): string | null {
  const env = process.env.COLO_DESIGN_CODEX_BIN;
  const candidates = [env, ...codexCandidates(homedir())].filter((value): value is string =>
    Boolean(value),
  );
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
  }
  return null;
}

/** `~/.codex/auth.json` — the CLI's own credential store. */
function codexLoggedIn(): boolean {
  try {
    const raw = readFileSync(join(codexHome(), "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

/**
 * The Codex driver: an `codex app-server` subprocess per session, plus the
 * CLI's own rollout store (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`)
 * for the transcript side. The wire protocol was probed live: `thread/start`
 * takes a SandboxMode string while `turn/start` takes the full SandboxPolicy,
 * approvals arrive as server→client requests, and `thread/fork` with
 * `lastTurnId` is the truncating fork that powers rewind.
 */
export class CodexDriver implements AgentDriver {
  readonly id = "codex";
  private executable: string | null | undefined;

  describe(): ProviderDescriptor {
    return {
      id: this.id,
      label: "Codex",
      modes: [
        { id: "default", label: "Default", tier: "moderate" },
        { id: "plan", label: "Plan", tier: "planning" },
        { id: "bypass", label: "Bypass", tier: "dangerous" },
      ],
      defaultModeId: "default",
      capabilities: { ...CODEX_CAPABILITIES },
    };
  }

  private exe(): string | null {
    if (this.executable === undefined) this.executable = resolveCodexExecutable();
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
    const loggedIn = codexLoggedIn();
    return {
      ok: true,
      executable,
      ...(version ? { version } : {}),
      loggedIn,
    };
  }

  createSession(launch: LaunchConfig, hooks: DriverHooks): AgentSession {
    const executable = this.exe();
    if (!executable) throw new Error("Codex CLI 를 찾지 못했습니다.");
    return new CodexAgentSession(this.id, executable, launch, hooks);
  }

  // -------------------------------------------------------------------------
  // The transcript store — `~/.codex/sessions` rollout files.
  // -------------------------------------------------------------------------

  readonly store: TranscriptStore = {
    list: async (cwd, limit = 50) => {
      let real = cwd;
      try {
        real = realpathSync(cwd);
      } catch {
        // The clone may not exist yet — compare the spelling we were given.
      }
      const rows: ImportableSession[] = [];
      for (const path of listRolloutFiles(codexHome())) {
        if (rows.length >= limit) break;
        const meta = readSessionMeta(path);
        if (!meta || (meta.cwd !== real && meta.cwd !== cwd)) continue;
        const prompts = collectPrompts(readRolloutLines(path));
        let lastModified = 0;
        try {
          lastModified = Math.round(statSync(path).mtimeMs);
        } catch {
          lastModified = meta.timestamp ? Date.parse(meta.timestamp) || 0 : 0;
        }
        rows.push({
          id: meta.id,
          title: prompts[0]?.text.split("\n", 1)[0]?.slice(0, 80) || "제목 없는 대화",
          lastModified,
          provider: "codex",
        });
      }
      return rows;
    },

    title: async (id, _cwd) => {
      const path = findRollout(codexHome(), id);
      if (!path) return null;
      const prompts = collectPrompts(readRolloutLines(path));
      return prompts[0]?.text.split("\n", 1)[0]?.slice(0, 80) ?? null;
    },

    import: async (id, _cwd) => {
      const path = findRollout(codexHome(), id);
      return path ? replayRollout(readRolloutLines(path)) : [];
    },

    /** 대화록에 이미 있는 프롬프트 수 — 재시작 뒤 턴 번호를 이어 셀 때의 밑값. */
    promptCount: async (id, _cwd) => {
      const path = findRollout(codexHome(), id);
      return path ? collectPrompts(readRolloutLines(path)).length : 0;
    },

    /**
     * k 번째 프롬프트를 버리는 절단점: `thread/fork` 의 `lastTurnId` 는
     * inclusive 이므로 cut = 직전 턴의 id, drops = 버릴 턴의 id. 첫 턴을
     * 버릴 때는 cut 이 null — 세션 쪽은 그때 빈 스레드를 새로 연다.
     */
    rewind: async (id, _cwd, turn) => {
      const path = findRollout(codexHome(), id);
      if (!path) return null;
      const prompts = collectPrompts(readRolloutLines(path));
      if (turn < 1 || turn > prompts.length) return null;
      const drops = prompts[turn - 1]?.turnId ?? null;
      const cut = turn > 1 ? (prompts[turn - 2]?.turnId ?? null) : null;
      // turn > 1 인데 이어 줄 이전 턴 id 를 못 찾았다 — 잘라낼 수 없는 대화록.
      if (turn > 1 && cut === null) return null;
      return { cut, drops, answerCount: prompts.length };
    },

    delete: async (id, _cwd) => {
      const path = findRollout(codexHome(), id);
      if (!path) return;
      try {
        unlinkSync(path);
      } catch {
        // Already gone.
      }
    },
  };
}
