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
 *
 * 하위 작업이 한 말(`agentId !== null`)은 답이 아니다: 보조
 * 에이전트의 수다까지 세면 되감기가 가리키는 k 번째 답이 밀려 엉뚱한 턴을
 * 버린다. 세는 것은 메인 스레드가 계획자에게 한 말뿐이다.
 */
export function answerTurnNumbers(blocks: Block[]): Map<string, number> {
  let prompts = 0;
  const turns = new Map<string, number>();
  for (const block of blocks) {
    if (block.type === "user") prompts += 1;
    // 값이 없는 블록(테스트의 얇은 조각, 옛 기록)은 메인의 말로 본다: 답을
    // 잃는 쪽이 하나 더 세는 쪽보다 나쁘다 — 되감기가 가리킬 답이 사라진다.
    else if (block.type === "text" && !block.agentId) {
      turns.set(block.id, Math.max(prompts, 1));
    }
  }
  return turns;
}
/**
 * 턴별 마지막 답의 블록 id — 턴 번호 → 그 턴의 마지막 답. 되돌리기 · 다시
 * 요청은 턴 단위 행동이다(같은 턴의 답들이 가리키는 체크포인트가 하나이므로)
 * — 답 카드마다 두르지 않고 그 턴의 마지막 답 하나에만 놓는다. 판정은
 * answerTurnNumbers 의 셈을 그대로 산다: 메인 스레드의 답만 후보다.
 */
export function lastAnswerPerTurn(blocks: Block[]): Map<number, string> {
  const last = new Map<number, string>();
  for (const [id, turn] of answerTurnNumbers(blocks)) last.set(turn, id);
  return last;
}

/**
 * 턴이 낸 답의 전문 — 턴 끝 블록 id → 그 턴의 답 텍스트 전부. 도구 사이에서
 * 나뉜 조각들을 빈 줄로 이어 붙여 한 번의 복사로 돌려 주는 게 목적이다. 답의
 * 판정은 answerTurnNumbers 와 같고(메인 스레드의 text 블록만), 답 없이 끝난
 * 턴은 목록에 들지 않는다.
 */
export function turnAnswerText(blocks: Block[]): Map<string, string> {
  const parts: string[] = [];
  const whole = new Map<string, string>();
  for (const block of blocks) {
    if (block.type === "user") {
      parts.length = 0;
    } else if (block.type === "text" && !block.agentId) {
      parts.push(block.text);
    } else if (block.type === "turn" && parts.length > 0) {
      whole.set(block.id, parts.join("\n\n"));
    }
  }
  return whole;
}
