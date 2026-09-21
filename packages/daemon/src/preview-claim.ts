import { type ChildProcess, execFile, spawn } from "node:child_process";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { currentPlatform } from "./environment.js";

/**
 * 미리보기 서버 프로세스의 거둠과 읽기 — `this` 없는 순수 절차라 워크스페이스의
 * 상태 기계를 읽지 않고도 읽히고 검사된다.
 */

export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    // Detached on POSIX means the shell and its children share a process
    // group; signalling the group is what actually releases the port.
    if (currentPlatform() !== "win32" && child.pid) process.kill(-child.pid, signal);
    else if (signal === "SIGKILL" && child.pid) {
      // Windows 에는 프로세스 그룹 시그널이 없어 child.kill 은 셸만 죽이고
      // dev 서버는 살아 포트를 쥔다. 트리 킬의 Windows 정품이 taskkill /T.
      const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      taskkill.unref();
    } else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

/**
 * 우리가 예전에 띄웠던 서버의 흔적(pid 기록)을 거둔다 — 데몬이 hard-die 하면
 * detached 트리는 살아 남아 포트를 계속 쥐고, 다음 bring-up 의 killPreview 는
 * 손에 쥔 핸들이 없어 아무것도 못 한다 (좀비 서버 실사).
 */
export function killPidTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (currentPlatform() !== "win32") process.kill(-pid, signal);
    else if (signal === "SIGKILL") {
      const taskkill = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
      taskkill.unref();
    } else process.kill(pid, signal);
  } catch {
    // 이미 죽은 pid — 거둘 것이 없다.
  }
}

/**
 * pid 의 명령줄 — 기록된 pid 가 지금도 우리 미리보기 트리인지의 앵커다.
 * 읽지 못하면(죽었거나 플랫폼이 말을 안 듣거나) null.
 */
export async function pidCommandLine(pid: number): Promise<string | null> {
  if (currentPlatform() === "win32") return null; // wmc 제거 이후의 Windows 는 앵커 없이 보수 간다
  const stdout = await new Promise<string>((resolve, reject) =>
    execFile("ps", ["-p", String(pid), "-o", "command="], { timeout: 5_000 }, (error, out) =>
      error ? reject(error) : resolve(String(out)),
    ),
  ).catch(() => "");
  const line = stdout.trim();
  return line === "" ? null : line;
}

/**
 * 주어진 URL 이 실제로 응답하는지 — 판별을 세 가지로 나눈 것.
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

/** 주어진 pid 들이 쥐고 있는 TCP LISTEN 포트들 — 프로세스 트리의 소켓 스캔. */
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
