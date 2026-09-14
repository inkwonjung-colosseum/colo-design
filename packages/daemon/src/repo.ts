import { type ChildProcess, execFile, type SpawnOptions, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { get as httpGet } from "node:http";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
// The summarizer's one Claude turn (PLAN D51) rides the same SDK the
// sessions use — one login, one code path, no `-p` process to spawn.
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  DeveloperReview,
  DiffFile,
  DiffHunk,
  DiffStatus,
  HandoffShot,
  HandoffStatus,
  HandoffStatusReport,
  RepoCheckpoint,
  RepoCheckpointRestore,
  RepoCheckpoints,
  RepoDiscard,
  RepoErrorKind,
  RepoHistory,
  RepoPhase,
  RepoSettingsWarning,
  RepoStatus,
  RepoSummary,
} from "@colo-design/protocol";
import { markTurn } from "@colo-design/protocol";
import { readComments } from "./comments.js";
import { mergeNpmrc, npmrcPath } from "./credentials.js";
import {
  COLO_DESIGN_DIR,
  currentPlatform,
  detectsRegistryAuthFailure,
  resolveGitExecutable,
  resolvePnpmExecutable,
} from "./environment.js";
import { type GitHubClient, parseRepoSlug } from "./github.js";

/**
 * The connected repo workspace: a clone of the repo the planner pointed the
 * daemon at, driven by that repo's own `colo-design.json` (install/check/build
 * commands, preview command + port, optional private registry). The daemon
 * clones and pulls it, runs its commands, and frames its preview server —
 * what the preview renders is entirely the repo's business.
 */

const CONFIG_FILE = "colo-design.json";
/** Reinstall marker, kept inside `.git/` so it travels with the clone only. */
const INSTALL_MARKER = "colo-design-install-hash";
/**
 * 실사 결함: fresh clone 의 첫 미리보기 부팅(next dev cold compile)이 30 초를
 * 넘겼다 — 시간 예산 안에 뜨는 fixture 로는 잡히지 않는다. 데드라인은 실제
 * 레포의 첫 부팅이 들어올 만큼 넉넉해야 한다.
 */
const READY_TIMEOUT_MS = 120_000;
const DETAIL_THROTTLE_MS = 200;
/** Commit message when the planner approves without writing one. */
const DEFAULT_COMMIT_MESSAGE = "Colo Design 화면 변경";
/** PR title when the planner sends the handoff without editing it. */
const DEFAULT_HANDOFF_TITLE = "Colo Design 화면 전달";
/** D56: where a handoff's screen captures are committed, relative to the root. */
const SHOTS_DIR = ".colo-design/shots";
/** D56: the captures ride their own commit — the reviewed diff stays the planner's. */
const SHOTS_COMMIT_MESSAGE = "Colo Design 화면 미리보기 캡처";
/**
 * Every branch this tool creates lives under one prefix, so a developer can
 * tell at a glance which branches a planner made and which are theirs.
 */
const BRANCH_PREFIX = "colo-design";
/** How many output lines a failed gate quotes back to people and Claude. */
const GATE_OUTPUT_TAIL_LINES = 30;
/**
 * Where every turn-start snapshot lives (PLAN D52). A namespace of its own
 * under `refs/`, so a developer's `git for-each-ref` never trips over it by
 * accident and one `refs/colo-design/checkpoints` listing sweeps it.
 */
const CHECKPOINT_REF_PREFIX = "refs/colo-design/checkpoints";
/** D52: a session keeps its most recent snapshots; older ones are deleted. */
const CHECKPOINTS_PER_SESSION = 20;
/** D51: how long the summary's one Claude turn may take before the fallback. */
const SUMMARY_TIMEOUT_MS = 3_000;
/** D51: "3줄 이내" — and that is all the save review shows first, anyway. */
const SUMMARY_MAX_LINES = 3;
/** D51: per-file diff fed to the summarizer — a refactor's full diff is noise. */
const SUMMARY_HUNK_CHAR_LIMIT = 4_096;
/** The fallback bucket for a changed file with no folder above it. */
const FALLBACK_ROOT_GROUP = "기타";

/**
 * What Claude is told when a step fails, named the way the planner's own
 * button is. "push 단계가 실패했습니다" would send it looking for a git
 * problem when the planner pressed 저장.
 */
const GATE_BRIEF: Record<"commit" | "push" | "pr", string> = {
  commit: "저장할 변경을 커밋하지 못했습니다.",
  push: "저장한 변경을 올리지 못했습니다.",
  pr: "개발자에게 넘기지 못했습니다.",
};

/**
 * The same five failures, named for the button the planner pressed rather than
 * for the step that ran. This is what the transcript CARD says (PLAN D9); the
 * brief above is what Claude reads, command output and all.
 */
/**
 * D90 ⓑ: push 거절 중 인증 · 권한 사유의 표식 — 이 문자열들이면 Claude 대신
 * 설정 안내로 간다. 문자열 분기의 위험(D41)은 상수 하나에 모으고 단위 테스트가
 * 잡는 것으로; 모르면 Claude 쪽(보수적)이다.
 */
const BOOTSTRAP_FAILED_DETAIL =
  "Claude 가 연결 준비를 마치지 못했습니다 — 설정의 문제 해결에서 자세히 본 뒤 대화에서 이어 가세요.";

// 리뷰 C6: 만료 · 무효 토큰의 말(401, Bad credentials, expired)도 같은
// 안내로 가야 한다 — 만료 토큰으로 push 하면 Claude 에게 헛돌았다.
export const PUSH_AUTH_FAILURE =
  /401|403|Permission denied|authentication|denied to|not authorized|bad credentials|credentials? (?:expired|invalid)|token expired|authenticity/i;

const GATE_STEP: Record<"commit" | "push" | "pr", string> = {
  commit: "저장",
  push: "저장한 내용 올리기",
  pr: "개발자에게 넘기기",
};
/**
 * The stash this tool parks unsaved work in while 최신화 moves the branch.
 * Named for the button, so `git stash list` reads like the product, not git.
 */
const STASH_MESSAGE = "Colo Design: 최신화 임시 보관";

/** What the planner reads when a conflict needs Claude and no thread is open. */
const REFRESH_CONFLICT_DETAIL =
  "최신 변경을 받아 오다 저장하지 않은 변경과 충돌이 남았습니다 — 대화를 열면 Claude가 정리합니다. 정리 전까지는 같은 상태입니다.";

/**
 * What the planner reads when replaying a dead run's parked work conflicts
 * and no thread is open — same state and remedy as REFRESH_CONFLICT_DETAIL,
 * named for how the work got parked.
 */
const RECOVER_CONFLICT_DETAIL =
  "임시 보관해 둔 저장하지 않은 변경을 돌려놓다 겹치는 부분이 생겼습니다 — 대화를 열면 Claude가 정리합니다. 정리 전까지는 같은 상태입니다.";

/** What the planner reads when a repo's commands have not been approved here. */
const COMMANDS_UNAPPROVED_DETAIL =
  "이 레포가 실행하기로 한 설치 · 미리보기 명령이 아직 승인되지 않았습니다 — 실행 허용을 누르면 준비를 계속합니다.";

/**
 * The one refresh this tool refuses to do alone: the base branch carries
 * commits the clone does not know. Rewriting history a planner cannot read
 * is not 자동 병합, so it stays a named failure.
 */
const REFRESH_DIVERGED_DETAIL =
  "기본 브랜치에 원격과 갈라진 커밋이 있어 자동 최신화를 멈췄습니다 — 대화를 열면 Claude가 확인합니다.";

const PNPM_MISSING_DETAIL =
  "pnpm이 없습니다 — corepack enable 또는 npm i -g pnpm 으로 설치해 주세요.";
const REGISTRY_AUTH_DETAIL =
  "GitHub 패키지 인증이 필요합니다 — pnpm config set //npm.pkg.github.com/:_authToken <read:packages 권한 PAT>";
export const REPO_URL_MISSING_DETAIL =
  "연결 레포 주소가 설정되지 않았습니다 — 설정에서 레포 주소를 넣어 주세요.";

// ---------------------------------------------------------------------------
// colo-design.json contract
// ---------------------------------------------------------------------------

export interface ColoDesignRegistry {
  host: string;
  scope: string;
}

export interface ColoDesignConfig {
  install?: string;
  check?: string;
  build?: string;
  preview: { command: string; port: number };
  registry?: ColoDesignRegistry;
  /** D56: `false` refuses the handoff's screen captures — no files, no PR section. */
  shots?: boolean;
}

/**
 * Parses and validates a repo's `colo-design.json`. Every rejection names the
 * field and what it should be, in Korean: the planner is the one who has to
 * act on it, and "invalid config" is not actionable.
 */
export function parseColoDesignConfig(source: string): ColoDesignConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `colo-design.json을 해석할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("colo-design.json은 객체여야 합니다");
  }
  const config = raw as Record<string, unknown>;

  for (const key of ["install", "check", "build"] as const) {
    const value = config[key];
    if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
      throw new Error(`colo-design.json의 ${key}는 실행할 명령을 문자열로 적어야 합니다`);
    }
  }

  const preview = config.preview;
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) {
    throw new Error(
      'colo-design.json에 preview가 없습니다 — { "command", "port" }를 적어야 합니다',
    );
  }
  const { command, port } = preview as Record<string, unknown>;
  if (typeof command !== "string" || command.trim() === "") {
    throw new Error("colo-design.json의 preview.command가 없습니다 — 미리보기를 띄울 명령입니다");
  }
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new Error(
      "colo-design.json의 preview.port가 잘못되었습니다 — 1~65535 사이의 포트 번호여야 합니다",
    );
  }

  if (config.shots !== undefined && typeof config.shots !== "boolean") {
    throw new Error("colo-design.json의 shots는 true 또는 false여야 합니다");
  }

  const common = {
    ...(typeof config.install === "string" ? { install: config.install } : {}),
    ...(typeof config.check === "string" ? { check: config.check } : {}),
    ...(typeof config.build === "string" ? { build: config.build } : {}),
    ...(config.shots !== undefined ? { shots: config.shots } : {}),
    preview: { command, port: port as number },
  };

  const rawRegistry = config.registry;
  if (rawRegistry === undefined) return common;

  const registry = rawRegistry as Record<string, unknown>;
  if (
    typeof registry.host !== "string" ||
    registry.host.trim() === "" ||
    typeof registry.scope !== "string" ||
    registry.scope.trim() === ""
  ) {
    throw new Error('colo-design.json의 registry는 { "host", "scope" } 형태여야 합니다');
  }
  // The registry line is the one place a connected repo aims the machine's
  // GitHub PAT: its host lands in ~/.npmrc as `//<host>/:_authToken=<PAT>`.
  // A repo must not point that at a server of its choosing — GitHub's npm
  // endpoints (npm.pkg.github.com and its subdomains) only.
  const host = registry.host.trim().toLowerCase();
  if (host !== "npm.pkg.github.com" && !host.endsWith(".pkg.github.com")) {
    throw new Error(
      "colo-design.json의 registry.host는 GitHub 패키지 호스트(npm.pkg.github.com)여야 합니다",
    );
  }

  return { ...common, registry: { host, scope: registry.scope } };
}

export function readColoDesignConfig(root: string): ColoDesignConfig {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) {
    throw new Error(
      `colo-design.json이 없습니다 — 연결 레포 루트에 ${CONFIG_FILE}가 있어야 합니다`,
    );
  }
  return parseColoDesignConfig(readFileSync(file, "utf8"));
}

/**
 * A connected repo can ship Claude Code project settings — and with them
 * `permissions.allow` rules that pre-approve tools no card will ever ask
 * about. Loading the project tier is deliberate (it is also how the repo's
 * CLAUDE.md reaches the session), so this does not block: it makes the
 * repo's ask visible, as one header warning line. The fingerprint (repo
 * root + raw bytes) is how a client files the news as read without
 * mistaking an edited file — or another repo — for news it already saw.
 */
export function repoSettingsWarning(root: string): RepoSettingsWarning | null {
  const file = join(root, ".claude", "settings.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    // Absent (the normal repo) or unreadable — nothing to report either way.
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A broken file is the CLI's news, not ours.
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const widening = (["permissions", "env", "hooks"] as const).filter((key) => key in parsed);
  if (widening.length === 0) return null;
  // 실사 결함: 보안 의도는 좋았지만 영어 한 줄이었다 — 이 도구를 읽는 기획자는
  // 한국어다. 무엇이 사전 승인되는지 그 자리에서 알려 준다.
  return {
    text: `이 레포가 보낸 .claude/settings.json(${widening.join(", ")})이 일부 도구를 미리 승인합니다 — 권한 카드 없이 실행될 수 있어요.`,
    fingerprint: createHash("sha256").update(root).update("\0").update(raw).digest("hex"),
  };
}

// ---------------------------------------------------------------------------
// Credential helpers (pure, unit tested)
// ---------------------------------------------------------------------------

/** The schemes a clone url may carry; anything else is a refusal. */
const CLONABLE_SCHEMES: Record<string, true> = {
  http: true,
  https: true,
  ssh: true,
  git: true,
  file: true,
};

/** Why an unacceptable clone url is refused, in the words the picker reads. */
const CLONE_URL_REFUSED_DETAIL =
  "이 주소로는 레포를 내려받을 수 없습니다 — https · ssh · git 주소나 이 기기의 경로만 가능합니다.";

/**
 * What git accepts as a clone source is wider than what a planner should be
 * able to aim at this machine: the `ext::` family is a command executor
 * wearing a url, and a leading `-` is an option, not an address. Allowed:
 * the web's two, the git/ssh remotes, scp-style `user@host:path`, and a
 * local path (the offline suites' bare remotes). Every wire entry that
 * names a repo url runs through this before the registry hears it.
 */
export function assertClonableRepoUrl(url: string): void {
  const trimmed = url.trim();
  // Bracketed IPv6 literals are the one place `::` is an address, not a helper.
  const unbracketed = trimmed.replace(/\[[^\]]*\]/g, "[]");
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(trimmed)?.[1]?.toLowerCase();
  const localOrScp = /^([^@\s]+@[^:\s]+:|\/|\.\.?\/|~\/|[A-Za-z]:[\\/])/.test(trimmed);
  if (
    trimmed === "" ||
    (scheme !== undefined && !CLONABLE_SCHEMES[scheme]) ||
    unbracketed.includes("::") ||
    (scheme === undefined && !localOrScp)
  ) {
    throw new Error(CLONE_URL_REFUSED_DETAIL);
  }
}

/** git error output quotes the remote url; the PAT must never survive that. */
function redact(text: string, secret: string | null): string {
  return secret ? text.split(secret).join("***") : text;
}

// ---------------------------------------------------------------------------
// Unified diff parsing (pure, unit tested)
// ---------------------------------------------------------------------------

const DIFF_HEADER = /^diff --git a\/(.*) b\/(.*)$/;

