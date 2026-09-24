import { execFile } from "node:child_process";
import { type Dirent, existsSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { DaemonStatus } from "@colo-design/protocol";
import { PROTOCOL_VERSION } from "@colo-design/protocol";
import { COMMON_INSTRUCTIONS } from "./common-instructions.js";

const run = promisify(execFile);

/**
 * Everything Colo Design writes lives under one hidden folder in the user's
 * home: the repo clones and this daemon's own settings (PLAN D1). One root is
 * one thing to back up, explain, or delete — and the dot keeps a planner out
 * of files only the tool should write.
 */
export const COLO_DESIGN_DIR = join(homedir(), ".colo-design");

/** Daemon settings: `daemon.json`, `repo.json`, `projects.json`. */
export const CONFIG_DIR = join(COLO_DESIGN_DIR, "config");

export type Platform = "win32" | "darwin" | "linux";

/** `win32` is the only branch that matters; macOS and Linux install alike. */
export function currentPlatform(): Platform {
  return process.platform === "win32"
    ? "win32"
    : process.platform === "darwin"
      ? "darwin"
      : "linux";
}

/**
 * Where Claude Code's own installers put the binary, in the order we trust them.
 *
 * Pure so the branch for the platform this daemon is not running on can still
 * be tested. The native installer owns `~/.local/bin` on every platform; the
 * remaining entries cover Homebrew on macOS and WinGet on Windows.
 */
export function claudeCandidates(
  platform: Platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return [
      join(home, ".local", "bin", "claude.exe"),
      join(localAppData, "Microsoft", "WinGet", "Links", "claude.exe"),
      join(localAppData, "Programs", "claude", "claude.exe"),
    ];
  }
  return [
    join(home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
}

/** The shell-free way to ask the OS where a command lives. */
export function lookupCommand(platform: Platform): {
  command: string;
  args: string[];
} {
  return platform === "win32"
    ? { command: "where", args: ["claude.exe"] }
    : { command: "which", args: ["claude"] };
}

/** 번들 도구 환경의 결과 — PATH 앞자리와 세울 변수들. */
export interface BundledToolEnv {
  /** PATH 의 맨 앞에 붙일 디렉터리(번들 git/bin). 데몬·세션·AI 명령이 물려받는다. */
  pathPrefixes: string[];
  /** 세울 환경 변수 — 번들이 신뢰의 근원이므로 있는 값을 덮어쓴다. */
  env: NodeJS.ProcessEnv;
}

/**
 * 번들 도구 환경(2단계): 데스크톱 앱이 resources/bin 에 실어 온 이동식 git 과
 * Windows bash 를 이 기계의 세계에서 가장 앞에 둔다.
 *
 * - darwin: `<bin>/git/bin/git` 이 있으면 그 폴더를 PATH 맨 앞에, 그리고
 *   `GIT_EXEC_PATH`·`GIT_TEMPLATE_DIR` 를 번들의 것으로 **덮어쓴다** — 이동식
 *   git 은 exec path 를 `//libexec/git-core` 로 잡아 HTTPS 복제가
 *   `remote-https is not a git command` 로 죽으므로(실측). 세웠으면 데몬 자신도
 *   반드시 번들 git 이어야 한다(다른 git 에 번들의 exec path 가 섞이면 깨진다)
 *   — PATH 맨 앞이 그 둘을 함께 보증한다. 또한 `/usr/bin/git` 이 CLT 설치
 *   대화상자를 여는 가짜인 mac 에서, AI 의 git 명령조차 대화상자를 부르지
 *   않게 한다.
 * - win32: MinGit 의 `usr/bin/bash.exe` 를 `CLAUDE_CODE_GIT_BASH_PATH` 로
 *   알린다 — Claude CLI 는 bash.exe 만 찾고 못 찾으면 BashTool 를 내놓지
 *   않는다. 사용자가 이미 정한 값은 존중해 건드리지 않는다.
 * - 번들이 없으면 아무것도 안 한다(브라우저 개발 경로).
 *
 * Pure in (resourcesBin, platform, env, exists) — 테스트가 exists 를 갈아끼운다.
 */
export function bundledToolEnv(
  resourcesBin: string,
  platform: string,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = existsSync,
): BundledToolEnv {
  if (platform === "darwin" && exists(join(resourcesBin, "git", "bin", "git"))) {
    const root = join(resourcesBin, "git");
    return {
      pathPrefixes: [join(root, "bin")],
      env: {
        GIT_EXEC_PATH: join(root, "libexec", "git-core"),
        GIT_TEMPLATE_DIR: join(root, "share", "git-core", "templates"),
      },
    };
  }
  if (
    platform === "win32" &&
    !env.CLAUDE_CODE_GIT_BASH_PATH &&
    exists(join(resourcesBin, "usr", "bin", "bash.exe"))
  ) {
    return {
      pathPrefixes: [],
      env: { CLAUDE_CODE_GIT_BASH_PATH: join(resourcesBin, "usr", "bin", "bash.exe") },
    };
  }
  return { pathPrefixes: [], env: {} };
}

/**
 * Where git's own installers put it, in the order we trust them. Only a
 * fallback: a git on PATH wins, because the PATH stub is what the offline
 * suites drive and the binary the user's own shell would run. `/usr/bin/git`
 * is deliberate and last — on a mac without the command-line tools it is a
 * shim whose only act is opening the CLT installer, and the `git --version`
 * probe below reads that as missing, not as an install. Pure so the branch
 * for the platform this daemon is not running on can still be tested.
 */
export function gitCandidates(platform: Platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "win32") {
    const programFiles = env["ProgramFiles"] ?? "C:\\Program Files";
    const localAppData = env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    // 번들 MinGit 이 먼저다(P1-1): 데스크톱 앱이 resources/bin 에 실어 나르고
    // git.exe 는 그 안의 cmd/ 아래에 있다 — PATH 의 resources/bin 만으로는
    // `where` 가 못 찾는 자리다. 번들이 없는 브라우저 개발 경로는 건너뛴다.
    const bundled = (env.COLO_DESIGN_EXTRA_PATH ?? "")
      .split(";")
      .filter(Boolean)
      .map((dir) => join(dir, "cmd", "git.exe"));
    return [
      ...bundled,
      join(programFiles, "Git", "cmd", "git.exe"),
      join(localAppData, "Programs", "Git", "cmd", "git.exe"),
    ];
  }
  // 번들 이동식 git 이 먼저다(2단계): 데스크톱 앱이 resources/bin/git 에 풀어
  // 두고 GIT_EXEC_PATH 를 그것으로 세웠으니, 데몬이 다른 git 을 집으면 exec
  // path 가 섞여 깨진다. EXTRA_PATH 의 각 항목에 대해 `<dir>/git/bin/git` 을
  // 맨 앞에 둔다(win32 분기의 모양과 같다). 번들이 없는 개발 실행은 그대로.
  const bundled = (env.COLO_DESIGN_EXTRA_PATH ?? "")
    .split(":")
    .filter(Boolean)
    .map((dir) => join(dir, "git", "bin", "git"));
  return [...bundled, "/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"];
}

/** A candidate only counts if it answers `git --version` — an install that
 *  cannot run is a missing install as far as every caller is concerned. */
async function gitWorks(candidate: string): Promise<boolean> {
  try {
    const { stdout } = await run(candidate, ["--version"]);
    return /^git version/.test(stdout.trim());
  } catch {
    return false;
  }
}

let gitResolution: { key: string; path: string | null } | null = null;

/**
 * The git this daemon drives — and the one every git child spawns, so the
 * gate's verdict and the clone it clears share one binary. A pinned
 * `COLO_DESIGN_GIT_BIN` replaces discovery outright: the suites point it at a
 * stub (or at nothing) and no machine-local install may answer instead.
 * Otherwise PATH wins and the installer locations fill its gaps — the
 * Finder-launched desktop app inherits `/usr/bin:/bin`, where a Homebrew-only
 * git never appears. Memoized on the discovery inputs: the suites that swap
 * them re-resolve, one long-lived daemon does not re-probe per git call.
 */
export async function resolveGitExecutable(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const platform = currentPlatform();
  const pin = env.COLO_DESIGN_GIT_BIN;
  const key = `${pin ?? ""}\u0000${env.PATH ?? ""}`;
  if (gitResolution?.key === key) return gitResolution.path;

  let path: string | null = null;
  if (pin) {
    path = (await gitWorks(pin)) ? pin : null;
  } else if (platform !== "win32") {
    if (await gitWorks("git")) path = "git";
  } else {
    try {
      const { stdout } = await run("where", ["git.exe"]);
      const found = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (found && (await gitWorks(found))) path = found;
    } catch {
      // `where` exits non-zero when nothing matches.
    }
  }
  if (!path && !pin) {
    for (const candidate of gitCandidates(platform, env)) {
      if (await gitWorks(candidate)) {
        path = candidate;
        break;
      }
    }
  }
  gitResolution = { key, path };
  return path;
}

/**
 * Where pnpm's own installers put it. The standalone script owns `PNPM_HOME`
 * (`~/Library/pnpm` on macOS, `~/.local/share/pnpm` on Linux, `%LOCALAPPDATA%\pnpm`
 * on Windows); corepack and `npm i -g` instead drop a shim beside the node
 * binary that is running us, and the native installer layout that already owns
 * `~/.local/bin/claude` puts pnpm there too.
 *
 * `nodeDir` is a parameter rather than a `process.execPath` read so the Windows
 * branch stays testable from a Mac.
 */
export function pnpmCandidates(
  platform: Platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  nodeDir: string = dirname(process.execPath),
): string[] {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    return [
      ...(env.PNPM_HOME ? [join(env.PNPM_HOME, "pnpm.cmd")] : []),
      join(nodeDir, "pnpm.cmd"),
      join(localAppData, "pnpm", "pnpm.cmd"),
      join(appData, "npm", "pnpm.cmd"),
    ];
  }
  return [
    ...(env.PNPM_HOME ? [join(env.PNPM_HOME, "pnpm")] : []),
    // A GUI-launched daemon inherits a minimal PATH, so `which pnpm` misses
    // exactly the installs a terminal would find. These two cover them.
    join(nodeDir, "pnpm"),
    join(home, ".local", "bin", "pnpm"),
    ...(platform === "darwin" ? [join(home, "Library", "pnpm", "pnpm")] : []),
    join(home, ".local", "share", "pnpm", "pnpm"),
    "/opt/homebrew/bin/pnpm",
    "/usr/local/bin/pnpm",
    "/usr/bin/pnpm",
  ];
}

