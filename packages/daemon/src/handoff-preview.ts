// 시점 빌드 재현: 보낸 화면 동결의 2번째 얼굴. 1단계가
// 커밋된 캡처(.colo-design/shots/)를 보여준다면, 이 모듈은 '넘긴 시점의 실제
// 빌드'를 띄운다 — 열린 넘김의 브랜치 꼭지를 별도 워크트리에 체크아웃하고,
// 레포가 선언한 미리보기 명령을 그 워크트리에서 두 번째 포트로 띄운다.
//
// 수명 규칙 — 워크트리와 포트는 언제 거둬지나:
//   1. 그 빌드를 연 대화가 닫히면 (server.ts의 session.state closed).
//   2. 열린 넘김이 사라지거나(반영·반려 착지) 다른 넘김·다른 프로젝트로
//      바뀌었을 때 — 다음 open()이 판정한다. 꼭지만 옮겼다면(같은 브랜치에
//      이어 저장) 서버를 죽이지 않고 워크트리만 새 꼭지로 옮긴다 — 개발
//      서버의 핫 리로드가 그 이동을 그려 주므로.
//   3. 마지막 open() 뒤로 15분이 지나면 (아무도 보지 않는 빌드가 포트를
//      쥐고 있지 않게 하는 보험 — 창이 닫히는 말을 데몬이 못 듣는 경로의
//      구멍을 막는다).
//   4. 데몬이 내려갈 때 (stop()).
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { HandoffPreviewInfo, HandoffStatus } from "@colo-design/protocol";
import { extraPathPrefix } from "./claude-trust.js";
import { currentPlatform, resolveGitExecutable } from "./environment.js";
import { descendantPids, killTree, pidListeningPorts, probePreviewUrl } from "./preview-claim.js";

/** The open handoff this build serves — 넘긴 요청이 열려 있을 때만 존재한다. */
export type HandoffPreviewSource = () => {
  slug: string;
  /** The clone — git worktree add reads its object store and refs. */
  repoRoot: string;
  /** `~/.colo-design/projects/<slug>` — the worktree's home, outside the clone. */
  projectRoot: string;
  /** The resolved preview contract — the command the worktree serves with. */
  previewCommand: string | null;
  /** The open handoff, if any; null은 넘김이 없거나 이미 착지했다는 뜻이다. */
  handoff: HandoffStatus | null;
} | null;

/** 브랜치 꼭지 판정의 준비 대기 — 본 미리보기와 같은 벽시계 상한. */
const READY_TIMEOUT_MS = Number(process.env.COLO_DESIGN_READY_TIMEOUT_MS) || 120_000;
/** 마지막 open() 뒤의 유휭 수명 — 위 수명 규칙 3번. */
const IDLE_TTL_MS = 15 * 60_000;

interface LivePreview {
  slug: string;
  branch: string;
  /** The tip the worktree was checked out at — '넘긴 시점'의 커밋. */
  commit: string;
  /** The clone — worktree remove·prune은 본 레포 자리에서 부른다. */
  repoRoot: string;
  worktree: string;
  child: ChildProcess | null;
  /** The port the server actually answers on — the hint port or a detected one. */
  port: number | null;
  url: string | null;
  /** 마지막 open()의 대화 — 닫힘이 곧 수명의 끝이다 (수명 규칙 1번). */
  opener: string | null;
}

/**
 * The worktree build, one at a time per daemon — the frozen stage exists for
 * the ACTIVE project's open handoff, so there is never a second tenant for
 * the port or the folder. All state sits in `live`; a null is a clean desk.
 */
export class HandoffPreviews {
  private live: LivePreview | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** 겹치는 open()은 줄을 선다 — 버튼 연타가 워크트리 둘을 만들지 않게. */
  private opening: Promise<HandoffPreviewInfo> | null = null;
  /**
   * The last session to call open() — stamped at ENTRY, not at completion.
   * A second open arriving while the first still builds must win the opener
   * slot: runOpen assigning its own argument would let the earlier caller
   * overwrite it when it finishes.
   */
  private lastOpener: string | null = null;

  constructor(
    private readonly source: HandoffPreviewSource,
    /** 거둠의 흔적 — 데몬의 파일 로거가 받는다. */
    private readonly log: (message: string) => void = () => {},
  ) {}

