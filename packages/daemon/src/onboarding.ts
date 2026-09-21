/**
 * Onboarding (reshaped by PLAN M1, D6, and the GitHub-token pass):
 * the four machine-wide gates a first run answers once — Claude Code, git,
 * Node·pnpm, and the GitHub token whose repo list the project picker shows.
 *
 * Which repo a planner works on is deliberately NOT here (PLAN D12[게이트 아님]):
 * a project is added from the workspace itself, and the clone's own
 * `repo.status` says where a bring-up stands. The wizard ends at the GitHub
 * gate.
 *
 * Gate semantics: `fail` blocks the workspace; `warn` (an API key shadowing
 * the subscription, a missing GitHub token) states its reason and lets the
 * planner past — a public repo needs no token, and the picker degrades to a
 * pasted url.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { OnboardingFix, OnboardingStep, OnboardingStepId } from "@colo-design/protocol";
import type { AgentDriver } from "./agent/driver.js";
import { extraPathPrefix } from "./claude-trust.js";
import {
  currentPlatform,
  type Platform,
  readAuthStatus,
  readClaudeVersion,
  resolveClaudeExecutable,
  resolveGitExecutable,
  resolveNodeVersion,
  resolvePnpmExecutable,
} from "./environment.js";
import type { GitHubClient } from "./github.js";

export type { OnboardingStep };

const run = promisify(execFile);

export interface OnboardingDeps {
  claudeExecutableOverride?: string;
  /**
   * Test seam: the real pnpm hunt reads machine-fixed locations a test
   * cannot scrub (PNPM_HOME, /usr/local/bin/pnpm) — a CI runner has pnpm
   * installed exactly there, so the "empty machine" suite injects a
   * resolver instead of the answer. See checkRuntime's own seam note.
   */
  pnpmResolver?: () => Promise<string | null>;
  /**
   * A client on the machine-wide GitHub token, or null when no token is
   * stored (the github gate's own warning) or the caller does not care.
   * Absent means the gate reports "토큰을 연결해 주세요", never an error.
   */
  gitHubClient?: () => GitHubClient | null;
  /**
   * 이 토큰으로 접근 가능한 쓰기 레포 수(P1-2) — 브리지의 캐시된 목록에서 센다.
   * 답이 0 이면 게이트는 warn 으로 물러난다: 토큰은 살아 있지만 이 기계가
   * 넘길 수 있는 레포가 하나도 없다는 뜻이므로. null(목록을 못 읽음)이면
   * 판정을 유보하고 지난날처럼 pass 로 둔다 — 게이트가 네트워크 탓에 막히는
   * 일은 없어야 한다.
   */
  githubWriteRepoCount?: () => Promise<number | null>;
  /**
   * Which provider the agent step checks (PLAN: provider-aware gate).
   * Defaults to "claude" — the historical gate.
   */
  provider?: string;
  /**
   * Driver lookup for non-claude providers. Absent with provider "claude"
   * keeps the direct resolveClaudeExecutable path (tests inject
   * claudeExecutableOverride without a registry).
   */
  driverFor?: (id: string) => AgentDriver | undefined;
}

export async function runOnboardingChecks(deps: OnboardingDeps): Promise<OnboardingStep[]> {
  return [
    await checkAgent(deps),
    await checkGit(),
    await checkRuntime(deps.pnpmResolver),
    await checkGitHub(deps),
  ];
}

