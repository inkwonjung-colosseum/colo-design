import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RepoSettingsWarning } from "@colo-design/protocol";
import { CONFIG_DIR, currentPlatform } from "./environment.js";

/**
 * 클론과 Claude Code 사이의 네 가지 — 레포가 스스로 넓힌 권한을 잘라 내고
 * 원본을 보관하는 일(`sanitizeRepoAgentSettings`), 잘라 낸 사실을 사용자에게
 * 보이게 하는 경고(`repoSettingsWarning`), 데스크톱이 실어 온 런타임을 레포
 * 명령의 PATH 앞에 붙이는 일(`extraPathPrefix`), 그리고 대화형 신뢰 대화상자가
 * 없는 데몬이 클론을 신뢰로 등록하는 일(`trustWorkspace`).
 *
 * `RepoWorkspace` 에서 떼어 둔 이유: 앞의 셋은 워크스페이스의 상태를 읽지
 * 않고, 온보딩 쪽에서도 쓰인다. `extraPathPrefix` 가 여기 있으면
 * `server → onboarding → repo` 순환도 끊긴다.
 */

/** The settings files a repo can ship that the project tier loads verbatim. */
const AGENT_SETTINGS_FILES = [".claude/settings.json", ".claude/settings.local.json"] as const;

interface QuarantineEntry {
  /** Repo-relative path the entry was cut from. */
  file: string;
  /** The widening keys that were removed, in field order. */
  removed: string[];
  /** The file's bytes exactly as the repo shipped them. */
  originalRaw: string;
}

interface QuarantineRecord {
  root: string;
  /** When the last cut happened (ISO) — a record is written only on a cut. */
  at: string;
  files: QuarantineEntry[];
}

/**
 * The keys a repo must not get to set. `hooks` runs shell commands on
 * lifecycle events; `env` owns `ANTHROPIC_BASE_URL` and friends — a
 * repo-held faucet for every prompt and credential the session touches;
 * `permissions.allow` pre-approves tools no card will ever ask about.
 * `permissions.deny` and `permissions.ask` only narrow, so they survive.
 */
function stripWideningSettings(raw: string): { stripped: string; removed: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A broken file is the CLI's news, not ours.
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const removed: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === "hooks" || key === "env") {
      removed.push(key);
      continue;
    }
    if (key === "permissions" && value && typeof value === "object" && !Array.isArray(value)) {
      const rest: Record<string, unknown> = {};
      for (const [rule, rules] of Object.entries(value as Record<string, unknown>)) {
        if (rule === "allow") {
          removed.push("permissions.allow");
          continue;
        }
        rest[rule] = rules;
      }
      if (Object.keys(rest).length > 0) out[key] = rest;
      continue;
    }
    out[key] = value;
  }
  if (removed.length === 0) return null;
  return { stripped: `${JSON.stringify(out, null, 2)}\n`, removed };
}

function readQuarantine(root: string, configDir: string): QuarantineRecord | null {
  // 파일명은 레포 루트의 sha256 — 루트 경로가 그대로 파일명이 되지 않게 한다.
  const id = createHash("sha256").update(root).digest("hex");
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(configDir, "settings-quarantine", `${id}.json`), "utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as QuarantineRecord;
    return Array.isArray(record.files) ? record : null;
  } catch {
    return null;
  }
}

/**
 * Cut the widening keys out of a clone's Claude Code project settings before
 * any session loads them. The project tier itself is deliberate — it is how
 * the repo's CLAUDE.md reaches the session — but the tier's trust is auto-
 * accepted here (see `trustWorkspace`), so a repo shipping `hooks` would
 * otherwise run shell commands at session start, or pre-approve tools past
 * every card, with a passive warning line as the only trace. Now the keys
 * are gone before the CLI reads the file; the original bytes go to a 0600
 * quarantine record under the daemon's config dir, and
 * `repoSettingsWarning` speaks from that record.
 *
 * Runs at clone, at every bring-up refresh (a pull can restore the file),
 * at daemon start for every cloned project, and at every session launch —
 * a mid-turn edit of settings.json by the agent meets the cut on the next
 * query. Idempotent: an already-clean file touches nothing, so the record
 * and its timestamps survive restarts unchanged.
 */
export function sanitizeRepoAgentSettings(root: string, configDir: string = CONFIG_DIR): boolean {
  const record = readQuarantine(root, configDir) ?? { root, at: "", files: [] };
  const entries = new Map(record.files.map((entry) => [entry.file, entry]));
  let changed = false;
  for (const rel of AGENT_SETTINGS_FILES) {
    let raw: string;
    try {
      raw = readFileSync(join(root, rel), "utf8");
    } catch {
      continue; // Absent (the normal repo) or unreadable — nothing to cut.
    }
    const cut = stripWideningSettings(raw);
    if (!cut) continue;
    // temp+rename — a crash never leaves half a settings file behind.
    const file = join(root, rel);
    const temporary = `${file}.colo-design-${process.pid}`;
    writeFileSync(temporary, cut.stripped, { mode: 0o644 });
    renameSync(temporary, file);
    entries.set(rel, { file: rel, removed: cut.removed, originalRaw: raw });
    changed = true;
  }
  if (!changed) return false;
  record.files = [...entries.values()];
  record.at = new Date().toISOString();
  const id = createHash("sha256").update(root).digest("hex");
  const target = join(configDir, "settings-quarantine", `${id}.json`);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.colo-design-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
  return true;
}

