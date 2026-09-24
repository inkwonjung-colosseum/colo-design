/**
 * 에이전트 설치 진행기 (1단계): Claude Code 와 Codex 의 설치를 데몬이 끝까지
 * 지켜본다. 옛 길(startClaudeInstall)은 설치 스크립트를 파이프로 흘려 받았다 —
 * 네트워크가 막혀 빈 입력을 받은 bash 가 종료 코드 0 을 내는 세계에서 실패를
 * 성공으로 셌다. 여기서는 스크립트를 파일로 받아 실행하고, 끝은 종료 코드와
 * 실행 파일의 실존이 함께 판정한다(0 인데 파일이 없으면 실패). 진행 줄과 끝은
 * 방송으로만 나간다(onboarding.install.progress · done). 관리자 권한은 한 줄도
 * 없다 — Claude 의 설치 스크립트도 Codex 의 내려받기도 사용자 홈 안에서 끝난다.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { AgentInstallKind } from "@colo-design/protocol";
import { resolveCodexExecutable } from "./agent/drivers/codex/driver.js";
import { COLO_DESIGN_DIR, resolveClaudeExecutable } from "./environment.js";
import type { SpawnLike } from "./onboarding.js";

/** 설치 전체의 시간 상한 — 넘으면 자식을 끊고 실패로 끝낸다. */
const INSTALL_TIMEOUT_MS = 15 * 60_000;
/** 설치 스크립트를 받는 시간 상한 — 파일로 받아야 실패 코드가 제대로 나온다. */
const SCRIPT_FETCH_TIMEOUT_MS = 30_000;
/** Codex 내려받기 진행 줄의 주기 — 5MB 마다 한 번. */
const DOWNLOAD_PROGRESS_BYTES = 5 * 1024 * 1024;
/** 진행 줄 방송의 최소 간격 — 1단계 실측에서 4 초에 19 번 나가는 것을 막는다. */
const PROGRESS_MIN_INTERVAL_MS = 1_000;

const CLAUDE_INSTALL_SH = "https://claude.ai/install.sh";
const CLAUDE_INSTALL_PS1 = "https://claude.ai/install.ps1";
const CODEX_RELEASE_API = "https://api.github.com/repos/openai/codex/releases/latest";

const ALREADY_RUNNING = "설치가 이미 진행 중입니다 — 잠시만 기다려 주세요.";
const CLAUDE_STARTED = "Claude Code 설치를 시작했습니다 — 진행 상황을 보여 드릴게요.";
const CODEX_STARTED = "Codex 설치를 시작했습니다 — 진행 상황을 보여 드릴게요.";
const INSTALL_TIMEOUT_DETAIL =
  "설치가 너무 오래 걸려 멈췄습니다 — 네트워크를 확인하고 다시 시도해 주세요.";
const MISSING_EXECUTABLE = "설치가 끝났지만 실행 파일을 찾지 못했습니다 — 다시 시도해 주세요.";
const NO_CODEX_ASSET = "이 컴퓨터에서는 Codex 를 설치할 수 없어요.";
const DIGEST_MISMATCH = "내려받은 파일을 확인하지 못했어요 — 다시 시도해 주세요.";

export interface AgentInstallEvents {
  onProgress(line: string): void;
  /**
   * 설치의 끝. ok 일 때 executable 은 성공 판정에 쓴 그 경로다 — claude 설치의
   * 몫이고(데몬이 시작 때 한 번 푼 경로를 갱신한다), codex 처럼 호출마다 푸는
   * 드라이버는 실리지 않는다.
   */
  onDone(ok: boolean, detail: string, executable?: string | null): void;
}