async function checkAgent(deps: OnboardingDeps): Promise<OnboardingStep> {
  const provider = deps.provider ?? "claude";
  if (provider !== "claude") {
    const driver = deps.driverFor?.(provider);
    if (!driver) {
      return fail(
        "claude",
        `선택한 에이전트(${provider})를 이 데몬이 모릅니다 — 설정에서 다른 에이전트를 골라 주세요.`,
      );
    }
    const label = driver.describe().label;
    const diag = await driver.isAvailable();
    if (diag.ok) {
      return pass("claude", `${label} 준비됨${diag.version ? ` (${diag.version})` : ""}`);
    }
    if (!diag.executable) {
      return fail("claude", `${label} CLI를 찾지 못했습니다 — 설치한 뒤 다시 확인해 주세요.`);
    }
    if (diag.loggedIn === false) {
      return fail(
        "claude",
        `${label} 로그인이 필요합니다 — 터미널에서 로그인한 뒤 다시 확인해 주세요.`,
      );
    }
    return fail("claude", diag.reason ?? `${label} 실행 준비가 되지 않았습니다.`);
  }
  const executable = await resolveClaudeExecutable(deps.claudeExecutableOverride);
  if (!executable) {
    return fail("claude", "Claude Code CLI를 찾지 못했습니다.", {
      kind: "install-claude",
      label: "Claude Code 설치",
    });
  }
  const auth = await readAuthStatus(executable);
  if (!auth.loggedIn) {
    return fail("claude", "Claude Code 로그인이 필요합니다 — 본인 구독으로 실행됩니다.", {
      kind: "login-claude",
      label: "Claude Code 로그인",
    });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      id: "claude",
      status: "warn",
      detail:
        "ANTHROPIC_API_KEY 환경변수가 설정되어 있어 구독 대신 이 키로 결제됩니다. 데몬 환경에서 키를 제거하고 다시 시작해 주세요.",
    };
  }
  const version = await readClaudeVersion(executable);
  const plan = auth.subscriptionType ? ` · ${auth.subscriptionType}` : "";
  return pass("claude", `Claude Code 준비됨${version ? ` (${version})` : ""}${plan}`);
}

async function checkGit(): Promise<OnboardingStep> {
  const git = await resolveGitExecutable();
  if (git) {
    try {
      const { stdout } = await run(git, ["--version"]);
      return pass("git", `git 준비됨 (${stdout.trim()})`);
    } catch {
      // The resolver proved this git a moment ago; a race is vanishingly
      // rare, and the honest answer either way is the missing-git step.
    }
  }
  return gitMissing();
}

/** One failing step for both "never installed" and "installed but broken". */
function gitMissing(): OnboardingStep {
  // darwin 은 이 도구가 설치 명령을 직접 띄운다(startGitInstall) — OS 의 설치
  // 대화상자가 곧 진행 표시다. 다른 플랫폼은 문장이 전부다.
  if (currentPlatform() === "darwin") {
    return fail("git", "git이 없습니다 — 설치 버튼을 누르면 설치 창이 열립니다.", {
      kind: "install-git",
      label: "git 설치",
    });
  }
  return fail("git", gitMissingGuidanceText(), {
    kind: "install-git",
    label: "설치 안내 보기",
  });
}

function gitMissingGuidanceText(): string {
  return `git이 없습니다 — 터미널에서 ${gitInstallGuidance().command} 로 설치한 뒤 다시 확인해 주세요.`;
}

// ---------------------------------------------------------------------------
// Node · pnpm (the runtime the connected repo's commands run on)
// ---------------------------------------------------------------------------

/** The Node line the connected repo's toolchain is built for (README). */
const MIN_NODE_MAJOR = 22;

/**
 * The runtime gate (PLAN D5[런타임 게이트]). It reads the same PATH the repo's install ·
 * preview · build children get — `COLO_DESIGN_EXTRA_PATH`, the desktop app's
 * bundled runtime, first — because that is the node that will actually run,
 * and a pass here names it ("앱에 포함됨"). pnpm resolves through the same
 * conventions `repo.ts` will use at install time.
 */
