import type { HandoffStatus, RepoPhase } from "./repo.js";
import type { PlanUsage, SessionModelInfo } from "./session.js";

// ---------------------------------------------------------------------------
// Daemon -> client
// ---------------------------------------------------------------------------

/**
 * One conversation of one project, as the sidebar tree's child row shows it
 * (PLAN D59). The daemon maps the session state onto the four words the tree
 * draws; the planner's own rename rides the client's 설정, not this wire.
 */

/**
 * 이 대화의 사이클 위치 (P3-1): the session tape's LAST cycle row, read per
 * session — `saved` a cycle.saved landed here, `handed` a cycle.handed,
 * `merged` a cycle.merged, `review` a review.arrived. The leaf's status dot
 * wears it; absent means this conversation has no cycle rows at all.
 */
export type ThreadCycle = "saved" | "handed" | "merged" | "review";

/**
 * 연결 준비 대화의 이름 — the tool opens it itself once on a repo whose
 * conventions are not written yet (PLAN D94). The tree reads the words to
 * tell the tool's own record from the planner's conversations; the constant
 * lives here because daemon and UI must hold the same one.
 */
export const BOOTSTRAP_THREAD_TITLE = "연결 준비";

export interface ThreadSummary {
  id: string;
  title: string;
  /** `running` a turn is on; `awaiting` a permission or question; `finished`
     a turn ended and nothing has followed it; `idle` everything else. */
  state: "running" | "awaiting" | "finished" | "idle";
  updatedAt: string;
  /** The tape's last cycle row for this conversation — 대화별 여정의 원천. */
  cycle?: ThreadCycle;
}

/**
 * A project as the client sees it: identity, what it builds, and — for the
 * sidebar (PLAN D16) — where its clone stands right now. The per-project
 * state rides `project.changed` because `repo.status` means THE ACTIVE
 * project only; these four fields are how an inactive row earns its badge.
 */
export interface ProjectSummary {
  slug: string;
  name: string;
  /** What a handoff PR targets. */
  baseBranch: string;
  /** The clone url this project works on — 등록 목록의 재등록 방지가 읽는다. */
  repoUrl?: string | null;
  /** Disk/process state. Only the active project climbs past `ready`; an inactive cloned one reports `ready` from disk alone. */
  phase: RepoPhase;
  /** Last counted unsaved-change files — the delivery chip's number, per project. */
  pendingChanges: number;
  /** A live Claude session is running in this project's clone right now. */
  working: boolean;
  /** The open (or merged) pull request of this project's save cycle. */
  handoff: HandoffStatus | null;
  /**
   * The project's conversations, newest first (PLAN D59) — the sidebar
   * tree's children. Optional: a daemon that has not scanned this clone
   * yet omits it, and an absent key means "unknown", not "none".
   */
  threads?: ThreadSummary[];
  /**
   * 이 프로젝트에서 지켜 줄 것(설정 문서 P1#8) — 프로젝트 설정 상자의 현재
   * 내용. 비어 있으면 키가 없다.
   */
  instructions?: string;
  /**
   * 답을 기다리는 질문 + 권한 요청의 수(스레드 단위, PLAN P3-2) — 비활성
   * 프로젝트도 포함. `threads[].state === "awaiting"` 인 대화의 개수와 같다.
   */
  pendingCount: number;
  /**
   * 열린 넘김의 마지막 사건 — 폴러(`pollOpenHandoffs`)가 감지한 것.
   * 코멘트 도착(`comments`) · 반영됨(`merged`) · 반려(`closed`·
   * `changes_requested`) 중 하나. 아직 아무 사건도 못 본 프로젝트는 키가 없다.
   */
  lastEventKind?: "merged" | "closed" | "changes_requested" | "comments";
  /** `lastEventKind`를 폴러가 감지한 시각(ISO) — 사건이 실제로 일어난 시각이
      아니라 최대 10분 지연된 발견 시각이다. */
  lastEventAt?: string;
}

export interface ProjectList {
  projects: ProjectSummary[];
  activeSlug: string | null;
}

/**
 * The connected repo ships its own .claude/settings.json whose permissions,
 * env, or hooks pre-approve tools no card will ever ask about. News, not a
 * live problem: the daemon re-sends the same sentence on every status, and
 * the fingerprint (repo root + raw file bytes) is how a client that has read
 * it stays quiet — an edited file or a different repo is a new fingerprint
 * and warns again.
 */
