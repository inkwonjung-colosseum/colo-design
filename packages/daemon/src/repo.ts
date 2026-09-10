import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { get as httpGet } from "node:http";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  DiffFile,
  DiffHunk,
  DiffStatus,
  HandoffStatus,
  RepoPhase,
  RepoStatus,
} from "@cds-design/protocol";
import { markTurn } from "@cds-design/protocol";
import {
  currentPlatform,
  detectsRegistryAuthFailure,
  resolveGitExecutable,
  resolvePnpmExecutable,
} from "./environment.js";
import { GitHubClient, parseRepoSlug } from "./github.js";
import { mergeNpmrc, npmrcPath } from "./credentials.js";

/**
 * The connected repo workspace: a clone of the repo the planner pointed the
 * daemon at, driven by that repo's own `cds-design.json` (install/check/build
 * commands, preview command + port, optional private registry). The daemon
 * clones and pulls it, runs its commands, and frames its preview server —
 * what the preview renders is entirely the repo's business.
 */

const CONFIG_FILE = "cds-design.json";
/** Reinstall marker, kept inside `.git/` so it travels with the clone only. */
const INSTALL_MARKER = "cds-design-install-hash";
const READY_TIMEOUT_MS = 30_000;
const DETAIL_THROTTLE_MS = 200;
/** Commit message when the planner approves without writing one. */
const DEFAULT_COMMIT_MESSAGE = "CDS Design 화면 변경";
/** PR title when the planner sends the handoff without editing it. */
const DEFAULT_HANDOFF_TITLE = "CDS Design 화면 전달";
/**
 * Every branch this tool creates lives under one prefix, so a developer can
 * tell at a glance which branches a planner made and which are theirs.
 */
const BRANCH_PREFIX = "cds-design";
/** How many output lines a failed gate quotes back to people and Claude. */
const GATE_OUTPUT_TAIL_LINES = 30;

/**
 * What Claude is told when a step fails, named the way the planner's own
 * button is. "push 단계가 실패했습니다" would send it looking for a git
 * problem when the planner pressed 저장.
 */
const GATE_BRIEF: Record<"check" | "build" | "commit" | "push" | "pr", string> = {
  check: "저장 전 검사(check)가 실패했습니다.",
  build: "넘기기 전 빌드(build)가 실패했습니다.",
  commit: "저장할 변경을 커밋하지 못했습니다.",
  push: "저장한 변경을 올리지 못했습니다.",
  pr: "개발자에게 넘기지 못했습니다.",
};

/**
 * The same five failures, named for the button the planner pressed rather than
 * for the step that ran. This is what the transcript CARD says (PLAN D9); the
 * brief above is what Claude reads, command output and all.
 */
const GATE_STEP: Record<"check" | "build" | "commit" | "push" | "pr", string> = {
  check: "저장 전 검사",
  build: "넘기기 전 빌드",
  commit: "저장",
  push: "저장한 내용 올리기",
  pr: "개발자에게 넘기기",
};
/**
 * The stash this tool parks unsaved work in while 최신화 moves the branch.
 * Named for the button, so `git stash list` reads like the product, not git.
 */
const STASH_MESSAGE = "CDS Design: 최신화 임시 보관";

/** What the planner reads when a conflict needs Claude and no thread is open. */
const REFRESH_CONFLICT_DETAIL =
  "최신 변경을 받아 오다 저장하지 않은 변경과 충돌이 남았습니다 — 대화를 열면 Claude가 정리합니다. 정리 전까지는 같은 상태입니다.";

/**
 * The one refresh this tool refuses to do alone: the base branch carries
 * commits the clone does not know. Rewriting history a planner cannot read
 * is not 자동 병합, so it stays a named failure.
 */
const REFRESH_DIVERGED_DETAIL =
  "기본 브랜치에 원격과 갈라진 커밋이 있어 자동 최신화를 멈췄습니다 — 대화를 열면 Claude가 확인합니다.";


export const PNPM_MISSING_DETAIL =
  "pnpm이 없습니다 — corepack enable 또는 npm i -g pnpm 으로 설치해 주세요.";
export const REGISTRY_AUTH_DETAIL =
  "GitHub 패키지 인증이 필요합니다 — pnpm config set //npm.pkg.github.com/:_authToken <read:packages 권한 PAT>";
export const REPO_URL_MISSING_DETAIL =
  "연결 레포 주소가 설정되지 않았습니다 — 설정에서 레포 주소를 넣어 주세요.";