export async function checkRuntime(
  /** Test seam: the machine's pnpm hunt reads fixed home paths a test
      cannot rename, so the resolver — not the answer — is what's injected. */
  resolvePnpm: () => Promise<string | null> = resolvePnpmExecutable,
): Promise<OnboardingStep> {
  const node = await resolveNodeVersion();
  const pnpm = await resolvePnpm();
  const nodeLine = node
    ? `Node.js ${node.version}${node.bundled ? " (앱에 포함됨)" : ""}`
    : "Node.js 없음";

  const problems: string[] = [];
  const fixes: OnboardingFix[] = [];
  if (!node || majorOf(node.version) < MIN_NODE_MAJOR) {
    problems.push(
      node
        ? `Node.js ${MIN_NODE_MAJOR} 이상이 필요합니다 (지금: ${node.version})`
        : `Node.js ${MIN_NODE_MAJOR} 이상이 필요합니다 (지금: 없음)`,
    );
    // A link, never an installer: picking a package manager on somebody's
    // machine is not this tool's call. The desktop app bundles its own
    // runtime, so reaching this branch already means the browser dev path
    // or a broken bundle.
    fixes.push({
      kind: "install-node",
      label: "Node.js 내려받기",
      href: "https://nodejs.org/ko/download",
    });
  }
  if (!pnpm) {
    problems.push("pnpm이 없습니다");
    fixes.push({ kind: "install-pnpm", label: "pnpm 설치" });
  }
  if (problems.length === 0) {
    const pnpmLine = pnpm ? `pnpm ${await pnpmVersionOr(pnpm)}` : "pnpm 준비됨";
    return pass("runtime", `${nodeLine} · ${pnpmLine}`);
  }
  return fail("runtime", problems.join("\n"), fixes[0]);
}

/** `v22.12.0` → 22; anything unparsable counts as too old to trust. */
function majorOf(version: string): number {
  return Number(version.replace(/^v/, "").split(".")[0]) || 0;
}

async function pnpmVersionOr(pnpm: string): Promise<string> {
  try {
    const { stdout } = await run(pnpm, ["--version"]);
    return stdout.trim();
  } catch {
    return "준비됨";
  }
}

// ---------------------------------------------------------------------------
// GitHub (the machine-wide token)
// ---------------------------------------------------------------------------

async function checkGitHub(deps: OnboardingDeps): Promise<OnboardingStep> {
  const client = deps.gitHubClient?.() ?? null;
  if (!client) {
    // Warn, not fail: a planner working on a public repo — or pointing at a
    // local remote through the manual url — never needs a token, and blocking
    // the workspace on it would lock them out of the product. The card stays
    // open with the form, the picker degrades to the manual url, and 넘기기
    // is the only thing a missing token eventually refuses.
    return {
      id: "github",
      status: "warn",
      detail:
        "GitHub 토큰이 없습니다 — 레포(GitHub의 프로젝트 저장소) 목록을 가져오고 개발자에게 넘길 때 쓰입니다. 연결하지 않으면 레포를 주소로 직접 추가해야 합니다.",
    };
  }
  const me = await client.whoAmI();
  if (!me.ok) {
    // A refused or unreachable check leaves the planner exactly where a
    // missing token does: the manual url and public repos stay open, so the
    // workspace must stay reachable too. A fail here used to vanish the
    // 시작하기 button the moment one bad token was pasted (실사 결함) — the
    // wizard had no way back, because nothing can un-store a token from the
    // cards it offers. The reason rides a warn, the form stays open for the
    // next paste, and 넘기기 remains the one thing a tokenless machine
    // eventually refuses.
    return {
      id: "github",
      status: "warn",
      detail: `${me.detail} 연결하지 않은 것과 같으니, 새 코드를 다시 넣거나 그대로 시작해도 됩니다 — 주소로 직접 추가한 레포에서는 코드가 필요 없습니다.`,
    };
  }
  // warn, not fail: 0개의 쓰기 레포도 "토큰 없음"과 같은 대우다. 개발자에게
  // 받은 코드가 이 조직의 어떤 레포에도 닿지 않는 상태에서 마법사를 막으면,
  // 카드가 다시 물을 수 있는 일은 아무것도 없다. 문구는 다시 요청하게 이끈다.
  const writeCount = deps.githubWriteRepoCount
    ? await deps.githubWriteRepoCount().catch(() => null)
    : null;
  if (writeCount === 0) {
    return {
      id: "github",
      status: "warn",
      detail:
        "개발자에게 받은 코드가 이 레포에 닿지 않습니다 — 개발자에게 다시 요청하세요. " +
        "그 전까지 주소를 직접 넣는 공개 레포로는 작업할 수 있습니다.",
    };
  }
  return pass(
    "github",
    `GitHub @${me.login} 로 연결됨${writeCount !== null ? ` · 쓸 수 있는 레포 ${writeCount}개` : ""}`,
  );
}

