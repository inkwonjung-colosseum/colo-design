import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
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
/**
 * Both loopback families a dev server may bind. Probes that try only
 * 127.0.0.1 miss a server bound to [::1] alone — react-router dev does
 * exactly that, which is how a live preview read as port-undetected.
 */
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;

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
    // Both loopback families are tried: a dev server bound to [::1] only
    // (react-router dev does this) accepts nothing on 127.0.0.1, and a
    // v4-only read would call its port free.
    let pending = LOOPBACK_HOSTS.length;
    let answered = false;
    const settle = (accepts: boolean) => {
      if (answered) return;
      if (accepts) {
        answered = true;
        resolve(true);
        return;
      }
      if (--pending === 0) {
        answered = true;
        resolve(false);
      }
    };
    for (const host of LOOPBACK_HOSTS) {
      const attempt = (retriesLeft: number) => {
        const socket = createConnection({ port, host });
        socket.setTimeout(1_000);
        socket.once("connect", () => {
          socket.destroy();
          settle(true);
        });
        socket.once("error", () => {
          socket.destroy();
          settle(false);
        });
        socket.once("timeout", () => {
          socket.destroy();
          if (retriesLeft > 0) attempt(retriesLeft - 1);
          else settle(false);
        });
      };
      attempt(1);
    }
  });
}

/**
 * The port's DEFINITIVE free verdict. A refused connection is the kernel
 * saying nothing listens here; a connect means something still answers; a
 * timeout is merely "unknown" — on a starved runner it can fire while a live
 * listener is still bound, so it reads as NOT free and the caller waits on.
 */
export function portRefused(port: number): Promise<boolean> {
  // Free means EVERY loopback family refuses — a listener on [::1] alone
  // still owns the port even though 127.0.0.1 refuses instantly.
  return Promise.all(LOOPBACK_HOSTS.map((host) => portRefusedOn(port, host))).then((verdicts) =>
    verdicts.every(Boolean),
  );
}

function portRefusedOn(port: number, host: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = createConnection({ port, host });
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
/**
 * 주어진 URL 이 실제로 응답하는지 — respondsOk 의 판별을 세 가지로 넓힌 것.
 * "html" 은 브라우저가 열 수 있는 페이지(5xx 미만 + text/html), "ok" 는 그
 * 외의 5xx 미만 응답(API·리다이렉트·정적 파일), null 은 오류·타임아웃.
 * https 의 자체서명 인증서는 개발 서버의 일상이라 검증을 끈다.
 */
export function probePreviewUrl(url: string): Promise<"html" | "ok" | null> {
  const { promise, resolve } = Promise.withResolvers<"html" | "ok" | null>();
  const get = url.startsWith("https:") ? httpsGet : httpGet;
  const request = get(url, { rejectUnauthorized: false }, (response) => {
    response.resume();
    const status = response.statusCode ?? 0;
    if (status >= 500 || status === 0) return resolve(null);
    const type = response.headers["content-type"] ?? "";
    resolve(type.includes("text/html") ? "html" : "ok");
  });
  request.setTimeout(2_000, () => {
    request.destroy();
    resolve(null);
  });
  request.once("error", () => resolve(null));
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
/** 주어진 pid 들이 쥐고 있는 TCP LISTEN 포트들 — portListenerPids 의 역방향. */
export async function pidListeningPorts(pids: number[]): Promise<number[]> {
  if (pids.length === 0) return [];
  const wanted = new Set(pids);
  const windows = currentPlatform() === "win32";
  const args = windows
    ? ["-a", "-n", "-o"]
    : ["-a", "-p", pids.join(","), "-iTCP", "-sTCP:LISTEN", "-Fn"];
  const stdout = await new Promise<string>((resolve, reject) =>
    execFile(
      windows ? "netstat" : "lsof",
      args,
      { timeout: 10_000, shell: windows },
      (error, out) => (error ? reject(error) : resolve(String(out))),
    ),
  ).catch(() => "");
  const ports = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    if (windows) {
      // `TCP  0.0.0.0:3000  0.0.0.0:0  LISTENING  4321` — the local address
      // names the port, the last column owns it.
      const columns = line.trim().split(/\s+/);
      if (columns.length < 5 || columns[3] !== "LISTENING") continue;
      const pid = Number(columns[4] ?? NaN);
      if (!wanted.has(pid)) continue;
      const port = Number((columns[1] ?? "").split(":").pop());
      if (Number.isInteger(port) && port > 0) ports.add(port);
    } else {
      // `-Fn` prints one field per line: `p<pid>` then `n<host>:<port>` —
      // the port sits after the last colon of each `n` line.
      if (!line.startsWith("n")) continue;
      const port = Number(line.slice(1).split(":").pop()?.replace(/]$/, ""));
      if (Number.isInteger(port) && port > 0) ports.add(port);
    }
  }
  return [...ports];
}

/** pid 아래의 전체 프로세스 트리 — 자식, 손자… (pid 자신은 제외). */
export async function descendantPids(pid: number): Promise<number[]> {
  const windows = currentPlatform() === "win32";
  const stdout = await new Promise<string>((resolve, reject) =>
    execFile(
      windows ? "powershell" : "ps",
      windows
        ? [
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId",
          ]
        : ["-axo", "pid=,ppid="],
      { timeout: 10_000, shell: windows },
      (error, out) => (error ? reject(error) : resolve(String(out))),
    ),
  ).catch(() => "");
  const children = new Map<number, number[]>();
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/).map(Number);
    const child = columns[0];
    const parent = columns[1];
    if (child === undefined || parent === undefined) continue;
    if (!Number.isInteger(child) || !Number.isInteger(parent)) continue;
    const list = children.get(parent) ?? [];
    list.push(child);
    children.set(parent, list);
  }
  const found: number[] = [];
  const queue = [pid];
  const seen = new Set<number>([pid]);
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of children.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
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

/**
 * 주인이 죽은 채 남은 미리보기 기록들을 거둔다 — 기록을 남긴 인스턴스가
 * 죽었는데 그 미리보기 서버만 살아 있으면, 다음 인스턴스가 그 포트를
 * "남의 것"으로 읽고 멈추는 길을 막기 위해 리스너를 죽이고 기록을 지운다.
 * 파일 하나의 실패가 나머지를 막지 않는다.
 */
export async function sweepOrphanedPreviewClaims(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const dir = env.COLO_DESIGN_RUN_DIR ?? join(COLO_DESIGN_DIR, "run");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // 기록 폴더가 없으면 거둘 것도 없다.
  }
  for (const name of names) {
    const match = /^preview-(\d+)\.json$/.exec(name);
    if (!match) continue;
    try {
      const port = Number(match[1]);
      const claim = readPreviewClaim(port, env);
      if (!claim || pidAlive(claim.instancePid)) continue;
      // A dead owner's listener pid may have been recycled by a stranger —
      // only kill it while it still holds THIS port (foreignLivePreviewClaim
      // makes the same check before trusting the record).
      if (claim.listenerPid !== null && pidAlive(claim.listenerPid)) {
        const holders = await portListenerPids(port);
        if (holders.includes(claim.listenerPid)) {
          try {
            process.kill(claim.listenerPid, "SIGKILL");
          } catch {
            // 이미 죽은 리스너 — 기록만 거두면 된다.
          }
        }
      }
      clearPreviewClaim(port, env);
    } catch {
      // 깨진 기록 하나가 나머지 청소를 막지 않는다.
    }
  }
}
