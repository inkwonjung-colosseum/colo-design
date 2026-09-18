// Shared state and plumbing behind RepoWorkspace — the clone's status,
// git capture, emit machinery and the conflict/refresh vocabulary every
// domain module speaks. Package-internal: only repo.ts and the repo-*.ts
// modules import this.
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type ChangedFileLite,
  type ChatEvent,
  type DiffFile,
  type DiffStatus,
  type HandoffStatus,
  markTurn,
  type RepoDiscard,
  type RepoErrorKind,
  type RepoHistory,
  type RepoPhase,
  type RepoStatus,
} from "@colo-design/protocol";
import { currentPlatform, resolveGitExecutable } from "./environment.js";
import { type GitHubClient, parseRepoSlug } from "./github.js";
import { killTree } from "./preview-claim.js";
import { type RepoConfig, type RepoRegistry, resolveRepoConfig } from "./repo-config.js";
import {
  numstatCounts,
  parseStatusRows,
  parseUnifiedDiff,
  sameChangedFiles,
  unquoteGitPath,
  untrackedAsAdded,
} from "./repo-diff.js";
import { safeRepoPath } from "./repo-paths.js";
export const INSTALL_MARKER = "colo-design-install-hash";
/**
 * 실사 결함: fresh clone 의 첫 미리보기 부팅(next dev cold compile)이 30 초를
 * 넘겼다 — 시간 예산 안에 뜨는 fixture 로는 잡히지 않는다. 데드라인은 실제
 * 레포의 첫 부팅이 들어올 만큼 넉넉해야 한다.
 */
export const READY_TIMEOUT_MS = Number(process.env.COLO_DESIGN_READY_TIMEOUT_MS) || 120_000;
const DETAIL_THROTTLE_MS = 200;
/** Commit message when the planner approves without writing one. */
export const DEFAULT_COMMIT_MESSAGE = "Colo Design 화면 변경";
/** PR title when the planner sends the handoff without editing it. */
export const DEFAULT_HANDOFF_TITLE = "Colo Design 화면 전달";
/** D56: where a handoff's screen captures are committed, relative to the root. */
export const SHOTS_DIR = ".colo-design/shots";
/** D56: the captures ride their own commit — the reviewed diff stays the planner's. */
export const SHOTS_COMMIT_MESSAGE = "Colo Design 화면 미리보기 캡처";
/**
 * Every branch this tool creates lives under one prefix, so a developer can
 * tell at a glance which branches a planner made and which are theirs.
 */
export const BRANCH_PREFIX = "colo-design";
/** How many output lines a failed gate quotes back to people and the agent. */
export const GATE_OUTPUT_TAIL_LINES = 30;
/**
 * 실사 결함: 멈춘 설치는 끝나지 않는다 — `capture` 는 `close` 만 기다리고,
 * 진행 줄은 마지막으로 찍힌 한 줄에 굳은 채 남는다. 비개발자가 보는 것은
 * 영원한 `설치 중`뿐이다. 벽시계 상한은 답이 아니다(큰 모노레포의 정상
 * 설치가 십 분을 넘긴다) — 기준은 **출력이 멎은 시간**이다. 파이프로 받는
 * stdio 라 npm 은 진행 막대를 끄므로 조용한 구간이 길다: 다섯 분은 정상
 * 설치가 결코 넘지 않고, 응답 없는 레지스트리·프록시는 반드시 넘는 선이다.
 */
export const COMMAND_STALL_MS = 300_000;
/**
 * Where every turn-start snapshot lives (PLAN D52). A namespace of its own
 * under `refs/`, so a developer's `git for-each-ref` never trips over it by
 * accident and one `refs/colo-design/checkpoints` listing sweeps it.
 */
export const CHECKPOINT_REF_PREFIX = "refs/colo-design/checkpoints";
/** D52: a session keeps its most recent snapshots; older ones are deleted. */
export const CHECKPOINTS_PER_SESSION = 20;
/**
 * 잠깐 치워두기 (보관함 토론 2026-09-15): the worktree's unsaved work, parked
 * in ONE ref of its own — a sibling of the checkpoints namespace, so 반영됨's
 * clearCheckpoints never sweeps it, and never a `git stash`, whose namespace
 * the refresh's transit stash and its recovery machinery own. A sibling ref
 * also means the agent Bash gate's open `git stash` verbs cannot reach it.
 */
export const SHELF_REF = "refs/colo-design/shelf";
/** Forensics only — the planner's words for the slot live in the UI. */
export const SHELF_COMMIT_MESSAGE = "Colo Design 잠깐 치워두기";

