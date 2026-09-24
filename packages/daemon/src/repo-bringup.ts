// Bring-up: clone → config → install → preview. Owns the preview
// process itself (startPreview/killPreview), plus the install short-circuit
// and the bring-up error taxonomy.
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { RepoErrorKind, RepoStatus } from "@colo-design/protocol";
import { extraPathPrefix, sanitizeRepoAgentSettings, trustWorkspace } from "./claude-trust.js";
import { mergeNpmrc, npmrcPath } from "./credentials.js";
import {
  currentPlatform,
  detectsRegistryAuthFailure,
  resolvePnpmExecutable,
} from "./environment.js";
import {
  daemonOwnedPorts,
  descendantPids,
  killPidTree,
  killTree,
  pidCommandLine,
  pidListeningPorts,
  probePreviewUrl,
} from "./preview-claim.js";
import {
  PREVIEW_COMMAND_UNKNOWN,
  type RepoConfig,
  resolveRepoConfig,
  scopeOf,
} from "./repo-config.js";
import {
  COMMAND_STALL_MS,
  COMMANDS_UNAPPROVED_DETAIL,
  detailOf,
  GATE_OUTPUT_TAIL_LINES,
  INSTALL_MARKER,
  PNPM_MISSING_DETAIL,
  PreviewPortUndetectedError,
  READY_TIMEOUT_MS,
  RECOVER_CONFLICT_DETAIL,
  REFRESH_CONFLICT_DETAIL,
  REGISTRY_AUTH_DETAIL,
  REPO_URL_MISSING_DETAIL,
  type RepoCore,
  redact,
} from "./repo-core.js";

export class BringUp {
  constructor(private readonly core: RepoCore) {}

  /** C5: 서버가 저절로 꺼졌을 때 남은 저절로 다시 켜기 시도 수. */
  private previewRestarts = 0;

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  async bootstrap(): Promise<RepoStatus> {
    try {
      if (!this.core.url) {
        this.core.setPhase("missing", REPO_URL_MISSING_DETAIL);
        return this.core.snapshot();
      }

      if (!this.core.isCloned()) {
        await this.killPreview();
        this.core.setPhase("cloning", null);
        this.clearBringUpDebris();
        // The clean url: the PAT travels in the environment (gitAuthEnv),
        // so neither `.git/config` nor `ps` ever sees it.
        // clone 만 차선에 태운다(PLAN L1) — bootstrap 전체가 줄을 잡으면
        // 설치와 미리보기 기동이 몇 분씩 다른 git 손을 막는다.
        const cloneArgs = ["clone", this.core.url, this.core.root];
        await this.core.lane.run("hygiene", () =>
          this.core.git(cloneArgs, dirname(this.core.root)),
        );
        trustWorkspace(this.core.root);
        sanitizeRepoAgentSettings(this.core.root);
      } else {
        this.core.setPhase("pulling", null);
        await this.core.scrubOriginCredential();
        // Already cloned: 최신화, not a blind ff. Unsaved work survives the
        // move off-cycle, and a conflict left by an earlier run resurfaces
        // with its Korean reason instead of a raw git error.
        await this.core.refreshFromRemote();
        // 원격이 .claude/settings.json 을 갱신해 권한 확장이 돌아왔을 수
        // 있다 — 클론 길에서와 같은 칼을 다시 댄다(이미 깨끗하면 무동작).
        sanitizeRepoAgentSettings(this.core.root);
      }

      // 설정이 못 읽는 것(명령 없음 · 깨진 JSON)은 그대로 오류 카드로 —
      // AI 에게 해결 요청이 이 레포를 고치는 길이다.
      const config = resolveRepoConfig(this.core.root);
      this.core.config = config;
      // The one gate the wire cannot skip: a repo nobody has vouched for
      // stops here, after the clone but before any command it declares runs.
      // 저장's check and 넘기기's build wait behind a planner's button press
      // already — install and preview are the ones that run unattended.
      // The verdict names WHAT runs: the approval is one button, so the card
      // must show the sentences it is about to execute — the planner reads the
      // verdict, a reviewer reads the evidence.
      if (!this.core.commandsApproved) {
        throw new Error(
          `${COMMANDS_UNAPPROVED_DETAIL} 실행하려는 명령 — 설치: ${config.install ?? "(선언되지 않음)"} · 미리보기: ${config.preview.command}`,
        );
      }
      // The switch race's fence: a bring-up this project no longer owns
      // stops here — install and preview are the unattended side effects,
      // and a late finisher would otherwise kill the port the project the
      // planner switched TO just started serving on.
      if (!this.core.active) return this.core.snapshot();
      const installed = await this.installIfNeeded(config);

      /**
       * Count once the clone is on disk and checked out. Without this the
       * chip reads zero after every restart — the count only moves on a
       * 화면 turn otherwise, and a planner who closed the app mid-cycle would
       * come back to a rail that says there is nothing to save.
       */
      await this.core.refreshPendingChanges();

      // Up to date and still serving: restarting the preview would only flip
      // the UI out of `ready` for no gain.
      if (!installed && this.core.preview && (await this.isServing())) {
        this.core.setPhase("ready", null);
        return this.core.snapshot();
      }
      await this.startPreview(config);
      this.core.setPhase("ready", null);
    } catch (error) {
      this.core.setPhase("error", detailOf(error, this.core.pat), this.bringUpErrorKind(error));
    }
    return this.core.snapshot();
  }

