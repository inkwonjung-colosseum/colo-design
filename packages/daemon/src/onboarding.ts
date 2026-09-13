/**
 * Onboarding (DESIGN §8, reshaped by PLAN M1, D6, and the GitHub-token pass):
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
import { extraPathPrefix } from "./repo.js";

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
}

export async function runOnboardingChecks(deps: OnboardingDeps): Promise<OnboardingStep[]> {
  return [
    await checkClaude(deps),
    await checkGit(),
    await checkRuntime(deps.pnpmResolver),
    await checkGitHub(deps),
  ];
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

async function checkClaude(deps: OnboardingDeps): Promise<OnboardingStep> {
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

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

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
  const detail =
    currentPlatform() === "darwin"
      ? "git이 없습니다 — Xcode 명령줄 도구를 설치해 주세요. 터미널에 xcode-select --install 을 실행하면 설치 창이 열립니다."
      : `git이 없습니다 — 터미널에서 ${gitInstallGuidance().command} 로 설치한 뒤 다시 확인해 주세요.`;
  return fail("git", detail, { kind: "install-git", label: "설치 안내 보기" });
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
      detail: `${me.detail} 연결하지 않은 것과 같으니, 새 토큰을 다시 넣거나 그대로 시작해도 됩니다 — 주소로 직접 추가한 레포에서는 토큰이 필요 없습니다.`,
    };
  }
  return pass("github", `GitHub @${me.login} 로 연결됨`);
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
 * Unlike the Claude flows this one runs to COMPLETION and returns the output:
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
const LOGIN_FAILED =
  "로그인 창을 열지 못했습니다 — 터미널에서 claude /login 을 직접 실행해 주세요.";

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

/** Opens a Terminal window running `claude /login` (macOS), else spawns it. */
export function startClaudeLogin(spawnLike: SpawnLike = spawn): {
  started: boolean;
  guidance: string;
} {
  if (process.platform === "darwin") {
    try {
      detach(
        spawnLike("osascript", ["-e", 'tell application "Terminal" to do script "claude /login"'], {
          detached: true,
          stdio: "ignore",
        }),
      );
      return {
        started: true,
        guidance:
          "터미널 창을 열었습니다 — 브라우저 로그인을 마친 뒤 이 단계를 다시 확인해 주세요.",
      };
    } catch {
      // fall through to the detached spawn
    }
  }
  try {
    // Windows: `claude` is a .cmd shim, which is not an executable — a shell
    // resolves it. Everywhere else the direct spawn is one process fewer.
    detach(
      spawnLike("claude", ["/login"], {
        detached: true,
        stdio: "ignore",
        shell: process.platform === "win32",
      }),
    );
    return {
      started: true,
      guidance:
        "로그인 절차를 시작했습니다 — 안내를 따라 로그인한 뒤 이 단계를 다시 확인해 주세요.",
    };
  } catch {
    return { started: false, guidance: LOGIN_FAILED };
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

function pass(id: OnboardingStepId, detail: string): OnboardingStep {
  return { id, status: "pass", detail };
}

/** A gate with no `fix` is one only the planner's own input can clear. */
function fail(id: OnboardingStepId, detail: string, fix?: OnboardingFix): OnboardingStep {
  return { id, status: "fail", detail, ...(fix ? { fix } : {}) };
}
