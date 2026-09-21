/**
 * CLI 원샷의 공통 몸통 — machine-provider 가 고른 드라이버의 단답 턴을
 * 실제 CLI 로 돈다. 계약의 시간 조항이 여기 산다: 시간 안에 끝나지 않으면
 * 자식은 끊기고 답은 null — 시간 초과든 실패든 폴백에게는 같은 한 길이다.
 *
 * stdin 은 어떤 경우에도 닫는다(/dev/null). execFile 의 파이프 stdin 은 CLI
 * 를 가둔다 — codex 도 omp 도 "stdin 이 파이프면 프롬프트를 기다린다"는
 * 규칙이 있어, 답을 인자로 넘긴 우리 호출이 영원히 붙잡혔던 길이다(실측:
 * 30 초 타임아웃까지 무응답). execFile 은 stdio 를 못 바꾸므로 spawn 이 직접.
 */

import { spawn } from "node:child_process";

const MAX_STDOUT = 1_000_000;

export async function runCliOneShot(
  executable: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<string | null> {
  if (!executable) return null;
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const child = spawn(executable, args, {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    resolve(null);
  }, opts.timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (stdout.length > MAX_STDOUT) child.kill("SIGKILL");
  });
  child.on("error", () => {
    clearTimeout(timer);
    resolve(null);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve(code === 0 && stdout.length > 0 ? stdout : null);
  });
  return promise;
}