/** The machine turns' model (비개발자 저장): reading a diff and saying what it
 * did is haiku's job — fast enough for the leashes above and below, and a
 * planner's model stays for planning. */
export const MACHINE_MODEL = "haiku";
/** How long the save-time memo turn may take before the default message. */
export const MEMO_TIMEOUT_MS = 8_000;
/** How long the 넘기기 draft's turn may take before the browser's proposal wins. */
export const HANDOFF_DRAFT_TIMEOUT_MS = 8_000;

/**
 * What the agent is told when a step fails, named the way the planner's own
 * button is. "push 단계가 실패했습니다" would send it looking for a git
 * problem when the planner pressed 저장.
 */
export const GATE_BRIEF: Record<"commit" | "push" | "pr", string> = {
  commit: "저장할 변경을 커밋하지 못했습니다.",
  push: "저장한 변경을 올리지 못했습니다.",
  pr: "개발자에게 넘기지 못했습니다.",
};

/**
 * The same five failures, named for the button the planner pressed rather than
 * for the step that ran. This is what the transcript CARD says (PLAN D9); the
 * brief above is what the agent reads, command output and all.
 *
 * D90 ⓑ: push 거절 중 인증 · 권한 사유의 표식 — 이 문자열들이면 AI 대신
 * 설정 안내로 간다. 문자열 분기의 위험(D41)은 상수 하나에 모으고 단위 테스트가
 * 잡는 것으로; 모르면 AI 쪽(보수적)이다.
 * 리뷰 C6: 만료 · 무효 토큰의 말(401, Bad credentials, expired)도 같은
 * 안내로 가야 한다 — 만료 토큰으로 push 하면 AI 에게 헛돌았다.
 */
export const PUSH_AUTH_FAILURE =
  /401|403|Permission denied|authentication|denied to|not authorized|bad credentials|credentials? (?:expired|invalid)|token expired|authenticity/i;

export const GATE_STEP: Record<"commit" | "push" | "pr", string> = {
  commit: "저장",
  push: "저장한 내용 올리기",
  pr: "개발자에게 넘기기",
};
/**
 * The stash this tool parks unsaved work in while 최신화 moves the branch.
 * Named for the button, so `git stash list` reads like the product, not git.
 */
const STASH_MESSAGE = "Colo Design: 최신화 임시 보관";

/** What the planner reads when a conflict needs the agent and no thread is open. */
export const REFRESH_CONFLICT_DETAIL =
  "최신 변경을 받아 오다 저장하지 않은 변경과 충돌이 남았습니다 — 대화를 열면 AI가 정리합니다. 정리 전까지는 같은 상태입니다.";

/**
 * What the planner reads when replaying a dead run's parked work conflicts
 * and no thread is open — same state and remedy as REFRESH_CONFLICT_DETAIL,
 * named for how the work got parked.
 */
export const RECOVER_CONFLICT_DETAIL =
  "임시 보관해 둔 저장하지 않은 변경을 돌려놓다 겹치는 부분이 생겼습니다 — 대화를 열면 AI가 정리합니다. 정리 전까지는 같은 상태입니다.";
/** What the planner reads when the slot they are filling is already full. */
export const SHELF_ALREADY_DETAIL =
  "이미 치워둔 작업이 있습니다 — 더 보기 메뉴에서 먼저 꺼내 주세요.";

/** 치워두기 pressed with nothing unsaved — the door is for work in hand. */
export const SHELF_EMPTY_DETAIL = "치워둘 변경이 없습니다 — 먼저 화면을 만들거나 고쳐 주세요.";

/**
 * 꺼내기 pressed onto work in progress — the one-slot contract's other half:
 * the slot is not a second worktree, so what is out must come back onto an
 * empty desk. Named for the two doors that clear it, never for git.
 */
export const SHELF_DIRTY_DETAIL =
  "지금 작업 중인 변경이 있습니다 — 저장하거나 버린 뒤 꺼내 주세요.";

export const SHELF_NONE_DETAIL = "치워둔 작업이 없습니다.";

/** 치워두기·꺼내기 pressed while the agent still owes a conflict's cleanup. */
export const SHELF_CONFLICT_OPEN_DETAIL =
  "정리가 끝나지 않은 충돌이 있습니다 — 대화에서 AI가 정리를 마친 뒤 시도해 주세요.";

