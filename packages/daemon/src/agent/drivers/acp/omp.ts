import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SessionModelInfo } from "@colo-design/protocol";
import type { TranscriptStore } from "../../driver.js";
import { ompModelRows } from "../omp/catalog.js";
import {
  deleteAllStoredSessions,
  deleteStoredSession,
  findFile,
  listStoredSessions,
  ompAgentDir,
  replayOmpSession,
  storedPromptCount,
  storedSessionTitle,
} from "../omp/store.js";
import type { AcpDriverConfig } from "./driver.js";

const run = promisify(execFile);

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
  const home = homedir();
  for (const candidate of ompCandidates(home)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * `omp models --json` — the CLI's own catalog, no session needed. ACP의
 * configOptions "model" 목록과 같은 어휘(provider/id)를 쓰므로 라이브 행과
 * 값으로 만난다.
 */
async function catalogModels(executable: string): Promise<SessionModelInfo[]> {
  try {
    const { stdout } = await run(executable, ["models", "--json"], {
      // The catalog spans every provider omp knows — the payload is the
      // big part, the spawn the slow part. Once per run, off the status path.
      timeout: 20_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const wire = JSON.parse(stdout) as { models?: unknown };
    const rows = Array.isArray(wire.models) ? wire.models : [];
    return withAcpTraits(ompModelRows(rows as Record<string, unknown>[]));
  } catch {
    // No catalog is better than a wrong one — the cache keeps serving
    // whatever a live session last reported.
    return [];
  }
}

/**
 * ACP 경로에 빠르게 와이어는 없다(/fast 슬래시 명령만) — 카탈로그가 rpc 시절
 * 참이라고 표시하던 supportsFastMode 를 거짓말이 되지 않게 되돌린다. 노력
 * 수준은 thinking configOption으로 살아 있다.
 */
function withAcpTraits(rows: SessionModelInfo[]): SessionModelInfo[] {
  return rows.map((row) => ({ ...row, supportsFastMode: false }));
}

/** The catalog by picker value — what enrichModels matches live rows against. */
let catalogByValue: Promise<Record<string, SessionModelInfo>> | null = null;
function catalogIndex(): Promise<Record<string, SessionModelInfo>> {
  catalogByValue ??= catalogModels(resolveOmpExecutable() ?? "").then((rows) =>
    Object.fromEntries(rows.map((row) => [row.value, row])),
  );
  return catalogByValue;
}

/**
 * Live configOptions rows know which models exist but not their traits —
 * the CLI catalog restores effort support so the picker keeps its 노력
 * menu after the first live session reports.
 */
async function enrichModels(rows: SessionModelInfo[]): Promise<SessionModelInfo[]> {
  const index = await catalogIndex();
  return rows.map((row) => {
    const known = index[row.value];
    return known
      ? {
          ...row,
          supportsEffort: known.supportsEffort,
          supportedEffortLevels: known.supportedEffortLevels,
        }
      : row;
  });
}

/** omp의 자체 대화록 저장소 — ACP 모드도 같은 JSONL에 적는다(같은 코어). */
function ompStore(): TranscriptStore {
  return {
    list: async (cwd, limit = 50) => listStoredSessions(ompAgentDir(), "omp", cwd, limit),
    title: async (id, cwd) => storedSessionTitle(ompAgentDir(), cwd, id),
    import: async (id, cwd) => replayOmpSession(ompAgentDir(), cwd, id),
    promptCount: async (id, cwd) => storedPromptCount(ompAgentDir(), cwd, id),
    has: async (id, cwd) => (await findFile(ompAgentDir(), cwd, id)) !== null,
    delete: async (id, cwd) => {
      await deleteStoredSession(ompAgentDir(), cwd, id);
    },
    deleteAll: async (cwd) => {
      await deleteAllStoredSessions(ompAgentDir(), cwd);
    },
  };
}

/**
 * Oh My Pi — `omp acp` 서브프로세스 한 개 per session. rpc 모드(--mode rpc)는
 * 도구 주입 wire가 없어 브라우저 MCP를 못 받았지만, ACP는 session/new의
 * mcpServers를 소비한다(검증됨). 권한 승인도 session/request_permission으로
 * 온다 — 쓰기 작업에서 카드가 열리고, 기본 모드는 "묻고 실행"인 moderate.
 */
export const OMP_ACP: AcpDriverConfig = {
  id: "omp",
  label: "Oh My Pi",
  modes: [
    { id: "default", label: "Default", tier: "moderate" },
    { id: "plan", label: "Plan", tier: "planning" },
    { id: "bypass", label: "Bypass", tier: "dangerous" },
  ],
  defaultModeId: "default",
  capabilities: {
    // omp 의 ACP 와이어에는 branch(되감기 절단)가 없다 — session/new · resume ·
    // fork(전체 복사)뿐이다. resume 으로 되감기를 흉내 내면 버린 답이 모델
    // 기억에 남는다(검증됨: fork 뒤에도 버린 답을 인용한다). 절단 없는
    // 되감기는 거짓말이므로 능력 자체를 내린다; store.rewind 도 함께 빼
    // session-manager 의 폴백(새 대화 + memoryKept:false)이 정직하게 먹히게
    // 한다.
    rewind: false,
    usage: false,
    contextUsage: true,
    // ACP에는 fast-mode 와이어가 없다 — /fast 슬래시 명령으로는 여전히 토글
    // 가능(composer 팔레트에 뜬다).
    fastMode: false,
    effort: true,
    modelSelect: true,
    slashCommands: true,
    planMode: "plan",
    subtasks: false,
    // 브라우저 도구 주입 가능(ACP v1 stdio 서버는 MUST). 공급자 선언일 뿐
    // 실제 제공은 host의 browserDriverFactory 주입이 정하고, status가 둘을
    // AND해 UI에 보인다.
    browserTools: true,
  },
  resolveExecutable: resolveOmpExecutable,
  acpArgs: ["acp"],
  store: () => ompStore(),
  listModels: () => {
    const executable = resolveOmpExecutable();
    return executable ? catalogModels(executable) : Promise.resolve([]);
  },
  effortConfigId: "thinking",
  enrichModels,
};