/** 시험 구멍 — env · 자식 실행 · 해석을 갈아 끼워 실제 설치 없이 검증한다. */
export interface AgentInstallDeps {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
  fetchLike?: typeof fetch;
  spawnLike?: SpawnLike;
  resolveClaude?: () => Promise<string | null>;
  resolveCodex?: () => Promise<string | null>;
  /** Codex 실행 파일이 내려앉는 자리 — 기본 ~/.colo-design/tools/bin. */
  toolsBinDir?: string;
  /** 전체 시간 상한(시험용 주입) — 기본 15 분. */
  timeoutMs?: number;
  /** 진행 줄 방송의 최소 간격(시험용 주입) — 기본 1 초(1단계 실측 보완). */
  progressIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// 진행 줄 다듬기 — 순수 함수
// ---------------------------------------------------------------------------

/** ANSI 이스케이프(색 이상의 CSI 전부)를 지운다. */
export function stripAnsiCodes(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI 이스케이프 시퀀스(\u001b[…m)를 벗기는 게 목적이다.
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/**
 * PATH 안내 문단의 표식들 — 앱은 절대 경로로 CLI 를 찾으므로 화면에 올리지
 * 않는다. 실측: mac 설치 스크립트가 이 문단을 두 번 내며, 머리 줄
 * `⚠ Setup notes:` 부터가 그 문단의 시작이다(1단계 실측 보완).
 */
const PATH_GUIDANCE_MARKERS = ["not in your path", "shell config", "export path", "setup notes"];

/**
 * 출력의 마지막 의미 있는 한 줄. ANSI 를 지우고, 빈 줄과 PATH 안내 문단을
 * 버린다. includePartialLastLine 이 false 면 줄이 완결된(개행까지 온) 것만
 * 본다 — 진행 방송이 미완의 마지막 줄을 두 번 울리지 않게 하는 소재.
 */
export function meaningfulInstallLine(
  output: string,
  includePartialLastLine = true,
): string | null {
  const complete = includePartialLastLine ? output : output.slice(0, output.lastIndexOf("\n") + 1);
  const lines = stripAnsiCodes(complete)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const meaningful = lines.filter((line) => {
    const low = line.toLowerCase();
    return !PATH_GUIDANCE_MARKERS.some((marker) => low.includes(marker));
  });
  return meaningful.at(-1) ?? null;
}

// ---------------------------------------------------------------------------
// 실패 분류 — 순수 함수
// ---------------------------------------------------------------------------

export type InstallFailureReason = "network" | "policy" | "disk" | "other";
export interface InstallFailure {
  reason: InstallFailureReason;
  detail: string;
}

/** curl 이 스스로 고백하는 네트워크 실패의 종료 코드(6 해석 실패 · 7 연결 · 28 시간초과). */
const CURL_NETWORK_EXIT_CODES = new Set([6, 7, 28]);
const NETWORK_MARKERS = [
  "could not resolve",
  "failed to connect",
  "failed to get latest version",
  "unable to connect",
  "the remote name could not be resolved",
  "timed out",
];
const POLICY_MARKERS = [
  "running scripts is disabled",
  "executionpolicy",
  "constrainedlanguage",
  "access is denied",
  "is blocked",
  "applocker",
];
const DISK_MARKERS = ["no space left", "not enough space", "enospc"];

/** IT 담당자에게 그대로 보낼 복사용 한 줄 — policy 분류의 detail 뒤에 붙는다. */
const POLICY_COPY_LINE =
  "Colo Design 이 Claude Code 를 사용자 폴더에 설치하려고 합니다(https://claude.ai/install.ps1 또는 install.sh). 이 설치를 허용해 주세요.";

/**
 * 설치 실패를 네 가지로 나눠 한국어 문장을 만든다. platform 은 curl 종료 코드의
 * 해석에만 쓴다 — PowerShell 은 같은 숫자를 다른 뜻으로 쓰므로 win32 에서는
 * 문장만 본다.
 */
export function classifyInstallFailure(
  output: string,
  exitCode: number | null,
  platform: string,
): InstallFailure {
  const text = output.toLowerCase();
  if (
    (platform !== "win32" && exitCode !== null && CURL_NETWORK_EXIT_CODES.has(exitCode)) ||
    NETWORK_MARKERS.some((marker) => text.includes(marker))
  ) {
    return { reason: "network", detail: "인터넷 연결을 확인한 뒤 다시 시도해 주세요." };
  }
  if (
    POLICY_MARKERS.some((marker) => text.includes(marker)) ||
    /\b403\b/.test(text) ||
    text.includes("forbidden")
  ) {
    return {
      reason: "policy",
      detail: `회사 PC 정책이 설치를 막은 것 같아요. 아래 문장을 IT 담당자에게 보내 주세요.\n${POLICY_COPY_LINE}`,
    };
  }
  if (DISK_MARKERS.some((marker) => text.includes(marker))) {
    return {
      reason: "disk",
      detail: "디스크 공간이 부족해요 — 공간을 비운 뒤 다시 시도해 주세요.",
    };
  }
  const last = meaningfulInstallLine(output);
  return {
    reason: "other",
    detail: last
      ? `설치가 실패했어요 — 다시 시도해 주세요.\n${last.slice(0, 200)}`
      : "설치가 실패했어요 — 다시 시도해 주세요.",
  };
}

/** fetch 실패의 즉답 — classify 의 network 판정 그대로(문장의 둘째 근거지). */
const NETWORK_FAILURE: InstallFailure = classifyInstallFailure("", null, "darwin");

// ---------------------------------------------------------------------------
// Codex 자산 선택 · digest 검증 — 순수 함수
// ---------------------------------------------------------------------------

export interface CodexReleaseAsset {
  name: string;
  browser_download_url: string;
  /** GitHub releases 가 자산마다 실어 주는 "sha256:<hex>". */
  digest?: string;
  size?: number;
}

/** 플랫폼/칩 조합 → 자산 이름. small static string-keyed lookup. */
const CODEX_ASSET_NAMES: Record<string, string> = {
  "darwin-arm64": "codex-aarch64-apple-darwin.tar.gz",
  "darwin-x64": "codex-x86_64-apple-darwin.tar.gz",
  "win32-x64": "codex-x86_64-pc-windows-msvc.exe.zip",
  "win32-arm64": "codex-aarch64-pc-windows-msvc.exe.zip",
};

/** 이 기계가 내려받아야 할 자산 — 목록에 없으면 null(설치 불가). */
export function codexAssetFor(
  platform: string,
  arch: string,
  assets: CodexReleaseAsset[],
): CodexReleaseAsset | null {
  const name = CODEX_ASSET_NAMES[`${platform}-${arch}`];
  if (!name) return null;
  return assets.find((asset) => asset?.name === name) ?? null;
}

/** digest 가 없거나 다르면 false — 있어야 설치가 계속된다. */
export function verifyDigest(expected: string | undefined, hex: string): boolean {
  if (!expected) return false;
  const want = expected.startsWith("sha256:") ? expected.slice("sha256:".length) : expected;
  return want.length === 64 && want.toLowerCase() === hex.toLowerCase();
}

// ---------------------------------------------------------------------------
// 자식 실행 — 진행 줄을 뽑으며 끝을 기다린다
// ---------------------------------------------------------------------------

interface ChildOutcome {
  exitCode: number | null;
  output: string;
}

/**
 * stdio 파이프로 자식을 띄워 끝까지 지켜본다. 완결된 줄의 마지막 의미 있는
 * 한 줄이 바뀔 때만 onLine 을 부른다(같은 줄의 반복은 다시 보내지 않는다).
 */
function runInstallChild(
  spawnLike: SpawnLike,
  command: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; signal: AbortSignal; onLine?: (line: string) => void },
): Promise<ChildOutcome> {
  const { promise, resolve: resolveRun } = Promise.withResolvers<ChildOutcome>();
  let child: ReturnType<SpawnLike>;
  try {
    child = spawnLike(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: opts.env,
      signal: opts.signal,
    });
  } catch (error) {
    resolveRun({ exitCode: null, output: String(error) });
    return promise;
  }
  let output = "";
  let lastLine: string | null = null;
  const feed = (chunk: Buffer | string) => {
    output += String(chunk);
    const line = meaningfulInstallLine(output, false);
    if (line && line !== lastLine) {
      lastLine = line;
      opts.onLine?.(line);
    }
  };
  child.stdout?.on("data", feed);
  child.stderr?.on("data", feed);
  child.once("error", (error: Error) => {
    resolveRun({ exitCode: null, output: `${output}${output ? "\n" : ""}${String(error)}` });
  });
  child.once("close", (code) => resolveRun({ exitCode: code, output }));
  return promise;
}

// ---------------------------------------------------------------------------
// 설치 진행기 — 종류마다 하나씩만 돈다
// ---------------------------------------------------------------------------

interface InstallFlowContext {
  env: NodeJS.ProcessEnv;
  platform: string;
  arch: string;
  fetchLike: typeof fetch;
  spawnLike: SpawnLike;
  toolsBinDir: string;
  signal: AbortSignal;
  progress(line: string, force?: boolean): void;
}

export class AgentInstall {
  private readonly running = new Map<AgentInstallKind, { cancel(): void }>();