/**
 * What the planner reads when the 꺼내기 overlapped: same state and remedy as
 * RECOVER_CONFLICT_DETAIL, named for the shelf. The slot SURVIVES the
 * conflict — dropping it is the cleanup's last step, not the failure's.
 */
export const SHELF_CONFLICT_DETAIL =
  "치워둔 작업을 다시 얹다 겹치는 부분이 생겼습니다 — 대화를 열면 AI가 정리합니다. 치워둔 작업은 그대로 남아 있습니다.";

/**
 * What a 저장 pressed before the agent finished a conflict's cleanup reads —
 * the unmerged files count as changes awaiting 저장, so the refusal must
 * name the one thing standing in the way, not leave a silent door.
 */
export const SAVE_CONFLICT_OPEN_DETAIL =
  "정리가 끝나지 않은 충돌이 있습니다 — 대화에서 AI가 정리를 마친 뒤 저장해 주세요.";

/** What the planner reads when a repo's commands have not been approved here. */
export const COMMANDS_UNAPPROVED_DETAIL =
  "이 레포가 실행하기로 한 설치 · 미리보기 명령이 아직 승인되지 않았습니다 — 실행 허용을 누르면 준비를 계속합니다.";

/**
 * The one refresh this tool refuses to do alone: the base branch carries
 * commits the clone does not know. Rewriting history a planner cannot read
 * is not 자동 병합, so it stays a named failure.
 */
const REFRESH_DIVERGED_DETAIL =
  "기본 브랜치에 원격과 갈라진 커밋이 있어 자동 최신화를 멈췄습니다 — 대화를 열면 AI가 확인합니다.";

export const PNPM_MISSING_DETAIL =
  "pnpm이 없습니다 — corepack enable 또는 npm i -g pnpm 으로 설치해 주세요.";
export const REGISTRY_AUTH_DETAIL =
  "GitHub 패키지 인증이 필요합니다 — pnpm config set //npm.pkg.github.com/:_authToken <read:packages 권한 PAT>";
export const REPO_URL_MISSING_DETAIL =
  "연결 레포 주소가 없습니다 — 새 프로젝트로 레포를 연결해 주세요.";

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
export function redact(text: string, secret: string | null): string {
  return secret ? text.split(secret).join("***") : text;
}

/** Options the facade hands straight through — see RepoWorkspace. */
export interface RepoWorkspaceOptions {
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
  cycle?: { branch: string | null; handoff: HandoffStatus | null; commentsSince?: string | null };
  /** Where the cycle is written back; the registry is the only store. */
  onCycleChange?: (cycle: {
    branch: string | null;
    handoff: HandoffStatus | null;
    commentsSince?: string | null;
  }) => void;
  /** Built per call so a PAT changed mid-run reaches the next request. */
  gitHubClient?: () => GitHubClient | null;
  /** Claude Code CLI executable for the summarizer's one turn (D51). */
  claudeExecutable?: string | null;
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
  /**
   * 사이클 사건의 기록 (hero-synthesis D1): 저장 · 넘김 · 반영 · 코멘트 도착을
   * 세션 채널로 보내고 테이프에 남기는 손잡이. `sessionId` 는 저장·넘기기를
   * 부른 대화 — 없으면 붙이는 쪽(플릿)이 마지막 활성 세션으로 귀속한다.
   */
  onCycleEvent?: (event: ChatEvent, sessionId?: string) => void;
}

export class RepoCore {
  readonly root: string;

  /**
   * The branch a handoff PR will target (PLAN D5[넘기기]). Nothing reads it in M1; it
   * lives beside the url because the same project decision fixes both.
   */
  readonly baseBranch: string;

  url: string | null;

  pat: string | null;

  phase: RepoPhase = "missing";

  detail: string | null = null;

  /** Set at the failure site, never sniffed back out of `detail` (PLAN D41). */
  errorKind: RepoErrorKind | null = null;

  config: RepoConfig | null = null;

  preview: ChildProcess | null = null;

  /** Counts preview starts — `RepoStatus.previewEpoch` names the process behind the port. */
  previewEpoch = 0;

  inFlight: Promise<RepoStatus> | null = null;

  publishing: Promise<DiffStatus> | null = null;

  /** The session-start/button refresh while it runs — saves wait it out. */
  refreshing: Promise<unknown> | null = null;

  /** 잠깐 치워두기 연산이 도는 동안 — 저장 · 최신화 · 버리기가 이를 기다린다. */
  shelving: Promise<unknown> | null = null;

  /** 치워둔 작업의 시각(ISO) — 상태의 한 조각으로 pendingChanges 와 함께 나간다. */
  shelfAt: string | null = null;

