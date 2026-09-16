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
export interface ThreadSummary {
  id: string;
  title: string;
  /** `running` a turn is on; `awaiting` a permission or question; `finished`
      a turn ended and nothing has followed it; `idle` everything else. */
  state: "running" | "awaiting" | "finished" | "idle";
  updatedAt: string;
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
   * 관례 최신화 (커미티 2026-09-14): 이 클론의 CLAUDE.md 표식이 현행 판과
   * 다르다(표식이 없어도) — 프로젝트 메뉴의 "관례 최신화"가 이 때만 뜬다.
   * 내려받기 전(cloned 아님)에는 항상 거짓.
   */
  conventionsStale: boolean;
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
   * The model rows the CLI offers, cached daemon-wide so the composer can
   * offer a choice before any thread exists. Empty until a session reports.
   */
  models: SessionModelInfo[];
  /**
   * The agent providers this daemon can run — id, label, availability, and
   * the modes/capabilities the UI reads to hide what a driver cannot do.
   */
  providers?: Array<{
    id: string;
    label: string;
    available: boolean;
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
  hasColoDesign: boolean;
  canPush: boolean;
  defaultBranch: string;
}