  constructor(private readonly deps: AgentInstallDeps = {}) {}

  isRunning(kind: AgentInstallKind): boolean {
    return this.running.has(kind);
  }

  start(
    kind: AgentInstallKind,
    events: AgentInstallEvents,
  ): { started: boolean; guidance: string } {
    if (this.running.has(kind)) return { started: false, guidance: ALREADY_RUNNING };
    const controller = new AbortController();
    let cancelled = false;
    // 진행 줄의 방송은 1 초에 한 번 이하(1단계 실측 보완): 그 사이 온 줄은
    // 마지막 것만 기억해 두었다가 간격이 차면 나간다. force 줄(내려받기의
    // 마지막 100% · 확인·설치 한 줄)은 스로틀을 건너뛴다 — 잘리면 안 된다.
    const intervalMs = this.deps.progressIntervalMs ?? PROGRESS_MIN_INTERVAL_MS;
    let lastSentAt = 0;
    let pendingLine: string | null = null;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    const dropPending = () => {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      pendingLine = null;
    };
    const flushPending = () => {
      if (cancelled) {
        dropPending();
        return;
      }
      const line = pendingLine;
      dropPending();
      if (line) {
        lastSentAt = Date.now();
        events.onProgress(line);
      }
    };
    const ctx: InstallFlowContext = {
      env: this.deps.env ?? process.env,
      platform: this.deps.platform ?? process.platform,
      arch: this.deps.arch ?? process.arch,
      fetchLike: this.deps.fetchLike ?? fetch,
      spawnLike: this.deps.spawnLike ?? spawn,
      // Codex 가 내려앉는 자리 — 드라이버의 탐색 후보 맨 앞이 같은 경로를 본다.
      toolsBinDir: this.deps.toolsBinDir ?? join(COLO_DESIGN_DIR, "tools", "bin"),
      signal: controller.signal,
      progress: (line, force = false) => {
        if (cancelled || !line) return;
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
        if (force || Date.now() - lastSentAt >= intervalMs) {
          pendingLine = null;
          lastSentAt = Date.now();
          events.onProgress(line);
          return;
        }
        pendingLine = line;
        pendingTimer = setTimeout(() => flushPending(), intervalMs - (Date.now() - lastSentAt));
        pendingTimer.unref?.();
      },
    };
    const entry = {
      cancel: () => {
        cancelled = true;
        dropPending();
        controller.abort();
      },
    };
    this.running.set(kind, entry);
    const timer = setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      dropPending();
      controller.abort();
      this.running.delete(kind);
      events.onDone(false, INSTALL_TIMEOUT_DETAIL);
    }, this.deps.timeoutMs ?? INSTALL_TIMEOUT_MS);
    timer.unref?.();
    const finish = (ok: boolean, detail: string, executable?: string | null) => {
      clearTimeout(timer);
      if (cancelled) return;
      // 끝의 문장보다 먼저, 스로틀에 붙들린 마지막 진행 줄을 내보낸다.
      flushPending();
      if (cancelled) return;
      this.running.delete(kind);
      events.onDone(ok, detail, executable);
    };
    const flow = kind === "install-claude" ? this.installClaude(ctx) : this.installCodex(ctx);
    void flow.then(
      (result) => finish(result.ok, result.detail, result.executable),
      (error) => finish(false, classifyInstallFailure(String(error), null, ctx.platform).detail),
    );
    return {
      started: true,
      guidance: kind === "install-claude" ? CLAUDE_STARTED : CODEX_STARTED,
    };
  }

  /** 진행 중인 설치를 모두 끊는다 — 재시작의 앞단계와 데몬 종료가 부른다. */
  stop(): void {
    for (const entry of this.running.values()) entry.cancel();
    this.running.clear();
  }

  // -------------------------------------------------------------------
  // Claude Code — 설치 스크립트를 파일로 받아 실행한다
  // -------------------------------------------------------------------

  private async installClaude(
    ctx: InstallFlowContext,
  ): Promise<{ ok: boolean; detail: string; executable?: string | null }> {
    // 시험용 대체: 스크립트 대신 이 명령을 셸로 실행한다(검수자가 성공·실패·
    // 느린 진행을 흉내 낸다). 실기 실행에서는 비어 있다.
    const override = ctx.env.COLO_DESIGN_CLAUDE_INSTALL_CMD;
    let scriptPath: string | null = null;
    let command: string;
    let args: string[];
    if (override) {
      [command, args] =
        ctx.platform === "win32"
          ? ["powershell", ["-NoProfile", "-Command", override]]
          : ["sh", ["-c", override]];
    } else {
      const url = ctx.platform === "win32" ? CLAUDE_INSTALL_PS1 : CLAUDE_INSTALL_SH;
      let script: string;
      try {
        script = await fetchText(url, ctx);
      } catch {
        // fetch 실패는 곧바로 네트워크 실패 — 자식을 띄우지 않는다.
        return { ok: false, detail: NETWORK_FAILURE.detail };
      }
      // 빈 몸통을 받은 bash 는 0 으로 정상 종료한다 — 실패를 성공으로 세는 옛
      // 함정이므로 역시 시작하지 않는다.
      if (script.trim().length === 0) return { ok: false, detail: NETWORK_FAILURE.detail };
      const ext = ctx.platform === "win32" ? "ps1" : "sh";
      scriptPath = join(
        tmpdir(),
        `colo-claude-install-${process.pid}-${Math.random().toString(36).slice(2)}.${ext}`,
      );
      await writeFile(scriptPath, script, "utf8");
      // 정책 우회(-ExecutionPolicy Bypass)는 이 프로세스의 이 실행 범위만 —
      // 관리자도 시스템 설정도 필요 없다.
      command = ctx.platform === "win32" ? "powershell" : "bash";
      args =
        ctx.platform === "win32"
          ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath]
          : [scriptPath];
    }
    try {
      const outcome = await runInstallChild(ctx.spawnLike, command, args, {
        env: ctx.env,
        signal: ctx.signal,
        onLine: ctx.progress,
      });
      if (outcome.exitCode !== 0) {
        return {
          ok: false,
          detail: classifyInstallFailure(outcome.output, outcome.exitCode, ctx.platform).detail,
        };
      }
      // 성공 판정에 쓴 경로를 그대로 흘려 보낸다 — 데몬이 시작 때 푼 경로를
      // 이 값으로 갱신해야 로그인 버튼이 방금 설치한 CLI 를 안다.
      const executable = await (this.deps.resolveClaude ?? resolveClaudeExecutable)();
      return executable
        ? { ok: true, detail: "Claude Code 설치가 완료되었습니다.", executable }
        : { ok: false, detail: MISSING_EXECUTABLE };
    } finally {
      if (scriptPath) await rm(scriptPath, { force: true }).catch(() => undefined);
    }
  }
  // -------------------------------------------------------------------
  // Codex — 최신 릴리스 자산을 골라 내려받고 확인해서 tools/bin 에 둔다
  // -------------------------------------------------------------------

  private async installCodex(
    ctx: InstallFlowContext,
  ): Promise<{ ok: boolean; detail: string; executable?: string | null }> {
    // 시험용 대체: 이 주소를 릴리스 API 로 쓴다(로컬 서버가 JSON 을 내어 준다).
    const api = ctx.env.COLO_DESIGN_CODEX_RELEASE_API ?? CODEX_RELEASE_API;
    const response = await ctx
      .fetchLike(api, {
        headers: { accept: "application/vnd.github+json", "user-agent": "colo-design" },
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(SCRIPT_FETCH_TIMEOUT_MS)]),
      })
      .catch(() => null);
    if (!response?.ok) return { ok: false, detail: NETWORK_FAILURE.detail };
    const release = (await response.json()) as { assets?: CodexReleaseAsset[] };
    const asset = codexAssetFor(ctx.platform, ctx.arch, release.assets ?? []);
    if (!asset) return { ok: false, detail: NO_CODEX_ASSET };

    const workDir = await mkdtemp(join(tmpdir(), "colo-codex-"));
    try {
      const archivePath = join(workDir, asset.name);
      let hex: string;
      try {
        hex = await downloadAsset(asset, archivePath, ctx);
      } catch {
        return { ok: false, detail: NETWORK_FAILURE.detail };
      }
      // 내려받기 뒤의 두 장면 — 확인(해시)과 설치(해제·이동)의 한 줄씩.
      // 스로틀에 잘리면 안 되므로 force 로 나간다(1단계 실측 보완).
      ctx.progress("Codex 확인하는 중…", true);
      if (!verifyDigest(asset.digest, hex)) return { ok: false, detail: DIGEST_MISMATCH };

      ctx.progress("Codex 설치하는 중…", true);
      // 두 OS 모두 tar 로 연다 — Windows 10+ 의 tar.exe 는 zip 도 푼다.
      const extractDir = join(workDir, "extracted");
      await mkdir(extractDir, { recursive: true });
      const outcome = await runInstallChild(
        ctx.spawnLike,
        "tar",
        ["-xf", archivePath, "-C", extractDir],
        { env: ctx.env, signal: ctx.signal },
      );
      if (outcome.exitCode !== 0) {
        return {
          ok: false,
          detail: classifyInstallFailure(outcome.output, outcome.exitCode, ctx.platform).detail,
        };
      }

      // 압축 안의 실행 파일 이름은 자산 이름에서 압축 확장자를 뗀 것 — codex 로
      // 이름을 바꿔 tools/bin 에 둔다.
      const innerName = asset.name.replace(/\.(tar\.gz|zip)$/, "");
      const executableName = ctx.platform === "win32" ? "codex.exe" : "codex";
      const destination = join(ctx.toolsBinDir, executableName);
      await mkdir(ctx.toolsBinDir, { recursive: true });
      await moveFile(join(extractDir, innerName), destination);
      if (ctx.platform === "darwin") await chmod(destination, 0o755);

      const executable = await (this.deps.resolveCodex ?? (async () => resolveCodexExecutable()))();
      return executable
        ? { ok: true, detail: "Codex 설치가 완료되었습니다." }
        : { ok: false, detail: MISSING_EXECUTABLE };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** 설치 스크립트 받기 — 실패는 곧바로 네트워크 실패다. */
async function fetchText(url: string, ctx: InstallFlowContext): Promise<string> {
  const response = await ctx
    .fetchLike(url, {
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(SCRIPT_FETCH_TIMEOUT_MS)]),
    })
    .catch(() => null);
  if (!response?.ok) throw new Error("network");
  return await response.text();
}

