import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ImportableSession, TranscriptStore } from "../../driver.js";
import type { AcpDriverConfig } from "./driver.js";
import { exportPromptCount, replayExport } from "./export.js";

const run = promisify(execFile);

type Wire = Record<string, unknown>;

/** Where opencode's own installers put the binary, in the order we trust them. */
function opencodeCandidates(home: string): string[] {
  return [
    join(home, ".opencode", "bin", "opencode"),
    join(home, ".local", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
  ];
}

function resolveOpencodeExecutable(): string | null {
  const env = process.env.COLO_DESIGN_OPENCODE_BIN;
  const candidates = [env, ...opencodeCandidates(homedir())].filter((value): value is string =>
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

/** `~/.local/share/opencode/auth.json` — the CLI's own credential store. */
function opencodeLoggedIn(): boolean {
  try {
    const raw = readFileSync(join(homedir(), ".local", "share", "opencode", "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

async function listStored(
  executable: string,
  cwd: string,
  limit: number,
): Promise<ImportableSession[]> {
  let rows: Wire[];
  try {
    const { stdout } = await run(
      executable,
      ["session", "list", "--format", "json", "-n", String(limit * 4)],
      { cwd, timeout: 15_000 },
    );
    rows = JSON.parse(stdout) as Wire[];
  } catch {
    return [];
  }
  // The store is global; a clone's threads are the rows whose directory
  // resolves to this clone's realpath.
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // The clone may not exist yet — compare the spelling we were given.
  }
  return rows
    .filter((row) => {
      const dir = String(row.directory ?? "");
      return dir === real || dir === cwd;
    })
    .slice(0, limit)
    .map((row) => ({
      id: String(row.id ?? ""),
      title: String(row.title ?? "") || "제목 없는 대화",
      lastModified: Number(row.updated ?? row.created ?? 0),
      provider: "opencode",
    }));
}

async function exportSession(executable: string, id: string, cwd: string): Promise<Wire | null> {
  try {
    const { stdout } = await run(executable, ["export", id], { cwd, timeout: 30_000 });
    // The CLI prints a banner line before the JSON document.
    const start = stdout.indexOf("{");
    if (start === -1) return null;
    return JSON.parse(stdout.slice(start)) as Wire;
  } catch {
    return null;
  }
}

function opencodeStore(executable: string): TranscriptStore {
  return {
    list: (cwd, limit = 50) => listStored(executable, cwd, limit),
    title: async (id, cwd) =>
      (await listStored(executable, cwd, 200)).find((s) => s.id === id)?.title ?? null,
    import: async (id, cwd) => {
      const doc = await exportSession(executable, id, cwd);
      return doc ? replayExport(doc) : [];
    },
    promptCount: async (id, cwd) => {
      const doc = await exportSession(executable, id, cwd);
      return doc ? exportPromptCount(doc) : 0;
    },
    delete: async (id, cwd) => {
      await run(executable, ["session", "delete", id], { cwd, timeout: 15_000 });
    },
  };
}

/**
 * OpenCode: an ACP subprocess (`opencode acp`) per session, plus the CLI's
 * own `session`/`export` commands for the transcript side.
 */
export const OPENCODE_ACP: AcpDriverConfig = {
  id: "opencode",
  label: "OpenCode",
  modes: [
    { id: "build", label: "Build", tier: "moderate" },
    { id: "plan", label: "Plan", tier: "planning" },
  ],
  defaultModeId: "build",
  capabilities: {
    steer: false,
    rewind: false,
    usage: false,
    contextUsage: true,
    fastMode: false,
    effort: false,
    modelSelect: true,
    slashCommands: true,
    mcpServers: true,
    inProcessMcp: false,
    planMode: "plan",
    subtasks: false,
  },
  resolveExecutable: resolveOpencodeExecutable,
  acpArgs: ["acp"],
  loggedIn: opencodeLoggedIn,
  store: opencodeStore,
};