/** The connected repo's install and preview commands may be pnpm ones. */
export async function resolvePnpmExecutable(): Promise<string | null> {
  const platform = currentPlatform();
  for (const candidate of pnpmCandidates(platform, homedir())) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    const { stdout } = await run(platform === "win32" ? "where" : "which", [
      platform === "win32" ? "pnpm.cmd" : "pnpm",
    ]);
    const found = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (found) return found;
  } catch {
    // Nothing on PATH; corepack has not been enabled either.
  }
  return null;
}

/**
 * Node as the repo's own commands would see it. `COLO_DESIGN_EXTRA_PATH` — the
 * desktop app's bundled runtime — is searched FIRST, because that is the PATH
 * prefix `repo.ts` puts ahead of every install · preview · build child: a
 * version the repo commands would not use is a wrong answer here, however
 * healthy the system node is. `bundled` is true when the resolved binary
 * lives under that extra prefix.
 */
export async function resolveNodeVersion(
  env: NodeJS.ProcessEnv = process.env,
  platform: Platform = currentPlatform(),
): Promise<{ version: string; bundled: boolean } | null> {
  const extra = env.COLO_DESIGN_EXTRA_PATH;
  const extraDirs = extra ? extra.split(platform === "win32" ? ";" : ":").filter(Boolean) : [];
  const binary = platform === "win32" ? "node.exe" : "node";
  for (const dir of extraDirs) {
    const candidate = join(dir, binary);
    if (existsSync(candidate)) {
      try {
        const { stdout } = await run(candidate, ["--version"]);
        return { version: stdout.trim(), bundled: true };
      } catch {
        // Present but broken — keep looking, the system node may still work.
      }
    }
  }
  try {
    const { stdout } = await run(binary, ["--version"]);
    return { version: stdout.trim(), bundled: false };
  } catch {
    return null;
  }
}