// ---------------------------------------------------------------------------
// cds-design.json contract
// ---------------------------------------------------------------------------

export interface CdsDesignRegistry {
  host: string;
  scope: string;
}

export interface CdsDesignConfig {
  install?: string;
  check?: string;
  build?: string;
  preview: { command: string; port: number };
  registry?: CdsDesignRegistry;
}

/**
 * Parses and validates a repo's `cds-design.json`. Every rejection names the
 * field and what it should be, in Korean: the planner is the one who has to
 * act on it, and "invalid config" is not actionable.
 */
export function parseCdsDesignConfig(source: string): CdsDesignConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `cds-design.json을 해석할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("cds-design.json은 객체여야 합니다");
  }
  const config = raw as Record<string, unknown>;

  for (const key of ["install", "check", "build"] as const) {
    const value = config[key];
    if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
      throw new Error(`cds-design.json의 ${key}는 실행할 명령을 문자열로 적어야 합니다`);
    }
  }

  const preview = config.preview;
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) {
    throw new Error('cds-design.json에 preview가 없습니다 — { "command", "port" }를 적어야 합니다');
  }
  const { command, port } = preview as Record<string, unknown>;
  if (typeof command !== "string" || command.trim() === "") {
    throw new Error("cds-design.json의 preview.command가 없습니다 — 미리보기를 띄울 명령입니다");
  }
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new Error(
      "cds-design.json의 preview.port가 잘못되었습니다 — 1~65535 사이의 포트 번호여야 합니다",
    );
  }


  const common = {
    ...(typeof config.install === "string" ? { install: config.install } : {}),
    ...(typeof config.check === "string" ? { check: config.check } : {}),
    ...(typeof config.build === "string" ? { build: config.build } : {}),
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
    throw new Error('cds-design.json의 registry는 { "host", "scope" } 형태여야 합니다');
  }

  return { ...common, registry: { host: registry.host, scope: registry.scope } };
}

export function readCdsDesignConfig(root: string): CdsDesignConfig {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) {
    throw new Error(`cds-design.json이 없습니다 — 연결 레포 루트에 ${CONFIG_FILE}가 있어야 합니다`);
  }
  return parseCdsDesignConfig(readFileSync(file, "utf8"));
}

// ---------------------------------------------------------------------------
// Credential helpers (pure, unit tested)
// ---------------------------------------------------------------------------

/** Embeds a PAT in an https url the way git accepts it; other schemes pass through. */
export function authenticatedUrl(url: string, pat: string | null): string {
  if (!pat || !url.startsWith("https://")) return url;
  return `https://${pat}@${url.slice("https://".length)}`;
}