  /**
   * A bring-up that died between creating the folder and finishing the clone
   * leaves the root with files but no `.git` — every later sync reads it as
   * uncloned, and `git clone` refuses a non-empty destination (128) until a
   * human deletes the folder by hand. Everything in it is a partial copy of
   * the remote, so clearing it is a re-clone, not a loss (the same trade the
   * url move already makes). A real clone has `.git` and is never touched.
   */
  private clearBringUpDebris(): void {
    if (this.core.isCloned() || !existsSync(this.core.root)) return;
    rmSync(this.core.root, { recursive: true, force: true });
  }

  /** True when the declared install already ran for the current lockfiles. */
  installUpToDate(): boolean {
    const config = this.core.repoConfig();
    if (!config?.install) return true;
    if (!existsSync(join(this.core.root, "node_modules"))) return false;
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
  private async installIfNeeded(config: RepoConfig): Promise<boolean> {
    if (!config.install) return false;
    if (!this.dependenciesMoved()) return false;

    this.core.setPhase("installing", null);
    // The repo declares its private registry; the daemon holds the PAT. The
    // credential goes ONLY into the user-level npmrc — the clone's tree is
    // committed and pushed, so a clone-level .npmrc would publish the PAT.
    if (config.registry && this.core.pat) {
      mergeNpmrc(npmrcPath(), [
        {
          key: `${scopeOf(config.registry)}:registry`,
          value: `https://${config.registry.host}/`,
        },
        { key: `//${config.registry.host}/:_authToken`, value: this.core.pat },
      ]);
    }
    await this.runCommand(config.install, "install");
    writeFileSync(join(this.core.root, ".git", INSTALL_MARKER), this.dependencyHash());
    return true;
  }

  private dependencyHash(): string {
    return dependencyHash(this.core.root);
  }

  dependenciesMoved(): boolean {
    const marker = join(this.core.root, ".git", INSTALL_MARKER);
    if (!existsSync(marker)) return true;
    try {
      return readFileSync(marker, "utf8") !== this.dependencyHash();
    } catch {
      return true;
    }
  }

  private async runCommand(command: string, label: string): Promise<void> {
    await this.requirePnpmIfReferenced(command);
    // 다섯 분을 기다리는 검사는 검사가 아니다 — `COLO_DESIGN_COMMAND_STALL_MS`
    // 가 e2e 를 초 단위로 그 문 앞에 세운다.
    const stall = Number(process.env.COLO_DESIGN_COMMAND_STALL_MS) || COMMAND_STALL_MS;
    const result = await this.core.capture(command, this.spawnOptions(), [], stall);
    if (result.code === 0) return;
    if (result.stalled) {
      const waited =
        stall < 60_000 ? `${Math.round(stall / 1000)}초` : `${Math.round(stall / 60_000)}분`;
      throw new Error(
        redact(
          `${label} 명령이 ${waited} 동안 아무 말도 하지 않아 중단했습니다 — 네트워크나 패키지 저장소가 응답하지 않는 것으로 보입니다.\n마지막으로 한 말: ${result.lastLine || "(없음)"}`,
          this.core.pat,
        ),
      );
    }
    if (detectsRegistryAuthFailure(result.output)) throw new Error(REGISTRY_AUTH_DETAIL);
    // The tail, not just the last line: a gate failure is handed to the agent,
    // whose fix starts where the first error line points.
    const tail = result.output
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-GATE_OUTPUT_TAIL_LINES)
      .join("\n");
    throw new Error(
      redact(`${label} 명령이 실패했습니다 (exit ${result.code})\n${tail}`, this.core.pat),
    );
  }