/**
 * Parses `git diff HEAD` output into per-file hunks. Header noise (index,
 * mode, ---/+++) is dropped; `\ No newline at end of file` stays in the hunk
 * it belongs to, because it is part of what the planner is approving.
 */
export function parseUnifiedDiff(output: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;

  const lines = output.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // trailing newline artifact

  for (const line of lines) {
    const header = DIFF_HEADER.exec(line);
    if (header) {
      current = { path: header[2]!, status: "modified", hunks: [] };
      files.push(current);
      hunk = null;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "deleted";
    else if (line.startsWith("rename from ")) current.status = "renamed";
    else if (line.startsWith("rename to ")) current.path = line.slice("rename to ".length);
    else if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      current.binary = true;
      hunk = null;
    } else if (line.startsWith("@@")) {
      hunk = { header: line, lines: [] };
      current.hunks.push(hunk);
    } else if (
      hunk &&
      (line.startsWith("+") ||
        line.startsWith("-") ||
        line.startsWith(" ") ||
        line.startsWith("\\"))
    ) {
      hunk.lines.push(line);
    }
    // Everything else — index, mode, ---/+++ — is plumbing the panel does not show.
  }
  return files;
}

/** An untracked file is a change too: shown as one added-everything hunk. */
function untrackedAsAdded(root: string, rel: string): DiffFile {
  const file: DiffFile = { path: rel, status: "added", hunks: [] };
  let content: Buffer;
  try {
    content = readFileSync(join(root, rel));
  } catch {
    return file; // vanished mid-listing; the next diff.get will tell the truth
  }
  // A NUL byte in the head of the file is how git decides "binary" without a
  // parser; adopt the same cheap test.
  if (content.subarray(0, 8000).includes(0)) return { ...file, binary: true };
  const lines = content.toString("utf8").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) lines.push("");
  file.hunks = [
    {
      header: `@@ -0,0 +1,${lines.length} @@`,
      lines: lines.map((line) => `+${line}`),
    },
  ];
  return file;
}

// ---------------------------------------------------------------------------
// 요약 폴백 · 되돌리기 경로 규칙 (PLAN D51 · D52 · D53 — pure, unit tested)
// ---------------------------------------------------------------------------

/**
 * The folder a changed path is read as, for the summary's fallback (PLAN
 * D51): `src/screens/member/PayFailed.screen.tsx` → `member`. The folder
 * directly above the file is the one the repo's own convention names a
 * screen group with; a file with no folder above it lands in `기타`. This is
 * string cutting, not repo-convention reading — the daemon never decides
 * what a "screens" folder means.
 */
export function fallbackGroup(path: string): string {
  const segments = path.split("/");
  return segments.length >= 2
    ? (segments[segments.length - 2] ?? FALLBACK_ROOT_GROUP)
    : FALLBACK_ROOT_GROUP;
}

/**
 * The summary when Claude's turn cannot land (PLAN D51): the changed paths
 * grouped by their folder, `폴더: 수정 N · 추가 M` per group. Deterministic —
 * same diff, same lines — because this is what the planner reads when the
 * fancy version failed.
 */
export function fallbackSummary(files: Array<Pick<DiffFile, "path" | "status">>): string[] {
  const groups = new Map<string, { modified: number; added: number }>();
  for (const file of files) {
    const group = fallbackGroup(file.path);
    const counts = groups.get(group) ?? { modified: 0, added: 0 };
    if (file.status === "added") counts.added += 1;
    else counts.modified += 1;
    groups.set(group, counts);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([group, counts]) => {
      const parts: string[] = [];
      if (counts.modified > 0) parts.push(`수정 ${counts.modified}`);
      if (counts.added > 0) parts.push(`추가 ${counts.added}`);
      return `${group}: ${parts.join(" · ")}`;
    });
}

/**
 * The diff as the summarizer reads it: `git diff`-shaped lines, each file
 * capped at SUMMARY_HUNK_CHAR_LIMIT so one wholesale rewrite cannot crowd
 * the rest out of the prompt. The cap is on what Claude is handed — the
 * planner's `자세히 보기` still gets every hunk.
 */
function renderSummaryFile(file: DiffFile): string {
  if (file.binary) return `파일: ${file.path} (바이너리 — 내용 생략)`;
  const lines: string[] = [`파일: ${file.path}`];
  let size = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const piece =
        line.length > SUMMARY_HUNK_CHAR_LIMIT ? `${line.slice(0, SUMMARY_HUNK_CHAR_LIMIT)}…` : line;
      if (size + piece.length > SUMMARY_HUNK_CHAR_LIMIT) {
        lines.push("(이 파일의 나머지는 생략했습니다)");
        return lines.join("\n");
      }
      size += piece.length;
      lines.push(piece);
    }
  }
  return lines.join("\n");
}

/**
 * The summarizer's whole instruction (PLAN D51): the changed screens, the
 * diff, and the ask — planner's words, three lines, no file names. The
 * diff is the only thing this turn may read, so it rides in the prompt.
 */
function summaryPrompt(files: DiffFile[]): string {
  return [
    "아래는 저장 전에 검토할 변경 내용입니다. 바뀐 화면과 바뀐 점을 기획자 말로 3줄 이내, 파일 이름 없이 적어 주세요. 한 줄에 한 가지 바뀐 점을 적습니다.",
    "",
    `바뀐 화면·파일: ${files.map((file) => file.path).join(", ")}`,
    "",
    files.map(renderSummaryFile).join("\n"),
  ].join("\n");
}

/**
 * The one path rule every write here obeys — the same rule a save's
 * reviewed diff already follows: a repo-relative, forward-slash path that
 * stays inside the clone. Absolute paths and `..` are not paths inside a
 * worktree; they are an escape attempt, and an escape is refused with null.
 * Returns the normalized path otherwise.
 */
