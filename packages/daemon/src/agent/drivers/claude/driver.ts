import { realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
import { HISTORY_LIMIT, isPrompt, resolveBranchCutoff } from "./cutoff.js";
import { replayHistory } from "./import.js";
import { claudeOneShot } from "./one-shot.js";
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
  branch: true,
  usage: true,
  contextUsage: true,
  fastMode: true,
  effort: true,
  modelSelect: true,
  slashCommands: true,
  planMode: "plan",
  subtasks: true,
  // SDK 의 interrupt 는 턴을 자를 뿐 도는 턴에 실어 넣는 길이 없다.
  steer: false,
  // 브라우저 도구 주입 가능. 공급자 선언일 뿐 실제 제공은 host의
  // browserDriverFactory 주입이 정하고, status가 둘을 AND해 UI에 보인다.
  browserTools: true,
} as const;

/**
 * The machine turns' model (비개발자 저장): reading a diff and saying what it
 * did is haiku's job — fast enough for the 8-second leashes the memo and the
 * draft run on, and a planner's model stays for planning. A property of the
 * driver, not the repo layer: each provider names its own cheap answer.
 */
const MACHINE_MODEL = "haiku";

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
      // 이름은 결과의 말이다(P3-1) — 값(`bypassPermissions` …)은 그대로 선로로
      // 나가고, 바뀐 것은 사람이 읽는 글자뿐이다. 드라이버가 준 라벨이 웹의
      // 표를 이기므로(Composer 의 modeRow), 두 자리가 같은 말을 해야 한다.
      modes: [
        { id: "default", label: "실행 전에 물어보기", tier: "safe" },
        { id: "acceptEdits", label: "화면 수정은 바로", tier: "moderate" },
        { id: "plan", label: "계획 먼저 보기", tier: "planning" },
        { id: "bypassPermissions", label: "바로 진행", tier: "dangerous" },
      ],
      // 새 대화의 기본 모드 — 사용자가 확인 방식을 고르지 않으면 전부 맡기기로
      // 시작한다(web DEFAULT_PERMISSION_MODE 와 같은 기본). 플래너 승인 뒤의
      // 복귀 지점이기도 하다. 실제 CLI 기동 모드는 session.ts 가 "default" 로
      // 깔고 web 의 post-create 쓰기가 여기를 채운다.
      defaultModeId: "bypassPermissions",
      capabilities: { ...CLAUDE_CAPABILITIES },
    };
  }

  async isAvailable(): Promise<Diagnostic> {
    const executable = this.executable();
    if (!executable) {
      return {
        ok: false,
        reason: "Claude Code CLI 를 찾지 못했습니다 — 설치한 뒤 다시 확인해 주세요.",
      };
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

  /**
   * 기계 잔일의 단답 턴 (비개발자 저장): 세션이 쓰는 같은 SDK 입구를 한 번만
   * 돌게 — 도구 없음, 설정 없음, haiku 응답(machine-provider.ts 가 이 드라이버를
   * 담당으로 골라 부른다). 프롬프트가 읽을 수 있는 전부이고 대화록은 요약
   * 폴더에 남는다. null 이면 폴백 — 시간 초과든 CLI 부재든 같은 길이다.
   */
  oneShot(prompt: string, opts: { cwd: string; timeoutMs: number }): Promise<string | null> {
    return claudeOneShot(prompt, {
      cwd: opts.cwd,
      executable: this.executable(),
      model: MACHINE_MODEL,
      timeoutMs: opts.timeoutMs,
    });
  }

  /**
   * `claude auth login` (P1-1, 스파이크 검증): OAuth 주소는 stdout 에, 코드는
   * stdin 의 "Paste code here" 프롬프트로 받는다 — `/login` 은 TTY 를
   * 요구해 파이프에서는 거절된다("isn't available in this environment").
   */
  loginCommand(): { command: string; args: string[] } | null {
    const executable = this.executable();
    return executable ? { command: executable, args: ["auth", "login"] } : null;
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
        provider: "claude",
      }));
    },

    has: async (id, cwd) => {
      const info = await getSessionInfo(id, { dir: cwd }).catch(() => null);
      return info !== null;
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

    branchCut: async (id, cwd, turn) => {
      const raw = await rawMessages(id, cwd);
      const cutoff = resolveBranchCutoff(raw, turn);
      // 존재하는 대화에서 k 가 넘친다 — 호출자 오류. 빈 대화록은 null 그대로.
      if (cutoff === null && raw.length > 0) {
        throw new Error(`분기할 ${turn}번째 답이 이 대화에 없습니다.`);
      }
      return cutoff;
    },

    delete: async (id, cwd) => {
      await deleteSession(id, { dir: cwd });
    },

    /**
     * A removed project's sweep: `~/.claude/projects` keys each clone's
     * transcripts under one directory named after the cwd — dropping it is
     * O(1) where list+delete walks the whole store.
     */
    deleteAll: async (cwd) => {
      const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
      let real = cwd;
      try {
        real = await realpath(cwd);
      } catch {
        // The clone may already be gone — encode the spelling we were given.
      }
      // The CLI's own naming: every non-alphanumeric in the cwd becomes `-`.
      const encoded = resolve(real).replace(/[^a-zA-Z0-9]/g, "-");
      await rm(join(configDir, "projects", encoded), { recursive: true, force: true });
    },
  };
}

/** Raw stored messages — the branch cutoff computation reads these. */
async function rawMessages(
  id: string,
  cwd: string,
  limit = HISTORY_LIMIT,
): Promise<Array<Record<string, unknown>>> {
  const raw = await getSessionMessages(id, { dir: cwd, limit }).catch(() => []);
  return raw as Array<Record<string, unknown>>;
}