/**
 * The header warning for a repo whose widening settings were cut — reads
 * from the quarantine record, so it stays truthful after the file on disk
 * is already clean, and re-arming it (the same fingerprint again) is a
 * client's "seen it" rather than news. The fingerprint hashes the repo root
 * and the ORIGINAL bytes: new dangerous content is a new fingerprint.
 */
export function repoSettingsWarning(
  root: string,
  configDir: string = CONFIG_DIR,
): RepoSettingsWarning | null {
  const record = readQuarantine(root, configDir);
  if (!record || record.files.length === 0) return null;
  const named = record.files
    .map((entry) => `${entry.file}(${entry.removed.join(", ")})`)
    .join(" · ");
  const hash = createHash("sha256").update(root).update("\0");
  for (const entry of record.files) hash.update(entry.originalRaw).update("\0");
  return {
    text: `이 레포가 보낸 설정의 권한 확장 키(${named})를 잘라 냈습니다 — 권한 카드 없이는 실행되지 않아요. 원본은 데몬 설정 디렉터리의 settings-quarantine 에 있습니다.`,
    fingerprint: hash.digest("hex"),
  };
}

/** PATH with COLO_DESIGN_EXTRA_PATH prepended when the desktop app sets it. */
export function extraPathPrefix(
  extra: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: "win32" | "darwin" | "linux" = currentPlatform(),
): string {
  const separator = platform === "win32" ? ";" : ":";
  if (!extra || extra.trim() === "") return env.PATH ?? "";
  const parts = (env.PATH ?? "").split(separator).filter(Boolean);
  const additions = extra.split(separator).filter(Boolean);
  const merged = [...additions];
  for (const part of parts) if (!merged.includes(part)) merged.push(part);
  return merged.join(separator);
}

// ---------------------------------------------------------------------------

/**
 * Claude Code drops every `permissions.allow` entry from a project's
 * `.claude/settings.json` until that directory has been trusted, and says so
 * only on stderr. The repo's rules are what keep approval cards away from a
 * planner, so an untrusted clone silently turns the product into a stream of
 * permission prompts. The trust dialog is interactive and the daemon has no
 * terminal, so record the acceptance the same way the CLI does.
 *
 * Connecting a repo is an explicit act by the planner, so accepting on their
 * behalf grants nothing they did not ask for.
 */
export function trustWorkspace(root: string, home = homedir()): void {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? home;
  const configFile = join(configDir, ".claude.json");
  mkdirSync(configDir, { recursive: true });

  let config: { projects?: Record<string, Record<string, unknown>> } = {};
  if (existsSync(configFile)) {
    try {
      config = JSON.parse(readFileSync(configFile, "utf8"));
    } catch {
      // A corrupt config is the CLI's problem to report; overwriting it with a
      // fresh object would throw away the user's own projects.
      return;
    }
  }

  // The CLI keys projects by the resolved cwd, which on macOS turns /tmp into
  // /private/tmp. Record both spellings when they differ.
  const keys = new Set([root]);
  try {
    keys.add(realpathSync(root));
  } catch {
    // Not created yet; the literal path is the best we can do.
  }

  // 실사: 파일이 최상위에 primitive 를 담아 두면 그 자리에 쓰는 순간 TypeError
  // 로 터져 데몬 기동이 죽는다 — 깨진 파일의 처리는 위의 parse 와 같은 갈래다.
  if (typeof config !== "object" || config === null) return;
  // 같은 충돌이 projects 자리와 행마다의 자리에서도난다 — ??= 관용구를 만나기
  // 전에 모양을 고쳐 놓는다.
  if (
    typeof config.projects !== "object" ||
    config.projects === null ||
    Array.isArray(config.projects)
  ) {
    config.projects = {};
  }
  const projects = config.projects;
  let changed = false;
  for (const key of keys) {
    const project = projects[key];
    if (typeof project !== "object" || project === null || Array.isArray(project)) {
      projects[key] = {};
    }
    const target = projects[key]!;
    if (target.hasTrustDialogAccepted !== true) {
      target.hasTrustDialogAccepted = true;
      changed = true;
    }
  }
  if (!changed) return;

  // The CLI rewrites this file whenever a session ends, so replace it in one
  // step rather than leaving a window where it is half written.
  const temporary = `${configFile}.colo-design-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, configFile);
}
