/**
 * 재생 벤치(PLAN-HARNESS §3.A)의 접속 파일 — 개발 실행(`pnpm dev:desktop`)이
 * `NOVA_DESIGN_BENCH_ENDPOINT` 가 가리키는 파일에 데몬의 ws 주소를 한 줄로
 * 적어 두면, `scripts/bench` 의 클라이언트가 그 파일을 읽고 접속한다.
 * 패키징된 앱은 절대 쓰지 않는다 — 이 문은 개발 도구만을 위한 문이다.
 * electron 을 임포트하지 않는 순수 파일이다 — 데몬 쪽 시험이 이 파일을
 * 경로로 직접 읽는다(invite-discard.ts 와 같은 길).
 */

/** 적을 파일 — 패키징된 앱이거나 env 가 없으면 null. */
export function benchEndpointPath(env: NodeJS.ProcessEnv, isPackaged: boolean): string | null {
  if (isPackaged) return null;
  const file = env.NOVA_DESIGN_BENCH_ENDPOINT?.trim();
  return file ? file : null;
}

/** 파일의 본문 — JSON 한 줄. */
export function benchEndpointBody(input: { url: string; pid: number; now: Date }): string {
  return `${JSON.stringify({ url: input.url, pid: input.pid, startedAt: input.now.toISOString() })}\n`;
}

/** 본문에 적어 둔 pid — will-quit 의 지우기가 이것으로 자기 것인지 가린다. */
export function benchEndpointPid(raw: string): number | null {
  try {
    const data = JSON.parse(raw) as { pid?: unknown };
    return typeof data.pid === "number" && Number.isInteger(data.pid) ? data.pid : null;
  } catch {
    return null;
  }
}