// The project is NOT a gate (PLAN D12[게이트 아님]): which repo a planner works on is
// picked in the workspace, and its clone reports its own progress through
// `repo.status` — a second judgement here would say the same thing twice
// and hold the whole product behind it.

// ---------------------------------------------------------------------------
// Fix helpers the server calls
// ---------------------------------------------------------------------------

/** The spawn surface the fix flows use — injectable in tests. */
export type SpawnLike = typeof spawn;

/** A spawned child nobody waits for: errors are absorbed, never unhandled. */
function detach(child: ReturnType<SpawnLike>): void {
  // A detached ENOENT surfaces as an async 'error' event; without a listener
  // it would crash the daemon. Nobody reads the outcome here — the planner
  // re-runs the check — so absorbing is the whole job.
  child.once("error", () => undefined);
  child.unref();
}

export type RunLike = typeof run;

/**
 * Enables pnpm through corepack — the same shim the bundled runtime ships.
 * Unlike the agent flows this one runs to COMPLETION and returns the output:
 * `corepack enable` is quick, writes inside the node prefix, and its failure
 * (usually a permission error) is exactly the sentence the planner needs.
 * The runner is injectable so tests never execute corepack for real.
 */
export async function runPnpmInstall(
  env: NodeJS.ProcessEnv = process.env,
  platform: Platform = currentPlatform(),
  runLike: RunLike = run,
): Promise<{ ok: boolean; detail: string }> {
  const command = platform === "win32" ? "corepack.cmd" : "corepack";
  try {
    const { stdout } = await runLike(command, ["enable"], {
      env: { ...env, PATH: extraPathPrefix(env.COLO_DESIGN_EXTRA_PATH, env) },
      shell: platform === "win32",
      timeout: 60_000,
    });
    const line = `${stdout}`.trim().split(/\r?\n/).find(Boolean);
    return {
      ok: true,
      detail: line ? `corepack enable: ${line}` : "corepack enable 을 실행했습니다.",
    };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const text = `${failure.stderr ?? ""}${failure.stdout ?? ""}${failure.message ?? ""}`.trim();
    return {
      ok: false,
      detail:
        `corepack enable 이 실패했습니다${text ? ` — ${text.split(/\r?\n/)[0]}` : ""}. ` +
        "터미널에서 corepack enable 을 직접 실행하거나 npm i -g pnpm 으로 설치해 주세요.",
    };
  }
}

const installFailed = (platform: string): string =>
  platform === "win32"
    ? "설치를 시작하지 못했습니다 — 터미널에서 irm https://claude.ai/install.ps1 | iex 를 직접 실행해 주세요."
    : "설치를 시작하지 못했습니다 — 터미널에서 curl -fsSL https://claude.ai/install.sh | bash 를 직접 실행해 주세요.";

/**
 * Runs the Claude Code native installer detached. Nothing here shows the
 * progress — stdio is dropped, and on macOS no window opens — so the reply's
 * guidance is the wizard's only feedback. The wizard checks ONCE right after
 * the press; while the installer works there is no re-check on its own —
 * 다시 확인 is the planner's move when a few minutes have passed.
 */
