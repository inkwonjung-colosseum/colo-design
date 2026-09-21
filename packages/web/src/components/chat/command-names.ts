/**
 * Korean names for the commands a planner meets often enough to deserve one.
 */

import type { SessionCommand } from "@colo-design/protocol";

/**
 * The few commands a planner meets often enough to deserve Korean names.
 * Every command the CLI advertises shows — the terminal's `/`, translated
 * only where the translation earns its place.
 */
export const COMMAND_LABEL: Record<string, { label: string; hint: string }> = {
  clear: {
    label: "대화 새로 시작",
    hint: "지금까지 대화를 지우고 처음부터 이야기해요",
  },
  compact: { label: "대화 정리", hint: "길어진 대화를 요약해서 이어가요" },
  usage: {
    label: "사용량 보기",
    hint: "5시간·주간 한도를 얼마나 썼는지 알려줘요",
  },
  context: {
    label: "대화 길이 보기",
    hint: "지금 대화가 얼마나 찼는지 알려줘요",
  },
};

/**
 * The palette reads the CLI, which answers only once a thread exists — and an
 * empty thread is exactly where a planner reaches for `/`. These four stand
 * in until a real answer lands, so the first keystroke still offers something
 * true.
 */
export const COMMAND_FALLBACK: SessionCommand[] = Object.keys(COMMAND_LABEL).map((name) => ({
  name,
  description: "",
  argumentHint: "",
  aliases: [],
}));
