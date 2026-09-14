/**
 * 되감기·체크포인트의 턴 번호 — 데몬의 정의를 그대로 따른다.
 *
 * 데몬의 `turn` 은 **k 번째 사용자 프롬프트**다(세션이 보낸 말; 기계 턴 —
 * 코멘트 묶음 · 게이트 브리프 — 도 프롬프트다). 예전 Transcript 는 assistant
 * `text` 블록을 세며 그 수를 그대로 턴 번호로 썼다: 도구만 돌거나 중단된 턴은
 * 모자라고, 텍스트 → 도구 → 텍스트 턴은 넘친다 — 누른 답과 되돌려지는 스냅샷이
 * 어긋나던 것은 이 셈의 탓이다. 여기의 셈은 프롬프트를 센다: 어떤 답의 턴은
 * 그 답을 낸 프롬프트의 순번이다.
 */

import type { Block } from "./daemon-client";

/** Every user block is one sent prompt — planner's words and machine turns alike. */
export function promptTotal(blocks: Block[]): number {
  return blocks.filter((block) => block.type === "user").length;
}

/**
 * 각 assistant 답 블록의 턴 번호 — 그 답에 앞선(그 답을 낸) 프롬프트의 수.
 * 프롬프트 없이 홀로 남은 답(불완전한 복원)은 1로 매겨 유효한 번호를 지킨다.
 */
export function answerTurnNumbers(blocks: Block[]): Map<string, number> {
  let prompts = 0;
  const turns = new Map<string, number>();
  for (const block of blocks) {
    if (block.type === "user") prompts += 1;
    else if (block.type === "text") turns.set(block.id, Math.max(prompts, 1));
  }
  return turns;
}