export function startClaudeInstall(
  spawnLike: SpawnLike = spawn,
  platform: string = process.platform,
): { started: boolean; guidance: string } {
  try {
    if (platform === "win32") {
      // No sh here: the native installer is a PowerShell one-liner, and the
      // console window it opens is the progress the planner sees.
      detach(
        spawnLike(
          "powershell",
          ["-NoProfile", "-Command", "irm https://claude.ai/install.ps1 | iex"],
          {
            detached: true,
            stdio: "ignore",
          },
        ),
      );
    } else {
      detach(
        spawnLike("sh", ["-c", "curl -fsSL https://claude.ai/install.sh | bash"], {
          detached: true,
          stdio: "ignore",
        }),
      );
    }
    return {
      started: true,
      guidance: "설치를 시작했습니다 — 몇 분 뒤 이 단계를 다시 확인해 주세요.",
    };
  } catch {
    return { started: false, guidance: installFailed(platform) };
  }
}

/**
 * 터미널 없는 에이전트 로그인 (P1-1): 데몬이 로그인 명령을 stdio 파이프로
 * 띄워 대신 몰고, 앱은 브라우저와 붙여넣기만 담당한다. 스파이크로 확인한
 * CLI 의 출력 계약 — `claude auth login` 은 OAuth 주소를 stdout 에 내놓고
 * `Paste code here if prompted >` 에서 stdin 의 코드를 기다린다(틀린 코드는
 * stderr 한 줄로 답하고 다시 기다린다). `codex login` 은 주소를 stderr 에
 * 내놓고 콜백을 기다린다(코드 입력 없음) — 주소는 어느 줄에서 왔든 첫
 * https URL 로 잡고, "코드 붙여넣기" 칸은 CLI 가 실제로 코드를 청했을 때만
 * 연다(wantsCode). 주소보다 프롬프트가 늦게 오면 wantsCode=true 로 다시
 * 방송한다 — 같은 판을 다시 그릴 뿐이다.
 */
export interface AgentLoginEvents {
  onUrl(url: string, wantsCode: boolean): void;
  onDone(ok: boolean, detail: string): void;
}

const LOGIN_GUIDANCE =
  "로그인을 시작했습니다 — 브라우저가 열리면 안내에 따라 로그인하고, 화면에 나온 코드를 붙여넣어 주세요.";
const LOGIN_FAILED =
  "로그인을 시작하지 못했습니다 — 에이전트 설치를 먼저 마치고 다시 시도해 주세요.";

export class AgentLogin {
  private child: ReturnType<SpawnLike> | null = null;
  /** stop() 이 치운 자식의 close 는 끝이 아니라 교체일 뿐 — 끝을 누른다. */
  private generation = 0;