export function safeRepoPath(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  if (normalized === "" || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return null;
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : null;
}

/**
 * A checkpoint restore's plan (PLAN D52): `git diff --name-status <tree>`
 * splits into the paths to check out (present in the snapshot, changed
 * since) and the paths to delete (created after the snapshot). Only paths
 * the allow rule passes survive — a snapshot tree is git's own output, but
 * the plan is what gets executed, and the plan never reaches outside.
 */
export function restorePlan(
  nameStatus: string,
  allowed: (path: string) => boolean = (path) => safeRepoPath(path) !== null,
): { checkout: string[]; remove: string[] } {
  const checkout = new Set<string>();
  const remove = new Set<string>();
  for (const line of nameStatus.split(/\r?\n/)) {
    const trimmed = line.trim();
    const tab = trimmed.indexOf("\t");
    if (trimmed === "" || tab < 0) continue;
    const status = trimmed.slice(0, tab).trim();
    const path = trimmed.slice(tab + 1).trim();
    if (!allowed(path)) continue;
    // `--no-renames` keeps this to A/M/D/T; anything else (U, X) is a state
    // a mid-merge worktree is in, and a restore must not touch it.
    if (status === "A") remove.add(path);
    else if (status === "M" || status === "D" || status === "T") checkout.add(path);
  }
  return {
    checkout: [...checkout].sort(),
    remove: [...remove].sort(),
  };
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export class RepoWorkspace {
  readonly root: string;
  /**
   * The branch a handoff PR will target (PLAN D5[넘기기]). Nothing reads it in M1; it
   * lives beside the url because the same project decision fixes both.
   */
  readonly baseBranch: string;

  private url: string | null;
  private pat: string | null;
  private phase: RepoPhase = "missing";
  private detail: string | null = null;
  /** Set at the failure site, never sniffed back out of `detail` (PLAN D41). */
  private errorKind: RepoErrorKind | null = null;
  private config: ColoDesignConfig | null = null;
  private preview: ChildProcess | null = null;
  /** Counts preview starts — `RepoStatus.previewEpoch` names the process behind the port. */
  private previewEpoch = 0;
  private inFlight: Promise<RepoStatus> | null = null;
  private publishing: Promise<DiffStatus> | null = null;
  /** The session-start/button refresh while it runs — saves wait it out. */
  private refreshing: Promise<unknown> | null = null;
  /** Whether this project is the one on screen — see `setActive`. */
  private active = true;
  /**
   * The summary's memory (PLAN D51): the diff hash its lines answer for.
   * One entry, in daemon memory on purpose — reopening the save review on
   * an unchanged diff must not pay for another Claude turn, and a moved
   * diff must not show yesterday's words.
   */
  private summaryCache: {
    hash: string;
    lines: string[];
    source: RepoSummary["source"];
  } | null = null;
  private lastEmit = 0;
  /**
   * The Claude Code CLI, resolved once by the server from the same source
   * the sessions get theirs (PLAN D51). The summarizer's one turn rides it;
   * null means the fallback path is the only path.
   */
  private readonly claudeExecutable: string | null;

  private readonly onStatus: (status: RepoStatus) => void;
  private readonly onDiffStatus: ((status: DiffStatus) => void) | null;
  private readonly onUrlChange: ((url: string | null) => void) | null;
  /**
   * The work-in-progress cycle: the branch this project's saves land on, and
   * the pull request a developer received (PLAN D5[넘기기]).
   *
   * Both are handed in by the owner and handed back through `onCycleChange`,
   * because they have to survive a daemon restart and the project registry is
   * the only thing that persists. Holding them here as well is what lets a
   * save know whether it is starting a cycle or continuing one, without
   * asking git what branch it is on — a planner who never types `git` should
   * not be able to end up on a branch the tool did not create.
   */
  private branch: string | null;
  /**
   * Files in the clone that a 저장 would carry, as of the last count. Zero
   * until something asks — a fresh clone is clean, and the delivery chip's own
   * mount is what triggers the first real count.
   */
  private pendingChanges = 0;
  private openHandoff: HandoffStatus | null;
  /** D94: this workspace was created with Claude-prepared connection. */
  private bootstrapRequested = false;
  /** The planner's word on this repo's install · preview commands. */
  private commandsApproved = true;
  /** The server's preparation turn: brief → Claude writes the contract → validate. */
  private prepareBootstrap: (() => Promise<boolean>) | null = null;
  /** D88: the developer comments the last 상태 확인 read — 답하기 resolves ids against this. */
  private lastReviews: DeveloperReview[] = [];
  private readonly onCycleChange:
    | ((cycle: { branch: string | null; handoff: HandoffStatus | null }) => void)
    | null;
  private readonly gitHubClient: (() => GitHubClient | null) | null;

  constructor(options: {
    /** Absolute path of the clone. */
    root: string;
    /** Remote url; the owning project decided it, this class never reads it back. */
    url: string | null;
    onStatus: (status: RepoStatus) => void;
    /** Publish progress; optional because not every host shows it. */
    onDiffStatus?: (status: DiffStatus) => void;
    /** The machine-wide GitHub token — see `loadRepoPat` in credentials. */
    pat?: string | null;
    /** Defaults to "main"; a project that forks elsewhere says so. */
    baseBranch?: string;
    /** Persistence hook for a moved url — see onUrlChange in update(). */
    onUrlChange?: (url: string | null) => void;
    /** Cycle state restored from the project registry, if any. */
    cycle?: { branch: string | null; handoff: HandoffStatus | null };
    /** Where the cycle is written back; the registry is the only store. */
    onCycleChange?: (cycle: { branch: string | null; handoff: HandoffStatus | null }) => void;
    /** Built per call so a PAT changed mid-run reaches the next request. */
    gitHubClient?: () => GitHubClient | null;
    /** Claude Code CLI executable for the summarizer's one turn (D51). */
    claudeExecutable?: string | null;
    /** D94: 연결 준비 — sync 가 설정 없음에서 막히면 Claude 가 계약을 쓴다. */
    bootstrap?: boolean;
    /** The preparation turn: brief → Claude writes the contract → validate. */
    prepareBootstrap?: () => Promise<boolean>;
    /**
     * Whether the planner said this repo's commands may run here. Absent
     * (a direct construction, a pre-gate project) reads as approved — the
     * gate is for repos nobody has vouched for yet.
     */
    commandsApproved?: boolean;
    /**
     * Whether this workspace's project is the one on screen. Only the active
     * project may take its preview port: a switch away abandons an in-flight
     * bring-up instead of letting it finish late and SIGKILL the listener the
     * NEXT project just started (or outlive the daemon on another port).
     */
    active?: boolean;
  }) {
    this.root = options.root;
    this.url = options.url;
    this.pat = options.pat ?? null;
    this.onStatus = options.onStatus;
    this.onDiffStatus = options.onDiffStatus ?? null;
    this.onUrlChange = options.onUrlChange ?? null;
    this.baseBranch = options.baseBranch ?? "main";
    this.branch = options.cycle?.branch ?? null;
    this.openHandoff = options.cycle?.handoff ?? null;
    this.bootstrapRequested = options.bootstrap ?? false;
    this.prepareBootstrap = options.prepareBootstrap ?? null;
    this.commandsApproved = options.commandsApproved ?? true;
    this.onCycleChange = options.onCycleChange ?? null;
    this.gitHubClient = options.gitHubClient ?? null;
    this.claudeExecutable = options.claudeExecutable ?? null;
    this.active = options.active ?? true;
  }

  /**
   * Whether this project is the one on screen. Only the active project may
   * START a preview (the bring-up gates below); an inactive one keeps the
   * server it already has warm, so coming back is a repaint, not a bring-up
   * — the server stops only for a port fence or the warm cap.
   */
  setActive(active: boolean): void {
    this.active = active;
  }

  /** A preview process this workspace owns right now, warm or on screen. */
  get previewRunning(): boolean {
    return this.preview !== null;
  }

  /**
   * Ready AND served by its own process: a return to this project needs no
   * bring-up, only the quiet refresh (`pull`) that never touches the server.
   */
  get previewLive(): boolean {
    return this.phase === "ready" && this.preview !== null;
  }

  /**
   * The port colo-design.json declares, when the clone can say — the switch
   * fence compares these. Unknown (not cloned, or no config yet) is `null`.
   */
  declaredPreviewPort(): number | null {
    if (this.config) return this.config.preview.port;
    if (!this.isCloned()) return null;
    try {
      return readColoDesignConfig(this.root).preview.port;
    } catch {
      return null;
    }
  }

  get remoteUrl(): string | null {
    return this.url;
  }

  /**
   * The machine-wide GitHub token, injected by the server: the workspace is
   * built synchronously, while reading the store is not. This is a load, not
   * a change — nothing is persisted here; the token lives in exactly one
   * credential item and the server is what points every workspace at it.
   */
  setPat(pat: string | null): void {
    this.pat = pat;
  }

  /** The error card's 실행 허용 button lands here (project.update). */
  setCommandsApproved(approved: boolean): void {
    this.commandsApproved = approved;
  }

  /** The repo's declared private registry, once its colo-design.json was read. */
  registry(): ColoDesignRegistry | null {
    return this.config?.registry ?? null;
  }

  /** Disk state only; safe to call from any client at any time. */
  async status(): Promise<RepoStatus> {
    if (this.isCloned()) {
      try {
        this.config = readColoDesignConfig(this.root);
      } catch {
        // Keep the last known config; the working phases surface parse errors.
      }
    }
    return this.snapshot();
  }

  sync(force = false): Promise<RepoStatus> {
    // A 다시 시작 pressed while a bootstrap crawls waits that run out instead
    // of riding it. The port itself needs no mandate any more: every bring-up
    // reclaims the declared port for the active project (startPreview).
    if (this.inFlight && force) return this.inFlight.then(() => this.sync(true));
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.bootstrap().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * Set the url and bring the workspace to the resulting state: a moved url
   * means a different repository, so the old clone is discarded and
   * re-cloned. Persistence is the owner's: a moved url is handed to
   * `onUrlChange` — the project registry is the only place it is written.
   */
  async update(changes: { url?: string | null }): Promise<RepoStatus> {
    // Absent keys stay unchanged; `null` clears.
    const urlChanged = changes.url !== undefined && changes.url !== this.url;
    if (changes.url !== undefined) this.url = changes.url;
    // Only a real move is announced: a re-submitted identical url must not
    // make the registry rewrite (and broadcast) a project that did not change.
    if (urlChanged) this.onUrlChange?.(this.url);

    if (!this.url) {
      await this.stop();
      this.setPhase("missing", REPO_URL_MISSING_DETAIL);
      return this.snapshot();
    }

    if (urlChanged) {
      await this.stop();
      rmSync(this.root, { recursive: true, force: true });
    } else if (this.isCloned()) {
      // Auth rides the environment now, but a clone made before that still
      // carries the PAT inside its remote url — the one place the keychain
      // promise must never leak. Idempotent; a clean origin is a no-op read.
      await this.scrubOriginCredential();
    }
    return await this.sync();
  }

  async stop(): Promise<void> {
    await this.killPreview();
  }

  /**
   * The PAT never rides the url again — not into `.git/config` at rest, not
   * into `ps`-visible argv. git takes per-invocation config from the
   * environment (GIT_CONFIG_*), which clone, fetch and push all read as an
   * `http.<origin>.extraheader`. Local-path remotes ignore http.* entirely.
   */
  private gitAuthEnv(): NodeJS.ProcessEnv {
    if (!this.pat || !this.url?.startsWith("https://")) return {};
    let scope: string;
    try {
      scope = new URL(this.url).origin;
    } catch {
      return {};
    }
    const basic = Buffer.from(`x-access-token:${this.pat}`).toString("base64");
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${scope}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    };
  }

  /** Rewrites a PAT-bearing origin to its clean form — see update(). */
  private async scrubOriginCredential(): Promise<void> {
    if (!this.isCloned()) return;
    const origin = (await this.git(["remote", "get-url", "origin"]).catch(() => "")).trim();
    if (!/^https:\/\/[^@/\s]+@/.test(origin)) return;
    await this.git(["remote", "set-url", "origin", origin.replace(/^(https:\/\/)[^@/\s]+@/, "$1")]);
  }

  /**
   * Everything that may still be writing to this clone, settled. A stop that
   * only killed the preview could kill a 최신화 between its stash and its
   * pop — the planner's unsaved work parks in `git stash` with nothing left
   * running to bring it back. Shutdown waits the writers out first;
   * `recoverParkedWork` is the net for the kills no wait survives.
   */
  async settle(): Promise<void> {
    await this.publishing?.catch(() => undefined);
    await this.refreshing?.catch(() => undefined);
    await this.inFlight?.catch(() => undefined);
  }

  /**
   * Session start · 레포 최신화: bring the clone current without tearing its
   * preview down, and without asking the planner to read git. Off-cycle that
   * is a fast-forward of the base branch; mid-cycle it is a merge of the
   * developer's base into this cycle's work. Unsaved work rides along (see
   * refreshFromRemote), a conflict becomes the session's first task, and a
   * plain failure stays a `detail`: hiding a live preview mid-conversation
   * is worse than being a commit behind until the next sync() reports the
   * failure properly.
   */
  async pull(
    onSessionTurn?: (brief: string) => void,
    opts?: { report?: boolean },
  ): Promise<"clean" | "conflict" | undefined> {
    if (!this.isCloned()) return;
    // 준비가 충돌로 멈춘 상태(phase error)에서도 문은 열려 있어야 한다(D96):
    // 오류 카드의 Claude 요청이 읽을 것은 바로 그 상태고, 새 대화가 태어날 때의
    // 이 pull 이 충돌을 첫 과제로 넣는다. error 이후의 상태는 어차피 없고,
    // clone 이 없는 실패(내려받기 실패)는 위에서 걸린다.
    if (this.phase !== "ready" && this.phase !== "error") return;
    // One worktree, two writers: a save or handoff in flight owns it, so
    // the refresh waits — and a save below waits for a refresh the same
    // way. Without this, the stash-move-replay window races `git diff` and
    // the planner's save can read a worktree that is momentarily parked.
    if (this.publishing) await this.publishing.catch(() => undefined);
    const run = this.refreshFromRemote(onSessionTurn)
      .then(async (outcome) => {
        // A conflict brief leaves the worktree mid-resolution: the delivery chip's
        // count must show it (the unmerged files are changes awaiting 저장),
        // and an install or preview restart would only bury the brief in
        // noise — so no sync runs on that path. A clean refresh ends with
        // the worktree exactly the planner's edits on the new HEAD:
        // recount, or let the dependency-driven sync recount at its end.
        if (outcome === "conflict") await this.refreshPendingChanges();
        else if (this.dependenciesMoved()) await this.sync();
        else await this.refreshPendingChanges();
        return outcome;
      })
      .catch((error) => {
        this.setDetail(detailOf(error, this.pat));
        // The 최신화 button's caller reports: a failure the planner asked for
        // by pressing a button must land as words on the screen, not only in
        // the status detail no card renders while phase stays ready.
        if (opts?.report) throw error;
      })
      .finally(() => {
        this.refreshing = null;
      });
    this.refreshing = run;
    await run;
  }

  /**
   * 최신화 버튼이 열린 대화 없이 눌렸을 때의 사전 확인 (실사 P0 — 조용한
   * no-op). 사이클 브랜치에 올라탄 클론의 병합은 충돌 시 Claude 의 첫 과제가
   * 되야 하므로 혼자 하지 않는다 — 대신 fetch 로 원격을 확인해 무엇이 기다리는
   * 지 알려준다. null 이면 막을 이유가 없다: 베이스 브랜치 위의 fast-forward 는
   * 혼자서도 안전하고, 새 커밋이 없으면 할 일 자체가 없다.
   */
  async refreshNeedsThread(): Promise<number | null> {
    if (!this.isCloned()) return null;
    if (this.phase !== "ready" && this.phase !== "error") return null;
    if (!this.branch) return null;
    if (this.publishing) await this.publishing.catch(() => undefined);
    await this.git(["fetch", "origin", this.baseBranch]);
    const [, behind] = await this.aheadBehindBase();
    return behind > 0 ? behind : null;
  }

  // -------------------------------------------------------------------------
  // The handoff cycle (PLAN D5[넘기기]): 저장 → 개발자에게 넘기기 → 반영됨
  // -------------------------------------------------------------------------

  /**
   * Uncommitted worktree changes vs HEAD, tracked and untracked alike. The
   * planner reviews exactly what a publish would commit — nothing more.
   */
  async diff(): Promise<DiffFile[]> {
    if (!this.isCloned()) return [];
    const tracked = parseUnifiedDiff(await this.git(["diff", "HEAD", "--no-color"]));
    const files = [...tracked];
    for (const rel of (await this.git(["ls-files", "--others", "--exclude-standard"]))
      .split(/\r?\n/)
      .filter(Boolean)) {
      files.push(untrackedAsAdded(this.root, rel));
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** The branch this cycle's saves land on, or null before the first 저장. */
  get currentBranch(): string | null {
    return this.branch;
  }

  get currentHandoff(): HandoffStatus | null {
    return this.openHandoff;
  }

  /** Last counted unsaved-change files — the sidebar badge's number (PLAN D16). */
  get pendingChangeCount(): number {
    return this.pendingChanges;
  }

  /**
   * 저장: review → commit → push, onto this cycle's own branch.
   *
   * The base branch is never written to. A developer receives this work as a
   * pull request they can read, run and refuse — pushing past them was what
   * the old `push origin HEAD` did, and it is the one thing a tool driven by
   * someone who does not read diffs must not do.
   *
   * The repo's own `check` does not gate this anymore (실사: a save stuck at
   * 레포 검사 left work the planner could not put up). Problems are the
   * developer's to catch in the pull request 넘기기 opens; Claude can still
   * run the check inside a turn when it wants one.
   */
  save(
    options: { message?: string; onSessionTurn?: (brief: string) => void } = {},
  ): Promise<DiffStatus> {
    if (!this.publishing) {
      this.publishing = this.runSave(options).finally(() => {
        this.publishing = null;
      });
    }
    return this.publishing;
  }

  private async runSave(options: {
    message?: string;
    onSessionTurn?: (brief: string) => void;
  }): Promise<DiffStatus> {
    if (!this.isCloned()) {
      return this.setDiff({
        stage: "failed",
        gate: "diff",
        detail: "연결 레포가 준비되지 않았습니다 — 잠시 후 다시 시도해 주세요.",
      });
    }
    // The worktree is the review's subject: a session-start refresh still
    // stashing and replaying must settle before the diff is computed.
    await this.refreshing?.catch(() => undefined);

    this.setDiff({ stage: "computing" });
    const approved = (await this.diff()).map((file) => file.path);
    if (approved.length === 0) {
      return this.setDiff({
        stage: "failed",
        gate: "diff",
        detail: "저장할 변경사항이 없습니다 — 먼저 화면을 만들거나 고쳐 주세요.",
      });
    }

    // Commit exactly the paths the planner approved — never `git add -A`, so
    // unreviewed output cannot ride along in the save.
    this.setDiff({ stage: "pushing" });
    try {
      const branch = await this.ensureCycleBranch();
      await this.commitApproved(options.message?.trim() || DEFAULT_COMMIT_MESSAGE, approved);
      await this.git(["push", "--set-upstream", "origin", branch]);
    } catch (error) {
      return this.failGate("push", error, options.onSessionTurn);
    }

    const commit = (await this.git(["rev-parse", "HEAD"])).trim();
    // The worktree is clean now; the chip moves off unsaved on this.
    await this.refreshPendingChanges();
    return this.setDiff({ stage: "published", commit });
  }

  /**
   * The branch this cycle belongs on, checked out and created if this is the
   * first save since the last handoff was merged.
   *
   * `<YYYYMMDD>-<n>` rather than a name derived from the work: the planner
   * never reads it, and a title mined from the diff would be one more place a
   * rename could break. `n` walks up until the remote has no such branch, so
   * two machines on one project cannot collide.
   */
  private async ensureCycleBranch(): Promise<string> {
    if (this.branch) {
      const head = (await this.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      if (head !== this.branch) await this.git(["checkout", this.branch]);
      return this.branch;
    }

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const prefix = `${BRANCH_PREFIX}/${today}`;
    let name = `${prefix}-1`;
    for (let n = 1; n <= 99; n += 1) {
      name = `${prefix}-${n}`;
      // An empty ls-remote line means nobody has taken it. A remote that
      // cannot be reached is not a reason to refuse the save: the push right
      // after this will report the real problem, with git's own words.
      const taken = await this.git(["ls-remote", "--heads", this.url ?? "origin", name]).catch(
        () => "",
      );
      if (taken.trim() === "") break;
    }

    await this.git(["checkout", "-B", name]);
    // D84: a MERGED handoff belongs to the cycle that ended. Carrying it onto
    // the new branch made the next 넘기기 try to `updatePullRequest` the
    // merged PR, and the chip read 반영됨 while changes piled up. A new cycle
    // starts with the handoff history in the store, not in the way.
    this.setCycle(name, this.openHandoff?.state === "merged" ? null : this.openHandoff);
    return name;
  }

  /**
   * 개발자에게 넘기기: open the pull request — or update the one this cycle
   * already has, because later saves accumulate on the same branch and a
   * second PR for the same work is noise in a developer's queue. The repo's
   * `build` no longer gates this: a broken build is the developer's to catch
   * in the PR, not a wall in front of the planner (실사).
   */
  handoff(
    options: {
      title?: string;
      body?: string;
      /** The server's preview-driver captures (PLAN D56), already taken. */
      shots?: HandoffShot[];
      onSessionTurn?: (brief: string) => void;
      /** D93: the project's comment store + declared titles, for the PR body. */
      commentsFile?: string;
      screenTitles?: Array<{ route: string; title: string }>;
    } = {},
  ): Promise<DiffStatus> {
    if (!this.publishing) {
      this.publishing = this.runHandoff(options).finally(() => {
        this.publishing = null;
      });
    }
    return this.publishing;
  }

  private async runHandoff(options: {
    title?: string;
    body?: string;
    shots?: HandoffShot[];
    onSessionTurn?: (brief: string) => void;
    /** D93: the project's comment store + declared titles, for the PR body. */
    commentsFile?: string;
    screenTitles?: Array<{ route: string; title: string }>;
  }): Promise<DiffStatus> {
    const branch = this.branch;
    if (!this.isCloned() || !branch) {
      return this.setDiff({
        stage: "failed",
        gate: "pr",
        detail: "넘길 변경사항이 없습니다 — 먼저 저장해 주세요.",
      });
    }
    // The same worktree contract as a save: wait out a refresh before
    // reading and writing the cycle.
    await this.refreshing?.catch(() => undefined);

    // Two different problems with two different fixes: a repo that is not on
    // GitHub needs a different url, a repo with no token needs a token. One
    // sentence covering both leaves the planner guessing which.
    const slug = this.repoSlug();
    if (!slug) {
      return this.setDiff({
        stage: "failed",
        gate: "pr",
        detail:
          "GitHub 레포가 아니라 개발자에게 넘길 수 없습니다 — 설정에서 레포 주소를 확인해 주세요.",
      });
    }
    const client = this.gitHubClient?.() ?? null;
    if (!client) {
      return this.setDiff({
        stage: "failed",
        gate: "pr",
        detail: "개인 액세스 토큰이 없습니다 — 설정에서 연결 레포 토큰을 넣어 주세요.",
      });
    }

    this.setDiff({ stage: "handing-off" });
    const title = options.title?.trim() || DEFAULT_HANDOFF_TITLE;
    let body = options.body ?? "";
    // D93: the planner's comment history rides the pull request body — the
    // developer reads what changed and why without leaving the PR.
    try {
      const since = (
        await this.git(["log", "--reverse", "--format=%cI", `origin/${this.baseBranch}..${branch}`])
      )
        .split("\n")[0]
        ?.trim();
      if (options.commentsFile && since) {
        const section = buildCommentsSection(
          readComments(options.commentsFile),
          (screenId) =>
            options.screenTitles?.find((screen) => screen.route === `/${screenId}`)?.title ?? null,
          since,
        );
        if (section) body = `${body.replace(/\n*$/, "")}\n\n${section}`;
      }
    } catch {
      // A history that will not read costs only the section — the handoff
      // itself carries the work.
    }
    try {
      // D56: the captures join the branch first, so the body can link files
      // the developer will really find in it.
      body = await this.attachShots(body, options.shots, branch);
      const pull = this.openHandoff
        ? await client.updatePullRequest({
            ...slug,
            number: this.openHandoff.number,
            title,
            body,
          })
        : await client.createPullRequest({
            ...slug,
            head: branch,
            base: this.baseBranch,
            title,
            body,
          });
      const handoff: HandoffStatus = pull;
      this.setCycle(branch, handoff);
      return this.setDiff({ stage: "handed-off", handoff });
    } catch (error) {
      return this.failGate("pr", error, options.onSessionTurn);
    }
  }

  /**
   * D56: writes the server's captures under `.colo-design/shots/`, commits and
   * pushes them on this cycle's branch, and returns the body with a
   * `### 화면 미리보기` section linking each one. Nothing here can fail the
   * handoff: the work is already saved — a set the repo refused
   * (`shots: false`) or a commit that would not land quietly leaves the body
   * without the section.
   */
  private async attachShots(
    body: string,
    shots: HandoffShot[] | undefined,
    branch: string,
  ): Promise<string> {
    if (!shots || shots.length === 0) return body;
    const slug = this.repoSlug();
    if (!slug || this.coloDesign()?.shots === false) return body;
    const links: string[] = [];
    try {
      // The captures must join the branch the pull request is from — a
      // worktree sitting anywhere else would bury them in the wrong history
      // and every link in the body would dangle.
      await this.git(["checkout", branch]);
      mkdirSync(join(this.root, SHOTS_DIR), { recursive: true });
      for (const shot of shots) {
        // A route keeps its Korean; only its path separators become dashes.
        const name = `${shot.route.replaceAll("/", "-")}--${shot.state}.png`;
        writeFileSync(join(this.root, SHOTS_DIR, name), shot.png);
        await this.git(["add", "--", `${SHOTS_DIR}/${name}`]);
        // Only the url's spaces are escaped — a Korean route reads as itself.
        const url =
          `https://github.com/${slug.owner}/${slug.repo}/blob/${branch}/` +
          `${SHOTS_DIR}/${name.replaceAll(" ", "%20")}`;
        links.push(`- [\`${shot.route} · ${shot.state}\`](${url})`);
      }
      // An identical set is a no-op: a re-handoff after a mere retitle must
      // not invent an empty commit.
      if ((await this.git(["diff", "--cached", "--name-only"])).trim() !== "") {
        await this.git([...(await this.identityArgs()), "commit", "-m", SHOTS_COMMIT_MESSAGE]);
        await this.git(["push", "origin", branch]);
      }
    } catch {
      return body;
    }
    return `${body.replace(/\n*$/, "")}\n\n### 화면 미리보기\n\n${links.join("\n")}\n`;
  }

  /**
   * Re-reads the pull request. A merge ends the cycle: the clone goes back to
   * the base branch with the developer's merge in it, and the next 저장 opens
   * a fresh branch — which is why this is not a passive status read.
   */
  async refreshHandoff(): Promise<HandoffStatusReport | null> {
    const current = this.openHandoff;
    const slug = this.repoSlug();
    const client = this.gitHubClient?.() ?? null;
    if (!current || !slug || !client) return current;

    const pull = await client.getPullRequest({ ...slug, number: current.number }).catch(() => null);
    if (!pull) return current;

    const handoff: HandoffStatus = pull;
    if (pull.state !== "merged") {
      this.setCycle(this.branch, handoff);
      return await this.withReviews(handoff);
    }

    // Merged: the work is the developer's now. Land back on the base branch
    // with their merge, and forget the branch so the next save starts clean.
    try {
      await this.git(["fetch", "origin", this.baseBranch]);
      // 반영됨은 저장 안 한 변경을 실어 나르지 않는다: 병합 직후엔 양쪽
      // 블롭이 같아 checkout 이 수정을 거부하지 않고, 이어지는 reset 이
      // 그대로 지워버린다. dirty 면 checkout 만 하고 reset 은 건너뛴다 —
      // 다음 세션 시작의 최신화가 stash 로 그 변경을 지키며 반영을 따라간다.
      const dirty = (await this.git(["status", "--porcelain"])).trim().length > 0;
      await this.git(["checkout", this.baseBranch]);
      if (!dirty) await this.git(["reset", "--hard", `origin/${this.baseBranch}`]);
    } catch (error) {
      // A dirty worktree can refuse the checkout. The PR really did merge, so
      // report that; the next session-start merge picks the base up anyway.
      this.setDetail(detailOf(error, this.pat));
    }
    this.setCycle(null, handoff);
    // 반영됨 (PLAN D52): the cycle's checkpoints snapshot a worktree the
    // developer has already absorbed — restoring them now would move the
    // work backwards past a merge. Their refs go, quietly.
    await this.clearCheckpoints().catch(() => undefined);
    return await this.withReviews(handoff);
  }

  /**
   * D88: the developer's words, read beside the pull request — 인라인 코멘트와
   * 말이 있는 리뷰 본문이 한 목록으로. A refused read costs the rows, not the
   * status: the badge stays quiet rather than failing 상태 확인.
   */
  private async withReviews(handoff: HandoffStatus): Promise<HandoffStatusReport> {
    const slug = this.repoSlug();
    const client = this.gitHubClient?.() ?? null;
    const reviews: DeveloperReview[] = [];
    if (slug && client) {
      const collect = async (): Promise<void> => {
        for (const row of await client.listPullComments({
          ...slug,
          number: handoff.number,
        })) {
          reviews.push({
            id: Number(row.id),
            kind: "inline",
            author: String(row.user?.login ?? ""),
            body: String(row.body ?? ""),
            pr: handoff.number,
            ...(row.path ? { path: String(row.path) } : {}),
            ...(Number.isFinite(Number(row.line)) ? { line: Number(row.line) } : {}),
            at: String(row.created_at ?? ""),
          });
        }
        for (const row of await client.listReviews({
          ...slug,
          number: handoff.number,
        })) {
          const text = String(row.body ?? "").trim();
          if (text === "") continue;
          reviews.push({
            id: Number(row.id),
            kind: "review",
            author: String(row.user?.login ?? ""),
            body: text,
            pr: handoff.number,
            at: String(row.submitted_at ?? ""),
          });
        }
      };
      await collect().catch(() => undefined);
    }
    this.lastReviews = reviews;
    return { ...handoff, reviews };
  }

  /**
   * D88: 답하기 — the planner's words go to GitHub under their own name. The
   * id resolves against the last 상태 확인 read: 인라인이면 스레드의 답글로,
   * 리뷰 본문이면 이슈 코멘트로.
   */
  async replyToReview(id: number, body: string): Promise<void> {
    const review = this.lastReviews.find((entry) => entry.id === id);
    const slug = this.repoSlug();
    const client = this.gitHubClient?.() ?? null;
    if (!slug || !client) {
      throw new Error("GitHub 에 답할 수 없습니다 — 설정에서 토큰을 확인해 주세요.");
    }
    if (!review) {
      throw new Error("답할 코멘트를 찾을 수 없습니다 — 상태 확인을 다시 눌러 주세요.");
    }
    if (review.kind === "inline") {
      await client.replyToPullComment({
        ...slug,
        number: review.pr,
        commentId: review.id,
        body,
      });
    } else {
      await client.commentOnIssue({ ...slug, number: review.pr, body });
    }
  }

  // -------------------------------------------------------------------------
  // 되돌리기와 요약 (PLAN D51 · D52 · D53)
  // -------------------------------------------------------------------------

  /**
   * 저장 검토의 요약 (PLAN D51): what changed, in the planner's words. One
   * Claude turn — `maxTurns: 1`, no tools, three seconds — over the diff
   * itself; anywhere it cannot land (no CLI, timeout, refusal, empty answer)
   * falls back to grouping the changed paths. Answered from memory when the
   * diff has not moved since the last ask, so re-opening the review is free.
   */
  async summarize(): Promise<RepoSummary> {
    if (!this.isCloned()) return { lines: [], source: "fallback" };
    const files = await this.diff();
    if (files.length === 0) return { lines: [], source: "fallback" };
    const hash = createHash("sha256").update(files.map(renderSummaryFile).join("\n")).digest("hex");
    if (this.summaryCache?.hash === hash) {
      return {
        lines: this.summaryCache.lines,
        source: this.summaryCache.source,
      };
    }
    const summary = (await this.claudeSummary(files).catch(() => null)) ?? {
      lines: fallbackSummary(files),
      source: "fallback" as const,
    };
    this.summaryCache = { hash, lines: summary.lines, source: summary.source };
    return summary;
  }

  /**
   * The summarizer's working directory — deliberately NOT the clone. The CLI
   * files every transcript under the project folder of its cwd, and the
   * session list offers every transcript in the clone's folder as a
   * resumable conversation: a batch turn's one machine prompt surfaced in the
   * tree as a thread, and opening it read as if the planner had typed a wall
   * of file paths. The prompt carries its own diff and runs with no tools,
   * so the summary never reads the clone; a scratch folder beside it keeps
   * the transcript out of the conversation store.
   */
  private summaryCwd(): string {
    const dir = join(dirname(this.root), "summary");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** The summarizer's one turn; null means "use the fallback". */
  private async claudeSummary(files: DiffFile[]): Promise<RepoSummary | null> {
    if (!this.claudeExecutable) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
    try {
      // The same SDK entry the sessions use, aimed at a single
      // answer-nothing-else turn: no tools to run, no settings to load — the
      // diff in the prompt is everything this call may read.
      const conversation = query({
        prompt: summaryPrompt(files),
        options: {
          cwd: this.summaryCwd(),
          pathToClaudeCodeExecutable: this.claudeExecutable,
          maxTurns: 1,
          tools: [],
          settingSources: [],
          abortController: controller,
        },
      });
      let answer: string | null = null;
      for await (const message of conversation) {
        if (message.type === "result" && message.subtype === "success" && !message.is_error) {
          answer = message.result;
        }
      }
      const lines = (answer ?? "")
        .split(/\r?\n/)
        .map((line) => line.replace(/^[-·•*]\s*/, "").trim())
        .filter(Boolean)
        .slice(0, SUMMARY_MAX_LINES);
      return lines.length > 0 ? { lines, source: "claude" } : null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 저장 기록 (PLAN D53): the cycle's saves, newest first, as the `저장
   * 기록` drawer lists them — the planner's own memos and times, no git.
   */
  async history(): Promise<RepoHistory> {
    if (!this.isCloned()) return { base: `origin/${this.baseBranch}`, entries: [] };
    const base = `origin/${this.baseBranch}`;
    // A clone that never fetched the base reads as an empty history, not as
    // an error: the drawer opens, it just has nothing to list yet.
    const output = await this.git([
      "log",
      "--pretty=format:%x1e%H%x1f%s%x1f%cI",
      "--name-only",
      `${base}..HEAD`,
    ]).catch(() => "");
    const entries = output
      .split("\x1e")
      .map((chunk) => chunk.replace(/^\r?\n/, ""))
      .filter((chunk) => chunk.trim() !== "")
      .map((chunk) => {
        const [head = "", ...fileLines] = chunk.split(/\r?\n/);
        const [sha = "", message = "", at = ""] = head.split("\x1f");
        return {
          sha,
          message,
          at,
          files: fileLines.map((line) => line.trim()).filter(Boolean),
        };
      })
      .filter((entry) => entry.sha !== "");
    return { base, entries };
  }

  /**
   * 되돌리기 (PLAN D53): bring the worktree back to a saved point as a NEW
   * commit on the cycle branch, pushed like any save. A developer may be
   * reading that branch right now, so reset · revert · force-push do not
   * exist here — the history only grows, and the commit says 되돌리기.
   */
  async restore(sha: string): Promise<DiffStatus> {
    if (!this.isCloned()) {
      return this.setDiff({
        stage: "failed",
        gate: "diff",
        detail: "연결 레포가 준비되지 않았습니다 — 잠시 후 다시 시도해 주세요.",
      });
    }
    // The same worktree contract as a save: a refresh settling underneath a
    // restore would half-undo two different moments at once.
    await this.refreshing?.catch(() => undefined);
    const dirty = await this.git(["-c", "core.quotepath=false", "status", "--porcelain"]);
    if (dirty.trim() !== "") {
      return this.setDiff({
        stage: "failed",
        gate: "diff",
        detail:
          "저장하지 않은 변경이 있습니다 — 먼저 저장하거나 되돌려 주세요. 저장은 저장 검토의 저장으로, 버리는 것은 더 보기 메뉴의 변경 버리기로 할 수 있습니다.",
      });
    }
    if (!this.branch) {
      return this.setDiff({
        stage: "failed",
        gate: "diff",
        detail: "되돌릴 저장 기록이 없습니다 — 먼저 저장해 주세요.",
      });
    }
    let subject: string;
    try {
      subject = (await this.git(["log", "-1", "--pretty=%s", sha])).trim();
    } catch {
      return this.setDiff({
        stage: "failed",
        gate: "diff",
        detail: "되돌릴 기록을 찾지 못했습니다 — 저장 기록을 다시 열어 확인해 주세요.",
      });
    }
    this.setDiff({ stage: "pushing" });
    try {
      // The branch name lives in the registry; git's HEAD may have been left
      // anywhere by a restart. ensureCycleBranch checks it out when named.
      const branch = await this.ensureCycleBranch();
      await this.git(["checkout", sha, "--", "."]);
      await this.git([...(await this.identityArgs()), "commit", "-m", `되돌리기: ${subject}`]);
      await this.git(["push", "--set-upstream", "origin", branch]);
    } catch (error) {
      return this.setDiff({
        stage: "failed",
        gate: "commit",
        detail: detailOf(error, this.pat),
      });
    }
    const commit = (await this.git(["rev-parse", "HEAD"])).trim();
    await this.refreshPendingChanges();
    return this.setDiff({ stage: "published", commit });
  }

  /**
   * 변경 버리기 (PLAN D53): every unsaved worktree change, gone — the same
   * path set a save would have carried, restored or deleted per file, and
   * only through the one path rule (inside the clone). The confirmation
   * dialog is the UI's half; this half cannot reach outside the repo.
   */
  async discard(): Promise<RepoDiscard> {
    if (!this.isCloned()) return { removed: [] };
    await this.refreshing?.catch(() => undefined);
    const changed = await this.changedPaths();
    const allowed = changed
      .map((path) => safeRepoPath(path))
      .filter((path): path is string => path !== null);
    if (allowed.length === 0) return { removed: [] };

    // Tracked paths go back to HEAD (bringing a deleted file back included);
    // paths HEAD never knew are un-staged and deleted from the worktree.
    const inHead = new Set(
      (await this.git(["ls-tree", "-r", "--name-only", "HEAD"]))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const tracked = allowed.filter((path) => inHead.has(path));
    if (tracked.length > 0) await this.git(["checkout", "HEAD", "--", ...tracked]);
    for (const path of allowed) {
      if (inHead.has(path)) continue;
      await this.git(["rm", "--force", "--cached", "--", path]).catch(() => undefined);
      // porcelain folds a wholly-untracked folder into one `dir/` row, so the
      // path here can BE a directory — force alone only suppresses ENOENT and
      // throws EISDIR on one. Recursive handles the file case identically.
      rmSync(join(this.root, path), { recursive: true, force: true });
    }
    await this.refreshPendingChanges();
    return { removed: allowed };
  }

  /** Every path with an unsaved change, renames split into both sides. */
  private async changedPaths(): Promise<string[]> {
    const out = await this.git(["-c", "core.quotepath=false", "status", "--porcelain"]);
    const paths: string[] = [];
    for (const line of out.split(/\r?\n/)) {
      if (line.length < 4) continue;
      const body = line.slice(3);
      const rename = body.match(/^(.*) -> (.*)$/);
      if (rename) paths.push((rename[1] ?? "").trim(), (rename[2] ?? "").trim());
      else paths.push(body.trim());
    }
    return paths.filter(Boolean);
  }

  /**
   * One 화면 turn's snapshot (PLAN D52), taken by the server the moment the
   * turn is handed to the session: the whole worktree — untracked screens
   * included — into a throwaway index, a tree, a parented commit, and a ref
   * under `refs/colo-design/checkpoints/<sessionId>/<turn>`. HEAD, the real
   * index and the worktree itself are never touched, which is exactly why
   * this is not a stash: a stash cannot carry untracked files and a first
   * screen is untracked by definition.
   */
  async checkpoint(sessionId: string, turn: number): Promise<RepoCheckpoint> {
    const ref = `${CHECKPOINT_REF_PREFIX}/${sessionId}/${turn}`;
    // Inside `.git/` so it can never surface as an untracked file of its own.
    const temporaryIndex = join(this.root, ".git", `colo-design-checkpoint-${randomUUID()}`);
    const indexEnv = { GIT_INDEX_FILE: temporaryIndex };
    try {
      await this.git(["add", "-A"], this.root, indexEnv);
      const tree = (await this.git(["write-tree"], this.root, indexEnv)).trim();
      const head = (await this.git(["rev-parse", "HEAD"])).trim();
      const commit = (
        await this.git(
          [
            ...(await this.identityArgs()),
            "commit-tree",
            tree,
            "-p",
            head,
            "-m",
            `Colo Design 체크포인트 · 대화 ${sessionId} · 턴 ${turn}`,
          ],
          this.root,
          indexEnv,
        )
      ).trim();
      await this.git(["update-ref", ref, commit]);
    } finally {
      rmSync(temporaryIndex, { force: true });
    }
    await this.pruneCheckpoints(sessionId);
    return {
      id: `${sessionId}/${turn}`,
      sessionId,
      turn,
      at: new Date().toISOString(),
    };
  }

  /** D52: a session keeps its newest snapshots; older refs are deleted. */
  private async pruneCheckpoints(sessionId: string): Promise<void> {
    const refs = await this.checkpointRefs(`${CHECKPOINT_REF_PREFIX}/${sessionId}`);
    for (const ref of refs.slice(0, Math.max(0, refs.length - CHECKPOINTS_PER_SESSION))) {
      await this.git(["update-ref", "-d", ref]).catch(() => undefined);
    }
  }

  /** 반영됨 (PLAN D52): a merged cycle's snapshots are history, not exits. */
  private async clearCheckpoints(): Promise<void> {
    for (const ref of await this.checkpointRefs(CHECKPOINT_REF_PREFIX)) {
      await this.git(["update-ref", "-d", ref]).catch(() => undefined);
    }
  }

  /** Snapshot refs under `prefix`, oldest first. */
  private async checkpointRefs(prefix: string): Promise<string[]> {
    if (!this.isCloned()) return [];
    return (await this.git(["for-each-ref", "--sort=committerdate", "--format=%(refname)", prefix]))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /** Every snapshot the planner can still step back to (PLAN D52). */
  async checkpoints(): Promise<RepoCheckpoints> {
    const prefix = `${CHECKPOINT_REF_PREFIX}/`;
    const out = await this.git([
      "for-each-ref",
      "--sort=committerdate",
      "--format=%(refname)%09%(committerdate:iso8601-strict)",
      CHECKPOINT_REF_PREFIX,
    ]).catch(() => "");
    const entries: RepoCheckpoint[] = [];
    for (const line of out.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      const [refname = "", at = ""] = line.split("\t");
      const id = refname.startsWith(prefix) ? refname.slice(prefix.length) : "";
      const slash = id.lastIndexOf("/");
      if (id === "" || slash <= 0) continue;
      entries.push({
        id,
        sessionId: id.slice(0, slash),
        turn: Number(id.slice(slash + 1)) || 0,
        at,
      });
    }
    return { entries };
  }

  /**
   * Put the worktree back the way it stood when a turn started (PLAN D52).
   * The move list is `git diff --name-status <tree>` filtered through the
   * one path rule: allowed paths that the snapshot has are checked out,
   * allowed paths it never had are deleted. Merge-conflicted paths (U) are
   * left for Claude, exactly like a refresh leaves them.
   */
  async checkpointRestore(id: string): Promise<RepoCheckpointRestore> {
    if (!this.isCloned()) return { restored: [] };
    // `id` is `<sessionId>/<turn>`, handed back verbatim from checkpoints().
    const ref = `${CHECKPOINT_REF_PREFIX}/${id}`;
    const tree = (await this.git(["rev-parse", `${ref}^{tree}`]).catch(() => "")).trim();
    if (tree === "") {
      throw new Error("되돌릴 체크포인트를 찾지 못했습니다 — 목록을 다시 불러와 주세요.");
    }
    const raw = await this.git([
      "-c",
      "core.quotepath=false",
      "diff",
      "--name-status",
      "--no-renames",
      tree,
    ]);
    const plan = restorePlan(raw);
    // Untracked files the snapshot predates never appear in `git diff` —
    // and they are exactly what "스냅샷에 없던 파일은 삭제" is about: the
    // first screen a turn just made existed nowhere when the turn began.
    const inSnapshot = new Set(
      (await this.git(["ls-tree", "-r", "--name-only", tree]))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const bornAfter = (
      await this.git(["-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard"])
    )
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((path) => path !== "" && !inSnapshot.has(path) && safeRepoPath(path) !== null);
    if (plan.checkout.length > 0) await this.git(["checkout", tree, "--", ...plan.checkout]);
    for (const path of [...plan.remove, ...bornAfter]) {
      rmSync(join(this.root, path), { force: true });
      // Folders the snapshot predates close behind it, quietly.
      let dir = dirname(join(this.root, path));
      while (dir.startsWith(this.root) && dir !== this.root) {
        try {
          rmdirSync(dir);
        } catch {
          break; // not empty — the snapshot era had company here
        }
        dir = dirname(dir);
      }
    }
    await this.refreshPendingChanges();
    return {
      restored: [...plan.checkout, ...plan.remove, ...bornAfter].sort(),
    };
  }

  // -------------------------------------------------------------------------
  // 레포 최신화: bring the developer's side in without reading git (PLAN D5[넘기기])
  // -------------------------------------------------------------------------

  /**
   * The whole refresh, in the planner's interest: unsaved work is the
   * precious half, so it is stashed first (untracked screens included), the
   * branch moves onto what the developer merged, and the work comes back on
   * top — git's mechanical merge does the combining. What git cannot finish
   * alone is a genuine conflict, and a conflict is Claude's task: the brief
   * rides the same wire a typed message does. With no thread to brief (a
   * bare bring-up), the throw names the state in Korean where the retry
   * panel reads it.
   *
   * Returns `"conflict"` when a conflict was left for Claude — the caller
   * must not pile an install or preview restart onto a mid-resolution tree.
   */
  private async refreshFromRemote(
    onSessionTurn?: (brief: string) => void,
  ): Promise<"clean" | "conflict"> {
    // A refresh that finds a conflict left over from an earlier run briefs
    // again instead of piling on: until Claude resolves it, that state IS
    // the current one.
    if (await this.mergeInProgress()) {
      return await this.briefOrThrow(
        this.mergeConflictBrief(
          await this.conflictedFiles(),
          // The stash from the run that left this merge open — Claude must
          // know it is still parked once the merge commit lands.
          (await this.git(["stash", "list"])).trim() !== "",
        ),
        onSessionTurn,
      );
    }
    const leftover = await this.conflictedFiles();
    if (leftover.length > 0) {
      return await this.briefOrThrow(this.popConflictBrief(leftover), onSessionTurn);
    }

    // A run that died between the stash and its pop parked the planner's
    // unsaved work in the stash — replay it before anything moves the branch,
    // or a stash can outlive the process that made it. A parked replay that
    // conflicts is exactly the leftover state above; the same brief covers it.
    if ((await this.recoverParkedWork(onSessionTurn)) === "conflict") return "conflict";

    // Mid-cycle, merging the developer's base needs Claude within reach — a
    // conflict has to land as a first task, not as an error nobody can read.
    // A bare bring-up mid-cycle stays put on the merge, but the fetch still
    // runs: the planner who pressed 최신화 deserves to learn that something
    // is waiting instead of watching a silent no-op.
    if (this.branch && !onSessionTurn) return "clean";

    const stashed = await this.stashUnsavedWork();
    try {
      await this.git(["fetch", "origin", this.baseBranch]);
      if (this.branch) {
        await this.git([
          ...(await this.identityArgs()),
          "merge",
          "--no-edit",
          `origin/${this.baseBranch}`,
        ]);
      } else {
        const [ahead, behind] = await this.aheadBehindBase();
        if (behind > 0) {
          if (ahead > 0) throw new Error(REFRESH_DIVERGED_DETAIL);
          await this.git(["merge", "--ff-only", `origin/${this.baseBranch}`]);
        }
      }
    } catch (error) {
      // A conflicted merge stays open on purpose (the brief is Claude's
      // recovery path); popping the stash onto a conflicted tree would pile
      // one conflict on another, so it waits. Any other failure never moved
      // the branch: the work goes straight back where it was.
      if (await this.mergeInProgress()) {
        return await this.briefOrThrow(
          this.mergeConflictBrief(await this.conflictedFiles(), stashed),
          onSessionTurn,
        );
      }
      if (stashed) await this.git(["stash", "pop"]).catch(() => undefined);
      throw error;
    }

    if (stashed) {
      const conflicted = await this.popStash();
      if (conflicted) {
        return await this.briefOrThrow(this.popConflictBrief(conflicted), onSessionTurn);
      }
    }
    return "clean";
  }

  /**
   * A conflict is news for Claude when a thread is open and for the planner
   * when one is not: the brief rides the session wire, the throw surfaces a
   * Korean one-liner where the retry panel reads it.
   */
  private async briefOrThrow(
    brief: string,
    onSessionTurn: ((brief: string) => void) | undefined,
  ): Promise<"conflict"> {
    if (onSessionTurn) onSessionTurn(brief);
    else throw new Error(REFRESH_CONFLICT_DETAIL);
    return "conflict";
  }

  /**
   * Claude's instructions, as a gate card: what collided and the exact
   * recovery, named for the planner's words (최신 변경 받아오기), never git's.
   */
  private mergeConflictBrief(files: string[], stashed: boolean): string {
    return markTurn(
      { kind: "gate", step: "최신 변경 받아오기" },
      "개발자가 반영한 최신 변경과 이번 작업이 겹쳐 자동으로 합치지 못했습니다." +
        (files.length > 0 ? `\n충돌한 파일:\n${files.map((file) => `- ${file}`).join("\n")}` : "") +
        "\n충돌을 정리하고 커밋 메시지 앞에 [conflict] 를 붙여 병합을 마무리해 주세요." +
        (stashed
          ? "\n병합을 마친 뒤 임시 보관해 둔 저장하지 않은 변경을 git stash pop 으로 돌려놓고, " +
            "여기서 충돌하면 정리한 뒤 git add 하고 git stash drop 으로 임시 보관을 치워 주세요."
          : ""),
    );
  }

  private popConflictBrief(files: string[]): string {
    return markTurn(
      { kind: "gate", step: "최신 변경 받아오기" },
      "최신 변경을 받아 온 뒤 저장하지 않은 변경을 돌려놓는 중에 겹치는 부분이 생겼습니다.\n" +
        `충돌한 파일:\n${files.map((file) => `- ${file}`).join("\n")}\n` +
        "충돌 표식을 정리한 뒤 git add 로 해결을 표시하고, git stash drop 으로 임시 보관을 치워 주세요. " +
        "그러면 변경은 저장 전 상태로 돌아옵니다.",
    );
  }

  /** True while a merge waits for its conflict resolution (MERGE_HEAD). */
  private async mergeInProgress(): Promise<boolean> {
    try {
      await this.git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  /** Paths git could not combine by itself — the only real conflict here. */
  private async conflictedFiles(): Promise<string[]> {
    const out = await this.git(["diff", "--name-only", "--diff-filter=U"]);
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /**
   * A planner's machine may have no git identity; the commits this tool
   * makes on the planner's behalf (saves, cycle merges, stashes) invent one
   * rather than fail over a name nobody reads.
   */
  private async identityArgs(): Promise<string[]> {
    try {
      return (await this.git(["config", "user.email"])).trim()
        ? []
        : ["-c", "user.name=Colo Design", "-c", "user.email=colo-design@localhost"];
    } catch {
      return ["-c", "user.name=Colo Design", "-c", "user.email=colo-design@localhost"];
    }
  }

  /**
   * Parks unsaved work (tracked and untracked alike) so the branch can
   * move; false when there was nothing to park.
   */
  private async stashUnsavedWork(): Promise<boolean> {
    const status = await this.git(["status", "--porcelain"]);
    if (status.trim() === "") return false;
    await this.git([
      ...(await this.identityArgs()),
      "stash",
      "push",
      "--include-untracked",
      "-m",
      STASH_MESSAGE,
    ]);
    return true;
  }

  /**
   * Replays the parked work onto the moved branch. Returns the unmerged
   * paths when git could not finish the combine alone; anything else throws.
   */
  private async popStash(ref = "stash@{0}"): Promise<string[] | null> {
    try {
      await this.git(["stash", "pop", ref]);
      return null;
    } catch (error) {
      const conflicted = await this.conflictedFiles();
      if (conflicted.length === 0) throw error;
      return conflicted;
    }
  }

  /**
   * Replays unsaved work a dead run parked under our stash message. Only the
   * entry carrying STASH_MESSAGE is touched — a stash the planner made by
   * hand is theirs. A clean replay answers "restored"; a conflict answers
   * "conflict" (the brief went to the thread when one is open, the Korean
   * one-liner and the error card when it is not); anything else throws and
   * the entry stays parked for the next attempt.
   */
  async recoverParkedWork(
    onSessionTurn?: (brief: string) => void,
  ): Promise<"none" | "restored" | "conflict"> {
    if (!this.isCloned()) return "none";
    let list: string;
    try {
      list = await this.git(["stash", "list"]);
    } catch {
      return "none";
    }
    const parked = list.split(/\r?\n/).find((line) => line.includes(STASH_MESSAGE));
    const ref = parked?.match(/^stash@\{\d+\}/)?.[0];
    if (!ref) return "none";
    const conflicted = await this.popStash(ref);
    if (!conflicted) return "restored";
    if (onSessionTurn) {
      onSessionTurn(this.popConflictBrief(conflicted));
      return "conflict";
    }
    this.setPhase("error", RECOVER_CONFLICT_DETAIL, "conflict");
    throw new Error(RECOVER_CONFLICT_DETAIL);
  }

  /** `ahead behind` vs the base branch, once the fetch has named it. */
  private async aheadBehindBase(): Promise<[number, number]> {
    const out = await this.git([
      "rev-list",
      "--left-right",
      "--count",
      `HEAD...origin/${this.baseBranch}`,
    ]);
    const [ahead, behind] = out.trim().split(/\s+/);
    return [Number(ahead) || 0, Number(behind) || 0];
  }

  /**
   * Which GitHub repository the handoff opens a pull request against.
   *
   * Normally the remote url says so. `COLO_DESIGN_GITHUB_SLUG` (`owner/repo`)
   * pins it instead, which is what lets the offline suites drive the real
   * handoff path: their remote is a local bare repository, so nothing in the
   * url could name a GitHub project. Same test-seam rule as
   * `COLO_DESIGN_REPO_URL` — it exists for tests and is documented as such.
   */
  private repoSlug(): { owner: string; repo: string } | null {
    const pinned = process.env.COLO_DESIGN_GITHUB_SLUG;
    if (pinned) {
      const [owner, repo] = pinned.split("/");
      if (owner && repo) return { owner, repo };
    }
    return this.url ? parseRepoSlug(this.url) : null;
  }

  private setCycle(branch: string | null, handoff: HandoffStatus | null): void {
    this.branch = branch;
    this.openHandoff = handoff;
    this.onCycleChange?.({ branch, handoff });
    this.emit();
  }

  private failGate(
    gate: "commit" | "push" | "pr",
    error: unknown,
    onSessionTurn: ((brief: string) => void) | undefined,
  ): DiffStatus {
    const detail = detailOf(error, this.pat);
    // D90 ⓑ: `pr` 은 Claude 에게 가지 않는다 — PR 열기 실패의 원인은 토큰
    // 권한 · 브랜치 보호 · 네트워크라 Claude 가 고칠 게 없어 헛돈다. 웹이
    // 넘기기 대화상자의 안내(넘기지 못했습니다 + 설정 열기)로 응답한다.
    // `push` 는 갈라진다: 인증 · 권한 사유면 안내로, 그 외(non-fast-forward
    // 등)는 지금처럼 Claude — 모르면 Claude 쪽(보수적).
    const pushAuth = gate === "push" && PUSH_AUTH_FAILURE.test(detail);
    const skipClaude = gate === "pr" || pushAuth;
    if (!skipClaude) {
      // The failure is actionable by Claude, not by the planner: hand it over
      // the same wire a typed message uses, output tail included. The step is
      // named the way the planner's button is, not the way git is.
      onSessionTurn?.(
        markTurn(
          { kind: "gate", step: GATE_STEP[gate] },
          `${GATE_BRIEF[gate]} 아래 출력의 원인을 고친 뒤 다시 시도해 주세요.\n\n${detail}`,
        ),
      );
    }
    // 리뷰 C5: push 인증 거절은 화면이 다음 행동(토큰 확인)을 말해야 한다 —
    // reason 이 없으면 저장 검토는 "멈췄습니다" 로만 끝났다.
    return this.setDiff({
      stage: "failed",
      gate,
      ...(pushAuth ? { reason: "push-auth" as const } : {}),
      detail,
    });
  }

  /** Stages and commits exactly the approved paths — the reviewed diff. */
  private async commitApproved(message: string, paths: string[]): Promise<void> {
    await this.git(["add", "--", ...paths]);
    await this.git([...(await this.identityArgs()), "commit", "-m", message]);
  }

  private setDiff(status: DiffStatus): DiffStatus {
    this.onDiffStatus?.(status);
    return status;
  }

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  private async bootstrap(): Promise<RepoStatus> {
    try {
      if (!this.url) {
        this.setPhase("missing", REPO_URL_MISSING_DETAIL);
        return this.snapshot();
      }

      if (!this.isCloned()) {
        await this.killPreview();
        this.setPhase("cloning", null);
        this.clearBringUpDebris();
        // The clean url: the PAT travels in the environment (gitAuthEnv),
        // so neither `.git/config` nor `ps` ever sees it.
        await this.git(["clone", this.url, this.root], dirname(this.root));
        trustWorkspace(this.root);
      } else {
        this.setPhase("pulling", null);
        await this.scrubOriginCredential();
        // Already cloned: 최신화, not a blind ff. Unsaved work survives the
        // move off-cycle, and a conflict left by an earlier run resurfaces
        // with its Korean reason instead of a raw git error.
        await this.refreshFromRemote();
      }

      let config: ColoDesignConfig;
      try {
        config = readColoDesignConfig(this.root);
      } catch (configError) {
        // D94: 연결 준비가 요청된 레포 — 막지 말고 Claude 가 계약을 쓰게
        // 한다. 검증은 validateBootstrapConfig 가 기계로 하고, 벗어나면
        // 준비는 실패로 끝난다(실행 없음).
        if (!this.bootstrapRequested || !this.prepareBootstrap) throw configError;
        this.setPhase("preparing", "Claude 가 레포를 살펴보고 연결을 준비하는 중");
        const ok = await this.prepareBootstrap().catch(() => false);
        config = readColoDesignConfig(this.root); // 실패면 여기서 다시 던진다
        if (!ok) throw new BootstrapPrepareError(BOOTSTRAP_FAILED_DETAIL);
        void configError;
      }
      this.config = config;
      // The one gate the wire cannot skip: a repo nobody has vouched for
      // stops here, after the clone but before any command it declares runs.
      // 저장's check and 넘기기's build wait behind a planner's button press
      // already — install and preview are the ones that run unattended.
      // The verdict names WHAT runs: the approval is one button, so the card
      // must show the sentences it is about to execute — the planner reads the
      // verdict, a reviewer reads the evidence.
      if (!this.commandsApproved) {
        throw new Error(
          `${COMMANDS_UNAPPROVED_DETAIL} 실행하려는 명령 — 설치: ${config.install ?? "(선언되지 않음)"} · 미리보기: ${config.preview.command} (포트 ${config.preview.port})`,
        );
      }
      // The switch race's fence: a bring-up this project no longer owns
      // stops here — install and preview are the unattended side effects,
      // and a late finisher would otherwise kill the port the project the
      // planner switched TO just started serving on.
      if (!this.active) return this.snapshot();
      const installed = await this.installIfNeeded(config);

      /**
       * Count once the clone is on disk and checked out. Without this the
       * chip reads zero after every restart — the count only moves on a
       * 화면 turn otherwise, and a planner who closed the app mid-cycle would
       * come back to a rail that says there is nothing to save.
       */
      await this.refreshPendingChanges();

      // Up to date and still serving: restarting the preview would only flip
      // the UI out of `ready` for no gain.
      if (!installed && this.preview && (await this.isServing(config.preview.port))) {
        this.setPhase("ready", null);
        return this.snapshot();
      }
      await this.startPreview(config);
      this.setPhase("ready", null);
    } catch (error) {
      this.setPhase("error", detailOf(error, this.pat), this.bringUpErrorKind(error));
    }
    return this.snapshot();
  }

  isCloned(): boolean {
    return existsSync(join(this.root, ".git"));
  }

  /**
   * A bring-up that died between creating the folder and finishing the clone
   * leaves the root with files but no `.git` — every later sync reads it as
   * uncloned, and `git clone` refuses a non-empty destination (128) until a
   * human deletes the folder by hand. Everything in it is a partial copy of
   * the remote, so clearing it is a re-clone, not a loss (the same trade the
   * url move already makes). A real clone has `.git` and is never touched.
   */
  private clearBringUpDebris(): void {
    if (this.isCloned() || !existsSync(this.root)) return;
    rmSync(this.root, { recursive: true, force: true });
  }

  /**
   * Where a bring-up (clone · install · preview) stands right now, for callers
   * that race it — the onboarding wizard's check runs while the create it
   * just fired is still cloning, and has to read that as progress, not as a
   * broken manifest.
   */
  syncState(): { running: boolean; phase: RepoPhase; detail: string | null } {
    return {
      running: this.inFlight !== null,
      phase: this.phase,
      detail: this.detail,
    };
  }

  /** The repo's colo-design.json, when the clone has one (onboarding check). */
  coloDesign(): ColoDesignConfig | null {
    try {
      return readColoDesignConfig(this.root);
    } catch {
      return null;
    }
  }

  /** True when the declared install already ran for the current lockfiles. */
  installUpToDate(): boolean {
    const config = this.coloDesign();
    if (!config?.install) return true;
    if (!existsSync(join(this.root, "node_modules"))) return false;
    return !this.dependenciesMoved();
  }

  // -------------------------------------------------------------------------
  // Command runner (install/check/build)
  // -------------------------------------------------------------------------

  /**
   * Runs `install` only when the dependency set moved or the clone is fresh.
   * The identity is a content hash of the manifest and lockfiles, recorded
   * inside `.git/` so it belongs to this clone alone.
   */
  private async installIfNeeded(config: ColoDesignConfig): Promise<boolean> {
    if (!config.install) return false;
    if (!this.dependenciesMoved()) return false;

    this.setPhase("installing", null);
    // The repo declares its private registry; the daemon holds the PAT. The
    // credential goes ONLY into the user-level npmrc — the clone's tree is
    // committed and pushed, so a clone-level .npmrc would publish the PAT.
    if (config.registry && this.pat) {
      mergeNpmrc(npmrcPath(), [
        {
          key: `${scopeOf(config.registry)}:registry`,
          value: `https://${config.registry.host}/`,
        },
        { key: `//${config.registry.host}/:_authToken`, value: this.pat },
      ]);
    }
    await this.runCommand(config.install, "install");
    writeFileSync(join(this.root, ".git", INSTALL_MARKER), this.dependencyHash());
    return true;
  }

  private dependencyHash(): string {
    return dependencyHash(this.root);
  }

  private dependenciesMoved(): boolean {
    const marker = join(this.root, ".git", INSTALL_MARKER);
    if (!existsSync(marker)) return true;
    try {
      return readFileSync(marker, "utf8") !== this.dependencyHash();
    } catch {
      return true;
    }
  }

  private async runCommand(command: string, label: string): Promise<void> {
    await this.requirePnpmIfReferenced(command);
    const result = await this.capture(command, this.spawnOptions());
    if (result.code === 0) return;
    if (detectsRegistryAuthFailure(result.output)) throw new Error(REGISTRY_AUTH_DETAIL);
    // The tail, not just the last line: a gate failure is handed to Claude,
    // whose fix starts where the first error line points.
    const tail = result.output
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-GATE_OUTPUT_TAIL_LINES)
      .join("\n");
    throw new Error(
      redact(`${label} 명령이 실패했습니다 (exit ${result.code})\n${tail}`, this.pat),
    );
  }

  /** A colo-design command may or may not need pnpm; only demand it when it does. */
  private async requirePnpmIfReferenced(command: string): Promise<void> {
    if (!/\bpnpm\b/.test(command)) return;
    if (!(await resolvePnpmExecutable())) throw new Error(PNPM_MISSING_DETAIL);
  }

  // -------------------------------------------------------------------------
  // Preview server
  // -------------------------------------------------------------------------
  private async startPreview(config: ColoDesignConfig): Promise<void> {
    // Second fence, closer to the metal: the window between bootstrap's gate
    // and this spawn is exactly where a fast B→C switch lands. An inactive
    // project must neither kill the port's holder nor START a server of its
    // own past the switch (the one it already has stays warm — the server's
    // switch fence decides that one).
    if (!this.active) return;
    await this.killPreview();
    this.setPhase("starting", null);
    const { command, port } = config.preview;
    await this.requirePnpmIfReferenced(command);

    // 활성 프로젝트가 선언한 포트의 주인은 활성 프로젝트다. 충돌의 보통 원인은
    // 강제 종료된 데몬이 남긴 고아 서버고, 전환 때 이전 프로젝트의 잔여분은 이미
    // 정리되므로 — 묻지 않고 점유자를 정리하고 이 자리에서 다시 띄운다. 명명된
    // 실패는 정리가 실패했을 때만 남는다: 그때는 다시 시작도 소용이 없으니
    // 직접 종료나 포트 변경이 다음 과제다. The kill is listener-only: a blanket
    // port kill also hits the port's clients.
    // The reclaimer runs unconditionally: a probe gate ("is the port busy?")
    // reads the same flaky 1s connect that the verdict below refuses to
    // trust — a starved runner can time it out against a live listener and
    // skip the kill, spawning the preview into EADDRINUSE. With nothing
    // listening, lsof finds no pid and the first refusal clears instantly —
    // the free-port path pays one lookup, nothing more.
    // 살아 있는 다른 인스턴스의 미리보기는 죽이지 않는다. 이 기록이 가리키는
    // 점유자는 고아가 아니라 다른 창(패키지 앱 또는 데몬)의 살아 있는 서버다 —
    // 죽이는 순간 두 인스턴스는 서로의 미리보기를 번갈아 죽이는 전쟁에 들어간다
    // (실사: 앱+개발 데몬이 포트 3000을 두고 1~2분마다 서버를 교체). 여기서는
    // 멈추고 카드로 말한다. 해법은 이 창 밖에 있다.
    const held = await foreignLivePreviewClaim(port);
    if (held)
      throw new PreviewHeldElsewhereError(
        `포트 ${port}에서 다른 Colo Design 인스턴스가 이 프로젝트의 미리보기를 이미 돌리고 있습니다 — ` +
          `서로의 미리보기를 죽이지 않도록 이쪽에서는 기다립니다. ` +
          `다른 인스턴스를 끄거나 연결 레포의 colo-design.json에서 preview.port를 바꾼 뒤 다시 시도해 주세요.`,
      );
    if (!(await this.killPortHolder(port)))
      throw new PreviewPortBusyError(
        `포트 ${port}를 종료하려 했지만 여전히 다른 프로그램이 쓰고 있어 미리보기를 켤 수 없습니다 — ` +
          `권한이 없거나 프로그램이 곧바로 되살아났을 수 있습니다. ` +
          `그 프로그램을 직접 끄거나 연결 레포의 colo-design.json에서 preview.port를 바꿔 주세요.`,
      );

    const child = spawn(command, this.spawnOptions());
    this.preview = child;
    this.previewEpoch += 1;
    /** Last output line, so an exit can quote what the command actually said. */
    let lastLine: string | null = null;
    const absorb = (chunk: Buffer) => {
      const line = String(chunk)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();
      if (!line) return;
      lastLine = line;
      this.setProgressLine(line);
    };
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);

    child.once("exit", (code, signal) => {
      if (this.preview !== child) return; // stop() already took it down
      this.preview = null;
      // 죽은 미리보기의 기록은 곧바로 거둔다 — 남은 기록은 낡은 리스너를
      // 가리켜 판정 때 스스로 지워지지만, 여기서 지우는 것이 정확하다.
      if (this.config?.preview.port) clearPreviewClaim(this.config.preview.port);
      const how = signal ? `signal ${signal}` : `exit ${code}`;
      this.setPhase(
        "error",
        // The command's own last line is what says WHY; an exit code alone
        // sends the planner to a terminal they were promised they would not need.
        lastLine
          ? `미리보기 서버가 종료되었습니다 (${how}) — ${lastLine}`
          : `미리보기 서버가 종료되었습니다 (${how})`,
        "preview",
      );
    });

    try {
      await this.waitReady(port);
    } catch (error) {
      // 늦게라도 뜰 예정이던 서버를 죽은 것으로 선고한 채 두면, 실제로는 살아
      // 포트를 쥔 유령이 남는다 (실사 목격). 선고가 서면 서버도 내려야 한다.
      await this.killPreview();
      throw error;
    }
    // 부팅이 확인된 리스너를 기록해 둔다 — 다음 포트 충돌 때 이 기록이 살아 있는
    // 다른 인스턴스의 미리보기를 말해 준다(위의 울타리).
    const holders = await portListenerPids(port);
    writePreviewClaim({
      instancePid: process.pid,
      listenerPid: holders[0] ?? null,
      port,
      at: new Date().toISOString(),
    });
  }

  private spawnOptions(): SpawnOptions {
    const windows = currentPlatform() === "win32";
    return {
      cwd: this.root,
      // colo-design.json commands are strings ("pnpm dev"), so a shell parses
      // them. `detached` on POSIX puts the tree in one process group we can
      // signal together when the preview must stop.
      shell: true,
      detached: !windows,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // The preview must never inherit a key that would bill API credit.
        ANTHROPIC_API_KEY: undefined,
        // The desktop app bundles portable Node/pnpm (and MinGit on Windows)
        // in its resources; those binaries win over whatever the planner's
        // machine happens to have — or not have — on PATH.
        PATH: extraPathPrefix(process.env.COLO_DESIGN_EXTRA_PATH),
      },
    };
  }

  private async waitReady(port: number): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.preview) throw new Error(this.detail ?? "미리보기 서버가 시작되지 않았습니다");
      if (await this.isServing(port)) return;
      await sleep(250);
    }
    throw new Error(
      `미리보기 서버가 ${READY_TIMEOUT_MS / 1000}초 안에 응답하지 않았습니다 (포트 ${port})`,
    );
  }

  /** Ready means the port is open *and* the app answers, not just listening. */
  private async isServing(port: number): Promise<boolean> {
    if (!(await portAccepts(port))) return false;
    return await respondsOk(`http://127.0.0.1:${port}/`);
  }

  private async killPreview(): Promise<void> {
    const child = this.preview;
    if (!child) return;
    this.preview = null;

    const { promise: exited, resolve } = Promise.withResolvers<void>();
    child.once("exit", () => resolve());
    killTree(child, "SIGTERM");
    const hard = setTimeout(() => killTree(child, "SIGKILL"), 3_000);
    await exited;
    clearTimeout(hard);

    // The command may start its server as its own child; the port is only
    // free once that process is gone, and a re-start would fail on a busy port.
    const port = this.config?.preview.port;
    if (!port) return;
    const deadline = Date.now() + 3_000;
    while (!(await portRefused(port))) {
      if (Date.now() > deadline) break;
      await sleep(100);
    }
    clearPreviewClaim(port);
  }

  /**
   * 다시 시작's mandate: whatever LISTENS on the declared preview port dies —
   * and only the listener. lsof without the LISTEN filter also matches the
   * port's clients (a browser tab on the old preview, this app's own iframe),
   * and a restart that kill -9s the planner's browser is no fix. The lookup's
   * exit status is not trusted — bind-ability is the verdict.
   */
  private async killPortHolder(port: number): Promise<boolean> {
    this.setProgressLine(`포트 ${port}를 쓰는 프로그램을 종료하는 중…`);
    for (const pid of await portListenerPids(port)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone, or not ours to signal — the verdict below says
        // whether the port actually freed.
      }
    }
    // The OS retires the listener asynchronously; a re-start before the port
    // truly frees would fail on the very bind this kill was for. Only an
    // explicit refusal is "free": a probe timeout can fire against a still-
    // bound listener on a starved runner, and a verdict read from it spawns
    // the preview into EADDRINUSE while the holder lives on.
    const deadline = Date.now() + 5_000;
    while (!(await portRefused(port))) {
      if (Date.now() > deadline) return false;
      await sleep(100);
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Process capture
  // -------------------------------------------------------------------------

  private async git(
    args: string[],
    cwd = this.root,
    /** Per-call environment — the checkpoint's temporary GIT_INDEX_FILE. */
    env: NodeJS.ProcessEnv = {},
  ): Promise<string> {
    const windows = currentPlatform() === "win32";
    // The same binary the onboarding gate judged: on a Finder-launched app
    // whose PATH stops at /usr/bin, a Homebrew-only git is exactly the one
    // the resolver found and the one the clone below needs.
    const git = (await resolveGitExecutable()) ?? "git";
    const result = await this.capture(
      git,
      {
        cwd,
        // `.cmd` shims are not executables on Windows; the resolver returns a
        // real git.exe, so the shell is only for the unresolved fallback.
        shell: windows && git === "git",
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: undefined,
          ...this.gitAuthEnv(),
          ...env,
        },
      },
      args,
    );
    if (result.code === 0) return result.stdout;
    // PLAN D36: a Korean lead, then git's own words — the throw may reach a
    // notice verbatim, and `exit` was never a word the planner wrote.
    throw new Error(
      redact(
        `git ${args[0]}에 실패했습니다 (${result.code}) — ${result.lastLine || result.output}`.trim(),
        this.pat,
      ),
    );
  }

  private capture(
    command: string,
    options: SpawnOptions,
    args: string[] = [],
  ): Promise<{
    code: number | null;
    output: string;
    stdout: string;
    lastLine: string;
  }> {
    const { promise, resolve, reject } = Promise.withResolvers<{
      code: number | null;
      output: string;
      stdout: string;
      lastLine: string;
    }>();

    let child: ChildProcess;
    try {
      child = spawn(command, args, options);
    } catch (error) {
      reject(error);
      return promise;
    }
    let output = "";
    let stdout = "";
    let lastLine = "";
    const absorb = (chunk: Buffer) => {
      const text = String(chunk);
      // The whole output is kept for the 401 check but only the tail is worth
      // holding: an install can print megabytes.
      output = (output + text).slice(-20_000);
      const line = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();
      if (line) {
        lastLine = line;
        this.setProgressLine(line);
      }
    };
    const absorbStdout = (chunk: Buffer) => {
      stdout = (stdout + String(chunk)).slice(-1_000_000);
      absorb(chunk);
    };
    child.stdout?.on("data", absorbStdout);
    child.stderr?.on("data", absorb);
    child.once("error", (error) =>
      reject(
        error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(GIT_MISSING_DETAIL)
          : error,
      ),
    );
    child.once("close", (code) => resolve({ code, output, stdout, lastLine }));
    return promise;
  }

  // -------------------------------------------------------------------------
  // Status plumbing
  // -------------------------------------------------------------------------

  private snapshot(): RepoStatus {
    const port = this.phase === "ready" ? (this.config?.preview.port ?? null) : null;
    return {
      root: this.root,
      phase: this.phase,
      detail: this.detail,
      previewUrl: port === null ? null : `http://127.0.0.1:${port}`,
      previewPort: port,
      previewEpoch: port === null ? null : this.previewEpoch,
      url: this.url,
      branch: this.branch,
      baseBranch: this.baseBranch,
      handoff: this.openHandoff,
      pendingChanges: this.pendingChanges,
      errorKind: this.errorKind,
      commands: this.config
        ? {
            install: this.config.install,
            check: this.config.check,
            build: this.config.build,
            preview: this.config.preview.command,
          }
        : undefined,
    };
  }

  /**
   * Why a bring-up failed, from the constants this class itself threw (PLAN
   * D41) — the same words `classifyError` used to substring-match on the web
   * side, now decided where the throw happened.
   */
  private bringUpErrorKind(error: unknown): RepoErrorKind {
    const message = error instanceof Error ? error.message : String(error);
    // The refusal names the commands it blocks (the card shows the evidence),
    // so the sentence CONTINUES past the constant — prefix, not equality.
    if (message.startsWith(COMMANDS_UNAPPROVED_DETAIL)) return "commands";
    if (error instanceof PreviewPortBusyError) return "port-busy";
    if (error instanceof PreviewHeldElsewhereError) return "held-elsewhere";
    if (error instanceof BootstrapPrepareError || message === BOOTSTRAP_FAILED_DETAIL) {
      return "bootstrap";
    }
    if (message === PNPM_MISSING_DETAIL) return "pnpm-missing";
    if (message === REGISTRY_AUTH_DETAIL) return "registry-auth";
    // D96: 최신화 충돌의 한 줄은 정확히 이 상수로 던져지므로, 같은 상수로
    // 읽는다 — 오류 카드가 "Claude에게 해결 요청" 을 보여 줄 수 있는 근거.
    if (
      message === REFRESH_CONFLICT_DETAIL ||
      message === RECOVER_CONFLICT_DETAIL ||
      message.includes("충돌한 파일")
    ) {
      return "conflict";
    }
    if (message.includes("미리보기 서버") || message.includes("preview.port")) return "preview";
    return this.isCloned() ? "install" : "clone";
  }

  /**
   * Recount what a 저장 would carry, then tell everyone (PLAN D8).
   *
   * Called where the number can actually have moved: a 화면 turn that finished
   * writing files, and a save that just cleaned the worktree. `git status` on
   * a clone this size is milliseconds, and a failure here must never take down
   * the caller — a stale count is a wrong button, a thrown error is a dead
   * session.
   */
  async refreshPendingChanges(): Promise<void> {
    if (!this.isCloned()) return;
    let next = 0;
    try {
      const out = await this.git(["-c", "core.quotepath=false", "status", "--porcelain"]);
      next = out.split("\n").filter((line) => line.trim().length > 0).length;
    } catch {
      return;
    }
    if (next === this.pendingChanges) return;
    this.pendingChanges = next;
    this.emit();
  }

  private setPhase(
    phase: RepoPhase,
    detail: string | null,
    kind: RepoErrorKind | null = null,
  ): void {
    this.phase = phase;
    this.detail = detail;
    this.errorKind = phase === "error" ? kind : null;
    this.emit();
  }

  private setDetail(detail: string): void {
    this.detail = detail;
    // Progress lines arrive faster than any UI can use them.
    if (Date.now() - this.lastEmit < DETAIL_THROTTLE_MS) return;
    this.emit();
  }

  /**
   * 진행 줄은 판정이 아니다: workspace 가 `error` 에 앉아 있는 동안에는 마지막
   * 판정이 그 자리를 지킨다. 실사에서 발견한 결함: 포트 충돌로 실패한 뒤 뒤에서
   * 돈 git fetch 의 진행 출력(`* branch main -> FETCH_HEAD`)이 에러 문구를
   * 덮어 써, 기획자는 실패 이유로 git 의 말을 읽게 됐다. 진행은 phase 가
   * 다시 움직이는 순간부터 흐른다.
   */
  private setProgressLine(line: string): void {
    if (this.phase === "error") return;
    this.setDetail(line);
  }

  private emit(): void {
    this.lastEmit = Date.now();
    this.onStatus(this.snapshot());
  }
}

