// Shared state and plumbing behind RepoWorkspace — the clone's status,
// git capture, emit machinery and the conflict/refresh vocabulary every
// domain module speaks. Package-internal: only repo.ts and the repo-*.ts
// modules import this.
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Attention,
  type ChangedFileLite,
  type ChatEvent,
  type DiffFile,
  type DiffStatus,
  type HandoffStatus,
  markTurn,
  type RepoErrorKind,
  type RepoHistory,
  type RepoPhase,
  type RepoStatus,
} from "@colo-design/protocol";
import type { CyclePendingOp } from "./cycle-ledger.js";
import { currentPlatform, resolveGitExecutable } from "./environment.js";
import { GitLane, gitWriteVerb } from "./git-lane.js";
import { type GitHubClient, parseRepoSlug } from "./github.js";
import { createFileLogger, type DaemonLogger } from "./log.js";
import type { MachineTurn } from "./machine-provider.js";
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
 * The one shelf slot's ref — v0.3.8~v0.3.10 의 치워두기 단추가 채웠고, 지금은
 * 시작 쓸기의 자동 꺼내기(repo-shelf 의 recoverShelf)가 읽는다. A ref of its
 * own (never a `git stash`, whose namespace the refresh's transit stash and
 * its recovery machinery own) also means the agent Bash gate's open `git
 * stash` verbs cannot reach it.
 */
export const SHELF_REF = "refs/colo-design/shelf";

/** How long the save-time memo turn may take before the default message. */
export const MEMO_TIMEOUT_MS = 8_000;
/** How long the 넘기기 draft's turn may take before the browser's proposal wins. */
export const HANDOFF_DRAFT_TIMEOUT_MS = 8_000;

/**
 * The planner's own word for each gate — the step as the planner's own
 * button is. "push 단계가 실패했습니다" would send it looking for a git
 * problem when the planner pressed 저장.
 */
export const GATE_BRIEF: Record<"commit" | "push" | "pr", string> = {
  commit: "보관할 변경을 커밋하지 못했습니다.",
  push: "보관한 변경을 올리지 못했습니다.",
  pr: "개발자에게 제출하지 못했습니다.",
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
  commit: "보관",
  push: "보관한 내용 올리기",
  pr: "제출",
};
/**
 * The stash this tool parks unsaved work in while 최신화 moves the branch.
 * Named for the button, so `git stash list` reads like the product, not git.
 * 관찰(cycle-observe)이 도구 태그의 stash 를 찾는 잣대로도 쓰인다(PLAN L3 3행).
 */
export const STASH_MESSAGE = "Colo Design: 최신화 임시 보관";

/** What the planner reads when a conflict needs the agent and no thread is open. */
export const REFRESH_CONFLICT_DETAIL =
  "최신 변경을 받아 오다 보관하지 않은 변경과 충돌이 남았습니다 — 대화를 열면 AI가 정리합니다. 정리 전까지는 같은 상태입니다.";

/**
 * What the planner reads when replaying a dead run's parked work conflicts
 * and no thread is open — same state and remedy as REFRESH_CONFLICT_DETAIL,
 * named for how the work got parked.
 */
export const RECOVER_CONFLICT_DETAIL =
  "치워 둔 보관 전 변경을 돌려놓다 겹치는 부분이 생겼습니다 — 대화를 열면 AI가 정리합니다. 정리 전까지는 같은 상태입니다.";

/** 충돌 브리프의 양쪽 — 개발자 쪽과 이번 작업의 커밋 제목들 (PLAN L5). */
export interface ConflictSides {
  theirs: string[];
  ours: string[];
}

/**
 * 충돌 브리프 하나 (PLAN L5) — 옛 mergeConflictBrief · popConflictBrief 를
 * 대체한다. 시키는 일은 표식 정리뿐: git 명령을 시키는 문장은 한 줄도 없다
 * (마무리는 도구가 한다). `op` 은 첫 문장만 갈라 상황을 말한다 — stash
 * 복원의 충돌은 개발자 변경과의 합치기가 아니라 되돌리기의 겹침이므로.
 */
export function conflictBrief(
  files: string[],
  op: CyclePendingOp["kind"],
  sides: ConflictSides,
): string {
  const opening =
    op === "stash-pop"
      ? "보관하지 않은 변경을 돌려놓다 이미 반영된 내용과 겹쳐 자동으로 합치지 못했습니다."
      : "개발자가 반영한 변경과 이번 작업이 같은 곳을 고쳐 자동으로 합치지 못했습니다.";
  const lines = [opening, `충돌 표식(<<<<<<< ======= >>>>>>>)이 남은 파일: ${files.join(", ")}`];
  if (sides.theirs.length > 0) lines.push(`개발자 쪽 변경: ${sides.theirs.join(", ")}`);
  if (sides.ours.length > 0) lines.push(`이번 작업: ${sides.ours.join(", ")}`);
  lines.push(
    "두 변경의 뜻을 모두 살려 표식을 지우고 파일을 정리해 주세요.",
    "git 명령은 쓰지 마세요 — 정리가 끝나면 도구가 마무리합니다.",
  );
  return lines.join("\n");
}

/**
 * What a 저장 pressed before the agent finished a conflict's cleanup reads —
 * the unmerged files count as changes awaiting 저장, so the refusal must
 * name the one thing standing in the way, not leave a silent door.
 */
export const SAVE_CONFLICT_OPEN_DETAIL =
  "정리가 끝나지 않은 충돌이 있습니다 — 대화에서 AI가 정리를 마친 뒤 제출해 주세요.";

/**
 * What the planner reads when a repo's commands have not been approved here.
 * P3-1: 문장은 사용자가 서 있는 자리의 말이다 — "승인되지 않은 명령" 은
 * 거절당한 기분을 주지만, 실제로 일어난 일은 이 컴퓨터에서 이 서비스를
 * 처음 켜는 것뿐이다.
 */
export const COMMANDS_UNAPPROVED_DETAIL =
  "이 서비스를 이 컴퓨터에서 처음 켭니다 — 준비에 몇 분 걸립니다. 시작하려면 아래 버튼을 눌러 주세요.";

export const PNPM_MISSING_DETAIL =
  "pnpm이 없습니다 — corepack enable 또는 npm i -g pnpm 으로 설치해 주세요.";
export const REGISTRY_AUTH_DETAIL =
  "GitHub 패키지 인증이 필요합니다 — pnpm config set //npm.pkg.github.com/:_authToken <read:packages 권한 PAT>";
export const REPO_URL_MISSING_DETAIL =
  "연결 레포 주소가 없습니다 — 개발자에게 받은 초대 파일을 다시 놓아 주세요.";

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
  /**
   * The machine turn that writes the save memo and the handoff draft —
   * machine-provider.ts picks the driver; the repo layer stays provider-blind.
   * Absent (a direct construction, doctor, tests) means the fallback is the
   * only path, exactly as a missing CLI used to mean.
   */
  machineTurn?: MachineTurn;
  /**
   * 넘긴 요청에 적을 작성자 이름(P1-3) — 온보딩이 machine.json 에 저장한 값.
   * 읽어가는 곳은 커밋 identity(fallback 이름)과 PR 본문의 `> 작성:` 줄 둘뿐.
   * 없으면 도구 이름(Colo Design)이 지난날처럼 쓰인다.
   */
  authorName?: () => string | null;
  /**
   * E4(초대 v2): 넘긴 요청의 리뷰를 부탁할 개발자들(GitHub 로그인) — 레지스트리
   * 가 기억하고 넘기기가 읽는다. 비면 아무에게도 부탁하지 않는다.
   */
  reviewers?: () => string[];
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
  /**
   * 개발자 알림 (PLAN L11) — 저장·넘기기의 인증·권한 게이트가 문제 키와
   * 함께 여기를 부른다. fleet 의 DeveloperNotice 로 이어진다.
   */
  notice?: (key: "push:auth" | "submit:pr", detail: string) => void;
  /**
   * 서 있던 개발자 알림을 거둔다 (PLAN L11) — 넘기기 성공이 `submit:pr` 을
   * 푸는 한 길이다. fleet 의 DeveloperNotice.resolve 로 이어진다.
   */
  resolveNotice?: (key: "submit:pr") => void;
  /**
   * 이 프로젝트의 주의 (PLAN L8) — 스냅샷이 읽는 재료의 묶음. fleet 이
   * 감독자 · 게이트 · 준비 복구의 상태를 모아 넣는다. 없으면 주의는 없다.
   */
  attention?: () => Attention | null;
}

export class RepoCore {
  readonly root: string;

  /**
   * The branch a handoff PR will target (PLAN D5[넘기기]). 감독자의 7행
   * (retargetBase)이 원격의 기본 가지를 따라 이 값을 옮긴다 — 레지스트리는
   * fleet 콜백이 함께 갱신한다.
   */
  baseBranch: string;

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

  /**
   * git 쓰기의 줄 (PLAN L1) — 이 클론을 바꾸는 모든 git 명령이 여기 하나씩
   * 서서 돈다. 옛 약속 슬롯(publishing · refreshing · shelving)의 몫과,
   * 슬롯 없이 돌던 랜딩 · 복구 · 배경 푸시까지 같은 줄에 태운다.
   * `inFlight` 는 남는다 — 저것은 git 잠금이 아니라 bootstrap 중복 방지다.
   */
  readonly lane = new GitLane();

  /** Whether this project is the one on screen — see `setActive`. */
  active = true;

  lastEmit = 0;
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
  /**
   * 재검수가 읽은 파일 목록 — P2-1 에서 선로를 떠났다(그리던 화면이 없다).
   * 데몬 안에 남는 이유는 하나: 개수가 같은 편집도 방송을 내야 하는지의
   * 같음 비교가 이 목록을 본다.
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

  /**
   * 도구가 시작한 git 조작(최신화 병합 · stash 복원)이 충돌로 멈췄을 때 부르는
   * 손잡이 (PLAN L5 · 단계 3) — 감독자(cycle-supervisor)가 여기에 걸려 원장의
   * pendingOp 에 적고 틱을 돌린다. 없으면(시험 · 감독자 없는 실행) 브리프를
   * 세션으로 보내거나 던지는 옛 길 그대로다. 콜백은 차선 문맥을 벗겨 부른다
   * (나가는 문 — 이 콜백이 세션을 만들어도 이 작업의 줄을 물려받지 않게).
   */
  onToolConflict: ((op: CyclePendingOp) => void) | null = null;

  /** 이 프로젝트의 주의 (PLAN L8) — 스냅샷이 읽는 재료의 묶음. */
  readonly attention: (() => Attention | null) | null;
  /** 넘긴 요청에 적을 작성자 이름 — 커밋 fallback 이름과 PR 본문이 읽는다(P1-3). */
  readonly authorName: (() => string | null) | null;

  /** E4(초대 v2): 넘긴 요청의 리뷰를 부탁할 개발자들 — 레지스트리가 기억한다. */
  readonly reviewers: (() => string[]) | null;
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
    /** 넘긴 요청에 적을 작성자 이름 — 없으면 도구 이름이 쓰인다(P1-3). */
    authorName?: () => string | null;
    /** E4(초대 v2): 리뷰를 부탁할 개발자들 — 레지스트리의 목록을 읽어간다. */
    reviewers?: () => string[];
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
    /** 이 프로젝트의 주의 (PLAN L8) — 스냅샷이 읽는 재료의 묶음. */
    attention?: () => Attention | null;
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
    this.authorName = options.authorName ?? null;
    this.reviewers = options.reviewers ?? null;
    this.attention = options.attention ?? null;
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

  /**
   * Rewrites a PAT-bearing origin to its clean form — see update(). bootstrap 과
   * update 양쪽에서 부르므로 `remote set-url`(쓰기)의 차선 감싸기도 안에 둔다.
   */
  async scrubOriginCredential(): Promise<void> {
    if (!this.isCloned()) return;
    await this.lane.run("hygiene", async () => {
      const origin = (await this.git(["remote", "get-url", "origin"]).catch(() => "")).trim();
      if (!/^https:\/\/[^@/\s]+@/.test(origin)) return;
      await this.git([
        "remote",
        "set-url",
        "origin",
        origin.replace(/^(https:\/\/)[^@/\s]+@/, "$1"),
      ]);
    });
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
    // the review would say 저장할 변경사항이 없습니다 over real work.
    // 차선(diff 칸, join)이 옛 `while (refreshing)` 손 기다림을 대신한다
    // (PLAN L1): 최신화가 줄을 잡으면 그 뒤에 서서 읽고, 저장 안에서 불리면
    // 재진입으로 곧바로 읽는다.
    return await this.lane.run(
      "diff",
      async (): Promise<DiffFile[]> => {
        if (!this.isCloned()) return [];
        const tracked = parseUnifiedDiff(
          await this.git(["-c", "core.quotepath=false", "diff", "HEAD", "--no-color"]),
        );
        const files = [...tracked];
        for (const rel of (
          await this.git([
            "-c",
            "core.quotepath=false",
            "ls-files",
            "--others",
            "--exclude-standard",
          ])
        )
          .split(/\r?\n/)
          .filter(Boolean)) {
          files.push(untrackedAsAdded(this.root, rel));
        }
        return files.sort((a, b) => a.path.localeCompare(b.path));
      },
      { join: true },
    );
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
    // PLAN L1: 최신화 전체가 차선의 refresh 칸이다(join) — 겹친 최신화는 한 번만
    // 돌고, bootstrap 이 불러도 같은 줄에 선다. 몸통 안의 recoverParkedWork 는
    // 재진입으로 곧바로 돈다.
    return await this.lane.run("refresh", () => this.refreshFromRemoteJob(onSessionTurn), {
      join: true,
    });
  }

  /** refreshFromRemote 의 몸통 — 차선 작업 안에서만 돈다. */
  private async refreshFromRemoteJob(
    onSessionTurn?: (brief: string) => void,
  ): Promise<"clean" | "conflict"> {
    // A refresh that finds a conflict left over from an earlier run briefs
    // again instead of piling on: until the agent resolves it, that state IS
    // the current one.
    if (await this.mergeInProgress()) {
      return await this.conflictOrBrief(
        {
          kind: "merge",
          files: await this.conflictedFiles(),
          startedAt: new Date().toISOString(),
          briefs: 0,
        },
        onSessionTurn,
      );
    }
    const leftover = await this.conflictedFiles();
    if (leftover.length > 0) {
      // 진행 표식 없이 unmerged 만 남은 상태 — 죽은 실행의 stash 복원 충돌로
      // 읽는다. 그 stash 가 아직 있으면 ref 를 함께 적어 마무리의 drop 이
      // 겨눌 것을 남긴다.
      const stashRef = await this.taggedStashRef();
      return await this.conflictOrBrief(
        {
          kind: "stash-pop",
          files: leftover,
          startedAt: new Date().toISOString(),
          briefs: 0,
          ...(stashRef !== null ? { stashRef } : {}),
        },
        onSessionTurn,
      );
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
          // 사이클 밖 갈라짐(베이스 위에 로컬 커밋)은 더 이상 준비 실패가
          // 아니다 (PLAN L3 6행) — 감독자의 adoptStrayCommits 가 그 커밋을
          // 사이클 브랜치로 옮긴다. 여기서는 최신화를 건너뛰고(치워둔 변경은
          // 아래에서 그대로 되돌린다) 준비를 계속한다.
          if (ahead === 0) {
            await this.git(["merge", "--ff-only", `origin/${this.baseBranch}`]);
          }
        }
      }
    } catch (error) {
      if (await this.mergeInProgress()) {
        return await this.conflictOrBrief(
          {
            kind: "merge",
            files: await this.conflictedFiles(),
            startedAt: new Date().toISOString(),
            briefs: 0,
          },
          onSessionTurn,
        );
      }
      if (stashed) await this.git(["stash", "pop"]).catch(() => undefined);
      throw error;
    }

    if (stashed) {
      // pop 이 겨눌 ref 는 도구 태그의 것이다 — stash@{0} 기본값 대신 태그로
      // 찾아, 그 사이 다른 stash 가 얹혀도 남의 것을 pop 하지 않는다.
      const ref = (await this.taggedStashRef()) ?? "stash@{0}";
      const conflicted = await this.popStash(ref);
      if (conflicted) {
        return await this.conflictOrBrief(
          {
            kind: "stash-pop",
            files: conflicted,
            startedAt: new Date().toISOString(),
            briefs: 0,
            stashRef: ref,
          },
          onSessionTurn,
        );
      }
    }
    return "clean";
  }

  /**
   * 도구가 시작한 조작이 충돌로 멈췄을 때의 한 갈래 (PLAN L5 · 단계 3):
   * 감독자가 붙어 있으면(onToolConflict) 원장에 적고 틱을 부르는 것으로
   * 끝낸다 — 브리프는 감독자의 2행이 낸다. 감독자가 없는 곳(시험 · 직접
   * 생성)은 옛 길 그대로: 열린 대화가 있으면 브리프를, 없으면 던진다.
   */
  private async conflictOrBrief(
    op: CyclePendingOp,
    onSessionTurn: ((brief: string) => void) | undefined,
    detail = REFRESH_CONFLICT_DETAIL,
  ): Promise<"conflict"> {
    if (this.onToolConflict !== null) {
      // 나가는 문 (PLAN L1): 콜백이 원장 쓰기와 틱을 하므로 이 작업의 차선
      // 문맥을 물려주지 않는다 — 틱은 이 작업이 끝난 뒤 제 줄에서 돈다.
      this.lane.outside(() => this.onToolConflict?.(op));
      return "conflict";
    }
    // 나가는 문 (PLAN L1): 브리프는 dispatch(fleet) 로 가서 세션을 만들 수
    // 있다 — 그 세션의 사슬이 이 작업의 문맥을 물려받으면 이후 저장이 줄을
    // 비켜간다. 문맥을 벗겨 보낸다.
    if (onSessionTurn) {
      this.lane.outside(() =>
        onSessionTurn(
          markTurn(
            { kind: "gate", step: "최신 변경 합치기" },
            conflictBrief(op.files, op.kind, { theirs: [], ours: [] }),
          ),
        ),
      );
      return "conflict";
    }
    throw new Error(detail);
  }

  /**
   * 도구 태그(STASH_MESSAGE)를 단 stash 의 ref — 관찰(cycle-observe)과
   * 복구가 같은 잣대로 찾는다. 없으면 null.
   */
  async taggedStashRef(): Promise<string | null> {
    const list = await this.git(["stash", "list", "--format=%gd%x00%s"]).catch(() => "");
    for (const row of list.split(/\r?\n/)) {
      if (row.trim() === "") continue;
      const [ref = "", ...subject] = row.split("\x00");
      if (subject.join("\x00").includes(STASH_MESSAGE)) return ref.trim();
    }
    return null;
  }

  /**
   * 충돌 브리프의 양쪽 커밋 제목 (PLAN L5) — 개발자 쪽(theirs)과 이번
   * 작업(ours)을 `git log --format=%s` 로 읽는다. stash 복원의 ours 는
   * 커밋이 아니므로 빈 목록이다.
   */
  async conflictSides(op: CyclePendingOp["kind"]): Promise<ConflictSides> {
    const titles = async (args: string[]): Promise<string[]> =>
      (await this.git(["log", "--format=%s", ...args]).catch(() => ""))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (op === "merge") {
      // 들어오는 쪽은 MERGE_HEAD 에만 있는 커밋들 — 없으면(이미 조상) 그
      // 커밋 자체를 보여 준다. ours 는 이 사이클이 베이스 위에 쌓은 커밋들.
      let theirs = await titles(["-5", "HEAD..MERGE_HEAD"]);
      if (theirs.length === 0) theirs = await titles(["-5", "MERGE_HEAD"]);
      const ours = await titles(["-5", `origin/${this.baseBranch}..HEAD`]);
      return { theirs, ours };
    }
    if (op === "cherry-pick") {
      return {
        theirs: await titles(["-1", "CHERRY_PICK_HEAD"]),
        ours: await titles(["-5", `origin/${this.baseBranch}..HEAD`]),
      };
    }
    return { theirs: await titles(["-5", "HEAD"]), ours: [] };
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

  /** True while a cherry-pick waits for its conflict resolution (CHERRY_PICK_HEAD). */
  async cherryPickInProgress(): Promise<boolean> {
    try {
      await this.git(["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"]);
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
   * rather than fail over a name nobody reads. 온보딩이 작성자 이름을 받아 뒀으면
   * 그 이름이 도구 이름을 대신한다(P1-3) — 이메일은 여전히 이 도구의 것이고,
   * 개발자는 PR 의 `> 작성:` 줄과 같은 이름을 커밋에서도 읽는다.
   */
  async identityArgs(): Promise<string[]> {
    const fallback = () => {
      const name = this.authorName?.() ?? "Colo Design";
      return ["-c", `user.name=${name}`, "-c", "user.email=colo-design@localhost"];
    };
    try {
      return (await this.git(["config", "user.email"])).trim() ? [] : fallback();
    } catch {
      return fallback();
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
   *
   * pop 이 전쟁 없이 죽는 길이 하나 더 있다 — 임시 보관 때 새 파일(untracked)로
   * 있던 경로를 받아 온 base 가 추적하기 시작한 충돌(실측: git 은 tracked
   * 변경을 먼저 깔고 untracked 복원에서 "already exists, no checkout" 으로
   * 죽는다, stash 는 남는다). 그대로 두면 새 파일은 stash 안에 갇혀 레지스트리만
   * 참조하는 깨진 커밋이 나가고(베타 테스트 B7), 충돌 브리프의 `git stash drop`
   * 지시는 갇힌 파일을 파괴한다. stash 의 untracked 판(`^3`)을 직접 깔아
   * 결정론적으로 마무리한다 — 계획자의 보관이 작업 나무를 이기는 것은 모든
   * pop 의 결과와 같은 규칙이고, 개발자 판은 HEAD 에 남아 diff 로 보인다.
   */
  async popStash(ref = "stash@{0}"): Promise<string[] | null> {
    try {
      await this.git(["stash", "pop", ref]);
      return null;
    } catch (error) {
      const salvaged = await this.restoreParkedUntracked(ref);
      const conflicted = await this.conflictedFiles();
      // tracked 병합이 남긴 충돌은 여전히 브리프의 것이다 — 단, 이번에는
      // untracked 가 이미 깔려 있으므로 브리프의 drop 지시가 아무것도 잃지
      // 않는다.
      if (conflicted.length > 0) return conflicted;
      if (salvaged) {
        // tracked 판은 pop 이 이미 깔았고(깨끗한 경우), untracked 판은
        // 방금 깔았다 — stash 는 비었으므로 여기서 치운다.
        await this.git(["stash", "drop", ref]);
        return null;
      }
      throw error;
    }
  }

  /**
   * The untracked half of a parked stash, laid onto the worktree by hand.
   * False when this failure is not the colliding-untracked kind — the caller
   * keeps its original verdict (brief or throw) for everything else.
   */
  private async restoreParkedUntracked(ref: string): Promise<boolean> {
    const parent = `${ref}^3`;
    try {
      await this.git(["rev-parse", "-q", "--verify", parent]);
    } catch {
      return false;
    }
    const listed = await this.git([
      "-c",
      "core.quotepath=false",
      "ls-tree",
      "-r",
      "--name-only",
      parent,
    ]);
    const parked = listed
      .split(/\r?\n/)
      .map((line) => unquoteGitPath(line.trim()))
      .filter(Boolean);
    if (parked.length === 0) return false;
    // 이미 자리에 있는 경로가 하나라도 있어야 이 실패가 이 충돌이다 — 없는데
    // pop 이 죽었다면 다른 병이므로 손대지 않는다.
    const colliding = parked.filter((path) => {
      const safe = safeRepoPath(path);
      return safe !== null && existsSync(join(this.root, safe));
    });
    if (colliding.length === 0) return false;
    // `^3` 의 나무에는 임시 보관 때의 새 파일만 들어 있다 — 통째로 깔아도
    // 겹치는 경로 외에는 아무것도 덮지 않는다.
    await this.git(["checkout", parent, "--", "."]);
    return true;
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
    // PLAN L1: stash pop 은 작업 트리를 움직인다 — 복구(recover) 칸에 선다.
    // 시작 쓸기(server.ts)와 최신화 몸통이 같은 줄에 태워져 시작의 두 복구
    // 경합이 저절로 직렬화된다. 최신화 안에서 불리면 재진입으로 곧바로 돈다.
    return await this.lane.run("recover", () => this.recoverParkedWorkJob(onSessionTurn));
  }

  /** recoverParkedWork 의 몸통 — 차선 작업 안에서만 돈다. */
  private async recoverParkedWorkJob(
    onSessionTurn?: (brief: string) => void,
  ): Promise<"none" | "restored" | "conflict"> {
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
    // 감독자가 붙어 있으면 원장에 적고 틱을 부르는 것으로 끝난다 — 브리프는
    // 감독자의 2행이 낸다(PLAN L5). 없으면 옛 길: 대화 브리프 또는 던지기.
    if (this.onToolConflict !== null) {
      this.lane.outside(() =>
        this.onToolConflict?.({
          kind: "stash-pop",
          files: conflicted,
          startedAt: new Date().toISOString(),
          briefs: 0,
          stashRef: ref,
        }),
      );
      return "conflict";
    }
    if (onSessionTurn) {
      // 나가는 문 — 세션을 만드는 콜백에 이 작업의 차선 문맥을 물려주지 않는다.
      this.lane.outside(() =>
        onSessionTurn(
          markTurn(
            { kind: "gate", step: "최신 변경 합치기" },
            conflictBrief(conflicted, "stash-pop", { theirs: [], ours: [] }),
          ),
        ),
      );
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
    // 나가는 문 (PLAN L1): 상태 방송 콜백이 사슬을 살리면 문맥이 번진다.
    this.lane.outside(() => this.onDiffStatus?.(status));
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
    // PLAN L1: 클론을 바꾸는 git 은 차선 작업 안에서만 돈다. 판정은 동사로
    // 한다 — 다른 작업 트리 cwd(handoff-preview 의 워크트리)로 도는 명령도
    // 같은 .git 을 쓰면 위반이다.
    this.guardLane(args);
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
   * 차선 위반 판정 (PLAN L1): 클론을 바꾸는 git 이 차선 작업 밖에서 불리면
   * 잡는다. 배포 판에서 빠뜨린 자리 하나가 사용자의 작업을 죽이지 않게
   * 기본은 동사당 한 번의 경고고, 시험·개발(COLO_DESIGN_LANE_STRICT=1)은
   * 던진다.
   */
  private guardLane(args: string[]): void {
    const verb = gitWriteVerb(args);
    if (verb === null || this.lane.holding) return;
    const detail =
      `git ${verb} 명령이 차선 밖에서 실행됐습니다 — ` +
      "클론을 바꾸는 git 은 차선 작업 안에서만 돕니다 (PLAN L1).";
    if (process.env.COLO_DESIGN_LANE_STRICT === "1") throw new Error(detail);
    warnLaneViolation(verb, detail);
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
      attention: this.attention?.() ?? null,
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
    if (files.length === this.pendingChanges && sameChangedFiles(files, this.changedFiles)) {
      return;
    }
    this.pendingChanges = files.length;
    this.changedFiles = files;
    this.emit();
  }

  /**
   * 방금 선 커밋의 sha 와 그 커밋이 건드린 파일(2026-09-22) — 라우트↔파일
   * 지도의 재료. 클론이 살아 있고 git 이 답할 때만 값이 있다. 경로는 클론
   * 루트 상대(지도와 핀 후보가 쓰는 모양 그대로)다.
   */
  async headCommitFiles(): Promise<{ sha: string; files: string[] } | null> {
    if (!this.isCloned()) return null;
    try {
      const sha = (await this.git(["rev-parse", "HEAD"])).trim();
      const numstat = await this.git([
        "-c",
        "core.quotepath=false",
        "diff-tree",
        "--numstat",
        "-r",
        "--no-commit-id",
        "HEAD",
      ]);
      return { sha, files: Object.keys(numstatCounts(numstat)) };
    } catch {
      return null;
    }
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
    // 나가는 문 (PLAN L1): 상태 방송은 fleet 의 자동 브리프(autoFixThreadFor
    // 의 세션 만들기)로 이어진다 — 세션의 사슬이 작업 문맥을 물려받아
    // holding 인 체하는 일을 여기서 끊는다. setPhase · setCycle · 최신화가
    // 차선 작업 안에서도 이 문을 지나므로 무조건 벗긴다.
    this.lane.outside(() => this.onStatus(this.snapshot()));
  }
}

const GIT_MISSING_DETAIL = "git을 찾을 수 없습니다 — git을 설치한 뒤 다시 시도해 주세요.";

export function detailOf(error: unknown, pat: string | null): string {
  return redact(error instanceof Error ? error.message : String(error), pat);
}

// ---------------------------------------------------------------------------
// 차선 위반 경고 (PLAN L1) — 동사당 한 번, 파일 로그로만
// ---------------------------------------------------------------------------

const laneWarnedVerbs = new Set<string>();
let laneWarnSink: DaemonLogger | null = null;

function warnLaneViolation(verb: string, detail: string): void {
  if (laneWarnedVerbs.has(verb)) return;
  laneWarnedVerbs.add(verb);
  try {
    laneWarnSink ??= createFileLogger();
    laneWarnSink.warn("[git-lane] 차선 밖 git 쓰기", { verb, detail });
  } catch {
    // 로깅이 도구를 죽일 수는 없다 — log.ts 의 계약.
  }
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
