import type { Attention } from "./attention.js";
import type { HandoffStatus, RepoPhase } from "./repo.js";
import type { PlanUsage, SessionModelInfo } from "./session.js";
import type { EffortLevel } from "./shared.js";

// ---------------------------------------------------------------------------
// Daemon -> client
// ---------------------------------------------------------------------------

/**
 * One conversation of one project, as the sidebar tree's child row shows it
 * (PLAN D59). The daemon maps the session state onto the four words the tree
 * draws; the planner's own rename rides the client's 설정, not this wire.
 */

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
  /** The branch 저장 pushes to this cycle — null until the first save. */
  branch?: string | null;
  /** The preview the clone's server answers on — only while a workspace is
      live and ready; an inactive or never-touched project omits it. */
  previewUrl?: string | null;
  /** The clone's folder on this machine — the hover card's 폴더 열기 target. */
  repoRoot?: string;
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
  lastEventKind?: "merged" | "closed" | "changes_requested" | "comments" | "replied";
  /** `lastEventKind`를 폴러가 감지한 시각(ISO) — 사건이 실제로 일어난 시각이
      아니라 최대 2분 지연된 발견 시각이다. */
  lastEventAt?: string;
  /**
   * 초대 v4(PLAN 단계 5): 개발자가 초대장에 실어 보낸 새 대화의 처음 값 —
   * 사용자가 칩에서 고른 적이 없을 때만 씨앗이 된다.
   */
  defaults?: ProjectDefaults;
  /** 초대 v4: 사이클의 수명 규칙 — 없으면 각 소비자의 기본값을 따른다. */
  lifecycle?: ProjectLifecycle;
  /**
   * 이 프로젝트의 주의 (PLAN L8) — 비활성 프로젝트의 사이드바 행도 같은
   * 문장을 읽는다. 없으면 키가 없다.
   */
  attention?: Attention | null;
}

export interface ProjectList {
  projects: ProjectSummary[];
  activeSlug: string | null;
}

// ---------------------------------------------------------------------------
// 초대 파일 v4 (PLAN 단계 5) — 개발자가 정하는 프로젝트의 기본값과 수명
// ---------------------------------------------------------------------------

/** 새 대화의 처음 값(초대 v4) — 칩이나 선로가 말하지 않았을 때만 쓰인다.
 *  사용자가 고르면 그것이 이긴다(PLAN 0.2 — 사용자는 모델을 안다). */
export interface ProjectDefaults {
  /** 이 기본값이 어느 공급자에게만 해당하는가 — 없으면 모든 공급자. */
  provider?: string;
  /** 모델 별칭 또는 id — 선로가 그대로 launch 에 싣는 값이다. */
  model?: string;
  effort?: EffortLevel;
}

/** 사이클의 수명 규칙(초대 v4 · PLAN L4) — 값이 없으면 각 소비자의 기본값
 *  (지운다 · 14일 · 답한다 · 제출할 수 있다)을 따른다. */
export interface ProjectLifecycle {
  /** 병합된 사이클 브랜치를 원격에서도 지울까 — 기본 true. */
  deleteMergedBranches?: boolean;
  /** 반려된 작업을 브랜치 채로 남기는 날 — 기본 14, 1~365. */
  keepRejectedDays?: number;
  /** 개발자 코멘트에 AI 가 스스로 답할까 — 기본 true. */
  autoReply?: boolean;
  /** 채팅의 "제출해 줘" 를 받아들일까 — 기본 true. */
  submitFromChat?: boolean;
}

/** 초대 v4 의 새 필드가 지키는 한도 — 읽는 쪽(normalizeInvite)과 레지스트리
 *  (parseProject)가 같은 잣자리를 쓴다. */
export const PROJECT_FIELD_LIMITS = {
  provider: 64,
  model: 64,
  keepRejectedDays: { min: 1, max: 365 },
} as const;

const EFFORT_LEVELS: Record<string, true> = {
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};

/**
 * 알 수 없는 defaults 값을 판독한다 — 초대 v4 의 규칙은 "모르는 값은 버리고
 * 나머지를 살린다"(PLAN 단계 5): 잘못된 effort 나 한도 밖 문자열은 그 필드만
 * 버리고, 남는 것이 없으면 필드 자체가 없어진다. 레지스트리의 손편집도 같은
 * 길로 흡수된다.
 */