  /** A colo-design command may or may not need pnpm; only demand it when it does. */
  private async requirePnpmIfReferenced(command: string): Promise<void> {
    if (!/\bpnpm\b/.test(command)) return;
    if (!(await resolvePnpmExecutable())) throw new Error(PNPM_MISSING_DETAIL);
  }

  // -------------------------------------------------------------------------
  // Preview server
  // -------------------------------------------------------------------------
  private async startPreview(config: RepoConfig): Promise<void> {
    // Second fence, closer to the metal: the window between bootstrap's gate
    // and this spawn is exactly where a fast B→C switch lands. An inactive
    // project must not START a server of its own past the switch (the one it
    // already has stays warm — the server's switch fence decides that one).
    if (!this.core.active) return;
    await this.killPreview();
    await this.reclaimStalePreview();
    this.core.setPhase("starting", null);
    const { command } = config.preview;
    await this.requirePnpmIfReferenced(command);

    // The dev server picks its own free port and the verdict below reads
    // where it landed — first the address the server printed, then the
    // process tree's LISTEN sockets.
    const child = spawn(command, this.spawnOptions());
    this.core.preview = child;
    this.core.previewEpoch += 1;
    // 다음 생의 bring-up 이 이 트리를 거둘 수 있게 — .git 아래는 워크트리를
    // 더럽히지 않는다. 동기 쓰기: 스폰 직후의 hard-die 도 기록을 남기게.
    if (child.pid) {
      try {
        writeFileSync(join(this.core.root, ".git", "colo-design-preview.pid"), String(child.pid));
      } catch {
        // 기록에 실패해도 서버는 뜬다 — 좀비 정리만 다음 기회로 넘어간다.
      }
    }
    /** Last output line, so an exit can quote what the command actually said. */
    let lastLine: string | null = null;
    /** The recent output tail — a failed detection quotes it as evidence. */
    const tail: string[] = [];
    /** URLs the server printed, normalized to loopback — the detection's first candidates. */
    const urlCandidates = new Set<string>();
    const absorb = (chunk: Buffer) => {
      for (const raw of String(chunk).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        lastLine = line;
        tail.push(line);
        if (tail.length > GATE_OUTPUT_TAIL_LINES) tail.shift();
        const candidate = previewUrlCandidate(line);
        if (candidate) urlCandidates.add(candidate);
      }
      if (lastLine) this.core.setProgressLine(lastLine);
    };
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);

