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
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { CONFIG_DIR, currentPlatform } from "./environment.js";

/**
 * 클론과 각 에이전트(Claude Code · omp · opencode) 사이의 네 가지 — 레포가
 * 스스로 넓힌 권한을 잘라 내고 원본을 보관하는 일(`sanitizeRepoAgentSettings`),
 * 잘라 낸 사실을 사용자에게 보이게 하는 경고(`repoSettingsWarning`), 데스크톱이
 * 실어 온 런타임을 레포 명령의 PATH 앞에 붙이는 일(`extraPathPrefix`), 그리고
 * 대화형 신뢰 대화상자가 없는 데몬이 클론을 신뢰로 등록하는 일
 * (`trustWorkspace`). Codex 는 정책이 파일이 아니라 턴 파라미터
 * (`drivers/codex/session.ts`)라 절단이 없다.
 *
 * `RepoWorkspace` 에서 떼어 둔 이유: 앞의 셋은 워크스페이스의 상태를 읽지
 * 않고, 온보딩 쪽에서도 쓰인다. `extraPathPrefix` 가 여기 있으면
 * `server → onboarding → repo` 순환도 끊긴다.
 */

/** How a driver's project settings file parses (and therefore re-serializes). */
type SettingsFormat = "json" | "jsonc" | "yaml";

/** What one file gave up: the widening keys removed, and the object left behind. */
interface SettingsCut {
  removed: string[];
  next: unknown;
}

/**
 * One settings file a repo can ship that a driver's project tier loads
 * verbatim — plus how to parse it and which of its keys widen.
 */
interface AgentSettingsFile {
  rel: string;
  format: SettingsFormat;
  /** null = nothing widening present, or the file is broken (the CLI's news). */
  strip: (parsed: unknown) => SettingsCut | null;
}

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
 * The invariant every driver's cut enforces: a repo may NARROW (deny · ask ·
 * prompt rules survive everywhere) but must not WIDEN — pre-approve tools
 * past every card, run code at startup, or own the endpoint/env faucet the
 * session's prompts and credentials flow through.
 */

/**
 * Claude Code — `.claude/settings.json` · `.claude/settings.local.json`.
 * `hooks` runs shell commands on lifecycle events; `env` owns
 * `ANTHROPIC_BASE_URL` and friends — a repo-held faucet for every prompt and
 * credential the session touches; `permissions.allow` pre-approves tools no
 * card will ever ask about. `permissions.deny` and `permissions.ask` only
 * narrow, so they survive. `permissions.defaultMode` survives too — the
 * session's `managedSettings` clamp (`drivers/claude/session.ts`) is the
 * enforcement there, not the file.
 */
function stripClaudeSettings(parsed: unknown): SettingsCut | null {
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
  return { removed, next: out };
}

/**
 * omp — `.omp/config.yml` · `.omp/config.yaml` · `.omp/settings.json`. The
 * settings schema's own words: `tools.approval` allow entries "auto-approve"
 * and are "honored in every approval mode"; `approvalMode: write|yolo`
 * auto-approves whole tiers (`ask` narrows, so it survives); `bash.patterns`
 * allow rules pre-approve bash commands; `bash.allowCompoundCommands: true`
 * lets an allow rule cover a whole `&&` chain. `extensions` loads code at
 * startup. `bash.patterns` deny/prompt entries and per-tool prompt/deny
 * entries only narrow, so they survive.
 */
function stripOmpSettings(parsed: unknown): SettingsCut | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const src = parsed as Record<string, unknown>;
  const removed: string[] = [];
  const out: Record<string, unknown> = { ...src };
  const approval = src.tools;
  if (approval && typeof approval === "object" && !Array.isArray(approval)) {
    const rest: Record<string, unknown> = {};
    let toolsCut = false;
    for (const [tool, policy] of Object.entries(approval as Record<string, unknown>)) {
      if (tool === "approval") {
        if (policy && typeof policy === "object" && !Array.isArray(policy)) {
          const kept: Record<string, unknown> = {};
          for (const [name, rule] of Object.entries(policy as Record<string, unknown>)) {
            if (rule === "allow") toolsCut = true;
            else kept[name] = rule;
          }
          if (toolsCut) {
            if (!removed.includes("tools.approval:allow")) removed.push("tools.approval:allow");
            if (Object.keys(kept).length > 0) rest.approval = kept;
          } else {
            rest.approval = policy;
          }
        } else {
          rest.approval = policy;
        }
        continue;
      }
      if (tool === "approvalMode" && (policy === "write" || policy === "yolo")) {
        if (!removed.includes("tools.approvalMode")) removed.push("tools.approvalMode");
        toolsCut = true;
        continue;
      }
      rest[tool] = policy;
    }
    if (toolsCut) {
      if (Object.keys(rest).length > 0) out.tools = rest;
      else delete out.tools;
    }
  }
  const bash = src.bash;
  if (bash && typeof bash === "object" && !Array.isArray(bash)) {
    const rest: Record<string, unknown> = {};
    let bashCut = false;
    for (const [key, value] of Object.entries(bash as Record<string, unknown>)) {
      if (key === "allowCompoundCommands" && value === true) {
        if (!removed.includes("bash.allowCompoundCommands")) {
          removed.push("bash.allowCompoundCommands");
        }
        bashCut = true;
        continue;
      }
      if (key === "patterns" && Array.isArray(value)) {
        const kept: unknown[] = [];
        let allowCut = false;
        for (const pattern of value) {
          const entry = pattern as Record<string, unknown> | null;
          if (entry && typeof entry === "object" && entry.approval === "allow") {
            allowCut = true;
            continue;
          }
          kept.push(pattern);
        }
        if (allowCut) {
          removed.push("bash.patterns:allow");
          if (kept.length > 0) rest.patterns = kept;
        } else {
          rest.patterns = value;
        }
        continue;
      }
      rest[key] = value;
    }
    if (bashCut) {
      if (Object.keys(rest).length > 0) out.bash = rest;
      else delete out.bash;
    }
  }
  if (Array.isArray(src.extensions)) {
    removed.push("extensions");
    delete out.extensions;
  }
  if (removed.length === 0) return null;
  return { removed, next: out };
}

