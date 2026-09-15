import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { COLO_DESIGN_DIR, currentPlatform } from "./environment.js";

/**
 * 미리보기 포트를 둘러싼 사실들 — 포트가 살아 있는지, 누가 쥐고 있는지, 어느
 * 인스턴스가 띄운 것인지. `RepoWorkspace` 에서 떼어 둔 이유는 하나다: 여기
 * 전부가 `this` 없는 순수 절차라, 워크스페이스의 상태 기계를 읽지 않고도
 * 읽히고 검사된다. 포트 전쟁의 울타리(두 인스턴스가 서로의 미리보기를 죽이던
 * 실사 결함)가 사는 자리이기도 하다.
 */

export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    // Detached on POSIX means the shell and its children share a process
    // group; signalling the group is what actually releases the port.
    if (currentPlatform() !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

export function portAccepts(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // A refused connection is the kernel's definitive "nothing listens here";
    // the 1s timeout is not. An event loop starved past the second (a loaded
    // runner mid-suite is enough) can deliver the timeout before the connect
    // of a LIVE listener — and a busy-port read that trusts it skips the
    // reclaimer and spawns the preview into EADDRINUSE. One immediate retry
    // turns that coin flip back into a fact; a dead port still refuses
    // instantly, so the free-side verdict pays nothing.
    const attempt = (retriesLeft: number) => {
      const socket = createConnection({ port, host: "127.0.0.1" });
      socket.setTimeout(1_000);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("timeout", () => {
        socket.destroy();
        if (retriesLeft > 0) attempt(retriesLeft - 1);
        else resolve(false);
      });
    };
    attempt(1);
  });
}

/**
 * The port's DEFINITIVE free verdict. A refused connection is the kernel
 * saying nothing listens here; a connect means something still answers; a
 * timeout is merely "unknown" — on a starved runner it can fire while a live
 * listener is still bound, so it reads as NOT free and the caller waits on.
 */
export function portRefused(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = createConnection({ port, host: "127.0.0.1" });
  socket.setTimeout(1_000);
  socket.once("error", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("connect", () => {
    socket.destroy();
    resolve(false);
  });
  socket.once("timeout", () => {
    socket.destroy();
    resolve(false);
  });
  return promise;
}

export function respondsOk(url: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const request = httpGet(url, (response) => {
    response.resume();
    resolve(response.statusCode === 200);
  });
  request.setTimeout(2_000, () => {
    request.destroy();
    resolve(false);
  });
  request.once("error", () => resolve(false));
  return promise;
}

// ---------------------------------------------------------------------------
// Preview ownership claims — 두 인스턴스의 포트 전쟁을 끊는 울타리
// ---------------------------------------------------------------------------

/**
 * 어느 인스턴스가 어느 포트의 미리보기를 띄웠는지 한 줄짜리 기록,
 * `~/.colo-design/run/preview-<포트>.json`. 검사 스위트는 `COLO_DESIGN_RUN_DIR`
 * 로 갈라 놓는다 — 개발자의 실제 기록을 읽지도 쓰지도 않도록, 프로젝트
 * 등록부가 하는 것과 같은 격리다.
 */
export interface PreviewClaim {
  /** 이 미리보기를 띄운 데몬(또는 앱) 프로세스의 pid. */
  instancePid: number;
  /** 부팅이 확인된 순간 포트의 LISTEN 소유자. 조회가 순간 실패하면 null —
   * 그때는 주인이 살아 있는 한 이 기록을 지킨다 (foreignLivePreviewClaim). */
  listenerPid: number | null;
  port: number;
  at: string;
}

function previewClaimFile(port: number, env: NodeJS.ProcessEnv = process.env): string {
  return join(env.COLO_DESIGN_RUN_DIR ?? join(COLO_DESIGN_DIR, "run"), `preview-${port}.json`);
}

export function readPreviewClaim(
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): PreviewClaim | null {
  try {
    const parsed = JSON.parse(readFileSync(previewClaimFile(port, env), "utf8")) as PreviewClaim;
    if (typeof parsed?.instancePid === "number" && parsed.port === port) return parsed;
  } catch {
    // 없거나 깨진 기록은 없는 것과 같다 — 울타리는 기록이 있을 때만 선다.
  }
  return null;
}

export function writePreviewClaim(claim: PreviewClaim, env: NodeJS.ProcessEnv = process.env): void {
  const file = previewClaimFile(claim.port, env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(claim, null, 2)}\n`, { mode: 0o600 });
}

export function clearPreviewClaim(port: number, env: NodeJS.ProcessEnv = process.env): void {
  rmSync(previewClaimFile(port, env), { force: true });
}

/** signal 0 은 흔들지 않는다 — EPERM 도 프로세스가 살아 있다는 답이다. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 이 포트에서 LISTEN 하는 pid 들 — lsof(linux·mac) / netstat(windows). */
export async function portListenerPids(port: number): Promise<number[]> {
  const windows = currentPlatform() === "win32";
  const args = windows ? ["-a", "-n", "-o"] : ["-t", `-i:${port}`, "-sTCP:LISTEN"];
  const stdout = await new Promise<string>((resolve, reject) =>
    execFile(
      windows ? "netstat" : "lsof",
      args,
      { timeout: 10_000, shell: windows },
      (error, out) => (error ? reject(error) : resolve(String(out))),
    ),
  ).catch(() => "");
  const pids = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    if (windows) {
      // `TCP  0.0.0.0:3000  0.0.0.0:0  LISTENING  4321` — the local address
      // names the port, the last column owns it.
      const columns = line.trim().split(/\s+/);
      const local = columns[1] ?? "";
      if (columns.length < 5 || columns[3] !== "LISTENING" || !local.endsWith(`:${port}`)) continue;
      const pid = Number(columns[4] ?? NaN);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    } else {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  return [...pids];
}

/**
 * 이 포트의 기록이 살아 있는 다른 인스턴스의 미리보기를 가리키면 그 기록을
 * 돌려 준다 — startPreview 는 이 경우 점유자를 죽이는 대신 멈춘다. 그 외는
 * 모두 정리하고 null: 우리 것(같은 pid), 주인이 죽은 고아의 기록, 기록이
 * 가리킨 리스너가 이미 사라진 낡은 기록.
 *
 * 오류의 방향은 하나다 — 살아 있는 남의 미리보기를 죽이는 쪽이 아니라, 죽어
 * 있는 점유자를 잠시 남겨 두는 쪽. 그래서 기록 시점의 리스너 조회가 순간
 * 실패해 listenerPid 가 null 인 기록(실사 목격: lsof 가 갓 뜬 리스너를 한
 * 번 놓쳤다)은 주인이 살아 있는 한 지킨다. 주인의 서버가 정말 죽으면 주인
 * 인스턴스의 exit 경로가 기록을 거두고, 그러지 못한 채 주인만 죽으면 이
 * 함수의 고아 판정이 거둔다.
 */
export async function foreignLivePreviewClaim(
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PreviewClaim | null> {
  const claim = readPreviewClaim(port, env);
  if (!claim) return null;
  if (claim.instancePid === process.pid) return null;
  if (!pidAlive(claim.instancePid)) {
    clearPreviewClaim(port, env);
    return null;
  }
  if (claim.listenerPid === null) return claim;
  const holders = await portListenerPids(port);
  if (holders.includes(claim.listenerPid)) return claim;
  clearPreviewClaim(port, env);
  return null;
}