/** git error output quotes the remote url; the PAT must never survive that. */
export function redact(text: string, secret: string | null): string {
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
    } else if (hunk && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line.startsWith("\\"))) {
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
    { header: `@@ -0,0 +1,${lines.length} @@`, lines: lines.map((line) => `+${line}`) },
  ];
  return file;
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export class RepoWorkspace {
  readonly root: string;
  /**
   * The branch a handoff PR will target (PLAN D5). Nothing reads it in M1; it
   * lives beside the url because the same project decision fixes both.
   */
  readonly baseBranch: string;

  private url: string | null;
  private pat: string | null;
  private phase: RepoPhase = "missing";
  private detail: string | null = null;
  private config: CdsDesignConfig | null = null;
  private preview: ChildProcess | null = null;
  private inFlight: Promise<RepoStatus> | null = null;
  private publishing: Promise<DiffStatus> | null = null;
  /** The session-start/button refresh while it runs — saves wait it out. */
  private refreshing: Promise<unknown> | null = null;
  private lastEmit = 0;

  private readonly onStatus: (status: RepoStatus) => void;
  private readonly onDiffStatus: ((status: DiffStatus) => void) | null;
  private readonly onUrlChange: ((url: string | null) => void) | null;
  /**
   * The work-in-progress cycle: the branch this project's saves land on, and
   * the pull request a developer received (PLAN D5).
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
   * until something asks — a fresh clone is clean, and the stepper's own
   * mount is what triggers the first real count.
   */
  private pendingChanges = 0;
  private openHandoff: HandoffStatus | null;
  private readonly onCycleChange:
    | ((cycle: { branch: string | null; handoff: HandoffStatus | null }) => void)
    | null;
  private readonly gitHubClient: (() => GitHubClient | null) | null;

  constructor(
    options: {
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
    },
  ) {
    this.root = options.root;
    this.url = options.url;
    this.pat = options.pat ?? null;
    this.onStatus = options.onStatus;
    this.onDiffStatus = options.onDiffStatus ?? null;
    this.onUrlChange = options.onUrlChange ?? null;
    this.baseBranch = options.baseBranch ?? "main";
    this.branch = options.cycle?.branch ?? null;
    this.openHandoff = options.cycle?.handoff ?? null;
    this.onCycleChange = options.onCycleChange ?? null;
    this.gitHubClient = options.gitHubClient ?? null;
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

  /** The repo's declared private registry, once its cds-design.json was read. */
  registry(): CdsDesignRegistry | null {
    return this.config?.registry ?? null;
  }

  /** Disk state only; safe to call from any client at any time. */
  async status(): Promise<RepoStatus> {
    if (this.isCloned()) {
      try {
        this.config = readCdsDesignConfig(this.root);
      } catch {
        // Keep the last known config; the working phases surface parse errors.
      }
    }
    return this.snapshot();
  }

  sync(): Promise<RepoStatus> {
    if (!this.inFlight) {
      this.inFlight = this.bootstrap().finally(() => {
        this.inFlight = null;
      });
    }
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
      // A PAT added later has to reach pulls too; clone already embedded it.
      await this.git(["remote", "set-url", "origin", authenticatedUrl(this.url, this.pat)]);
    }
    return await this.sync();
  }


  async stop(): Promise<void> {
    await this.killPreview();
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
  async pull(onSessionTurn?: (brief: string) => void): Promise<void> {
    if (this.phase !== "ready" || !this.isCloned()) return;
    // One worktree, two writers: a save or handoff in flight owns it, so
    // the refresh waits — and a save below waits for a refresh the same
    // way. Without this, the stash-move-replay window races `git diff` and
    // the planner's save can read a worktree that is momentarily parked.
    if (this.publishing) await this.publishing.catch(() => undefined);
    const run = this.refreshFromRemote(onSessionTurn)
      .then(async (outcome) => {
        // A conflict brief leaves the worktree mid-resolution: the stepper's
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
      })
      .finally(() => {
        this.refreshing = null;
      });
    this.refreshing = run;
    await run;
  }

  // -------------------------------------------------------------------------
  // The handoff cycle (PLAN D5): 저장 → 개발자에게 넘기기 → 반영됨
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
   * 저장: review → `check` → commit → push, onto this cycle's own branch.
   *
   * The base branch is never written to. A developer receives this work as a
   * pull request they can read, run and refuse — pushing past them was what
   * the old `push origin HEAD` did, and it is the one thing a tool driven by
   * someone who does not read diffs must not do.
   *
   * `build` is deliberately NOT run here. It gates 넘기기, where being wrong
   * costs a developer's attention; making every save pay for a full build
   * would teach the planner to save rarely, which is the opposite of what a
   * reviewable history needs.
   */
  save(options: { message?: string; onSessionTurn?: (brief: string) => void } = {}): Promise<DiffStatus> {
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

    // Gates can change cds-design.json or write files between here and the
    // commit: read the config fresh, and commit exactly the paths the planner
    // approved — never `git add -A`, so a gate's unreviewed output cannot ride
    // along in the save.
    const config = readCdsDesignConfig(this.root);
    this.config = config;
    if (config.check) {
      this.setDiff({ stage: "gating", gate: "check" });
      try {
        await this.runCommand(config.check, "check");
      } catch (error) {
        return this.failGate("check", error, options.onSessionTurn);
      }
    }

    this.setDiff({ stage: "pushing" });
    try {
      const branch = await this.ensureCycleBranch();
      await this.commitApproved(options.message?.trim() || DEFAULT_COMMIT_MESSAGE, approved);
      await this.git(["push", "--set-upstream", "origin", branch]);
    } catch (error) {
      return this.failGate("push", error, options.onSessionTurn);
    }

    const commit = (await this.git(["rev-parse", "HEAD"])).trim();
    // The worktree is clean now; the stepper moves off 검토·수정 on this.
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
      const taken = await this.git([
        "ls-remote",
        "--heads",
        authenticatedUrl(this.url ?? "origin", this.pat),
        name,
      ]).catch(() => "");
      if (taken.trim() === "") break;
    }

    await this.git(["checkout", "-B", name]);
    this.setCycle(name, this.openHandoff);
    return name;
  }

  /**
   * 개발자에게 넘기기: `build`, then open the pull request — or update the one
   * this cycle already has, because later saves accumulate on the same branch
   * and a second PR for the same work is noise in a developer's queue.
   */
  handoff(options: {
    title?: string;
    body?: string;
    onSessionTurn?: (brief: string) => void;
  } = {}): Promise<DiffStatus> {
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
    onSessionTurn?: (brief: string) => void;
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
        detail: "GitHub 레포가 아니라 개발자에게 넘길 수 없습니다 — 설정에서 레포 주소를 확인해 주세요.",
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

    const config = readCdsDesignConfig(this.root);
    this.config = config;
    if (config.build) {
      this.setDiff({ stage: "gating", gate: "build" });
      try {
        await this.runCommand(config.build, "build");
      } catch (error) {
        return this.failGate("build", error, options.onSessionTurn);
      }
    }

    this.setDiff({ stage: "handing-off" });
    const title = options.title?.trim() || DEFAULT_HANDOFF_TITLE;
    const body = options.body ?? "";
    try {
      const pull = this.openHandoff
        ? await client.updatePullRequest({ ...slug, number: this.openHandoff.number, title, body })
        : await client.createPullRequest({ ...slug, head: branch, base: this.baseBranch, title, body });
      const handoff: HandoffStatus = pull;
      this.setCycle(branch, handoff);
      return this.setDiff({ stage: "handed-off", handoff });
    } catch (error) {
      return this.failGate("pr", error, options.onSessionTurn);
    }
  }

  /**
   * Re-reads the pull request. A merge ends the cycle: the clone goes back to
   * the base branch with the developer's merge in it, and the next 저장 opens
   * a fresh branch — which is why this is not a passive status read.
   */
  async refreshHandoff(): Promise<HandoffStatus | null> {
    const current = this.openHandoff;
    const slug = this.repoSlug();
    const client = this.gitHubClient?.() ?? null;
    if (!current || !slug || !client) return current;

    const pull = await client
      .getPullRequest({ ...slug, number: current.number })
      .catch(() => null);
    if (!pull) return current;

    const handoff: HandoffStatus = pull;
    if (pull.state !== "merged") {
      this.setCycle(this.branch, handoff);
      return handoff;
    }

    // Merged: the work is the developer's now. Land back on the base branch
    // with their merge, and forget the branch so the next save starts clean.
    try {
      await this.git(["fetch", "origin", this.baseBranch]);
      await this.git(["checkout", this.baseBranch]);
      await this.git(["reset", "--hard", `origin/${this.baseBranch}`]);
    } catch (error) {
      // A dirty worktree can refuse the checkout. The PR really did merge, so
      // report that; the next session-start merge picks the base up anyway.
      this.setDetail(detailOf(error, this.pat));
    }
    this.setCycle(null, handoff);
    return handoff;
  }

  // -------------------------------------------------------------------------
  // 레포 최신화: bring the developer's side in without reading git (PLAN D5)
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

    // Mid-cycle, merging the developer's base needs Claude within reach — a
    // conflict has to land as a first task, not as an error nobody can read.
    // A bare bring-up mid-cycle stays put; the merge is a session start's
    // (or 최신화 button's) job, and those name a thread.
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
        : ["-c", "user.name=CDS Design", "-c", "user.email=cds-design@localhost"];
    } catch {
      return ["-c", "user.name=CDS Design", "-c", "user.email=cds-design@localhost"];
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
  private async popStash(): Promise<string[] | null> {
    try {
      await this.git(["stash", "pop"]);
      return null;
    } catch (error) {
      const conflicted = await this.conflictedFiles();
      if (conflicted.length === 0) throw error;
      return conflicted;
    }
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
   * Normally the remote url says so. `CDS_DESIGN_GITHUB_SLUG` (`owner/repo`)
   * pins it instead, which is what lets the offline suites drive the real
   * handoff path: their remote is a local bare repository, so nothing in the
   * url could name a GitHub project. Same test-seam rule as
   * `CDS_DESIGN_REPO_URL` — it exists for tests and is documented as such.
   */
  private repoSlug(): { owner: string; repo: string } | null {
    const pinned = process.env.CDS_DESIGN_GITHUB_SLUG;
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
    gate: "check" | "build" | "commit" | "push" | "pr",
    error: unknown,
    onSessionTurn: ((brief: string) => void) | undefined,
  ): DiffStatus {
    const detail = detailOf(error, this.pat);
    // The failure is actionable by Claude, not by the planner: hand it over
    // the same wire a typed message uses, output tail included. The step is
    // named the way the planner's button is, not the way git is.
    onSessionTurn?.(
      markTurn(
        { kind: "gate", step: GATE_STEP[gate] },
        `${GATE_BRIEF[gate]} 아래 출력의 원인을 고친 뒤 다시 시도해 주세요.\n\n${detail}`,
      ),
    );
    return this.setDiff({ stage: "failed", gate, detail });
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
        await this.git(
          ["clone", authenticatedUrl(this.url, this.pat), this.root],
          dirname(this.root),
        );
        trustWorkspace(this.root);
      } else {
        this.setPhase("pulling", null);
        // Already cloned: 최신화, not a blind ff. Unsaved work survives the
        // move off-cycle, and a conflict left by an earlier run resurfaces
        // with its Korean reason instead of a raw git error.
        await this.refreshFromRemote();
      }

      const config = readCdsDesignConfig(this.root);
      this.config = config;
      const installed = await this.installIfNeeded(config);

      /**
       * Count once the clone is on disk and checked out. Without this the
       * stepper reads zero after every restart — the count only moves on a
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
      this.setPhase("error", detailOf(error, this.pat));
    }
    return this.snapshot();
  }

  isCloned(): boolean {
    return existsSync(join(this.root, ".git"));
  }

  /**
   * Where a bring-up (clone · install · preview) stands right now, for callers
   * that race it — the onboarding wizard's check runs while the create it
   * just fired is still cloning, and has to read that as progress, not as a
   * broken manifest.
   */
  syncState(): { running: boolean; phase: RepoPhase; detail: string | null } {
    return { running: this.inFlight !== null, phase: this.phase, detail: this.detail };
  }

  /** The repo's cds-design.json, when the clone has one (onboarding check). */
  cdsDesign(): CdsDesignConfig | null {
    try {
      return readCdsDesignConfig(this.root);
    } catch {
      return null;
    }
  }

  /** True when the declared install already ran for the current lockfiles. */
  installUpToDate(): boolean {
    const config = this.cdsDesign();
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
  private async installIfNeeded(config: CdsDesignConfig): Promise<boolean> {
    if (!config.install) return false;
    if (!this.dependenciesMoved()) return false;

    this.setPhase("installing", null);
    // The repo declares its private registry; the daemon holds the PAT. The
    // credential goes ONLY into the user-level npmrc — the clone's tree is
    // committed and pushed, so a clone-level .npmrc would publish the PAT.
    if (config.registry && this.pat) {
      mergeNpmrc(npmrcPath(), [
        { key: `${scopeOf(config.registry)}:registry`, value: `https://${config.registry.host}/` },
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

  /** A cds-design command may or may not need pnpm; only demand it when it does. */
  private async requirePnpmIfReferenced(command: string): Promise<void> {
    if (!/\bpnpm\b/.test(command)) return;
    if (!(await resolvePnpmExecutable())) throw new Error(PNPM_MISSING_DETAIL);
  }

  // -------------------------------------------------------------------------
  // Preview server
  // -------------------------------------------------------------------------

  private async startPreview(config: CdsDesignConfig): Promise<void> {
    await this.killPreview();
    this.setPhase("starting", null);
    const { command, port } = config.preview;
    await this.requirePnpmIfReferenced(command);

    // The commonest failure on a developer's machine, and the one the planner
    // has no way to diagnose: something else already owns the declared port.
    // A dev server that cannot bind usually exits 0, so without this the only
    // report was "미리보기 서버가 종료되었습니다 (exit 0)" — true, useless, and
    // it stays true through every retry. Left-over servers from a daemon that
    // was killed rather than stopped are the usual culprit.
    if (await portAccepts(port)) {
      throw new Error(
        `포트 ${port}를 다른 프로그램이 이미 쓰고 있어 미리보기를 켤 수 없습니다 — ` +
          `그 프로그램을 끄거나 연결 레포의 cds-design.json에서 preview.port를 바꿔 주세요.`,
      );
    }

    const child = spawn(command, this.spawnOptions());
    this.preview = child;
    /** Last output line, so an exit can quote what the command actually said. */
    let lastLine: string | null = null;
    const absorb = (chunk: Buffer) => {
      const line = String(chunk).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
      if (!line) return;
      lastLine = line;
      this.setDetail(line);
    };
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);

    child.once("exit", (code, signal) => {
      if (this.preview !== child) return; // stop() already took it down
      this.preview = null;
      const how = signal ? `signal ${signal}` : `exit ${code}`;
      this.setPhase(
        "error",
        // The command's own last line is what says WHY; an exit code alone
        // sends the planner to a terminal they were promised they would not need.
        lastLine ? `미리보기 서버가 종료되었습니다 (${how}) — ${lastLine}` : `미리보기 서버가 종료되었습니다 (${how})`,
      );
    });

    await this.waitReady(port);
  }

  private spawnOptions(): SpawnOptions {
    const windows = currentPlatform() === "win32";
    return {
      cwd: this.root,
      // cds-design.json commands are strings ("pnpm dev"), so a shell parses
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
        PATH: extraPathPrefix(process.env.CDS_DESIGN_EXTRA_PATH),
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
    while (Date.now() < deadline && (await portAccepts(port))) await sleep(100);
  }

  // -------------------------------------------------------------------------
  // Process capture
  // -------------------------------------------------------------------------

  private async git(args: string[], cwd = this.root): Promise<string> {
    const windows = currentPlatform() === "win32";
    // The same binary the onboarding gate judged: on a Finder-launched app
    // whose PATH stops at /usr/bin, a Homebrew-only git is exactly the one
    // the resolver found and the one the clone below needs.
    const git = (await resolveGitExecutable()) ?? "git";
    const result = await this.capture(git, {
      cwd,
      // `.cmd` shims are not executables on Windows; the resolver returns a
      // real git.exe, so the shell is only for the unresolved fallback.
      shell: windows && git === "git",
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ANTHROPIC_API_KEY: undefined },
    }, args);
    if (result.code === 0) return result.stdout;
    throw new Error(
      redact(`git ${args[0]} 실패 (exit ${result.code}): ${result.lastLine || result.output}`.trim(), this.pat),
    );
  }

  private capture(
    command: string,
    options: SpawnOptions,
    args: string[] = [],
  ): Promise<{ code: number | null; output: string; stdout: string; lastLine: string }> {
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
      const line = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
      if (line) {
        lastLine = line;
        this.setDetail(line);
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
      url: this.url,
      branch: this.branch,
      baseBranch: this.baseBranch,
      handoff: this.openHandoff,
      pendingChanges: this.pendingChanges,
    };
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
      const out = await this.git(["status", "--porcelain"]);
      next = out.split("\n").filter((line) => line.trim().length > 0).length;
    } catch {
      return;
    }
    if (next === this.pendingChanges) return;
    this.pendingChanges = next;
    this.emit();
  }

  private setPhase(phase: RepoPhase, detail: string | null): void {
    this.phase = phase;
    this.detail = detail;
    this.emit();
  }

  private setDetail(detail: string): void {
    this.detail = detail;
    // Progress lines arrive faster than any UI can use them.
    if (Date.now() - this.lastEmit < DETAIL_THROTTLE_MS) return;
    this.emit();
  }

  private emit(): void {
    this.lastEmit = Date.now();
    this.onStatus(this.snapshot());
  }
}

export const GIT_MISSING_DETAIL =
  "git을 찾을 수 없습니다 — git을 설치한 뒤 다시 시도해 주세요.";

/** PATH with CDS_DESIGN_EXTRA_PATH prepended when the desktop app sets it. */
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
function scopeOf(registry: CdsDesignRegistry): string {
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
      .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "")
      .replace(/^\.+/, "")
      .trim() || "spec";

  // Planners date their filenames too, and `2026-09-08-2026-09-08-…` reads as
  // a bug to the person who attached it.
  const prefix = /^\d{4}-\d{2}-\d{2}-/.test(cleaned) ? "" : `${date}-`;
  const base = prefix + cleaned.slice(0, Math.max(1, MAX_SPEC_NAME - prefix.length - extension.length));

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

  const projects = (config.projects ??= {});
  let changed = false;
  for (const key of keys) {
    const project = (projects[key] ??= {});
    if (project.hasTrustDialogAccepted !== true) {
      project.hasTrustDialogAccepted = true;
      changed = true;
    }
  }
  if (!changed) return;

  // The CLI rewrites this file whenever a session ends, so replace it in one
  // step rather than leaving a window where it is half written.
  const temporary = `${configFile}.cds-design-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
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
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = createConnection({ port, host: "127.0.0.1" });
  const settle = (ok: boolean) => {
    socket.destroy();
    resolve(ok);
  };
  socket.setTimeout(1_000);
  socket.once("connect", () => settle(true));
  socket.once("timeout", () => settle(false));
  socket.once("error", () => settle(false));
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