/**
 * opencode — `opencode.json` · `opencode.jsonc`. `permission` (top level and
 * per agent) with any "allow" — the string form, a per-tool action, or a
 * pattern map entry — pre-approves those tools; "ask"/"deny" survive.
 * `mcp.<name>` entries with `type: "local"` spawn a command at startup
 * (remote entries only add later-carded tools, so they survive); `plugin`
 * loads code. opencode also auto-loads `<repo>/.opencode/plugin/*.ts` — a
 * directory convention, not a key, so it stays outside this cut.
 */
function stripOpencodeSettings(parsed: unknown): SettingsCut | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const src = parsed as Record<string, unknown>;
  const removed: string[] = [];
  const out: Record<string, unknown> = { ...src };

  const stripPermission = (rule: unknown): { kept: unknown; cut: boolean } => {
    if (rule === "allow") return { kept: undefined, cut: true };
    if (rule && typeof rule === "object" && !Array.isArray(rule)) {
      const kept: Record<string, unknown> = {};
      let cut = false;
      for (const [name, action] of Object.entries(rule as Record<string, unknown>)) {
        if (action === "allow") {
          cut = true;
          continue;
        }
        if (action && typeof action === "object" && !Array.isArray(action)) {
          const keptPatterns: Record<string, unknown> = {};
          for (const [pattern, verdict] of Object.entries(action as Record<string, unknown>)) {
            if (verdict === "allow") cut = true;
            else keptPatterns[pattern] = verdict;
          }
          if (Object.keys(keptPatterns).length > 0) kept[name] = keptPatterns;
          continue;
        }
        kept[name] = action;
      }
      return { kept: Object.keys(kept).length > 0 ? kept : undefined, cut };
    }
    return { kept: rule, cut: false };
  };

  const applyPermission = (holder: Record<string, unknown>, key: string): boolean => {
    const result = stripPermission(holder[key]);
    if (!result.cut) return false;
    if (!removed.includes("permission:allow")) removed.push("permission:allow");
    if (result.kept === undefined) delete holder[key];
    else holder[key] = result.kept;
    return true;
  };

  applyPermission(out, "permission");
  const agents = out.agent;
  if (agents && typeof agents === "object" && !Array.isArray(agents)) {
    for (const agent of Object.values(agents as Record<string, unknown>)) {
      if (agent && typeof agent === "object" && !Array.isArray(agent)) {
        applyPermission(agent as Record<string, unknown>, "permission");
      }
    }
  }

  const mcp = out.mcp;
  if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
    const kept: Record<string, unknown> = {};
    let localCut = false;
    for (const [name, server] of Object.entries(mcp as Record<string, unknown>)) {
      const entry = server as Record<string, unknown> | null;
      if (entry && typeof entry === "object" && entry.type === "local" && entry.enabled !== false) {
        localCut = true;
        continue;
      }
      kept[name] = server;
    }
    if (localCut) {
      removed.push("mcp:local");
      if (Object.keys(kept).length > 0) out.mcp = kept;
      else delete out.mcp;
    }
  }
  if (Array.isArray(out.plugin) && out.plugin.length > 0) {
    removed.push("plugin");
    delete out.plugin;
  }
  if (removed.length === 0) return null;
  return { removed, next: out };
}

