import type { Block } from "./daemon-client";

/**
 * Whether a block belongs on the tape the planner actually sees — 설정의
 * `생각 과정 보기` · `작업 과정 보기` in one rule. Both switches drop their
 * blocks **before grouping** (Transcript): trimming after would leave
 * tool-only or thinking-only stretches as empty activity bars. 계획 카드
 * (TodoWrite) keeps its place either way — the plan is what the planner
 * reads, not the log of how.
 *
 * ChatColumn's 대기 줄 (turnlive) asks the same filter through `tailMoving`:
 * "is the tape's tail producing anything the planner can see?" The two call
 * sites must agree, or a turn that only runs hidden tools would show neither
 * a moving tape nor the waiting line — a running session that looks frozen.
 */
export function blockOnTape(block: Block, showThinking: boolean, showTools: boolean): boolean {
  if (block.type === "thinking") return showThinking;
  if (block.type === "tool") {
    if (block.name === "TodoWrite") return true;
    return showTools;
  }
  // 하위 작업이 한 말은 답이 아니라 활동이다 — 도구 행과 같은 스위치를
  // 따른다. 그러지 않으면 작업 과정을 끈 테이프에 도구 없는 빈 활동 막대만
  // 남는다(이 파일이 막으려고 있는 바로 그것).
  if (block.type === "text" && block.agentId) return showTools;
  return true;
}

/**
 * 테이프 꼬리가 지금 움직이는가 — 대기 표시(turnlive)의 판정 한 줄. 보일
 * 것이 하나도 없는 첫 초뿐 아니라, 도구와 도구 사이 모델이 생각만 하는
 * 구간(생각 과정은 기본 숨김)에도 테이프는 새로 그리는 것이 없다 — 실사에서
 * 그 빈 자리마다 화면이 통째로 조용해졌다(스피너도 시계도 없는 턴). 꼬리에
 * 도는 도구나 흐르는 말이면 참이 아니다 — 테이프 자체가 말하는 중이니 줄은
 * 비켜 선다.
 *
 * 도는 판정의 주인은 progress 의 `isToolRunning` 이다 — 이 모듈은 node 의
 * `.mts` 테스트가 직접 잦는 순수 자리라 런타임 상대 import 를 갖지 않으므로,
 * 주입받아 쓴다(호출부 ChatColumn 이 잇는다).
 */
export function tailMoving(
  blocks: Block[],
  showThinking: boolean,
  showTools: boolean,
  isRunning: (block: Extract<Block, { type: "tool" }>) => boolean,
): boolean {
  // Transcript 가 그리는 것과 같은 테이프를 물어야 한다 — 같은 거르기,
  // 같은 이어 붙이기. 그러지 않으면 화면엔 움직임이 있는데 줄이 서거나 그 반대다.
  const tape = mergeThinking(blocks.filter((block) => blockOnTape(block, showThinking, showTools)));
  const last = tape.at(-1);
  if (!last) return false;
  if (last.type === "tool") return isRunning(last);
  if (last.type === "text" || last.type === "thinking") return last.streaming;
  return false;
}

/**
 * 붙어 있는 생각 조각은 한 번의 생각이다. 한 턴의 AI 는 도구를 부를 때마다
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