export interface RepoSettingsWarning {
  /** Korean, one line: what the file pre-approves. */
  text: string;
  /** sha256 over the repo root and the settings file's raw bytes. */
  fingerprint: string;
}
export interface DaemonStatus {
  /**
   * Every registered project and which one everything else means. Empty on a
   * first run: the wizard's last step is creating one.
   */
  projects: ProjectSummary[];
  activeProject: string | null;
  protocolVersion: number;
  /**
   * The app-authored instruction block every session's system prompt carries
   * (커미티 2026-09-14): owned by the app release, read-only for users — the
   * 지켜 줄 것 dialog shows it so the planner can see what the app always
   * says. Project instructions ride `ProjectSummary.instructions` beside it.
   */
  commonInstructions: string;
  /** node's process.platform, so a bug report says which OS produced it. */
  platform: string;
  claudeVersion: string | null;
  claudeExecutable: string | null;
  /** git powers clone/pull, @-mention listing and Claude Code's Bash tool. */
  gitAvailable: boolean;
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
  email: string | null;
  /** True when ANTHROPIC_API_KEY is present, which would bill the key not the subscription. */
  apiKeyInEnv: boolean;
  /**
   * 데몬 자신의 GitHub 읽기가 마지막으로 본 인증 판정: 어떤 GitHub REST 응답이
   * 401 이면 true, 그 뒤의 어떤 응답이든(숨긴 레포의 404 도 인증을 마친 뒤의
   * 대답이다) 다시 false. 만료 카드의 진입점 — 푸시 인증 거절은 이미
   * `DiffStatus.reason: "push-auth"` 로 말하므로 여기에 섞지 않는다.
   * 브로드캐스트는 판정이 바뀔 때만이다.
   */
  githubAuthExpired?: boolean;
  liveSessions: number;
  pendingPermissions: number;
  warnings: string[];
  /**
   * The repo-settings warning rides here instead of `warnings` because the
   * two behave differently on close: those are live problems (session-scoped
   * dismissal), this is news a fingerprint can retire.
   */
  repoSettingsWarning: RepoSettingsWarning | null;
  /** pnpm may drive the connected repo's install and preview commands. */
  pnpmAvailable: boolean;
  /**
   * Whether this machine can read @colosseumcoinckr packages from GitHub
   * Packages. Probed only when the connected repo declares a `registry`.
   */
  cdsRegistryAuth: "ok" | "unauthenticated" | "unknown";
  /**
   * The plan's rolling limits as the daemon last saw them. Cached daemon-wide
   * so the composer can show them without a session open; null until some
   * session has reported once (and for API-key sessions, which have no plan).
   */
  planUsage: PlanUsage | null;
  /**
   * The model rows each provider's CLI offers, cached daemon-wide so the
   * composer can offer a choice before any thread exists. Keyed by provider
   * id — a Claude alias and a Codex model id are different vocabularies and
   * must never share a list. Empty until a session reports.
   */
  modelsByProvider: Record<string, SessionModelInfo[]>;
  /**
   * The agent providers this daemon can run — id, label, availability, and
   * the modes/capabilities the UI reads to hide what a driver cannot do.
   * `version`/`loggedIn`/`reason` carry the driver's own diagnostic so the
   * settings list can say what is wrong, not just that something is.
   */
  providers?: Array<{
    id: string;
    label: string;
    available: boolean;
    /** The CLI's own version string when the driver could read it. */
    version?: string;
    /** The vendor's credential check; absent when the driver doesn't track one. */
    loggedIn?: boolean;
    /** Why the provider cannot run — shown in place of a bare "설치 필요". */
    reason?: string;
    modes: Array<{ id: string; label: string; tier: string }>;
    defaultModeId: string;
    capabilities: Record<string, unknown>;
  }>;
}

// ---------------------------------------------------------------------------
// Onboarding (DESIGN §8)
// ---------------------------------------------------------------------------

/**
 * Machine-wide gates, answered once: Claude Code, git, Node·pnpm (the runtime
 * the connected repo's install · preview · build commands run on), and the
 * GitHub token whose repo list the project picker shows. Which repo a planner
 * works on is NOT a gate — a project is added from the workspace itself, and
 * its clone reports its own progress through `repo.status`.
 */
export type OnboardingStepId = "claude" | "git" | "runtime" | "github";
export type OnboardingStatus = "pass" | "warn" | "fail";
export type OnboardingFixKind =
  | "install-claude"
  | "login-claude"
  | "install-git"
  | "install-node"
  | "install-pnpm";

export interface OnboardingFix {
  kind: OnboardingFixKind;
  label: string;
  /** Set when the fix is a link the planner follows (`install-node`): the tool installs nothing itself. */
  href?: string;
}

export interface OnboardingStep {
  id: OnboardingStepId;
  /** `fail` blocks the tabs; `warn` shows its reason and fix only. */
  status: OnboardingStatus;
  /** Korean: what passed, or why it failed and what to do. */
  detail: string;
  fix?: OnboardingFix;
}

// ---------------------------------------------------------------------------
// GitHub token, repo list, repo inspection (onboarding · project picker)
// ---------------------------------------------------------------------------

/** One repo the stored token can reach, as the project picker lists it. */
export interface GitHubRepo {
  /** `owner/name`, which is also how GitHub sorts and searches it. */
  fullName: string;
  owner: string;
  name: string;
  /** The https clone url the daemon hands to git. */
  cloneUrl: string;
  /** What a handoff PR would target. */
  defaultBranch: string;
  /** Whether this token may push — 넘기기 opens pull requests with it. */
  canPush: boolean;
  /** When the repo last moved, for the picker's most-recent-first order. */
  pushedAt: string | null;
}

export interface GitHubRepoList {
  repos: GitHubRepo[];
  /**
   * True when listing stopped at the page cap — the token can see more than
   * we showed, so the picker's search stays honest about it.
   */
  truncated: boolean;
}

/** What the picker shows about the one repo a planner chose, before cloning. */
export interface GitHubRepoInspection {
  /** package.json scripts carry a dev-family script (dev · start · serve · preview). */
  hasDevScript: boolean;
  canPush: boolean;
  defaultBranch: string;
}
