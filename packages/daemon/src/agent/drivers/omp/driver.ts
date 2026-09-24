import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SessionModelInfo } from "@colo-design/protocol";
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
import { runCliOneShot } from "../../one-shot-cli.js";
import { ompModelRows } from "./catalog.js";
import { OmpAgentSession } from "./session.js";
import {
  deleteAllStoredSessions,
  deleteStoredSession,
  findFile,
  listStoredSessions,
  ompAgentDir,
  replayOmpSession,
  resolveOmpBranchCut,
  storedPromptCount,
  storedSessionTitle,
} from "./store.js";

const run = promisify(execFile);

const OMP_CAPABILITIES: Capabilities = {
  // `branch{entryId}` 는 지정한 프롬프트 앞에서 잘라 새 세션 id 를 발급하는
  // 진짜 절단 포크다(검증됨) — 버린 답은 모델 기억에 남지 않는다.
  branch: true,
  usage: false,
  contextUsage: true,
  // `set_fast_mode` — 받지 않는 모델은 카탈로그 행이 미리 말한다(catalog.ts).
  fastMode: true,
  effort: true,
  modelSelect: true,
  slashCommands: true,
  subtasks: false,
  // `steer` — 도는 턴에 말을 얹는 와이어. omp 는 같은 agent run 안에서
  // 소화한다(검증됨).
  steer: true,
  // 브라우저 도구는 host tool 로 실린다 — MCP 자식 프로세스가 없다. 공급자
  // 선언일 뿐 실제 제공은 host 의 browserDriverFactory 주입이 정하고,
  // status 가 둘을 AND 해 UI 에 보인다.
  browserTools: true,
};

/** Where omp installers put the binary, in the order we trust them. */
function ompCandidates(home: string): string[] {
  return [
    join(home, ".bun", "bin", "omp"),
    join(home, ".local", "bin", "omp"),
    "/opt/homebrew/bin/omp",
    "/usr/local/bin/omp",
  ];
}

function resolveOmpExecutable(): string | null {
  const override = process.env.COLO_DESIGN_OMP_BIN;
  if (override && existsSync(override)) return override;
  for (const candidate of ompCandidates(homedir())) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Oh My Pi — an `omp --mode rpc-ui` subprocess per session.
 *
 * `rpc-ui` over plain `rpc`: the `-ui` suffix installs an ExtensionUIContext
 * on the tool path, so tool approvals and the `ask` tool reach this host as
 * `extension_ui_request` frames. Plain `rpc` fails those closed ("requires
 * approval but no interactive UI available"), which is why the earlier omp
 * driver had to route through ACP instead. rpc-ui also gives what ACP cannot:
 * a truncating fork (`branch`), mid-turn input (`steer`), the fast-mode
 * toggle, compaction notices, and host tools — the browser toolset is served
 * in-process, with no MCP child.
 */
export class OmpDriver implements AgentDriver {
  readonly id = "omp";
  private executable: string | null | undefined;

  describe(): ProviderDescriptor {
    return {
      id: this.id,
      label: "Oh My Pi",
      capabilities: { ...OMP_CAPABILITIES },
    };
  }

  private exe(): string | null {
    if (this.executable === undefined) this.executable = resolveOmpExecutable();
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
   * `omp models --json` — the CLI's own catalog, no session needed. This
   * fills the daemon's per-provider cache before any thread exists, so a
   * fresh planner picking omp sees real rows. The live session's
   * `get_available_models` speaks the same `provider/id` vocabulary, so the
   * two sources meet on value (catalog.ts maps both row shapes).
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
      return ompModelRows(
        Array.isArray(wire.models) ? (wire.models as Record<string, unknown>[]) : [],
      );
    } catch {
      // No catalog is better than a wrong one — the cache keeps serving
      // whatever a live session last reported.
      return [];
    }
  }

  /** The transcript store — the CLI's own JSONL session files. */
  readonly store: TranscriptStore = {
    list: async (cwd, limit = 50) => listStoredSessions(ompAgentDir(), "omp", cwd, limit),
    title: async (id, cwd) => storedSessionTitle(ompAgentDir(), cwd, id),
    import: async (id, cwd) => replayOmpSession(ompAgentDir(), cwd, id),
    promptCount: async (id, cwd) => storedPromptCount(ompAgentDir(), cwd, id),
    branchCut: async (id, cwd, turn) => resolveOmpBranchCut(ompAgentDir(), cwd, id, turn),
    has: async (id, cwd) => (await findFile(ompAgentDir(), cwd, id)) !== null,
    delete: async (id, cwd) => {
      await deleteStoredSession(ompAgentDir(), cwd, id);
    },
    deleteAll: async (cwd) => {
      await deleteAllStoredSessions(ompAgentDir(), cwd);
    },
  };

  /**
   * 기계 잔일의 단답 턴 — `omp -p` 의 무도구 길. 3보장을 전부 문자 그대로
   * 지킨다: --no-tools(도구 없음) · -p(프롬프트 하나 답 하나) · 목줄은
   * runCliOneShot 이 지킨다. --no-session 으로 대화 저장소도 더럽히지
   * 않고, 빠른 모델(smol)과 생각 끄기로 목줄 안에 든다(실측 2.6 초).
   */
  async oneShot(prompt: string, opts: { cwd: string; timeoutMs: number }): Promise<string | null> {
    const executable = this.exe();
    if (!executable) return null;
    const out = await runCliOneShot(
      executable,
      [
        "-p",
        "--no-tools",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--thinking=off",
        "--model=smol",
        "--cwd",
        opts.cwd,
        prompt,
      ],
      opts,
    );
    return out?.trim() ? out.trim() : null;
  }
}