/**
 * The PATH a child needs. pnpm and the Claude CLI ship as scripts whose shebang
 * is `#!/usr/bin/env node`, so spawning either fails when node is not on PATH —
 * exactly the case for a daemon started from a desktop app rather than a shell.
 * The daemon widens its own PATH with this at startup, once, so every child
 * inherits it.
 */
export function childPath(
  env: NodeJS.ProcessEnv = process.env,
  nodeDir = dirname(process.execPath),
): string {
  const separator = currentPlatform() === "win32" ? ";" : ":";
  const parts = (env.PATH ?? "").split(separator).filter(Boolean);
  return parts.includes(nodeDir) ? parts.join(separator) : [nodeDir, ...parts].join(separator);
}

/** A network round trip per status request would stall every client connect. */
const registryAuthCache = new Map<string, { value: RegistryAuth; readAt: number }>();
const REGISTRY_AUTH_TTL_MS = 5 * 60_000;

type RegistryAuth = "ok" | "unauthenticated" | "unknown";

/**
 * pnpm reports a private-registry rejection as a 401/403 fetch error. A bare
 * `401` is not enough: install progress lines count packages ("resolved 401").
 */
export function detectsRegistryAuthFailure(output: string): boolean {
  return /ERR_PNPM_FETCH_40[13]|\bunauthorized\b|\bforbidden\b|authentication token|status(?: code)? 40[13]\b/i.test(
    output,
  );
}
/**
 * Whether this machine can read the CDS packages from GitHub Packages. Run in
 * the connected repo's clone so its `.npmrc` (registry mapping) is in scope;
 * repos that declare no registry are not probed at all.
 */
