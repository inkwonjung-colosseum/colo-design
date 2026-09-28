import type { ChatEvent } from "@nova-design/protocol";

/**
 * 다시 연 대화에 턴 끝을 세운다 (PLAN-THREAD T-1). 라이브는 턴마다 `turn.end`
 * 가 나가지만 저장된 대화록에는 그 자리가 없다 — 세 드라이버의 재생(claude
 * import.ts · codex replayRollout · omp replayOmpSession) 어느 것도 내지
 * 않으므로, 드라이버마다 고치는 대신 재생 결과에 한 번 입힌다. 턴 끝 블록이
 * 있어야 웹이 `고친 화면` 카드와 정산 줄(걸린 시간 · 여기서 새 대화)을 그린다.
 *
 * 턴은 `user.echo` 하나부터 다음 `user.echo` 앞까지다. 본 에이전트
 * (agentId === null)의 답 — `text.done` · `thinking.delta` · `tool.start` —
 * 이 하나라도 든 턴만 닫는다: 답 없는 턴(말만 있고 답이 오기 전에 끊긴 것)에
 * 정산 줄을 서게 하지 않고, 하위 에이전트의 말만 든 턴도 마찬가지다. 이미
 * `turn.end` 가 있는 턴에는 겹쳐 넣지 않는다.
 *
 * 재생에는 시각 · 비용이 없으므로 정산 칸은 전부 비워 넣는다 — 줄은
 * `turn.end` 가 섰다는 사실로 서지 그 숫자들은 알 수 없다.
 */
const END: ChatEvent = {
  kind: "turn.end",
  subtype: "success",
  isError: false,
  costUsd: null,
  numTurns: null,
  durationMs: null,
  resultText: null,
};

/** CLI 가 중단된 말로 저장하는 표식 — "for tool use" 변종까지 같은 머리다. */
const INTERRUPTED = "[Request interrupted by user";

export function closeReplayTurns(events: ChatEvent[], options: { open: boolean }): ChatEvent[] {
  const out: ChatEvent[] = [];
  /** 지금 턴에 본 에이전트의 답이 들었는가. */
  let answered = false;
  /** 지금 턴에 이미 `turn.end` 가 섰는가. */
  let closed = false;

  for (const event of events) {
    if (event.kind === "user.echo") {
      // 중단 표식 앞의 턴은 닫지 않는다 — 라이브에서도 멈춘 턴에 정산 줄은
      // 없고, 웹은 그 말을 `멈췄어요` 한 줄로 그린다.
      if (answered && !closed && !event.text.trimStart().startsWith(INTERRUPTED)) {
        out.push({ ...END });
      }
      answered = false;
      closed = false;
    } else if (
      (event.kind === "text.done" ||
        event.kind === "thinking.delta" ||
        event.kind === "tool.start") &&
      event.agentId === null
    ) {
      answered = true;
    } else if (event.kind === "turn.end") {
      closed = true;
    }
    out.push(event);
  }

  // 꼬리: 마지막 턴이 답을 들었으면 끝에 붙인다. `open`(그 세션의 턴이 도는
  // 중)이면 붙이지 않는다 — 도는 턴을 끝난 것처럼 그리면 안 된다.
  if (!options.open && answered && !closed) {
    out.push({ ...END });
  }
  return out;
}