/** 자산을 내려받으며 sha256 을 센다 — 진행 줄은 5MB 마다 한 번. */
async function downloadAsset(
  asset: CodexReleaseAsset,
  archivePath: string,
  ctx: InstallFlowContext,
): Promise<string> {
  const response = await ctx
    .fetchLike(asset.browser_download_url, { signal: ctx.signal })
    .catch(() => null);
  if (!response?.ok || !response.body) throw new Error("network");
  const hash = createHash("sha256");
  let bytes = 0;
  let bucket = -1;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      const now = Math.floor(bytes / DOWNLOAD_PROGRESS_BYTES);
      if (now > bucket) {
        bucket = now;
        const done = `${Math.floor(bytes / (1024 * 1024))} MB`;
        ctx.progress(
          asset.size
            ? `Codex 내려받는 중 ${done} / ${Math.floor(asset.size / (1024 * 1024))} MB`
            : `Codex 내려받는 중 ${done}`,
        );
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as unknown as NodeWebReadableStream),
    counter,
    createWriteStream(archivePath),
  );
  // 마지막(100%) 줄은 반드시 나간다 — 스로틀의 5MB 경계에 딱 맞지 않아도
  // 끝났다는 사실이 먼저 보여야 한다(force).
  if (asset.size) {
    const total = `${Math.floor(asset.size / (1024 * 1024))} MB`;
    ctx.progress(`Codex 내려받는 중 ${total} / ${total}`, true);
  }
  return hash.digest("hex");
}

/** 같은 볼륨이면 이름 바꾸기, 아니면 복사 — tmp 와 홈이 갈라진 기계를 위한 길. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch {
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}