  /**
   * 보낸 시점의 실제 빌드, 있으면 그 자리의 사실. 부재는 오류가 아니라
   * `ready:false`의 정직한 답이다 — 캡처가 동결 단계의 바닥이다.
   */
  open(sessionId: string | null): Promise<HandoffPreviewInfo> {
    // 마지막으로 부른 대화가 주인이다 — 두 대화가 번갈아 열면 나중 대화의
    // 닫힘이 거둔다. 그래야 '아무도 없는데 서버가 남는' 상태가 없다. 진입
    // 시점에 새긴다: 아직 짓는 중인 runOpen 이 끝날 때 자기 인자로 덮어쓰는
    // 일이 없도록.
    this.lastOpener = sessionId;
    this.opening ??= this.runOpen().finally(() => {
      this.opening = null;
    });
    if (this.live) this.live.opener = sessionId;
    return this.opening;
  }

  /** 수명 규칙 1번 — 그 빌드를 연 대화가 닫혔다. */
  closeSession(sessionId: string): void {
    if (this.live?.opener !== sessionId) return;
    void this.dispose("빌드를 연 대화가 닫혔습니다");
  }

  /** 수명 규칙 4번 — 데몬이 내려간다. */
  async dispose(): Promise<void>;

  async dispose(reason: string): Promise<void>;
  async dispose(reason?: string): Promise<void> {
    this.disarmIdleTimer();
    const live = this.live;
    this.live = null;
    if (!live) return;
    await stopServer(live);
    await removeWorktree(live.repoRoot, live.worktree);
    if (reason) this.log(`handoff-preview 해체: ${reason}`);
  }

  private async runOpen(): Promise<HandoffPreviewInfo> {
    const context = this.source();
    if (!context) {
      await this.dispose();
      return notReady(null, "연결 레포가 아직 준비되지 않았습니다.");
    }
    const { slug, repoRoot, projectRoot, previewCommand, handoff } = context;
    // 수명 규칙 2번: 넘김이 착지해 사라졌다면 빌드도 함께 거둔다 — '넘긴
    // 시점'은 넘긴 요청이 열려 있는 동안만 존재하는 약속이다.
    if (!handoff) {
      await this.dispose("열린 넘김이 없습니다");
      return notReady(
        null,
        "열려 있는 넘김이 없습니다 — 넘긴 요청이 열려 있을 때만 실제 빌드를 띄울 수 있습니다.",
      );
    }
    if (!previewCommand) {
      return notReady(
        null,
        "이 레포는 미리보기 명령을 찾지 못했습니다 — package.json 의 scripts 를 확인해 주세요.",
      );
    }
    const branch = handoff.branch;
    const commit = await tipOf(repoRoot, branch);
    if (!commit) {
      return notReady(
        null,
        "넘긴 브랜치의 커밋을 찾지 못했습니다 — 저장과 넘기기가 온전히 끝난 뒤 다시 시도해 주세요.",
      );
    }

    // 다른 프로젝트·다른 브랜치의 남은 빌드는 처음부터 — 같은 자리를 쓰므로
    // 먼저 거두고 새로 짓는다.
    if (this.live && (this.live.slug !== slug || this.live.branch !== branch)) {
      await this.dispose("넘김이 바뀌었습니다");
    }
    if (!this.live) {
      const built = await this.build({
        slug,
        repoRoot,
        projectRoot,
        previewCommand,
        branch,
        commit,
      });
      if (typeof built === "string") return notReady(commit, built);
      this.live = built;
    }
    const live = this.live;
    live.opener = this.lastOpener;
    this.armIdleTimer();

    // 같은 브랜치의 꼭지만 옮겨갔다(이어 저장) — 서버는 살려 두고 워크트리만
    // 새 꼭지로. 핫 리로드가 그려 주고, 포트도 그대로다.
    if (live.commit !== commit) {
      const moved = await git(repoRoot, ["-C", live.worktree, "checkout", "--detach", commit]);
      if (moved === null)
        return notReady(live.commit, "넘긴 브랜치의 새 커밋으로 옮기지 못했습니다.");
      live.commit = commit;
    }

    // 서버가 죽어 있으면(핫 리로드가 견디지 못한 자리 등) 같은 워크트리에서
    // 다시 띄운다 — 워크트리를 다시 짓는 일은 없다. 지난 포트·주소는 이전
    // 서버의 것이라 새 판정 전에 비워 둔다.
    if (live.child === null || live.child.exitCode !== null) {
      live.child = null;
      live.port = null;
      live.url = null;
      const started = await this.startServer(live, previewCommand);
      if (typeof started === "string") return notReady(live.commit, started);
    }
    return { port: live.port, ready: true, commit: live.commit, url: live.url };
  }

