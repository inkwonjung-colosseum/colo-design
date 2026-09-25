import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { realpath, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { meaningfulFirstLine } from "../../../common-instructions.js";
import { COLO_DESIGN_DIR } from "../../../environment.js";
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
import { codexOneShot } from "./one-shot.js";
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
  branch: true,
  usage: true,
  contextUsage: true,
  fastMode: false,
  effort: true,
  modelSelect: true,
  slashCommands: true,
  subtasks: false,
  // 요약(/compact)이 없다 — 길이 초과 실패는 실패 카드가 사람의 손으로 남는다.
  compact: false,
  // turn/steer — 도는 턴에 말을 실을 수 있는 유일한 와이어(experimentalApi).
  steer: true,
  // 브라우저 도구 주입 가능. 공급자 선언일 뿐 실제 제공은 host의
  // browserDriverFactory 주입을 정하고, status가 둘을 AND해 UI에 보인다.
  browserTools: true,
} as const;

/** Where the installers put the binary, in the order we trust them. */
function codexCandidates(home: string): string[] {
  // 맨 앞은 이 도구의 설치 진행기가 내려놓은 자리(~/.colo-design/tools/bin,
  // 1단계) — 환경 변수 오버라이드 다음으로 먼저 본다.
  const installed = join(
    COLO_DESIGN_DIR,
    "tools",
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  return [
    installed,
    join(home, ".local", "bin", "codex"),
    join(home, ".codex", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/usr/bin/codex",
  ];
}

/** 설치 진행기(1단계)가 설치의 성공 판정에 쓰는 같은 규칙. */
export function resolveCodexExecutable(): string | null {
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
 * `lastTurnId` is the truncating fork that powers the branch.
 */
export class CodexDriver implements AgentDriver {
  readonly id = "codex";

  describe(): ProviderDescriptor {
    return {
      id: this.id,
      label: "Codex",
      capabilities: { ...CODEX_CAPABILITIES },
    };
  }

  /**
   * 호출마다 푼다(2026-09-24): 후보는 existsSync 몇 번뿐이라 싸고, 한 번 null 로
   * 캐시하면 앱 안에서 설치한 Codex 를 재시작 전까지 못 보는 세계가 된다.
   */
  private exe(): string | null {
    return resolveCodexExecutable();
  }

  async isAvailable(): Promise<Diagnostic> {
    const executable = this.exe();
    if (!executable) {
      return { ok: false, reason: "Codex CLI 를 찾지 못했습니다 — 설치한 뒤 다시 확인해 주세요." };
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
    return new CodexAgentSession(executable, launch, hooks);
  }

  /**
   * 기계 잔일의 단답 턴 — codex exec 의 읽기 전용 샌드박스 길. 무도구는
   * 못 지키지만 무해는 지킨다(읽기 전용 · 네트워크 없음 · 세션 기록 없음).
   * 세부 계약은 codex/one-shot.ts 머리에.
   */
  oneShot(prompt: string, opts: { cwd: string; timeoutMs: number }): Promise<string | null> {
    return codexOneShot(prompt, { ...opts, executable: this.exe() });
  }

  /**
   * `codex login` (P1-1): 주소를 stderr 에 내고 로컬 콜백을 기다린다 — 코드
   * 붙여넣기 없음(AgentLogin 은 주소만 방송하고 wantsCode 는 켜지 않는다).
   */
  loginCommand(): { command: string; args: string[] } | null {
    const executable = this.exe();
    return executable ? { command: executable, args: ["login"] } : null;
  }
  // -------------------------------------------------------------------------
  // The transcript store — `~/.codex/sessions` rollout files.
  // -------------------------------------------------------------------------

  readonly store: TranscriptStore = {
    list: async (cwd, limit = 50) => {
      let real = cwd;
      try {
        real = await realpath(cwd);
      } catch {
        // The clone may not exist yet — compare the spelling we were given.
      }
      const rows: ImportableSession[] = [];
      for (const path of await listRolloutFiles(codexHome())) {
        if (rows.length >= limit) break;
        const meta = await readSessionMeta(path);
        if (!meta || (meta.cwd !== real && meta.cwd !== cwd)) continue;
        const prompts = await collectPrompts(await readRolloutLines(path));
        let lastModified = 0;
        try {
          lastModified = Math.round((await stat(path)).mtimeMs);
        } catch {
          lastModified = meta.timestamp ? Date.parse(meta.timestamp) || 0 : 0;
        }
        rows.push({
          id: meta.id,
          // 표식 · 공통 규칙이 앞에 붙은 첫 프롬프트가 제목이 되지 않게 (베타 테스트 #1)
          title: meaningfulFirstLine(prompts[0]?.text ?? "").slice(0, 80) || "제목 없는 대화",
          lastModified,
          provider: "codex",
        });
      }
      return rows;
    },

    title: async (id, _cwd) => {
      const path = await findRollout(codexHome(), id);
      if (!path) return null;
      const prompts = await collectPrompts(await readRolloutLines(path));
      return meaningfulFirstLine(prompts[0]?.text ?? "").slice(0, 80) || null;
    },

    import: async (id, _cwd) => {
      const path = await findRollout(codexHome(), id);
      return path ? replayRollout(await readRolloutLines(path)) : [];
    },

    /** 대화록에 이미 있는 프롬프트 수 — 재시작 뒤 턴 번호를 이어 셀 때의 밑값. */
    promptCount: async (id, _cwd) => {
      const path = await findRollout(codexHome(), id);
      return path ? (await collectPrompts(await readRolloutLines(path))).length : 0;
    },

    /**
     * k 번째 답까지 남기는 절단점: `thread/fork` 의 `lastTurnId` 는 한 턴
     * (프롬프트와 그 답) 을 통째로 세므로 남기는 마지막 턴은 prompt[k] 그
     * 자체다. 중간 분기는 그다음 턴을 drops 로 적는다 — cut+drops 짝.
     * 마지막 답에서의 분기는 잘릴 것이 없으므로 같은 cut 으로
     * 전체를 남긴다.
     */
    branchCut: async (id, _cwd, turn) => {
      const path = await findRollout(codexHome(), id);
      if (!path) return null;
      const prompts = await collectPrompts(await readRolloutLines(path));
      if (turn < 1 || turn > prompts.length) return null;
      const cut = prompts[turn - 1]?.turnId ?? null;
      if (cut === null) return null;
      return {
        cut,
        drops: turn < prompts.length ? (prompts[turn]?.turnId ?? null) : null,
        answerCount: prompts.length,
      };
    },

    has: async (id, _cwd) => (await findRollout(codexHome(), id)) !== null,

    delete: async (id, _cwd) => {
      const path = await findRollout(codexHome(), id);
      if (!path) return;
      try {
        await unlink(path);
      } catch {
        // Already gone.
      }
    },

    /**
     * A removed project's sweep: rollouts are date-keyed, so the scan still
     * walks the store — but only the first line (`session_meta`) decides the
     * cwd match; the full prompt read `list` pays for is skipped.
     */
    deleteAll: async (cwd) => {
      let real = cwd;
      try {
        real = await realpath(cwd);
      } catch {
        // The clone may already be gone — compare the spelling we were given.
      }
      for (const path of await listRolloutFiles(codexHome())) {
        const meta = await readSessionMeta(path);
        if (!meta || (meta.cwd !== real && meta.cwd !== cwd)) continue;
        await unlink(path).catch(() => undefined);
      }
    },
  };
}