export function parseProjectDefaults(value: unknown): ProjectDefaults | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const provider =
    typeof record.provider === "string" && record.provider.trim() !== ""
      ? record.provider.trim().slice(0, PROJECT_FIELD_LIMITS.provider)
      : undefined;
  const model =
    typeof record.model === "string" && record.model.trim() !== ""
      ? record.model.trim().slice(0, PROJECT_FIELD_LIMITS.model)
      : undefined;
  const effort =
    typeof record.effort === "string" && EFFORT_LEVELS[record.effort] === true
      ? (record.effort as EffortLevel)
      : undefined;
  const defaults: ProjectDefaults = {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

/** parseProjectDefaults 의 lifecycle 판 — 같은 규칙으로 모르는 값을 버린다. */
export function parseProjectLifecycle(value: unknown): ProjectLifecycle | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const days =
    typeof record.keepRejectedDays === "number" &&
    Number.isInteger(record.keepRejectedDays) &&
    record.keepRejectedDays >= PROJECT_FIELD_LIMITS.keepRejectedDays.min &&
    record.keepRejectedDays <= PROJECT_FIELD_LIMITS.keepRejectedDays.max
      ? record.keepRejectedDays
      : undefined;
  const lifecycle: ProjectLifecycle = {
    ...(typeof record.deleteMergedBranches === "boolean"
      ? { deleteMergedBranches: record.deleteMergedBranches }
      : {}),
    ...(days !== undefined ? { keepRejectedDays: days } : {}),
    ...(typeof record.autoReply === "boolean" ? { autoReply: record.autoReply } : {}),
    ...(typeof record.submitFromChat === "boolean"
      ? { submitFromChat: record.submitFromChat }
      : {}),
  };
  return Object.keys(lifecycle).length > 0 ? lifecycle : undefined;
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
  /** Korean, one line: which keys were cut from which settings file. */
  text: string;
  /** sha256 over the repo root and the quarantined settings' raw bytes. */
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
  /** 슬라이스 5: 개발자 에스컬레이션 웹훅이 저장되어 있는가 — URL 자체는 못 나간다. */
  escalationConfigured?: boolean;
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
   * The plan's rolling limits per provider's account, as the daemon last saw
   * them. One machine signs into one account per provider — claude's 43% and
   * codex's are different budgets, so the readings live side by side and the
   * composer reads the row of the provider it is about to spend. Cached
   * daemon-wide so the composer can show them without a session open; a
   * provider missing from the map has not reported yet (and for API-key
   * sessions, which have no plan, it never will).
   */
  planUsageByProvider: Record<string, PlanUsage>;
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
    /** 이 드라이버가 기계 잔일(저장 메모 · 넘기기 초안)의 단답 턴을 맡을 수
     *  있다 — machine-provider 의 후보. 없으면 설정의 담당 행에 나오지 않는다. */
    oneShot?: boolean;
    capabilities: Record<string, unknown>;
  }>;
  /** 설정창의 저장 메모 담당 — 계획자가 고른 값. null(또는 없음) = 자동(기본). */
  machineProvider?: string | null;
  /**
   * 지금 실제 담당 — 설정이 고른 것("setting") 또는 자동 규칙의 것("auto").
   * null = 후보가 없어 폴백만 남는다 (메모·초안을 건너뛴다).
   */
  machineProviderActive?: { id: string; origin: "setting" | "auto" } | null;
  /**
   * 이 데몬이 개발 실행인가(COLO_DESIGN_DEV_AGENTS=1 · 패키징 안 된 데스크톱).
   * 웹 번들은 production 빌드라 import.meta.env.DEV 로 대신 판단하면 패키징된
   * 앱에서 항상 false 다 — 개발 전용 면(슬래시 메뉴 등)은 이 선로 값을 본다.
   */
  dev?: boolean;
  /** 넘긴 요청에 적을 작성자 이름 — 온보딩이 묻고 machine.json 이 기억한다. */
  authorName?: string | null;
  /**
   * 기계 전체의 주의 (PLAN L8) — 연결 코드 만료 · AI 로그아웃처럼 어느
   * 프로젝트의 것도 아닌 문제. 없으면 키가 없다.
   */
  attention?: Attention | null;
  /**
   * 개발자 알림이 실제로 나가는 경로 (PLAN L11) — GitHub(PR 코멘트 · 이슈)가
   * 열려 있으면 "github", 아니면 Slack, 둘 다 없으면 "none". 화면은 이 값으로
   * `개발자에게 알렸어요` 가 어느 채널로 갔는지 안다.
   */
  noticeRoute?: "github" | "slack" | "none";
}

// ---------------------------------------------------------------------------
// Onboarding
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
  | "install-codex"
  | "login-claude"
  | "install-git"
  | "install-node"
  | "install-pnpm";

/** 데몬이 끝까지 지켜보는 두 설치 — 진행기와 그 방송이 함께 쓰는 종류. */
export type AgentInstallKind = "install-claude" | "install-codex";

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
  /** `owner/repo` — 저장소가 옮겨졌는지 감독자가 알아보는 표식 (PLAN 단계 9).
   * null 이면 GitHub 이 말하지 않은 것이다. */
  fullName?: string | null;
}