  /** 워크트리를 짓고 서버를 띄워 준비를 기다린다. 실패는 사유의 문자열이다. */
  private async build(input: {
    slug: string;
    repoRoot: string;
    projectRoot: string;
    previewCommand: string;
    branch: string;
    commit: string;
  }): Promise<LivePreview | string> {
    const worktree = join(input.projectRoot, "handoff");
    mkdirSync(input.projectRoot, { recursive: true });
    // 남은 자리의 청소: 이전 수명이 강제 종료로 마치지 못한 워크트리가
    // 남아 있으면 add가 거절한다. rm 뒤의 prune이 메타데이터까지 지운다.
    rmSync(worktree, { recursive: true, force: true });
    const pruned = await git(input.repoRoot, ["worktree", "prune"]);
    if (pruned === null) return "git 워크트리 목록을 정리하지 못했습니다.";
    const added = await git(input.repoRoot, [
      "worktree",
      "add",
      "--detach",
      worktree,
      input.commit,
    ]);
    if (added === null) return "넘긴 시점의 워크트리를 만들지 못했습니다.";

    // 설치는 복사하지 않는다 — 클론의 node_modules를 그대로 빌려 쓴다.
    // 두 번 설치는 수백 MB와 몇 분의 값어치가 없고, 같은 브랜치의 워크트리는
    // 같은 잠금파일을 안다.
    const fromModules = join(input.repoRoot, "node_modules");
    const toModules = join(worktree, "node_modules");
    if (existsSync(fromModules) && !existsSync(toModules)) {
      try {
        symlinkSync(fromModules, toModules, currentPlatform() === "win32" ? "junction" : "dir");
      } catch {
        // 빌려 쓰기가 실패해도 서버는 스스로 뜰 수 있다 — 실패는 준비 판정이 말한다.
      }
    }

    const live: LivePreview = {
      slug: input.slug,
      branch: input.branch,
      commit: input.commit,
      repoRoot: input.repoRoot,
      worktree,
      child: null,
      port: null,
      url: null,
      opener: null,
    };
    // 포트 힌트: 아무도 안 쓰는 포트를 하나 골라 PORT 환경으로 흘린다. 힌트를
    // 무시하고 제 포트를 고집하는 서버의 진짜 리스너는 아래 준비 판정의 소켓
    // 스캔이 찾는다.
    const hint = await freePort();
    live.port = hint;
    const failure = await this.startServer(live, input.previewCommand, hint);
    if (typeof failure === "string") {
      await stopServer(live);
      await removeWorktree(input.repoRoot, worktree);
      return failure;
    }
    return live;
  }

  /**
   * 미리보기 명령을 워크트리에서 띄우고 준비를 기다린다. 성공은 null, 실패는
   * 기획자가 읽을 사유다. 준비는 '포트가 열리고 앱이 응답한다' — 본 미리보기의
   * 판정과 같다. 힌트 포트가 먼저고, 서버가 제 포트를 골랐다면 프로세스
   * 트리의 LISTEN 소켓에서 찾는다.
   */
  private async startServer(
    live: LivePreview,
    previewCommand: string,
    hint?: number,
  ): Promise<null | string> {
    const windows = currentPlatform() === "win32";
    const child = spawn(previewCommand, {
      cwd: live.worktree,
      // 레포의 명령은 문자열("pnpm dev")이라 셀이 읽는다.
      // detached는 POSIX에서 프로세스 그룹 하나로 묶어 거둠을 가능하게 한다.
      shell: true,
      detached: !windows,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(hint === undefined ? {} : { PORT: String(hint) }),
        // 미리보기는 절대 과금 키를 물려받지 않는다 (본 미리보기와 같은 규율).
        ANTHROPIC_API_KEY: undefined,
        PATH: extraPathPrefix(process.env.COLO_DESIGN_EXTRA_PATH),
      },
    });
    live.child = child;
    /** 서버의 마지막 말 — 죽은 이유의 근거. */
    let lastLine = "";
    const absorb = (chunk: Buffer) => {
      const line = String(chunk)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();
      if (line) lastLine = line;
    };
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const scanned = new Set<number>();
    try {
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          return `넘긴 시점의 미리보기 서버가 종료되었습니다${lastLine ? ` — ${lastLine}` : ""}`;
        }
        // 힌트 포트부터 — 명령이 힌트를 따랐다면 첫 판정으로 끝난다.
        if (hint !== undefined && !scanned.has(hint)) {
          const url = await servingUrl(hint);
          if (url !== null) {
            live.port = hint;
            live.url = url;
            return null;
          }
        }
        // 제 포트를 고른 서버 — 프로세스 트리가 여는 LISTEN 소켓에서 찾는다.
        const pids = [
          ...(child.pid ? [child.pid] : []),
          ...(await descendantPids(child.pid ?? -1)),
        ];
        for (const port of await pidListeningPorts(pids)) {
          if (scanned.has(port)) continue;
          scanned.add(port);
          const url = await servingUrl(port);
          if (url !== null) {
            live.port = port;
            live.url = url;
            return null;
          }
        }
        await Promise.race([sleep(250), exited]);
      }
    } finally {
      // 띄우다 만 서버는 유령이 된다 (본 미리보기의 실사 결함) — 판정이
      // 서면 서버도 내린다. 살아 낸 뒤의 finally는 아무것도 죽이지 않는다.
      if (live.port === null) await stopServer(live);
    }
    return `넘긴 시점의 미리보기 서버가 ${Math.round(READY_TIMEOUT_MS / 1000)}초 안에 응답하지 않았습니다${
      lastLine ? ` — ${lastLine}` : ""
    }`;
  }

  /** 수명 규칙 3번 — 마지막 open() 뒤의 유횭 보험. */
  private armIdleTimer(): void {
    this.disarmIdleTimer();
    this.idleTimer = setTimeout(() => void this.dispose("오랫동안 불리지 않았습니다"), IDLE_TTL_MS);
    this.idleTimer.unref?.();
  }

  private disarmIdleTimer(): void {
    clearTimeout(this.idleTimer ?? undefined);
    this.idleTimer = null;
  }
}

