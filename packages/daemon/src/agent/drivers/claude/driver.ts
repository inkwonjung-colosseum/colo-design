import {
  deleteSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
} from "@anthropic-ai/claude-agent-sdk";
import { readAuthStatus, readClaudeVersion } from "../../../environment.js";
import type {
  AgentDriver,
  AgentSession,
  Diagnostic,
  DriverHooks,
  ProviderDescriptor,
  TranscriptStore,
} from "../../driver.js";
import { replayHistory } from "./import.js";
import { isPrompt, REWIND_HISTORY_LIMIT, resolveRewindCutoff } from "./rewind.js";
import { ClaudeAgentSession, type ClaudeLaunch } from "./session.js";

/**
 * A transcript's summary can be the conversation's own first line — and the
 * tool's machine-authored turns open with the `<!-- colo-design:… -->` marker
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

const CLAUDE_CAPABILITIES = {
  steer: true,
  rewind: true,
  usage: true,
  contextUsage: true,
  fastMode: true,
  effort: true,
  modelSelect: true,
  slashCommands: true,
  mcpServers: true,
  inProcessMcp: true,
  planMode: "plan",
  subtasks: true,
} as const;

/**
 * The Claude Code driver: SDK query transport plus the `~/.claude/projects`
 * transcript store. `executable` is resolved once by the daemon (env override
 * → PATH → installer candidates) and handed in; sessions carry it per launch.
 */
export class ClaudeDriver implements AgentDriver {
  readonly id = "claude";

  constructor(private readonly executable: () => string | null) {}

  describe(): ProviderDescriptor {
    return {
      id: this.id,
      label: "Claude",
      modes: [
        { id: "default", label: "Default", tier: "safe" },
        { id: "acceptEdits", label: "Accept Edits", tier: "moderate" },
        { id: "plan", label: "Plan", tier: "planning" },
        { id: "bypassPermissions", label: "Bypass Permissions", tier: "dangerous" },
      ],
      defaultModeId: "default",
      capabilities: { ...CLAUDE_CAPABILITIES },
    };
  }

  async isAvailable(): Promise<Diagnostic> {
    const executable = this.executable();
    if (!executable) {
      return { ok: false };
    }
    const version = await readClaudeVersion(executable);
    const auth = await readAuthStatus(executable).catch(() => null);
    return {
      ok: true,
      executable,
      ...(version ? { version } : {}),
      loggedIn: auth?.loggedIn ?? false,
    };
  }

  createSession(launch: ClaudeLaunch, hooks: DriverHooks): AgentSession {
    return new ClaudeAgentSession(launch, hooks);
  }

  // -------------------------------------------------------------------------
  // The transcript store — `~/.claude/projects` via the SDK's own readers.
  // -------------------------------------------------------------------------

  readonly store: TranscriptStore = {
    list: async (cwd, limit = 50) => {
      const stored = await listSessions({ dir: cwd, limit }).catch(() => []);
      return stored.map((info) => ({
        id: info.sessionId,
        title: info.customTitle || presentableTitle(info.summary) || "제목 없는 대화",
        lastModified: info.lastModified,
      }));
    },

    title: async (id, cwd) => {
      const info = await getSessionInfo(id, { dir: cwd }).catch(() => null);
      return info ? info.customTitle || presentableTitle(info.summary) || null : null;
    },

    import: async (id, cwd, limit = 1000) => {
      const messages = await getSessionMessages(id, { dir: cwd, limit }).catch(() => []);
      return replayHistory(messages);
    },

    /** 대화록에 이미 있는 프롬프트 수 — 재시작 뒤 턴 번호를 이어 셀 때의 밑값. */
    promptCount: async (id, cwd) => {
      const raw = await rawMessages(id, cwd);
      return raw.filter((message) => isPrompt(message)).length;
    },

    rewind: async (id, cwd, turn) => {
      const raw = await rawMessages(id, cwd);
      const cutoff = resolveRewindCutoff(raw, turn);
      // 존재하는 대화에서 k 가 넘친다 — 호출자 오류. 빈 대화록은 null 그대로.
      if (cutoff === null && raw.length > 0) {
        throw new Error(`되돌릴 ${turn}번째 답이 이 대화에 없습니다.`);
      }
      return cutoff;
    },

    delete: async (id, cwd) => {
      await deleteSession(id, { dir: cwd });
    },
  };
}

/** Raw stored messages — the rewind cutoff computation reads these. */
async function rawMessages(
  id: string,
  cwd: string,
  limit = REWIND_HISTORY_LIMIT,
): Promise<Array<Record<string, unknown>>> {
  const raw = await getSessionMessages(id, { dir: cwd, limit }).catch(() => []);
  return raw as Array<Record<string, unknown>>;
}