const GIT_MISSING_DETAIL = "git을 찾을 수 없습니다 — git을 설치한 뒤 다시 시도해 주세요.";

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

/** The npm scope form with a leading @, whatever the repo wrote. */
function scopeOf(registry: ColoDesignRegistry): string {
  return registry.scope.startsWith("@") ? registry.scope : `@${registry.scope}`;
}

function detailOf(error: unknown, pat: string | null): string {
  return redact(error instanceof Error ? error.message : String(error), pat);
}

// ---------------------------------------------------------------------------
// Spec attachments
// ---------------------------------------------------------------------------

export interface SpecFile {
  name: string;
  mediaType: string;
  /** base64 */
  data: string;
}

const ALLOWED_SPEC_EXTENSIONS = [".md", ".txt", ".pdf", ".png", ".jpg", ".jpeg", ".webp"];
const MAX_SPEC_NAME = 100;

/**
 * `<YYYY-MM-DD>-<original name>.<ext>`, unique within `specs/`.
 *
 * The name reaches Claude as an `@specs/…` mention and reaches the filesystem
 * of three operating systems, so anything a path parser could read as
 * structure is removed. Spaces and Korean stay: the planner recognises their
 * own document by them.
 */
export function specFileName(
  original: string,
  date: string,
  taken: (candidate: string) => boolean,
): string {
  const dot = original.lastIndexOf(".");
  const extension = dot > 0 ? original.slice(dot).toLowerCase() : "";
  if (!ALLOWED_SPEC_EXTENSIONS.includes(extension)) {
    throw new Error(
      `첨부할 수 없는 파일 형식입니다: ${extension || original} (허용: ${ALLOWED_SPEC_EXTENSIONS.join(" ")})`,
    );
  }

  const cleaned =
    (dot > 0 ? original.slice(0, dot) : original)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: 제어 문자 strip 이 목적이다.
      .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "")
      .replace(/^\.+/, "")
      .trim() || "spec";

  // Planners date their filenames too, and `2026-09-08-2026-09-08-…` reads as
  // a bug to the person who attached it.
  const prefix = /^\d{4}-\d{2}-\d{2}-/.test(cleaned) ? "" : `${date}-`;
  const base =
    prefix + cleaned.slice(0, Math.max(1, MAX_SPEC_NAME - prefix.length - extension.length));

  let candidate = base + extension;
  for (let n = 2; taken(candidate); n += 1) candidate = `${base}-${n}${extension}`;
  return candidate;
}

