import type { Block } from "./daemon-client";

/**
 * The screen captures — their own card rows (PLAN D56), pulled out of the
 * activity fold. The visibility rule shares this one pattern with the
 * renderer: a capture is content, not machine traffic, so it must survive
 * every filter that trims the tape.
 */
export const SCREEN_SHOT_TOOL = /screen_screenshot$/;

/**
 * Whether a block belongs on the tape the planner actually sees — 설정의
 * `생각 과정 보기` · `작업 과정 보기` in one rule. Both switches drop their
 * blocks **before grouping** (Transcript): trimming after would leave
 * tool-only or thinking-only stretches as empty activity bars. 계획 카드
 * (TodoWrite, PLAN D48)와 캡처 카드(PLAN D56) keep their place either way —
 * the plan and the picture are what the planner reads, not the log of how.
 *
 * ChatColumn's 첫 초 line (turnlive) asks the same question of the same
 * blocks: "is there anything on the tape yet?" The two call sites must agree,
 * or a turn that only runs hidden tools would go quiet on the tape while the
 * start line already believes blocks have landed.
 */
export function blockOnTape(block: Block, showThinking: boolean, showTools: boolean): boolean {
  if (block.type === "thinking") return showThinking;
  if (block.type === "tool") {
    if (block.name === "TodoWrite" || SCREEN_SHOT_TOOL.test(block.name)) return true;
    return showTools;
  }
  // D98: 하위 작업이 한 말은 답이 아니라 활동이다 — 도구 행과 같은 스위치를
  // 따른다. 그러지 않으면 작업 과정을 끈 테이프에 도구 없는 빈 활동 막대만
  // 남는다(이 파일이 막으려고 있는 바로 그것).
  if (block.type === "text" && block.agentId) return showTools;
  return true;
}