  /**
   * Whether the ref behind `shelfAt` was read at least once in this daemon.
   * The field above is memory; the ref is the truth (`shelve` checks it), so
   * the first status on a clone reconciles them — see `status`.
   */
  shelfRead = false;

  /** Whether this project is the one on screen — see `setActive`. */
  active = true;

  lastEmit = 0;

  /**
   * The Claude Code CLI, resolved once by the server from the same source
   * the sessions get theirs (PLAN D51). The summarizer's one turn rides it;
   * null means the fallback path is the only path.
   */
  readonly claudeExecutable: string | null;

  readonly onStatus: (status: RepoStatus) => void;

  readonly onDiffStatus: ((status: DiffStatus) => void) | null;

  readonly onUrlChange: ((url: string | null) => void) | null;

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
  branch: string | null;

  /**
   * Files in the clone that a 저장 would carry, as of the last count. Zero
   * until something asks — a fresh clone is clean, and the delivery chip's own
   * mount is what triggers the first real count.
   */
  pendingChanges = 0;

  /**
   * The same count's rows, light — the 변경 점 strip lists exactly what the
   * chip counts, so the number and the list move in one emit or not at all.
   */
  changedFiles: ChangedFileLite[] = [];

  openHandoff: HandoffStatus | null;

  /**
   * 이 사이클의 핀 앵커 (D93 후속): 이 시각 이후의 코멘트가 이 사이클의 것이다 —
   * 넘기기가 요청 본문의 `### 수정 요청` 절을 여기부터 읽는다. 사이클이
   * 태어난 시각(프로젝트 생성 · 이전 요청의 착지)에 새로 쓰이고, setCycle 이
   * 레지스트리로 같이 나른다. 널이면(업그레이드 전에 시작한 사이클) 넘기기가
   * 예전처럼 브랜치 첫 커밋 시각으로 대신 읽는다.
   */
  commentsSince: string | null;

  /** The URL the preview actually answers on — declared origin or detected at startup. */
  previewUrl: string | null = null;

  /** The planner's word on this repo's install · preview commands. */
  commandsApproved = true;

  readonly onCycleChange:
    | ((cycle: {
        branch: string | null;
        handoff: HandoffStatus | null;
        commentsSince?: string | null;
      }) => void)
    | null;

  readonly gitHubClient: (() => GitHubClient | null) | null;

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
    cycle?: { branch: string | null; handoff: HandoffStatus | null; commentsSince?: string | null };
    /** Where the cycle is written back; the registry is the only store. */
    onCycleChange?: (cycle: {
      branch: string | null;
      handoff: HandoffStatus | null;
      commentsSince?: string | null;
    }) => void;
    /** Built per call so a PAT changed mid-run reaches the next request. */
    gitHubClient?: () => GitHubClient | null;
    /** Claude Code CLI executable for the summarizer's one turn (D51). */
    claudeExecutable?: string | null;
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
    this.commentsSince = options.cycle?.commentsSince ?? null;
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

  /** The repo's private registry, once the clone's config was resolved. */
  registry(): RepoRegistry | null {
    return this.config?.registry ?? null;
  }

  /**
   * Disk state only; safe to call from any client at any time.
   *
   * The shelf is read from the REF the first time a status is asked on a
   * clone, not left at the memory field's `null`. Without this probe the
   * first status after a daemon restart says "no shelf": the menu offers
   * 잠깐 치워두기 (which the ref-checking `shelve` then refuses) and hides
   * 꺼내기 — 치워둔 작업이 분실로 읽히는 그 자리다. `refreshPendingChanges`
   * keeps it current afterwards, so this costs one `for-each-ref` per
   * daemon lifetime rather than one per poll.
   */
  async status(): Promise<RepoStatus> {
    if (this.isCloned()) {
      try {
        this.config = resolveRepoConfig(this.root);
      } catch {
        // Keep the last known config; the working phases surface parse errors.
      }
      if (!this.shelfRead) {
        this.shelfRead = true;
        this.shelfAt = await this.readShelfAt();
      }
    }
    return this.snapshot();
  }

