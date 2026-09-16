import type { Block } from "./daemon-client";

/**
 * The screen captures — their own card rows, pulled out of the
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
 * (TodoWrite)와 캡처 카드 keep their place either way —
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
  // 하위 작업이 한 말은 답이 아니라 활동이다 — 도구 행과 같은 스위치를
  // 따른다. 그러지 않으면 작업 과정을 끈 테이프에 도구 없는 빈 활동 막대만
  // 남는다(이 파일이 막으려고 있는 바로 그것).
  if (block.type === "text" && block.agentId) return showTools;
  return true;
}

/**
 * 붙어 있는 생각 조각은 한 번의 생각이다. 한 턴의 Claude 는 도구를 부를 때마다
 * 생각을 새 블록으로 끊어 보내므로, `작업 과정 보기`가 꺼져 사이의 도구 행이
 * 빠지면 그 조각들이 서로 이웃이 된다 — 실사에서 대화가 접힌 "생각 중…" 줄
 * 여덟 개의 벽으로 열린 것이 이것이다. 이으는 것은 **같은 주체(agentId)의
 * 이웃한 조각**뿐이다: 하위 작업의 속말은 그 작업의 것이고, 도구 행이 보이는
 * 테이프에서는 애초에 이웃이 되지 않는다(활동 카드가 그 사이에 선다).
 */
export function mergeThinking(tape: Block[]): Block[] {
  const merged: Block[] = [];
  for (const block of tape) {
    const prev = merged[merged.length - 1];
    if (block.type === "thinking" && prev?.type === "thinking" && prev.agentId === block.agentId) {
      // 마지막 조각의 진행이 이어진 생각의 진행이다 — 앞 조각들은 이미 끝났다.
      merged[merged.length - 1] = {
        ...prev,
        text: `${prev.text.trimEnd()}\n\n${block.text.trimStart()}`,
        streaming: block.streaming,
      };
      continue;
    }
    merged.push(block);
  }
  return merged;
}