  constructor(private readonly spawnLike: SpawnLike = spawn) {}

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  start(
    command: string,
    args: string[],
    events: AgentLoginEvents,
  ): {
    started: boolean;
    guidance: string;
  } {
    this.stop();
    const generation = this.generation;
    try {
      // Windows: `claude` is a .cmd shim, which is not an executable — a shell
      // resolves it. Everywhere else the direct spawn is one process fewer.
      const child = this.spawnLike(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      this.child = child;
      let output = "";
      let url: string | null = null;
      let wantsCode = false;
      const feed = (text: string) => {
        output += text;
        const found = /(https:\/\/[^\s"']+)/.exec(output)?.[1] ?? null;
        const asked = /paste (the )?code/i.test(output);
        // 주소·프롬프트는 한 덩어리로 오기도 하고 갈라져 오기도 한다 — 상태가
        // 바뀐 만큼만 다시 방송한다(웹은 같은 판을 다시 그린다).
        if (found !== null && (found !== url || asked !== wantsCode)) {
          url = found;
          wantsCode = asked;
          events.onUrl(url, wantsCode);
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => feed(String(chunk)));
      child.stderr?.on("data", (chunk: Buffer) => feed(String(chunk)));
      child.once("error", () => {
        if (generation !== this.generation) return;
        this.child = null;
        events.onDone(false, LOGIN_FAILED);
      });
      child.once("close", (code) => {
        if (generation !== this.generation) return;
        this.child = null;
        if (code === 0) {
          events.onDone(true, "로그인이 완료되었습니다.");
          return;
        }
        // 실패의 이유는 자식의 마지막 말 — 프롬프트 잔상보다 정보가 있는 줄이다.
        const last =
          output
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith("https://"))
            .at(-1) ?? "";
        events.onDone(
          false,
          last ? `로그인이 끝나지 않았습니다 — ${last.slice(0, 160)}` : LOGIN_FAILED,
        );
      });
      return { started: true, guidance: LOGIN_GUIDANCE };
    } catch {
      this.child = null;
      return { started: false, guidance: LOGIN_FAILED };
    }
  }

  /** 웹이 붙여넣은 코드를 자식의 stdin 으로 — 로그인이 살아 있을 때만 true. */
  submitCode(code: string): boolean {
    if (!this.running) return false;
    this.child?.stdin?.write(`${code.trim()}\n`);
    return true;
  }

  /** 진행 중인 로그인을 끊는다 — 재시작의 앞단계와 데몬 종료가 부른다. */
  stop(): void {
    this.generation += 1;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && !child.killed) child.kill();
  }
}

/**
 * The guidance is surfaced, not executed: per platform, one command the
 * planner can read and run themselves. Pure in the platform so the branches
 * for the platforms this daemon is not running on can still be tested.
 */
export function gitInstallGuidance(platform: Platform = currentPlatform()): {
  command: string;
  guidance: string;
} {
  if (platform === "darwin") {
    return {
      command: "xcode-select --install",
      guidance:
        "터미널에 위 명령을 실행하면 Xcode 명령줄 도구 설치 창이 열립니다. 설치 후 다시 확인해 주세요.",
    };
  }
  if (platform === "win32") {
    return {
      command: "winget install --id Git.Git -e --source winget",
      guidance: "터미널에 위 명령을 실행해 git을 설치한 뒤 다시 확인해 주세요.",
    };
  }
  return {
    command: "sudo apt install git",
    guidance:
      "배포판의 패키지 매니저로 git을 설치해 주세요 — 위 명령은 데비안/우분투 기준입니다. 설치 후 다시 확인해 주세요.",
  };
}

/**
 * git 설치 (P1-1): darwin 은 설치 명령을 실제로 띄운다 — OS 가 제 설치
 * 대화상자를 열므로 그것으로 원클릭이 성립한다. 그 외 플랫폼은 문장만
 * 돌려준다(Windows 데스크톱 앱은 MinGit 을 함께 배포하므로 이 길에 서는
 * 일 자체가 드물다). detached · stdio ignore — 결과는 다시 확인이 읽는다.
 */
export function startGitInstall(
  spawnLike: SpawnLike = spawn,
  platform: Platform = currentPlatform(),
): { started: boolean; guidance: string } {
  if (platform === "darwin") {
    try {
      detach(spawnLike("xcode-select", ["--install"], { detached: true, stdio: "ignore" }));
      return {
        started: true,
        guidance: "설치 창을 열었습니다 — 설치가 끝나면 이 단계를 다시 확인해 주세요.",
      };
    } catch {
      // 스폰에 실패한 세계는 아래 문장이 직접 실행할 길을 알려 준다.
    }
  }
  const guide = gitInstallGuidance(platform);
  return {
    started: false,
    guidance: `git이 없습니다 — 터미널에 ${guide.command} 로 설치한 뒤 다시 확인해 주세요.`,
  };
}
function pass(id: OnboardingStepId, detail: string): OnboardingStep {
  return { id, status: "pass", detail };
}

/** A gate with no `fix` is one only the planner's own input can clear. */
function fail(id: OnboardingStepId, detail: string, fix?: OnboardingFix): OnboardingStep {
  return { id, status: "fail", detail, ...(fix ? { fix } : {}) };
}