// ---------------------------------------------------------------------------
// 순수 절차 — git, 포트, 워크트리 자리
// ---------------------------------------------------------------------------

function notReady(commit: string | null, detail: string): HandoffPreviewInfo {
  return { port: null, ready: false, commit, url: null, detail };
}

/** git 한 번 — 실패는 null이고, 절대 던지지 않는다. 이 모듈의 실패는 사유로 가야 한다. */
async function git(cwd: string, args: string[]): Promise<string | null> {
  const executable = (await resolveGitExecutable()) ?? "git";
  return await new Promise<string | null>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ANTHROPIC_API_KEY: undefined },
      });
    } catch {
      resolve(null);
      return;
    }
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code === 0 ? stdout : null));
  });
}

/**
 * 브랜치 꼭지 — origin 을 먼저 믿는다 (handoffShot 과 같은 판정): 반영된
 * 사이클의 로컬 브랜치는 이미 없을 수 있어도 origin 은 남아 있다.
 */
async function tipOf(repoRoot: string, branch: string): Promise<string | null> {
  for (const ref of [`origin/${branch}`, branch]) {
    const sha = (await git(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]))?.trim();
    if (sha) return sha;
  }
  return null;
}

/** 아무도 듣지 않는 포트 하나 — 커널이 골라 주는 것을 빌렸다가 돌려준다. */
async function freePort(): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    server.close(() => resolve(port));
  });
  return await promise;
}

/** 어느 루프백 패밀리든 응답하는 쪽의 주소를 그대로 돌린다 (본 미리보기와 같다). */
async function servingUrl(port: number): Promise<string | null> {
  for (const host of ["127.0.0.1", "[::1]"] as const) {
    const url = `http://${host}:${port}/`;
    if ((await probePreviewUrl(url)) !== null) return url;
  }
  return null;
}

/** 서버 거둠 — 본 미리보기의 killPreview 와 같은 두 단계 (SIGTERM 뒤 SIGKILL). */
async function stopServer(live: LivePreview): Promise<void> {
  const child = live.child;
  live.child = null;
  if (!child || child.exitCode !== null) return;
  const { promise: exited, resolve } = Promise.withResolvers<void>();
  child.once("exit", () => resolve());
  killTree(child, "SIGTERM");
  const hard = setTimeout(() => killTree(child, "SIGKILL"), 3_000);
  await exited;
  clearTimeout(hard);
}

/**
 * 워크트리 거둠 — git 의 지우기가 정확하고(.git/worktrees 메타데이터까지),
 * 실패하면(이미 강제 종료로 어긋난 자리) rm 뒤의 prune이 같은 자리를 만든다.
 * 명령은 본 클론 자리에서 부른다 — 지워질 워크트리 안에서 부르면 자기 자신을
 * 지우는 모양이 되어 git이 거절하는 자리가 있다.
 */
async function removeWorktree(repoRoot: string, worktree: string): Promise<void> {
  const removed = await git(repoRoot, ["worktree", "remove", "--force", worktree]);
  if (removed !== null) return;
  rmSync(worktree, { recursive: true, force: true });
  await git(repoRoot, ["worktree", "prune"]);
}
