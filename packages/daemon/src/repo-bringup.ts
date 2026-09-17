// Bring-up: clone → config → install → preview. Owns the preview
// process itself (startPreview/killPreview) and the port fence around it,
// plus the install short-circuit and the bring-up error taxonomy.
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { RepoErrorKind, RepoStatus } from "@colo-design/protocol";
import { extraPathPrefix, trustWorkspace } from "./claude-trust.js";
import { mergeNpmrc, npmrcPath } from "./credentials.js";
import {
  currentPlatform,
  detectsRegistryAuthFailure,
  resolvePnpmExecutable,
} from "./environment.js";
import {
  clearPreviewClaim,
  descendantPids,
  foreignLivePreviewClaim,
  killTree,
  pidListeningPorts,
  portAccepts,
  portListenerPids,
  portRefused,
  probePreviewUrl,
  writePreviewClaim,
} from "./preview-claim.js";
import {
  CONFIG_FILE,
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
  PreviewHeldElsewhereError,
  PreviewPortBusyError,
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
        await this.core.git(["clone", this.core.url, this.core.root], dirname(this.core.root));
        trustWorkspace(this.core.root);
      } else {
        this.core.setPhase("pulling", null);
        await this.core.scrubOriginCredential();
        // Already cloned: 최신화, not a blind ff. Unsaved work survives the
        // move off-cycle, and a conflict left by an earlier run resurfaces
        // with its Korean reason instead of a raw git error.
        await this.core.refreshFromRemote();
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
          `${COMMANDS_UNAPPROVED_DETAIL} 실행하려는 명령 — 설치: ${config.install ?? "(선언되지 않음)"} · 미리보기: ${config.preview.command} (포트 ${config.preview.port ?? "자동 감지"})`,
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
        this.maybePrepareConventions();
        return this.core.snapshot();
      }
      await this.startPreview(config);
      this.core.setPhase("ready", null);
      this.maybePrepareConventions();
    } catch (error) {
      this.core.setPhase("error", detailOf(error, this.core.pat), this.bringUpErrorKind(error));
    }
    return this.core.snapshot();
  }

  /**
   * ready 에 도달한 뒤 한 번 — 컨벤션(브리지 · 래퍼 · CLAUDE.md)이 없는 레포에
   * AI 가 그것들을 설치하는 턴을 연다. 실패는 세션 카드가 말하고 준비
   * 상태를 바꾸지 않는다 — 미리보기는 이미 떠 있다.
   */
  private maybePrepareConventions(): void {
    if (!this.core.prepareConventions) return;
    void this.core.prepareConventions().catch(() => undefined);
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
    // project must neither kill the port's holder nor START a server of its
    // own past the switch (the one it already has stays warm — the server's
    // switch fence decides that one).
    if (!this.core.active) return;
    await this.killPreview();
    this.core.setPhase("starting", null);
    const { command, port } = config.preview;
    await this.requirePnpmIfReferenced(command);

    // 선언 포트가 있는 레포만 포트 전쟁을 치른다. 없는 레포는 서버가 빈 포트를
    // 스스로 고르고 우리는 뜬 곳을 읽기만 하면 된다 — 점유자를 죽일 일이 없다.
    // 활성 프로젝트가 선언한 포트의 주인은 활성 프로젝트다. 충돌의 보통 원인은
    // 강제 종료된 데몬이 남긴 고아 서버고, 전환 때 이전 프로젝트의 잔여분은 이미
    // 정리되므로 — 묻지 않고 점유자를 정리하고 이 자리에서 다시 띄운다. 명명된
    // 실패는 정리가 실패했을 때만 남는다: 그때는 다시 시작도 소용이 없으니
    // 직접 종료나 포트 변경이 다음 과제다. The kill is listener-only: a blanket
    // port kill also hits the port's clients.
    // The reclaimer runs unconditionally: a probe gate ("is the port busy?")
    // reads the same flaky 1s connect that the verdict below refuses to
    // trust — a starved runner can time it out against a live listener and
    // skip the kill, spawning the preview into EADDRINUSE. With nothing
    // listening, lsof finds no pid and the first refusal clears instantly —
    // the free-port path pays one lookup, nothing more.
    // 살아 있는 다른 인스턴스의 미리보기는 죽이지 않는다. 이 기록이 가리키는
    // 점유자는 고아가 아니라 다른 창(패키지 앱 또는 데몬)의 살아 있는 서버다 —
    // 죽이는 순간 두 인스턴스는 서로의 미리보기를 번갈아 죽이는 전쟁에 들어간다
    // (실사: 앱+개발 데몬이 포트 3000을 두고 1~2분마다 서버를 교체). 여기서는
    // 멈추고 카드로 말한다. 해법은 이 창 밖에 있다.
    if (port !== undefined) {
      const held = await foreignLivePreviewClaim(port);
      if (held)
        throw new PreviewHeldElsewhereError(
          `포트 ${port}에서 다른 Colo Design 인스턴스가 이 프로젝트의 미리보기를 이미 돌리고 있습니다 — ` +
            `서로의 미리보기를 죽이지 않도록 이쪽에서는 기다립니다. ` +
            `다른 인스턴스를 끄거나 연결 레포의 colo-design.json에서 preview.port를 바꾼 뒤 다시 시도해 주세요.`,
        );
      if (!(await this.killPortHolder(port)))
        throw new PreviewPortBusyError(
          `포트 ${port}를 종료하려 했지만 여전히 다른 프로그램이 쓰고 있어 미리보기를 켤 수 없습니다 — ` +
            `권한이 없거나 프로그램이 곧바로 되살아났을 수 있습니다. ` +
            `그 프로그램을 직접 끄거나 연결 레포의 colo-design.json에서 preview.port를 바꿔 주세요.`,
        );
    }

    const child = spawn(command, this.spawnOptions());
    this.core.preview = child;
    this.core.previewEpoch += 1;
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
      // 죽은 미리보기의 기록은 곧바로 거둔다 — 남은 기록은 낡은 리스너를
      // 가리켜 판정 때 스스로 지워지지만, 여기서 지우는 것이 정확하다.
      const claimed = this.core.occupiedPreviewPort();
      this.core.previewUrl = null;
      if (claimed !== null) clearPreviewClaim(claimed);
      const how = signal ? `signal ${signal}` : `exit ${code}`;
      this.core.setPhase(
        "error",
        // The command's own last line is what says WHY; an exit code alone
        // sends the planner to a terminal they were promised they would not need.
        lastLine
          ? `미리보기 서버가 종료되었습니다 (${how}) — ${lastLine}`
          : `미리보기 서버가 종료되었습니다 (${how})`,
        "preview",
      );
    });

    try {
      this.core.previewUrl =
        port !== undefined
          ? await this.waitDeclared(port)
          : await this.detectPreviewUrl(child, urlCandidates, tail);
    } catch (error) {
      // 늦게라도 뜰 예정이던 서버를 죽은 것으로 선고한 채 두면, 실제로는 살아
      // 포트를 쥔 유령이 남는다 (실사 목격). 선고가 서면 서버도 내려야 한다.
      await this.killPreview();
      throw error;
    }
    // 부팅이 확인된 리스너를 기록해 둔다 — 다음 포트 충돌 때 이 기록이 살아 있는
    // 다른 인스턴스의 미리보기를 말해 준다(위의 울타리). 감지 포트도 같은 기록을
    // 남겨, 이 포트를 선언한 다른 프로젝트가 held-elsewhere 로 읽게 한다.
    const claimed = this.core.occupiedPreviewPort();
    if (claimed !== null) {
      const holders = await portListenerPids(claimed);
      writePreviewClaim({
        instancePid: process.pid,
        listenerPid: holders[0] ?? null,
        port: claimed,
        at: new Date().toISOString(),
      });
    }
  }

  /**
   * 포트 미선언 레포의 준비 판정: 서버가 찍은 URL 을 먼저 믿고, 출력이 없으면
   * 프로세스 트리의 LISTEN 소켓에서 찾는다. HTML 응답이 곧 미리보기다 — API
   * 전용 포트가 함께 뜨는 레포에서도 화면을 서는 쪽을 고른다. 끝까지 못 찾으면
   * port-undetected 로 던져 AI 가 서버 출력이나 선언을 고치게 한다.
   */
  private async detectPreviewUrl(
    child: ChildProcess,
    urlCandidates: Set<string>,
    tail: string[],
  ): Promise<string> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const probed = new Set<string>();
    const scanned = new Set<number>();
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
          if (probed.has(url)) continue;
          probed.add(url);
          if ((await probePreviewUrl(url)) !== null) return url;
        }
      }
      const pids = [...(child.pid ? [child.pid] : []), ...(await descendantPids(child.pid ?? -1))];
      for (const port of await pidListeningPorts(pids)) {
        if (scanned.has(port)) continue;
        scanned.add(port);
        for (const scheme of ["http", "https"] as const) {
          for (const host of ["127.0.0.1", "[::1]"] as const) {
            const url = `${scheme}://${host}:${port}/`;
            const verdict = await probePreviewUrl(url);
            if (verdict === "html") return url;
            if (verdict === "ok" && fallback === null) fallback = url;
          }
        }
      }
      await sleep(250);
    }
    if (fallback !== null) return fallback;
    throw new PreviewPortUndetectedError(
      `미리보기 서버는 시작됐지만 어느 주소에서 듣는지 찾지 못했습니다 — ` +
        `서버가 뜬 주소를 출력하게 하거나 ${CONFIG_FILE} 의 preview.port 로 포트를 적어 주세요.` +
        (tail.length > 0 ? `\n마지막 출력:\n${tail.slice(-10).join("\n")}` : ""),
    );
  }

  /** 선언 포트의 준비 판정 — 포트가 열리고 앱이 응답할 때까지. */
  private async waitDeclared(port: number): Promise<string> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.core.preview)
        throw new Error(this.core.detail ?? "미리보기 서버가 시작되지 않았습니다");
      const url = await this.servingUrl(port);
      if (url !== null) return url;
      await sleep(250);
    }
    throw new Error(
      `미리보기 서버가 ${READY_TIMEOUT_MS / 1000}초 안에 응답하지 않았습니다 (포트 ${port})`,
    );
  }

  /** Ready means the port is open *and* the app answers, not just listening. */
  private async isServing(port?: number): Promise<boolean> {
    if (port !== undefined) return (await this.servingUrl(port)) !== null;
    const url = this.core.previewUrl;
    if (url === null) return false;
    return (await probePreviewUrl(url)) !== null;
  }

  /**
   * 선언 포트가 실제로 서는 주소 — 어느 루프백 패밀리든 응답하는 쪽을 그대로
   * 돌린다. [::1] 에만 바인드한 서버는 127.0.0.1 프로브가 전부 거절하므로,
   * 한 패밀리만 보는 판정은 살아 있는 서버를 못 찾는다.
   */
  private async servingUrl(port: number): Promise<string | null> {
    if (!(await portAccepts(port))) return null;
    for (const host of ["127.0.0.1", "[::1]"] as const) {
      const url = `http://${host}:${port}`;
      if ((await probePreviewUrl(url)) !== null) return url;
    }
    return null;
  }

  async killPreview(): Promise<void> {
    const child = this.core.preview;
    if (!child) return;
    this.core.preview = null;

    const { promise: exited, resolve } = Promise.withResolvers<void>();
    child.once("exit", () => resolve());
    killTree(child, "SIGTERM");
    const hard = setTimeout(() => killTree(child, "SIGKILL"), 3_000);
    await exited;
    clearTimeout(hard);

    // The command may start its server as its own child; the port is only
    // free once that process is gone, and a re-start would fail on a busy port.
    const port = this.core.occupiedPreviewPort();
    this.core.previewUrl = null;
    if (port === null) return;
    const deadline = Date.now() + 3_000;
    while (!(await portRefused(port))) {
      if (Date.now() > deadline) break;
      await sleep(100);
    }
    clearPreviewClaim(port);
  }

  private spawnOptions(): SpawnOptions {
    const windows = currentPlatform() === "win32";
    return {
      cwd: this.core.root,
      // colo-design.json commands are strings ("pnpm dev"), so a shell parses
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
   * 다시 시작's mandate: whatever LISTENS on the declared preview port dies —
   * and only the listener. lsof without the LISTEN filter also matches the
   * port's clients (a browser tab on the old preview, this app's own iframe),
   * and a restart that kill -9s the planner's browser is no fix. The lookup's
   * exit status is not trusted — bind-ability is the verdict.
   */
  private async killPortHolder(port: number): Promise<boolean> {
    this.core.setProgressLine(`포트 ${port}를 쓰는 프로그램을 종료하는 중…`);
    for (const pid of await portListenerPids(port)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone, or not ours to signal — the verdict below says
        // whether the port actually freed.
      }
    }
    // The OS retires the listener asynchronously; a re-start before the port
    // truly frees would fail on the very bind this kill was for. Only an
    // explicit refusal is "free": a probe timeout can fire against a still-
    // bound listener on a starved runner, and a verdict read from it spawns
    // the preview into EADDRINUSE while the holder lives on.
    const deadline = Date.now() + 5_000;
    while (!(await portRefused(port))) {
      if (Date.now() > deadline) return false;
      await sleep(100);
    }
    return true;
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
    if (error instanceof PreviewPortBusyError) return "port-busy";
    if (error instanceof PreviewHeldElsewhereError) return "held-elsewhere";
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
    // 깨진 colo-design.json 도 미리보기 카드로 — AI 가 파일을 고치는 길.
    if (
      message.includes("미리보기 서버") ||
      message.includes("preview.port") ||
      message.includes(CONFIG_FILE)
    ) {
      return "preview";
    }
    return this.core.isCloned() ? "install" : "clone";
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