    child.once("exit", (code, signal) => {
      if (this.core.preview !== child) return; // stop() already took it down
      this.core.preview = null;
      this.core.previewUrl = null;
      const how = signal ? `signal ${signal}` : `exit ${code}`;
      // The command's own last line is what says WHY; an exit code alone
      // sends the planner to a terminal they were promised they would not need.
      const detail = lastLine
        ? `미리보기 서버가 종료되었습니다 (${how}) — ${lastLine}`
        : `미리보기 서버가 종료되었습니다 (${how})`;
      // C5: 사람보다 도구가 먼저 다시 켠다 — 카드는 재시도 문장으로 말하고,
      // 다 못 켤 때 비로소 실패 문장이 선다(그때부터는 D4 가 대화로 넘긴다).
      void this.restartPreview(detail);
    });

    try {
      this.core.previewUrl = await this.detectPreviewUrl(child, urlCandidates, tail);
      // 살아 남은 서버 — 다음 죽음은 다시 두 번의 기회를 가진다.
      this.previewRestarts = 0;
    } catch (error) {
      // 늦게라도 뜰 예정이던 서버를 죽은 것으로 선고한 채 두면, 실제로는 살아
      // 포트를 쥔 유령이 남는다 (실사 목격). 선고가 서면 서버도 내려야 한다.
      await this.killPreview();
      throw error;
    }
  }

  /**
   * 준비 판정: 서버가 찍은 URL 을 먼저 믿고, 출력이 없으면 프로세스 트리의
   * LISTEN 소켓에서 찾는다. HTML 응답이 곧 미리보기다 — API 전용 포트가 함께
   * 뜨는 레포에서도 화면을 서는 쪽을 고른다. 끝까지 못 찾으면
   * port-undetected 로 던져 AI 가 서버 출력을 고치게 한다.
   */
  private async detectPreviewUrl(
    child: ChildProcess,
    urlCandidates: Set<string>,
    tail: string[],
  ): Promise<string> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    /** 후보별 마지막 시도 — 한 번의 null 은 "죽음"이 아니라 "아직"이다. */
    const probedAt = new Map<string, number>();
    const scannedAt = new Map<number, number>();
    /**
     * 실패 판정의 재시도 간격 — 매 틱 다시 찌르지 않되, 영구 제외도 하지 않는다.
     * 출력된 주소는 틱 간격(250ms)으로 다시 보고, 소켓 스캔은 2초로 늦춘다 —
     * 서버가 찍은 주소가 스캔보다 이기는 것이 이 판정의 우선순위다.
     */
    const CANDIDATE_RETRY_MS = 250;
    const SCAN_RETRY_MS = 2_000;
    /** HTML 이 아니어도 응답한 첫 포트 — 더 나은 후보가 없을 때의 답. */
    let fallback: string | null = null;
    while (Date.now() < deadline) {
      if (this.core.preview !== child) {
        throw new Error(this.core.detail ?? "미리보기 서버가 시작되지 않았습니다");
      }
      for (const candidate of urlCandidates) {
        // A printed loopback URL is probed on BOTH families — the server may
        // say `localhost` while binding [::1] alone, and normalizing to
        // 127.0.0.1 would probe a dead address (the port-undetected 실사).
        for (const url of loopbackUrlVariants(candidate)) {
          // URL 을 찍은 뒤 바인드·응답 준비까지의 창이 있다 — 한 번의 null 로
          // 후보를 영구 제외하면 준비 느린 서버는 죽는다.
          const seen = probedAt.get(url);
          if (seen !== undefined && Date.now() - seen < CANDIDATE_RETRY_MS) continue;
          probedAt.set(url, Date.now());
          if ((await probePreviewUrl(url)) !== null) return url;
        }
      }
      const pids = [...(child.pid ? [child.pid] : []), ...(await descendantPids(child.pid ?? -1))];
      // 데몬 자신의 포트는 제외한다 — 자식들이 fd 로 물려받은 이 리스너가
      // lsof 에 자기 소켓처럼 보여, 서버 출력이 없을 때 도구의 웹 UI 를
      // 미리보기로 판정하는 사고(CI 러너 실측 2026-09-21)를 닫는다.
      const ports = (await pidListeningPorts(pids)).filter((port) => !daemonOwnedPorts.has(port));
      for (const port of ports) {
        // 소켓 스캔도 같은 규율: LISTEN 이 떴어도 HTTP 응답 전의 포트는
        // 첫 스캔에서 null 이고, 그렇다고 영구 제외하면 영원히 못 찾는다.
        const seen = scannedAt.get(port);
        if (seen !== undefined && Date.now() - seen < SCAN_RETRY_MS) continue;
        scannedAt.set(port, Date.now());
        for (const scheme of ["http", "https"] as const) {
          for (const host of ["127.0.0.1", "[::1]"] as const) {
            const url = `${scheme}://${host}:${port}/`;
            const verdict = await probePreviewUrl(url);
            if (verdict === "html") {
              // The scan only names the port — when the server's own output
              // already named it too, the printed spelling wins (URL 을 먼저
              // 믿는다).
              for (const candidate of urlCandidates) {
                if (new URL(candidate).port === String(port)) {
                  if ((await probePreviewUrl(candidate)) !== null) return candidate;
                }
              }
              return url;
            }
            if (verdict === "ok" && fallback === null) fallback = url;
          }
        }
      }
      await sleep(250);
    }
    if (fallback !== null) return fallback;
    throw new PreviewPortUndetectedError(
      `미리보기 서버는 시작됐지만 어느 주소에서 듣는지 찾지 못했습니다 — ` +
        `서버가 뜬 주소를 출력하게 해 주세요 (예: \`Local: http://localhost:PORT\`).` +
        (tail.length > 0 ? `\n마지막 출력:\n${tail.slice(-10).join("\n")}` : ""),
    );
  }

  /** Ready means the port is open *and* the app answers, not just listening. */
  private async isServing(): Promise<boolean> {
    const url = this.core.previewUrl;
    if (url === null) return false;
    return (await probePreviewUrl(url)) !== null;
  }

  async killPreview(): Promise<void> {
    const child = this.core.preview;
    if (!child) return;
    this.core.preview = null;
    this.core.previewUrl = null;

    const { promise: exited, resolve } = Promise.withResolvers<void>();
    child.once("exit", () => resolve());
    killTree(child, "SIGTERM");
    const hard = setTimeout(() => killTree(child, "SIGKILL"), 3_000);
    await exited;
    clearTimeout(hard);
  }

  /**
   * 데몬이 hard-die 하면 detached 미리보기 트리는 살아 남아 포트를 계속 쥔다
   * — 손에 핸들이 없는 다음 생의 killPreview 는 그 좀비를 못 거둔다 (실사:
   * 오래된 next dev 가 3000 을 쥔 채 새 서버가 엉뚱한 포트로 새는 꼴). 마지막
   * spawn 의 pid 기록(.git 아래 — 워크트리를 더럽히지 않는다)이 가리키는
   * 트리의 명령줄이 이 클론을 말하면 우리 것임이 확실하므로 거둔다. Windows 는
   * 명령줄 앵커가 없어 보수적으로 건너뛴다.
   */
  private async reclaimStalePreview(): Promise<void> {
    if (currentPlatform() === "win32") return;
    const pidFile = join(this.core.root, ".git", "colo-design-preview.pid");
    let recorded = 0;
    try {
      recorded = Number(readFileSync(pidFile, "utf8").trim());
    } catch {
      return;
    }
    if (!Number.isInteger(recorded) || recorded <= 1) return;
    const tree = [recorded, ...(await descendantPids(recorded).catch(() => []))];
    const lines = await Promise.all(tree.map((pid) => pidCommandLine(pid)));
    const ours = lines.some((line) => line?.includes(this.core.root) === true);
    if (!ours) {
      // 기록이 남의 것이 됐다(pid 재활용 등) — 지워 다음 생이 다시 판단하게.
      rmSync(pidFile, { force: true });
      return;
    }
    killPidTree(recorded, "SIGTERM");
    const hard = setTimeout(() => killPidTree(recorded, "SIGKILL"), 3_000);
    // 프로세스 소멸 대기 — 포트가 풀려야 다음 스폰이 그 자리를 얻는다.
    const settled = Promise.withResolvers<void>();
    const poll = setInterval(() => {
      try {
        process.kill(recorded, 0);
      } catch {
        clearInterval(poll);
        clearTimeout(hard);
        settled.resolve();
      }
    }, 100);
    const giveUp = setTimeout(() => {
      clearInterval(poll);
      settled.resolve();
    }, 8_000);
    await settled.promise;
    clearInterval(poll);
    clearTimeout(giveUp);
    clearTimeout(hard);
    rmSync(pidFile, { force: true });
  }

  private spawnOptions(): SpawnOptions {
    const windows = currentPlatform() === "win32";
    return {
      cwd: this.core.root,
      // The repo's commands are strings ("pnpm dev"), so a shell parses
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
        PATH: extraPathPrefix(process.env.COLO_DESIGN_EXTRA_PATH),
      },
    };
  }

  /**
   * Why a bring-up failed, from the constants this class itself threw (PLAN
   * D41) — the same words `classifyError` used to substring-match on the web
   * side, now decided where the throw happened.
   */
  private bringUpErrorKind(error: unknown): RepoErrorKind {
    const message = error instanceof Error ? error.message : String(error);
    // The refusal names the commands it blocks (the card shows the evidence),
    // so the sentence CONTINUES past the constant — prefix, not equality.
    if (message.startsWith(COMMANDS_UNAPPROVED_DETAIL)) return "commands";
    if (error instanceof PreviewPortUndetectedError) return "port-undetected";
    // PREVIEW_COMMAND_UNKNOWN 은 preview.command 를 말하므로 아래의 포트·
    // 미리보기 매칭보다 먼저 읽는다 — 명령 부재는 설정 문제가 아니라 레포의
    // scripts 문제다.
    if (message === PREVIEW_COMMAND_UNKNOWN) return "no-preview-command";
    if (message === PNPM_MISSING_DETAIL) return "pnpm-missing";
    if (message === REGISTRY_AUTH_DETAIL) return "registry-auth";
    // D96: 최신화 충돌의 한 줄은 정확히 이 상수로 던져지므로, 같은 상수로
    // 읽는다 — 오류 카드가 "AI에게 해결 요청" 을 보여 줄 수 있는 근거.
    if (
      message === REFRESH_CONFLICT_DETAIL ||
      message === RECOVER_CONFLICT_DETAIL ||
      message.includes("충돌한 파일")
    ) {
      return "conflict";
    }
    // 미리보기 자리의 실패도 미리보기 카드로 — AI 가 서버를 고치는 길.
    if (message.includes("미리보기 서버") || message.includes("미리보기 명령을 찾지 못했습니다")) {
      return "preview";
    }
    return this.core.isCloned() ? "install" : "clone";
  }

  /**
   * C5: 미리보기가 저절로 꺼지면 도구가 먼저 다시 켠다 — 두 번까지, 5 초
   * 간격. 다시 켜는 동안 상태는 `화면을 다시 켜는 중` 으로 시작한다(웹의
   * 중단 카드가 이 접두를 스핀너로 읽는다 — 계약). 두 번을 다 쓰면 원래
   * 실패 문장을 내려놓는다: 그 실패를 대화로 넘기는 것은 fleet 의 몫(D4)이지
   * 이 자리에서 다시 도는 것이 아니다.
   */
  private async restartPreview(detail: string): Promise<void> {
    if (this.previewRestarts >= 2) {
      this.core.setPhase("error", detail, "preview");
      return;
    }
    this.previewRestarts += 1;
    this.core.setPhase("error", `화면을 다시 켜는 중 — ${detail}`, "preview");
    await sleep(5_000);
    // 기다리는 사이 누군가(전환 · 동기화)가 이미 다시 켰다 — 중복으로 켜지
    // 않는다. 이미 켜진 쪽의 성공이 횟수를 초기화한다.
    if (this.core.preview) return;
    try {
      await this.bootstrap();
    } catch {
      // bootstrap 은 스스로 phase 를 적는다 — 여기서 할 말이 없다.
    }
  }
}

