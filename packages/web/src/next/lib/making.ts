import type { Block } from "../../lib/daemon-client";
import { isToolRunning } from "../../lib/progress.ts";
import { bucketOf } from "../../lib/tool-buckets.ts";

/**
 * 상태 줄의 단계 말(PLAN-UI §10 · U18) — `만드는 중 · 240초` 는 무엇을 하는지
 * 말하지 않으므로, 지금 도는 도구의 묶음이 말을 고른다(`화면을 살펴보는 중` ·
 * `화면 파일을 고치는 중` · `검사를 돌리는 중`). 묶음의 표는 대화록의 활동
 * 머리줄과 같은 사본(lib/tool-buckets.ts)이고, 도는지의 판정은 진행 시계와
 * 같은 것(lib/progress.ts)을 쓴다 — next/ 밖의 순수 모듈이라 가져왔다.
 */

type ToolBlock = Extract<Block, { type: "tool" }>;

/** 첫 턴의 안개가 걷히는 시간 — 첫 답은 레포를 읽느라 유난히 늦게 온다. */
export const FIRST_TURN_HINT_MS = 60_000;
/** 단계 말이 갈아 입기 전에 입던 옷을 입는 최소 시간 — 몇 초 사이의 말 바꿈이
 * 상태 줄 알약을 흔들지 않게. */
export const MAKING_HOLD_MS = 1500;

/** 답이 끝난 뒤 체크를 보이는 시간 — 조각이 곧장 사라지지 않게. */
export const MAKING_CHECK_MS = 600;

/** 단계 말의 종류 — `null` 은 묶음을 모르는 지금의 `만드는 중`. */
export type MakingPhase = "file" | "command" | "read" | null;

/**
 * 지금 보여야 할 단계 말 — 보이던 말은 최소 `MAKING_HOLD_MS` 동안 산다. 그보다
 * 빨리 밑의 단계가 바뀌면 입던 말을 계속 입고, 시간이 차면 지금의 단계로 곧장
 * 갈아입는다(그 사이의 단계는 건너뛴다). 첫 말은 곧장 보인다.
 */
export function heldPhase(
  shown: { phase: MakingPhase; at: number } | null,
  next: MakingPhase,
  now: number,
  holdMs: number = MAKING_HOLD_MS,
): { phase: MakingPhase; at: number } {
  if (shown === null) return { phase: next, at: now };
  if (shown.phase === next) return shown;
  if (now - shown.at < holdMs) return shown;
  return { phase: next, at: now };
}

/**
 * 지금 도는 도구의 묶음. 마지막 사용자 말 뒤의 도구(하위 에이전트의 것도
 * 한 턴으로 센다) 가운데 **아직 도는 것**의 마지막 하나가 말을 고른다; 도는
 * 것이 없으면 그 턴의 마지막 도구가 대신한다 — 답을 적는 사이에도 마지막
 * 걸음이 무엇이었는지 말하게. 도구가 없거나(생각 중 · 막 보낸 참) 이름을
 * 모르면 null — 상태 줄은 지금의 `만드는 중` 을 쓴다.
 */
export function makingPhase(blocks: Block[]): MakingPhase {
  let start = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]?.type === "user") {
      start = index + 1;
      break;
    }
  }
  let lastRunning: ToolBlock | null = null;
  let last: ToolBlock | null = null;
  for (const block of blocks.slice(start)) {
    if (block.type !== "tool") continue;
    last = block;
    if (isToolRunning(block)) lastRunning = block;
  }
  const chosen = lastRunning ?? last;
  return chosen === null ? null : bucketOf(chosen.name);
}

/**
 * 이 대화의 첫 턴인가 — 사용자의 말이 정확히 하나일 때. 첫 답의 기다림은
 * 처음 겪는 일이라 60초를 넘으면 한 마디 안내가 시계 뒤에 붙는다.
 */
export function firstTurn(blocks: Block[]): boolean {
  let sends = 0;
  for (const block of blocks) {
    if (block.type === "user") sends += 1;
  }
  return sends === 1;
}
