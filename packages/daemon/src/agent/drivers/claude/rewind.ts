// ---------------------------------------------------------------------------
// 되감기의 절단점 (PLAN D95 §9) — 순수 함수, 단위 테스트가 케이스를 박는다.
// ---------------------------------------------------------------------------

export interface RewindCutoff {
  /** The chain uuid the truncated resume keeps up to; null when k = 1. */
  cut: string | null;
  /** The discarded turn's prompt uuid, per `resumeDropsTurn`. */
  drops: string | null;
  answerCount: number;
}

/** A user message that STARTED a turn: not a tool-result carrier, not synthetic. */
export function isPrompt(message: Record<string, unknown>): boolean {
  if (message.type !== "user") return false;
  if (message.isSynthetic === true) return false;
  const content = message.message as { content?: unknown } | undefined;
  const value = content?.content;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) {
    return !value.some((block) => (block as { type?: unknown })?.type === "tool_result");
  }
  return false;
}

/** 되감기가 프롬프트를 찾는 창 — 대화록 전체에서 k 번째를 읽는다(제한 없이). */
export const REWIND_HISTORY_LIMIT = 100_000;

/**
 * k 번째 답을 버리는 절단점: kept = prompt[k] 바로 앞의 마지막 체인 항목
 * (도구 결과 캐리어가 뒤에 있으면 그것 — SDK 문서의 규칙), drops = prompt[k].
 */
export function resolveRewindCutoff(
  raw: Array<Record<string, unknown>>,
  turn: number,
): RewindCutoff | null {
  const promptIndexes: number[] = [];
  raw.forEach((message, index) => {
    if (isPrompt(message)) promptIndexes.push(index);
  });
  if (turn < 1 || turn > promptIndexes.length) return null;
  const start = promptIndexes[turn - 1]!;
  const kept = start > 0 ? raw[start - 1] : null;
  const keptUuid = typeof kept?.uuid === "string" ? kept.uuid : null;
  const dropsUuid = typeof raw[start]?.uuid === "string" ? (raw[start]!.uuid as string) : null;
  return {
    cut: turn === 1 ? null : keptUuid,
    drops: dropsUuid,
    answerCount: promptIndexes.length,
  };
}