  /**
   * The PAT never rides the url again — not into `.git/config` at rest, not
   * into `ps`-visible argv. git takes per-invocation config from the
   * environment (GIT_CONFIG_*), which clone, fetch and push all read as an
   * `http.<origin>.extraheader`. Local-path remotes ignore http.* entirely.
   */
  gitAuthEnv(): NodeJS.ProcessEnv {
    if (!this.pat || !this.url?.startsWith("https://")) return {};
    let scope: string;
    try {
      scope = new URL(this.url).origin;
    } catch {
      return {};
    }
    // The PAT is GitHub's: a non-github.com remote (a mirror, a proxy, a
    // typo'd host) must never receive the header. The registry the repo's
    // committed .npmrc declares is a package host, not a git one.
    if (scope !== "https://github.com" && scope !== "https://www.github.com") return {};
    const basic = Buffer.from(`x-access-token:${this.pat}`).toString("base64");
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${scope}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    };
  }

  /** Rewrites a PAT-bearing origin to its clean form — see update(). */
  async scrubOriginCredential(): Promise<void> {
    if (!this.isCloned()) return;
    const origin = (await this.git(["remote", "get-url", "origin"]).catch(() => "")).trim();
    if (!/^https:\/\/[^@/\s]+@/.test(origin)) return;
    await this.git(["remote", "set-url", "origin", origin.replace(/^(https:\/\/)[^@/\s]+@/, "$1")]);
  }

  /**
   * 최신화 버튼이 열린 대화 없이 눌렸을 때의 사전 확인 (실사 P0 — 조용한
   * no-op). 사이클 브랜치에 올라탄 클론의 병합은 충돌 시 AI 의 첫 과제가
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
    // A refresh mid-flight has parked the planner's work in a stash — a diff
    // answered inside that window reads a clean (or half-popped) tree and
    // the review would say 저장할 변경사항이 없습니다 over real work. Same
    // contract as runSave: wait the pull out, then read.
    while (this.refreshing) await this.refreshing.catch(() => undefined);
    if (!this.isCloned()) return [];
    const tracked = parseUnifiedDiff(
      await this.git(["-c", "core.quotepath=false", "diff", "HEAD", "--no-color"]),
    );
    const files = [...tracked];
    for (const rel of (
      await this.git(["-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard"])
    )
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
      "-c",
      "core.quotepath=false",
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
   * 버리기의 본문 — 잠깐 치워두기가 스냅샷을 남긴 뒤 워크트리를 비우는 같은
   * 경로. 대기 없음: 호출자(버리기·치워두기)가 이미 worktree 소유권을
   * 정리했고, 여기서 다시 기다리면 치워두기가 자기 자신을 기다린다.
   */
  async clearUnsavedWork(): Promise<RepoDiscard> {
    const changed = await this.changedPaths();
    const allowed = changed
      .map((path) => safeRepoPath(path))
      .filter((path): path is string => path !== null);
    if (allowed.length === 0) return { removed: [] };

    // Tracked paths go back to HEAD (bringing a deleted file back included);
    // paths HEAD never knew are un-staged and deleted from the worktree.
    const inHead = new Set(
      (await this.git(["-c", "core.quotepath=false", "ls-tree", "-r", "--name-only", "HEAD"]))
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
  async changedPaths(): Promise<string[]> {
    const out = await this.git(["-c", "core.quotepath=false", "status", "--porcelain"]);
    const paths: string[] = [];
    for (const line of out.split(/\r?\n/)) {
      if (line.length < 4) continue;
      const body = line.slice(3);
      const rename = body.match(/^(.*) -> (.*)$/);
      if (rename)
        paths.push(
          unquoteGitPath((rename[1] ?? "").trim()),
          unquoteGitPath((rename[2] ?? "").trim()),
        );
      else paths.push(unquoteGitPath(body.trim()));
    }
    return paths.filter(Boolean);
  }

  /** 치워둔 작업이 자리를 잡고 있는가 — the ref, nothing else, says so. */
  async shelfExists(): Promise<boolean> {
    try {
      await this.git(["rev-parse", "-q", "--verify", SHELF_REF]);
      return true;
    } catch {
      return false;
    }
  }

  /** The slot's `at`, read where `refreshPendingChanges` recounts the chip. */
  async readShelfAt(): Promise<string | null> {
    try {
      const out = await this.git([
        "for-each-ref",
        "--format=%(committerdate:iso8601-strict)",
        SHELF_REF,
      ]);
      return out.trim() === "" ? null : out.trim();
    } catch {
      return this.shelfAt;
    }
  }

  // -------------------------------------------------------------------------
  // 레포 최신화: bring the developer's side in without reading git (PLAN D5[넘기기])
  // -------------------------------------------------------------------------

  /**
   * The whole refresh, in the planner's interest: unsaved work is the
   * precious half, so it is stashed first (untracked screens included), the
   * branch moves onto what the developer merged, and the work comes back on
   * top — git's mechanical merge does the combining. What git cannot finish
   * alone is a genuine conflict, and a conflict is the agent.s task: the brief
   * rides the same wire a typed message does. With no thread to brief (a
   * bare bring-up), the throw names the state in Korean where the retry
   * panel reads it.
   *
   * Returns `"conflict"` when a conflict was left for the agent — the caller
   * must not pile an install or preview restart onto a mid-resolution tree.
   */
  async refreshFromRemote(onSessionTurn?: (brief: string) => void): Promise<"clean" | "conflict"> {
    // A refresh that finds a conflict left over from an earlier run briefs
    // again instead of piling on: until the agent resolves it, that state IS
    // the current one.
    if (await this.mergeInProgress()) {
      return await this.briefOrThrow(
        this.mergeConflictBrief(
          await this.conflictedFiles(),
          // The stash from the run that left this merge open — the agent must
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

    // Mid-cycle, merging the developer's base needs the agent within reach — a
    // conflict has to land as a first task, not as an error nobody can read.
    // A bare bring-up mid-cycle stays put on the merge, but the fetch still
    // runs BEFORE the early return: bootstrap·활성화는 brief 받을 대화 없이
    // 지나가는 자리이므로, 여기서 origin 을 새로 읽지 않으면
    // aheadBehindBase() 가 지난 원격을 읽고 위에 쌓인 커밋이 있어도 조용히
    // 넘어간다. 못 읽은 fetch 는 지난 origin 을 남길 뿐 — 예전의 조용한
    // no-op 그대로다.
    if (this.branch && !onSessionTurn) {
      await this.git(["fetch", "origin", this.baseBranch]).catch(() => undefined);
      return "clean";
    }

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
      // A conflicted merge stays open on purpose (the brief is the agent.s
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
   * A conflict is news for the agent when a thread is open and for the planner
   * when one is not: the brief rides the session wire, the throw surfaces a
   * Korean one-liner where the retry panel reads it.
   */
  async briefOrThrow(
    brief: string,
    onSessionTurn: ((brief: string) => void) | undefined,
  ): Promise<"conflict"> {
    if (onSessionTurn) onSessionTurn(brief);
    else throw new Error(REFRESH_CONFLICT_DETAIL);
    return "conflict";
  }

  /**
   * the agent.s instructions, as a gate card: what collided and the exact
   * recovery, named for the planner's words (최신 변경 받아오기), never git's.
   */
  mergeConflictBrief(files: string[], stashed: boolean): string {
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

  popConflictBrief(files: string[]): string {
    return markTurn(
      { kind: "gate", step: "최신 변경 받아오기" },
      "최신 변경을 받아 온 뒤 저장하지 않은 변경을 돌려놓는 중에 겹치는 부분이 생겼습니다.\n" +
        `충돌한 파일:\n${files.map((file) => `- ${file}`).join("\n")}\n` +
        "충돌 표식을 정리한 뒤 git add 로 해결을 표시하고, git stash drop 으로 임시 보관을 치워 주세요. " +
        "그러면 변경은 저장 전 상태로 돌아옵니다.",
    );
  }

  /** True while a merge waits for its conflict resolution (MERGE_HEAD). */
  async mergeInProgress(): Promise<boolean> {
    try {
      await this.git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  /** Paths git could not combine by itself — the only real conflict here. */
  async conflictedFiles(): Promise<string[]> {
    const out = await this.git([
      "-c",
      "core.quotepath=false",
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
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
  async identityArgs(): Promise<string[]> {
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
  async stashUnsavedWork(): Promise<boolean> {
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
  async popStash(ref = "stash@{0}"): Promise<string[] | null> {
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
  async aheadBehindBase(): Promise<[number, number]> {
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
  repoSlug(): { owner: string; repo: string } | null {
    const pinned = process.env.COLO_DESIGN_GITHUB_SLUG;
    if (pinned) {
      const [owner, repo] = pinned.split("/");
      if (owner && repo) return { owner, repo };
    }
    return this.url ? parseRepoSlug(this.url) : null;
  }

  setCycle(branch: string | null, handoff: HandoffStatus | null): void {
    this.branch = branch;
    this.openHandoff = handoff;
    this.onCycleChange?.({ branch, handoff, commentsSince: this.commentsSince });
    this.emit();
  }

  /**
   * 핀 앵커를 다음 사이클로 넘긴다 (D93 후속): 방금 내려앉은 요청까지의 코멘트는
   * 그 요청의 것이고, 이 순간 이후의 핀은 다음 넘기기의 `### 수정 요청` 절의
   * 것이다. 사이클이 끝나는 유일한 자리(landCycle)에서 부른다.
   */
  rotateCommentsCycle(): void {
    this.commentsSince = new Date().toISOString();
    this.onCycleChange?.({
      branch: this.branch,
      handoff: this.openHandoff,
      commentsSince: this.commentsSince,
    });
    this.emit();
  }

  /**
   * 사이클의 앵커 — 이 사이클에 기록된 코멘트와 캡처 대상을 가르는 시각.
   * 기록된 앵커(commentsSince)가 없으면 사이클 브랜치의 첫 커밋 시각으로
   * 읽는다. repo-publish · repo-summary 가 각자 두던 판정을 한 곳에 모은다.
   */
  async cycleAnchor(): Promise<string | null> {
    if (this.commentsSince) return this.commentsSince;
    if (!this.branch) return null;
    const out = await this.git([
      "log",
      "--reverse",
      "--format=%cI",
      `origin/${this.baseBranch}..${this.branch}`,
    ]).catch(() => "");
    return out.split("\n")[0]?.trim() || null;
  }

  setDiff(status: DiffStatus): DiffStatus {
    this.onDiffStatus?.(status);
    return status;
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
    return {
      running: this.inFlight !== null,
      phase: this.phase,
      detail: this.detail,
    };
  }

  /** The contract the clone resolves to — derived commands plus its overrides. */
  repoConfig(): RepoConfig | null {
    try {
      return resolveRepoConfig(this.root);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Process capture
  // -------------------------------------------------------------------------

  async git(
    args: string[],
    cwd = this.root,
    /** Per-call environment — the checkpoint's temporary GIT_INDEX_FILE. */
    env: NodeJS.ProcessEnv = {},
    /** `binary` keeps stdout as bytes and answers base64 — `git show` on a
     *  committed capture would otherwise come back utf8-mangled. */
    binary = false,
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
      undefined,
      binary,
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

  /**
   * Runs a command and keeps its tail. `stallMs`, when given, is the silence
   * the caller refuses to wait past: every chunk of output rearms it, so a
   * command that keeps talking is never cut, and one that stops talking is
   * killed with its whole process group and reported as `stalled` rather
   * than left to hold the phase forever. `binary` keeps stdout as bytes and
   * answers it base64 — for `git show` on a committed capture.
   */
  capture(
    command: string,
    options: SpawnOptions,
    args: string[] = [],
    stallMs?: number,
    binary = false,
  ): Promise<{
    code: number | null;
    output: string;
    stdout: string;
    lastLine: string;
    stalled: boolean;
  }> {
    const { promise, resolve, reject } = Promise.withResolvers<{
      code: number | null;
      output: string;
      stdout: string;
      lastLine: string;
      stalled: boolean;
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
    /** Binary stdout accumulates as bytes — a utf8 join would corrupt it. */
    const stdoutBytes: Buffer[] = [];
    let lastLine = "";
    let stalled = false;
    let watchdog: NodeJS.Timeout | undefined;
    let hardKill: NodeJS.Timeout | undefined;
    const clearTimers = () => {
      clearTimeout(watchdog);
      clearTimeout(hardKill);
      watchdog = undefined;
      hardKill = undefined;
    };
    const rearm = () => {
      if (stallMs === undefined || stalled) return;
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        stalled = true;
        killTree(child, "SIGTERM");
        // A shell that ignores SIGTERM would keep the phase hostage anyway.
        hardKill = setTimeout(() => killTree(child, "SIGKILL"), 3_000);
      }, stallMs);
      // The watchdog must not be the reason the daemon's loop stays alive.
      watchdog.unref?.();
    };
    const absorb = (chunk: Buffer) => {
      const text = String(chunk);
      // The whole output is kept for the 401 check but only the tail is worth
      // holding: an install can print megabytes.
      output = (output + text).slice(-20_000);
      rearm();
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
      if (binary) {
        // Bytes only — no progress-line parsing on an image's innards.
        stdoutBytes.push(chunk);
        rearm();
        return;
      }
      stdout = (stdout + String(chunk)).slice(-1_000_000);
      absorb(chunk);
    };
    child.stdout?.on("data", absorbStdout);
    child.stderr?.on("data", absorb);
    child.once("error", (error) => {
      clearTimers();
      reject(
        error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(GIT_MISSING_DETAIL)
          : error,
      );
    });
    child.once("close", (code) => {
      clearTimers();
      const bytes = stdoutBytes.length > 0 ? Buffer.concat(stdoutBytes).toString("base64") : stdout;
      resolve({ code, output, stdout: binary ? bytes : stdout, lastLine, stalled });
    });
    return promise;
  }

  // -------------------------------------------------------------------------
  // Status plumbing
  // -------------------------------------------------------------------------

  snapshot(): RepoStatus {
    const url = this.phase === "ready" ? this.previewUrl : null;
    const port = previewPortOf(url);
    return {
      root: this.root,
      phase: this.phase,
      detail: this.detail,
      previewUrl: url,
      previewPort: port,
      previewEpoch: port === null ? null : this.previewEpoch,
      url: this.url,
      branch: this.branch,
      baseBranch: this.baseBranch,
      handoff: this.openHandoff,
      pendingChanges: this.pendingChanges,
      changedFiles: this.changedFiles,
      shelf: this.shelfAt === null ? null : { at: this.shelfAt },
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
    let rows: Array<{ path: string; status: ChangedFileLite["status"] }> = [];
    try {
      // -uall: a wholly-untracked folder would fold into one `dir/` row and
      // the strip would name a directory where a review later names files.
      // Every file, its own row — the count's "files" stays literal.
      const out = await this.git(["-c", "core.quotepath=false", "status", "--porcelain", "-uall"]);
      rows = parseStatusRows(out);
    } catch {
      return;
    }
    // The ± sizes need one more read — status says what changed, numstat says
    // how much. A failure here still cannot take the recount down: the rows
    // keep their word and stay quiet about size.
    let counts: Record<string, { added: number; removed: number }> = {};
    try {
      counts = numstatCounts(
        await this.git(["-c", "core.quotepath=false", "diff", "--numstat", "HEAD"]),
      );
    } catch {
      // Sizeless rows are the honest answer for this recount.
    }
    const files: ChangedFileLite[] = rows.map((row) => ({
      ...row,
      added: counts[row.path]?.added ?? null,
      removed: counts[row.path]?.removed ?? null,
    }));
    const shelf = await this.readShelfAt();
    this.shelfRead = true;
    if (
      files.length === this.pendingChanges &&
      shelf === this.shelfAt &&
      sameChangedFiles(files, this.changedFiles)
    )
      return;
    this.pendingChanges = files.length;
    this.changedFiles = files;
    this.shelfAt = shelf;
    this.emit();
  }

  setPhase(phase: RepoPhase, detail: string | null, kind: RepoErrorKind | null = null): void {
    this.phase = phase;
    this.detail = detail;
    this.errorKind = phase === "error" ? kind : null;
    this.emit();
  }

  setDetail(detail: string): void {
    this.detail = detail;
    // Progress lines arrive faster than any UI can use them.
    if (Date.now() - this.lastEmit < DETAIL_THROTTLE_MS) return;
    this.emit();
  }

  /**
   * 진행 줄은 판정이 아니다: workspace 가 `error` 에 앉아 있는 동안에는 마지막
   * 판정이 그 자리를 지킨다. 실사에서 발견한 결함: 포트 충돌로 실패한 뒤 뒤에서
   * 돈 git fetch 의 진행 출력(`* branch main -> FETCH_HEAD`)이 에러 문구를
   * 덮어 써, 사용자는 실패 이유로 git 의 말을 읽게 됐다. 진행은 phase 가
   * 다시 움직이는 순간부터 흐른다.
   */
  setProgressLine(line: string): void {
    if (this.phase === "error") return;
    this.setDetail(line);
  }

  emit(): void {
    this.lastEmit = Date.now();
    this.onStatus(this.snapshot());
  }
}

const GIT_MISSING_DETAIL = "git을 찾을 수 없습니다 — git을 설치한 뒤 다시 시도해 주세요.";

export function detailOf(error: unknown, pat: string | null): string {
  return redact(error instanceof Error ? error.message : String(error), pat);
}

/** Port a preview URL answers on — explicit, or the scheme's default. */
function previewPortOf(url: string | null): number | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Small process/network helpers
// ---------------------------------------------------------------------------

/**
 * 서버는 떴지만 어느 포트에서 듣는지 끝내 알지 못했을 때의 오류 — errorKind
 * "port-undetected". 출력에 URL 이 없고 소켓 스캔도 못 찾은 경우다. 카드의
 * 다음 과제는 서버가 뜬 주소를 출력하게 하는 것이다.
 */
export class PreviewPortUndetectedError extends Error {}
