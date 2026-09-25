/**
 * 첫 보내기가 실패한 갓 태어난 대화를 거둘까(W4 · 콜드 리뷰 N5) — 세션은 첫 말이
 * 나갈 때 태어나는데, 그 첫 보내기가 데몬에서 거절되면 아무것도 적히지 않은
 * 「새 화면」 대화가 하나씩 목록에 쌓인다. 순수 판정이라 시험이 src 에서 곧장
 * 읽는다(README 「순수 판정」과 같은 규칙).
 */

/**
 * 남은 것이 시스템의 안내(notice 블록)뿐인가 — 사용자의 말(user)도 AI 의 답(text ·
 * tool · turn)도 아닌 것. 거절된 첫 보내기의 자리에 데몬이 남겨 두는 것은 이 안내뿐이므로,
 * 이것만 남아 있으면 아무것도 전해진 적 없는 것과 같다.
 */
const onlySystemNotes = (blocks: readonly unknown[]) =>
  blocks.every(
    (block) =>
      typeof block === "object" && block !== null && "type" in block && block.type === "notice",
  );

/**
 * @param blocks 이번 보내기가 거절되기 전까지 그 세션에 적힌 블록 — 시스템의
 *   안내만 남아 있으면 아무 말도 전해진 적 없다는 뜻이다.
 * @param sentCount 이번 보내기를 포함해 이 세션에 시도한 보내기의 수.
 */
export function shouldDiscardOnFirstFailure(
  blocks: readonly unknown[],
  sentCount: number,
): boolean {
  // 두 번째 보내기부터는 세션이 이미 대화다 — 그대로 둔다.
  if (sentCount !== 1) return false;
  return onlySystemNotes(blocks);
}