/**
 * 서버 출력 한 줄에서 미리보기 후보 URL 을 뽑는다. 스킴 있는 URL 은 루프백·
 * 와일드카드 호스트만 받는다 — Network 주소는 소켓 스캔이 같은 포트를 잡는다.
 * 루프백 철자(localhost·127.0.0.1·[::1])는 서버가 찍은 그대로 둔다: 어느
 * 패밀리에 바인드했는지는 프로브가 가린다. 와일드카드(0.0.0.0·[::])만 그
 * 패밀리의 루프백으로 옮긴다 — 그 주소는 연결할 수 있는 주소가 아니다.
 * `localhost:3000` 같은 bare host:port 는 http 로 본다. 서버가 찍은
 * 경로(`/app` 같은)는 그대로 둔다 — 루트가 아닌 곳에서 서는 앱도 있으므로.
 */
function previewUrlCandidate(line: string): string | null {
  const hit = /https?:\/\/[^\s"'<>)\]]+/.exec(line);
  if (hit) {
    try {
      const url = new URL(hit[0]);
      const host = url.hostname;
      const wildcard = host === "0.0.0.0" || host === "[::]";
      if (LOOPBACK_URL_HOSTS[host] === true || wildcard) {
        if (wildcard) url.hostname = host === "0.0.0.0" ? "127.0.0.1" : "[::1]";
        // 루트 주소는 선언 경로와 같은 철자로 — 끝의 / 는 붙이지 않는다.
        if (url.pathname === "/" && url.search === "" && url.hash === "") {
          return `${url.protocol}//${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
        }
        return url.toString();
      }
    } catch {
      // Not a URL after all — fall through to the bare host:port check.
    }
  }
  const bare =
    /(?:^|\s)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})(?:\/[\s"'<>)\]]*)?/.exec(line);
  if (bare) return `http://${bare[1] === "0.0.0.0" ? "127.0.0.1" : bare[1]}:${bare[2]}`;
  return null;
}

/** URL 호스트로 받아들이는 루프백 철자 — URL 파서는 [::1] 의 괄호를 유지한다. */
const LOOPBACK_URL_HOSTS: Record<string, true> = {
  localhost: true,
  "127.0.0.1": true,
  "[::1]": true,
};

/**
 * 후보 URL 의 프로브 대상들 — 원래 철자에다, 루프백이면 다른 패밀리의 같은
 * 포트를 덧붙인다. `localhost` 는 어느 한 패밀리로만 풀릴 수 있으므로 명시적
 * 127.0.0.1·[::1] 둘 다를 더한다. 루프백이 아닌 주소는 그대로 하나다.
 */
function loopbackUrlVariants(url: string): string[] {
  const variants = [url];
  try {
    const parsed = new URL(url);
    const extra =
      parsed.hostname === "localhost"
        ? ["127.0.0.1", "[::1]"]
        : parsed.hostname === "127.0.0.1"
          ? ["[::1]"]
          : parsed.hostname === "[::1]"
            ? ["127.0.0.1"]
            : [];
    for (const hostname of extra) {
      const copy = new URL(url);
      copy.hostname = hostname;
      variants.push(copy.toString());
    }
  } catch {
    // Not a parseable URL — probe it as printed.
  }
  return variants;
}

function dependencyHash(root: string): string {
  const hash = createHash("sha256");
  for (const file of ["package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    const path = join(root, file);
    hash.update(file);
    hash.update(existsSync(path) ? readFileSync(path) : Buffer.alloc(0));
  }
  return hash.digest("hex").slice(0, 16);
}