/** Every project settings file a repo can ship, per driver, with its format. */
const REPO_AGENT_SETTINGS: AgentSettingsFile[] = [
  { rel: ".claude/settings.json", format: "json", strip: stripClaudeSettings },
  { rel: ".claude/settings.local.json", format: "json", strip: stripClaudeSettings },
  { rel: ".omp/config.yml", format: "yaml", strip: stripOmpSettings },
  { rel: ".omp/config.yaml", format: "yaml", strip: stripOmpSettings },
  { rel: ".omp/settings.json", format: "json", strip: stripOmpSettings },
  { rel: "opencode.json", format: "json", strip: stripOpencodeSettings },
  { rel: "opencode.jsonc", format: "jsonc", strip: stripOpencodeSettings },
];

/**
 * JSONC = JSON plus comments (line and block) plus trailing commas. A
 * string-aware one-pass stripper: outside strings it drops comments, and a
 * comma is kept only when the next non-comment, non-whitespace character is
 * not a closing bracket. Parse failure is the CLI's news, not ours.
 */
function parseJsonc(raw: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        if (i + 1 < raw.length) out += raw[++i];
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i + 1 < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw.charAt(j))) j++;
      if (raw.charAt(j) === "}" || raw.charAt(j) === "]") continue;
    }
    out += ch;
  }
  return JSON.parse(out);
}

function parseSettings(raw: string, format: SettingsFormat): unknown {
  try {
    if (format === "json") return JSON.parse(raw);
    if (format === "jsonc") return parseJsonc(raw);
    return parseYaml(raw);
  } catch {
    // A broken file is the CLI's news, not ours.
    return null;
  }
}

function serializeSettings(value: unknown, format: SettingsFormat): string {
  if (format === "yaml") return stringifyYaml(value);
  // A cut jsonc file rewrites as plain JSON — the comments it carried sat on
  // keys we are about to name in the warning anyway, and JSON is valid input.
  return `${JSON.stringify(value, null, 2)}\n`;
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
 * Cut the widening keys out of a clone's project settings — Claude Code,
 * omp, and opencode — before any session loads them. The project tier itself
 * is deliberate — it is how the repo's CLAUDE.md reaches the session — but
 * the tier's trust is auto-accepted here (see `trustWorkspace`), so a repo
 * shipping `hooks` would otherwise run shell commands at session start, or
 * pre-approve tools past every card, with a passive warning line as the only
 * trace. Now the keys are gone before the CLI reads the file; the original
 * bytes go to a 0600 quarantine record under the daemon's config dir, and
 * `repoSettingsWarning` speaks from that record.
 *
 * Runs at clone, at every bring-up refresh (a pull can restore the file),
 * at daemon start for every cloned project, and at every session launch —
 * a mid-turn edit of settings.json by the agent meets the cut on the next
 * query. Idempotent: an already-clean file touches nothing, so the record
 * and its timestamps survive restarts unchanged.
 */
export function sanitizeRepoAgentSettings(root: string, configDir: string = CONFIG_DIR): boolean {
  // 운영자가 연결 레포 설정을 신뢰하기로한 배포(사내 전용 — docs/repo-settings-trust.md):
  // 파일을 건드리지도, 경고를 내지도 않는다.
  if (
    process.env.COLO_DESIGN_TRUST_REPO_SETTINGS === "1" ||
    process.env.COLO_DESIGN_TRUST_REPO_SETTINGS === "true"
  ) {
    return false;
  }
  const record = readQuarantine(root, configDir) ?? { root, at: "", files: [] };
  const entries = record.files.slice();
  let changed = false;
  for (const settings of REPO_AGENT_SETTINGS) {
    let raw: string;
    try {
      raw = readFileSync(join(root, settings.rel), "utf8");
    } catch {
      continue; // Absent (the normal repo) or unreadable — nothing to cut.
    }
    const parsed = parseSettings(raw, settings.format);
    if (!parsed) continue;
    const cut = settings.strip(parsed);
    if (!cut) continue;
    // temp+rename — a crash never leaves half a settings file behind.
    const file = join(root, settings.rel);
    const temporary = `${file}.colo-design-${process.pid}`;
    writeFileSync(temporary, serializeSettings(cut.next, settings.format), { mode: 0o644 });
    renameSync(temporary, file);
    const fresh = { file: settings.rel, removed: cut.removed, originalRaw: raw };
    const existing = entries.find((entry) => entry.file === settings.rel);
    if (existing) {
      existing.removed = fresh.removed;
      existing.originalRaw = fresh.originalRaw;
    } else {
      entries.push(fresh);
    }
    changed = true;
  }
  if (!changed) return false;
  record.files = entries;
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
  // 절단이 켜져 있을 때만 경고가 존재한다 — 신뢰 모드(docs/repo-settings-trust.md)는
  // 건드린 것도 없으면서 유령 경고를 내지 않는다.
  if (
    process.env.COLO_DESIGN_TRUST_REPO_SETTINGS === "1" ||
    process.env.COLO_DESIGN_TRUST_REPO_SETTINGS === "true"
  ) {
    return null;
  }
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