export async function readCdsRegistryAuth(
  pnpm: string | null,
  cwd: string | null,
): Promise<RegistryAuth> {
  if (!pnpm || !cwd || !existsSync(cwd)) return "unknown";
  const cached = registryAuthCache.get(cwd);
  if (cached && Date.now() - cached.readAt < REGISTRY_AUTH_TTL_MS) return cached.value;

  const value = await probeCdsRegistry(pnpm, cwd);
  registryAuthCache.set(cwd, { value, readAt: Date.now() });
  return value;
}

async function probeCdsRegistry(pnpm: string, cwd: string): Promise<RegistryAuth> {
  try {
    const { stdout } = await run(pnpm, ["view", "@colosseumcoinckr/cds", "version"], {
      cwd,
      shell: currentPlatform() === "win32",
      timeout: 20_000,
    });
    return /\d+\.\d+\.\d+/.test(stdout) ? "ok" : "unknown";
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    const text = `${failure.stdout ?? ""}${failure.stderr ?? ""}${String(error)}`;
    // Anything else (offline, registry down, no such package) is not something
    // the user can fix by pasting a token, so it must not claim they must.
    return detectsRegistryAuthFailure(text) ? "unauthenticated" : "unknown";
  }
}

/**
 * Resolve the Claude Code binary this daemon should drive.
 *
 * We deliberately prefer the user's own installed CLI: it is the binary they
 * ran `/login` against, so the session bills to their subscription. The binary
 * is used unmodified, which is what Anthropic's terms require.
 */
export async function resolveClaudeExecutable(override?: string): Promise<string | null> {
  const platform = currentPlatform();
  const candidates = [
    override,
    process.env.COLO_DESIGN_CLAUDE_BIN,
    ...claudeCandidates(platform, homedir()),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolveRealPath(candidate);
  }

  try {
    const { command, args } = lookupCommand(platform);
    const { stdout } = await run(command, args);
    // `where` can report several hits; the first is the one that would run.
    const found = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (found) return resolveRealPath(found);
  } catch {
    // Both `which` and `where` exit non-zero when nothing matches.
  }
  return null;
}

/**
 * The installed `claude` entry is usually a symlink into a versioned binary
 * (`~/.local/share/claude/versions/<version>`). Resolve it so the daemon
 * records the exact binary it drives, which is what the status view reports.
 */
function resolveRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export async function readClaudeVersion(executable: string): Promise<string | null> {
  try {
    const { stdout } = await run(executable, ["--version"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

interface AuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
  email: string | null;
}

export async function readAuthStatus(executable: string): Promise<AuthStatus> {
  try {
    const { stdout } = await run(executable, ["auth", "status"]);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return {
      loggedIn: Boolean(parsed.loggedIn),
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
      subscriptionType:
        typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : null,
      email: typeof parsed.email === "string" ? parsed.email : null,
    };
  } catch {
    return {
      loggedIn: false,
      authMethod: null,
      subscriptionType: null,
      email: null,
    };
  }
}

export async function isGitAvailable(): Promise<boolean> {
  // The same resolution the onboarding gate and every git child use: a git
  // the daemon's PATH cannot see but the machine has, is available.
  return (await resolveGitExecutable()) !== null;
}

export async function buildStatus(input: {
  executable: string | null;
  liveSessions: number;
  pendingPermissions: number;
  /**
   * Directory to probe GitHub Packages auth in — the connected repo's clone,
   * and only when that repo declares a registry. Null otherwise.
   */
  registryProbeDir: string | null;
  // Plan limits, the model list and the project registry are the server's to
  // own across sessions, so the machine report stops short of the wire shape.
}): Promise<
  Omit<
    DaemonStatus,
    | "planUsageByProvider"
    | "modelsByProvider"
    | "projects"
    | "activeProject"
    | "repoSettingsWarning"
  >
> {
  const warnings: string[] = [];
  const apiKeyInEnv = Boolean(process.env.ANTHROPIC_API_KEY);
  if (apiKeyInEnv) {
    warnings.push(
      "데몬 환경에 ANTHROPIC_API_KEY 가 설정되어 있어 구독 대신 이 키로 결제됩니다 — 키를 지우고 앱을 다시 시작해 주세요.",
    );
  }
  if (!input.executable) {
    warnings.push("Claude Code CLI 를 찾지 못했습니다 — 설치한 뒤 다시 확인해 주세요.");
  }

  const version = input.executable ? await readClaudeVersion(input.executable) : null;
  const auth = input.executable
    ? await readAuthStatus(input.executable)
    : {
        loggedIn: false,
        authMethod: null,
        subscriptionType: null,
        email: null,
      };

  if (input.executable && !auth.loggedIn) {
    // 로그인 만료는 앱 안에서 풀린다: 이 문장으로 시작하는 줄에는 헤더가 다시
    // 로그인 버튼을 붙인다(Shell). 시작 문장을 바꾸면 그쪽도 함께.
    warnings.push("Claude Code 로그인이 필요합니다 — 다시 로그인하면 이어집니다.");
  }

  const gitAvailable = await isGitAvailable();
  if (!gitAvailable) {
    warnings.push(
      currentPlatform() === "win32"
        ? "git 이 없어 AI 가 파일을 찾고 명령을 내리는 데 제약이 있습니다 — Git for Windows 를 설치해 주세요."
        : "git 이 없어 파일 찾기가 .gitignore 를 따르지 않습니다 — git 을 설치해 주세요.",
    );
  }

  // pnpm's absence is the runtime onboarding gate's news, in Korean — an
  // English header warning here would say the same thing twice (PLAN D6).
  const pnpm = await resolvePnpmExecutable();
  const cdsRegistryAuth = await readCdsRegistryAuth(pnpm, input.registryProbeDir);
  if (cdsRegistryAuth === "unauthenticated") {
    warnings.push(
      "GitHub 패키지 저장소가 @colosseumcoinckr/cds 요청을 거절했습니다 — 설정의 개인 액세스 토큰(read:packages 권한)을 확인해 주세요.",
    );
  } else if (cdsRegistryAuth === "unknown" && pnpm && input.registryProbeDir) {
    warnings.push(
      "GitHub 패키지 저장소 접근을 확인하지 못했습니다 — 기기가 오프라인이거나 인증이 없으면 연결 레포의 설치가 실패합니다.",
    );
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    /** The app-authored block every session carries (read-only for users). */
    commonInstructions: COMMON_INSTRUCTIONS,
    platform: process.platform,
    claudeVersion: version,
    claudeExecutable: input.executable,
    gitAvailable,
    loggedIn: auth.loggedIn,
    authMethod: auth.authMethod,
    subscriptionType: auth.subscriptionType,
    email: auth.email,
    apiKeyInEnv,
    liveSessions: input.liveSessions,
    pendingPermissions: input.pendingPermissions,
    pnpmAvailable: Boolean(pnpm),
    cdsRegistryAuth,
    warnings,
  };
}

/**
 * File list for @-mention autocomplete.
 *
 * Prefers `git ls-files` because it is fast and already respects .gitignore,
 * which keeps node_modules and build output out of the picker. Directories
 * that are not repositories fall back to a bounded walk in Node, so nothing
 * here depends on a shell utility that exists on only one platform.
 */
const fileCache = new Map<string, { files: string[]; readAt: number }>();
const FILE_CACHE_TTL_MS = 15_000;
const WALK_FILE_LIMIT = 20_000;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".venv",
  "__pycache__",
]);

async function walk(root: string): Promise<string[]> {
  const found: string[] = [];
  const queue: string[] = [""];

  while (queue.length > 0 && found.length < WALK_FILE_LIMIT) {
    const relative = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = await readdir(join(root, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        queue.push(relative ? `${relative}/${entry.name}` : entry.name);
      } else if (entry.isFile()) {
        found.push(relative ? `${relative}/${entry.name}` : entry.name);
        if (found.length >= WALK_FILE_LIMIT) break;
      }
    }
  }
  return found;
}

export async function listFiles(cwd: string): Promise<string[]> {
  const cached = fileCache.get(cwd);
  if (cached && Date.now() - cached.readAt < FILE_CACHE_TTL_MS) return cached.files;
  if (!existsSync(cwd)) return [];

  let files: string[] = [];
  try {
    // GUI 로 띄워진 데몬의 PATH 에 git 이 없을 수 있다 — resolver 가 찾은 실행
    // 파일을 쓴다. 그림자 없는 "git" 은 walk 로 떨어지고, walk 는 .gitignore 를
    // 모른다(.env 가 @-목록에 새어 나온다).
    const git = (await resolveGitExecutable()) ?? "git";
    const { stdout } = await run(
      git,
      ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    // git always reports forward slashes, including on Windows.
    files = stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    files = await walk(cwd);
  }

  files.sort();
  fileCache.set(cwd, { files, readAt: Date.now() });
  return files;
}

/**
 * What `@` shows: a directory listing, not a flat dump of every path. An empty
 * query lists the root's own children, `dir/` lists that folder's, and anything
 * else falls back to the ranked substring search a planner typing a filename
 * expects. Folders come back with a trailing slash, so the caller can drill in.
 *
 * Dot-entries stay out of the listing: `.claude/`, `.npmrc` and friends mean
 * nothing to a planner picking a file to mention. Typing the name still finds them.
 */
export function browseFiles(files: string[], query: string, limit: number): string[] {
  if (query !== "" && !query.endsWith("/")) return filterFiles(files, query, limit);
  const directories = new Set<string>();
  const plain: string[] = [];
  for (const file of files) {
    if (!file.startsWith(query)) continue;
    const rest = file.slice(query.length);
    if (rest.startsWith(".")) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) plain.push(file);
    else directories.add(`${query}${rest.slice(0, slash)}/`);
  }
  return [...[...directories].sort(), ...plain.sort()].slice(0, limit);
}

/** Rank matches so a hit in the filename beats a hit deep in the path. */
export function filterFiles(files: string[], query: string, limit: number): string[] {
  if (!query) return files.slice(0, limit);
  const needle = query.toLowerCase();
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const index = lower.indexOf(needle);
    if (index === -1) continue;
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    const inName = base.includes(needle);
    scored.push({
      file,
      score: (inName ? 0 : 1000) + index + file.length / 1000,
    });
    if (scored.length > limit * 20) break;
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.file);
}