/** Writes each attachment into `<cwd>/specs/` and returns the relative paths. */
export function saveSpecFiles(cwd: string, files: SpecFile[], now = new Date()): string[] {
  const dir = join(cwd, "specs");
  mkdirSync(dir, { recursive: true });
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const saved: string[] = [];
  for (const file of files) {
    const name = specFileName(
      file.name,
      date,
      (candidate) => existsSync(join(dir, candidate)) || saved.includes(`specs/${candidate}`),
    );
    writeFileSync(join(dir, name), Buffer.from(file.data, "base64"));
    saved.push(`specs/${name}`);
  }
  return saved;
}

// ---------------------------------------------------------------------------
// Workspace trust
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

  // biome-ignore lint/suspicious/noAssignInExpressions: 없으면 만들고 그 값을 곧 쓰는 ??= 관용구다.
  const projects = (config.projects ??= {});
  let changed = false;
  for (const key of keys) {
    // biome-ignore lint/suspicious/noAssignInExpressions: 없으면 만들고 그 값을 곧 쓰는 ??= 관용구다.
    const project = (projects[key] ??= {});
    if (project.hasTrustDialogAccepted !== true) {
      project.hasTrustDialogAccepted = true;
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

// ---------------------------------------------------------------------------
// Small process/network helpers
// ---------------------------------------------------------------------------

/** Identity of the installed dependency set: reinstall exactly when it moves. */
function dependencyHash(root: string): string {
  const hash = createHash("sha256");
  for (const file of ["package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    const path = join(root, file);
    hash.update(file);
    hash.update(existsSync(path) ? readFileSync(path) : Buffer.alloc(0));
  }
  return hash.digest("hex").slice(0, 16);
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    // Detached on POSIX means the shell and its children share a process
    // group; signalling the group is what actually releases the port.
    if (currentPlatform() !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

function portAccepts(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // A refused connection is the kernel's definitive "nothing listens here";
    // the 1s timeout is not. An event loop starved past the second (a loaded
    // runner mid-suite is enough) can deliver the timeout before the connect
    // of a LIVE listener — and a busy-port read that trusts it skips the
    // reclaimer and spawns the preview into EADDRINUSE. One immediate retry
    // turns that coin flip back into a fact; a dead port still refuses
    // instantly, so the free-side verdict pays nothing.
    const attempt = (retriesLeft: number) => {
      const socket = createConnection({ port, host: "127.0.0.1" });
      socket.setTimeout(1_000);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("timeout", () => {
        socket.destroy();
        if (retriesLeft > 0) attempt(retriesLeft - 1);
        else resolve(false);
      });
    };
    attempt(1);
  });
}

/**
 * The port's DEFINITIVE free verdict. A refused connection is the kernel
 * saying nothing listens here; a connect means something still answers; a
 * timeout is merely "unknown" — on a starved runner it can fire while a live
 * listener is still bound, so it reads as NOT free and the caller waits on.
 */
function portRefused(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = createConnection({ port, host: "127.0.0.1" });
  socket.setTimeout(1_000);
  socket.once("error", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("connect", () => {
    socket.destroy();
    resolve(false);
  });
  socket.once("timeout", () => {
    socket.destroy();
    resolve(false);
  });
  return promise;
}

function respondsOk(url: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const request = httpGet(url, (response) => {
    response.resume();
    resolve(response.statusCode === 200);
  });
  request.setTimeout(2_000, () => {
    request.destroy();
    resolve(false);
  });
  request.once("error", () => resolve(false));
  return promise;
}

// ---------------------------------------------------------------------------
// 넘기기 본문의 코멘트 절 (PLAN D93) — the developer reads what changed AND
// why, without leaving the pull request.
// ---------------------------------------------------------------------------

/** The planner's words for a screen state, matching the web's stateLabel. */
const COMMENT_STATE_LABEL: Record<string, string> = {
  default: "기본",
  empty: "비어 있음",
  loading: "불러오는 중",
  error: "오류",
};

/**
 * Builds the `### 수정 요청` section from this cycle's recorded comments:
 * 브랜치가 생긴 시각(sinceIso) 이후의 항목, 최대 20건(넘으면 `외 N건`), 화면은
 * 선언된 제목으로, 요소 이름과 경로는 쓰지 않는다(D38). 자동 정리 뒤 모든 행은
 * Claude에게 전달된 것 — 해결 표식은 없다, 목록 자체가 요청의 기록이다.
 */
export function buildCommentsSection(
  rows: Array<{
    screen: string;
    state: string;
    text: string;
    at: string;
  }>,
  screenTitle: (screenId: string) => string | null,
  sinceIso: string,
  max = 20,
): string | null {
  // Compare as instants, not strings: the commit date is local-offset ISO,
  // the comment rows are UTC — a string compare would sort them wrong.
  const sinceMs = Date.parse(sinceIso);
  if (Number.isNaN(sinceMs)) return null;
  const cycle = rows
    .filter((row) => {
      const at = Date.parse(row.at);
      return !Number.isNaN(at) && at >= sinceMs;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (cycle.length === 0) return null;
  const shown = cycle.slice(-max);
  const overflow = cycle.length - shown.length;
  const lines = shown.map((row) => {
    const screen = screenTitle(row.screen) ?? row.screen;
    const state = COMMENT_STATE_LABEL[row.state] ?? row.state;
    return `- ${screen} · ${state} — "${row.text}"`;
  });
  const tail = overflow > 0 ? `\n- 외 ${overflow}건` : "";
  return `### 수정 요청\n\n기획자가 미리보기에서 찍어 Claude에게 보낸 수정 요청입니다.\n\n${lines.join("\n")}${tail}\n`;
}

// ---------------------------------------------------------------------------
// 연결 준비 (PLAN D94) — Claude 가 쓴 설정을 기계 검증하는 울타리. 벗어난
// 명령은 한 번도 실행되지 않는다: "그래도 실행" 버튼은 없다.
// ---------------------------------------------------------------------------

/** Claude 가 쓴 연결 설정이 이 도구의 울타리 안에 있는지 판정하는 입력. */
export interface BootstrapValidationInput {
  config: {
    install?: string;
    check?: string;
    build?: string;
    preview?: { command: string; port: number };
  };
  /** package.json 의 scripts — 허용된 스크립트의 유일한 출처다. */
  packageScripts: Record<string, unknown>;
  /** 락파일이 정하는 설치 명령 — 없으면 pnpm 이 기본이다. */
  lockfile: "pnpm-lock.yaml" | "package-lock.json" | "yarn.lock" | null;
}

const LOCKFILE_INSTALL: Record<string, string> = {
  "pnpm-lock.yaml": "pnpm install",
  "package-lock.json": "npm ci",
  "yarn.lock": "yarn install",
};

/**
 * `pnpm run dev` · `pnpm dev` · `npm run dev` 꼴만 허용한다 — scripts 에 있는
 * 스크립트 이름만 뒤에 붙을 수 있고, 그 외의 문자는 전부 거부다.
 */
export function validateBootstrapConfig(input: BootstrapValidationInput): string | null {
  const { config, packageScripts, lockfile } = input;
  const expectedInstall = LOCKFILE_INSTALL[lockfile ?? "pnpm-lock.yaml"];
  if (config.install !== expectedInstall) {
    return `install 명령이 락파일과 맞지 않습니다 — "${expectedInstall}" 이어야 합니다.`;
  }
  const scriptGate = (label: string, raw: string | undefined): string | null => {
    if (!raw) return null;
    const words = raw.trim().split(/\s+/);
    if (words.length === 0 || words.length > 3) {
      return `${label} 명령이 허용된 꼴이 아닙니다 — "<pm> [run] <script>" 만 허용됩니다.`;
    }
    const [pm, second, third] = words;
    if (!pm || !["pnpm", "npm", "yarn", "bun"].includes(pm)) {
      return `${label} 명령의 실행 도구(${pm ?? "(없음)"})는 허용되지 않습니다 — pnpm · npm · yarn · bun 만 됩니다.`;
    }
    let scriptName: string | undefined;
    if (words.length === 3) {
      if (second !== "run") {
        return `${label} 명령이 허용된 꼴이 아닙니다 — "<pm> run <script>" 이어야 합니다.`;
      }
      scriptName = third;
    } else {
      scriptName = second;
    }
    if (typeof scriptName !== "string" || !(scriptName in packageScripts)) {
      return `${label} 명령의 스크립트(${String(scriptName)})가 package.json 의 scripts 에 없습니다.`;
    }
    return null;
  };
  for (const [label, raw] of [
    ["check", config.check],
    ["build", config.build],
  ] as const) {
    const problem = scriptGate(label, raw);
    if (problem) return problem;
  }
  if (config.preview) {
    const problem = scriptGate("preview", config.preview.command);
    if (problem) return problem;
    const port = config.preview.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return "preview.port 는 1~65535 사이의 포트여야 합니다.";
    }
  }
  return null;
}

/** D94: 준비 턴이 계약을 못 썼을 때의 오류 — errorKind "bootstrap". */
class BootstrapPrepareError extends Error {}

/**
 * 선언된 미리보기 포트를 정리하려 했지만 정리하지 못했을 때의 오류 — errorKind
 * "port-busy". 평범한 충돌은 활성 프로젝트가 이겨 자동 정리되지만, 이 오류는
 * 그 정리가 실패한 경우다(권한 부재 · 즉시 되살아남). 카드의 다음 과제는
 * 직접 종료나 colo-design.json 의 포트 변경이다. 종류는 던지는 자리가 밝힌다
 * (PLAN D41).
 */
class PreviewPortBusyError extends Error {}

/**
 * 살아 있는 다른 인스턴스의 미리보기를 발견했을 때의 오류 — errorKind
 * "held-elsewhere". 점유자가 고아가 아니라 다른 창(패키지 앱 또는 데몬)의 산
 * 서버라는 뜻이고, 죽이는 대신 이쪽이 멈춘다. 종류는 던지는 자리가 밝힌다
 * (PLAN D41).
 */
class PreviewHeldElsewhereError extends Error {}

// ---------------------------------------------------------------------------
// Preview ownership claims — 두 인스턴스의 포트 전쟁을 끊는 울타리
// ---------------------------------------------------------------------------

/**
 * 어느 인스턴스가 어느 포트의 미리보기를 띄웠는지 한 줄짜리 기록,
 * `~/.colo-design/run/preview-<포트>.json`. 검사 스위트는 `COLO_DESIGN_RUN_DIR`
 * 로 갈라 놓는다 — 개발자의 실제 기록을 읽지도 쓰지도 않도록, 프로젝트
 * 등록부가 하는 것과 같은 격리다.
 */
export interface PreviewClaim {
  /** 이 미리보기를 띄운 데몬(또는 앱) 프로세스의 pid. */
  instancePid: number;
  /** 부팅이 확인된 순간 포트의 LISTEN 소유자. 조회가 순간 실패하면 null —
   * 그때는 주인이 살아 있는 한 이 기록을 지킨다 (foreignLivePreviewClaim). */
  listenerPid: number | null;
  port: number;
  at: string;
}

function previewClaimFile(port: number, env: NodeJS.ProcessEnv = process.env): string {
  return join(env.COLO_DESIGN_RUN_DIR ?? join(COLO_DESIGN_DIR, "run"), `preview-${port}.json`);
}

export function readPreviewClaim(
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): PreviewClaim | null {
  try {
    const parsed = JSON.parse(readFileSync(previewClaimFile(port, env), "utf8")) as PreviewClaim;
    if (typeof parsed?.instancePid === "number" && parsed.port === port) return parsed;
  } catch {
    // 없거나 깨진 기록은 없는 것과 같다 — 울타리는 기록이 있을 때만 선다.
  }
  return null;
}

export function writePreviewClaim(claim: PreviewClaim, env: NodeJS.ProcessEnv = process.env): void {
  const file = previewClaimFile(claim.port, env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(claim, null, 2)}\n`, { mode: 0o600 });
}

export function clearPreviewClaim(port: number, env: NodeJS.ProcessEnv = process.env): void {
  rmSync(previewClaimFile(port, env), { force: true });
}

/** signal 0 은 흔들지 않는다 — EPERM 도 프로세스가 살아 있다는 답이다. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 이 포트에서 LISTEN 하는 pid 들 — lsof(linux·mac) / netstat(windows). */
export async function portListenerPids(port: number): Promise<number[]> {
  const windows = currentPlatform() === "win32";
  const args = windows ? ["-a", "-n", "-o"] : ["-t", `-i:${port}`, "-sTCP:LISTEN"];
  const stdout = await new Promise<string>((resolve, reject) =>
    execFile(
      windows ? "netstat" : "lsof",
      args,
      { timeout: 10_000, shell: windows },
      (error, out) => (error ? reject(error) : resolve(String(out))),
    ),
  ).catch(() => "");
  const pids = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    if (windows) {
      // `TCP  0.0.0.0:3000  0.0.0.0:0  LISTENING  4321` — the local address
      // names the port, the last column owns it.
      const columns = line.trim().split(/\s+/);
      const local = columns[1] ?? "";
      if (columns.length < 5 || columns[3] !== "LISTENING" || !local.endsWith(`:${port}`)) continue;
      const pid = Number(columns[4] ?? NaN);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    } else {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  return [...pids];
}

/**
 * 이 포트의 기록이 살아 있는 다른 인스턴스의 미리보기를 가리키면 그 기록을
 * 돌려 준다 — startPreview 는 이 경우 점유자를 죽이는 대신 멈춘다. 그 외는
 * 모두 정리하고 null: 우리 것(같은 pid), 주인이 죽은 고아의 기록, 기록이
 * 가리킨 리스너가 이미 사라진 낡은 기록.
 *
 * 오류의 방향은 하나다 — 살아 있는 남의 미리보기를 죽이는 쪽이 아니라, 죽어
 * 있는 점유자를 잠시 남겨 두는 쪽. 그래서 기록 시점의 리스너 조회가 순간
 * 실패해 listenerPid 가 null 인 기록(실사 목격: lsof 가 갓 뜬 리스너를 한
 * 번 놓쳤다)은 주인이 살아 있는 한 지킨다. 주인의 서버가 정말 죽으면 주인
 * 인스턴스의 exit 경로가 기록을 거두고, 그러지 못한 채 주인만 죽으면 이
 * 함수의 고아 판정이 거둔다.
 */
export async function foreignLivePreviewClaim(
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PreviewClaim | null> {
  const claim = readPreviewClaim(port, env);
  if (!claim) return null;
  if (claim.instancePid === process.pid) return null;
  if (!pidAlive(claim.instancePid)) {
    clearPreviewClaim(port, env);
    return null;
  }
  if (claim.listenerPid === null) return claim;
  const holders = await portListenerPids(port);
  if (holders.includes(claim.listenerPid)) return claim;
  clearPreviewClaim(port, env);
  return null;
}
