import type { EffortLevel, SessionModelInfo } from "@colo-design/protocol";

/**
 * How the conversation settings are named.
 *
 * Two places offer them — 설정 and the composer's own toolbar — from one
 * list, so the two can never disagree about what a value means.
 *
 * 확인 방식은 더 이상 설정이 아니다(2026-09-23): 모든 대화가 바로 진행
 * (bypass)으로만 돈다. 남은 설정은 모델과 생각 시간이고, 그 이름은 CLI 의
 * 것으로 남는다 — 그 둘은 이 도구가 고른 말이 아니라 벤더가 파는 이름이고,
 * 바꿔 적으면 릴리스 노트와 어긋난다.
 */

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

/**
 * 생각 시간 메뉴 행의 한 줄 설명 — Low/High 같은 CLI 단어가 혼자 서면
 * 비개발자에게는 저울눈금이 아니라 외국어다. 이름은 CLI 의 것으로
 * 남기고(무엇을 보냈는지 칩이 말한다), 무게는 이 한 줄이 읽는다:
 * 왼쪽은 빠르고 오른쪽은 깊다는 저울의 눈금 설명.
 */
export const EFFORT_HINT: Record<EffortLevel, string> = {
  low: "가장 빠르게 답합니다 — 가벼운 질문에",
  medium: "대부분의 질문에 알맞은 속도입니다",
  high: "깊게 생각하고 꼼꼼하게 답합니다",
  xhigh: "어려운 문제를 오래 들여다봅니다",
  max: "시간이 걸려도 최선의 답을 찾습니다",
};

/**
 * What a model row says, exactly as the CLI said it: `displayName` leads the
 * row, `description` rides along as the hint 설정 reads. This app rewrites
 * neither — a hand-tuned label ("Sonnet 5", "자동 (추천)") or a hand-written
 * hint goes stale the day the CLI's list changes, and says something the CLI
 * never said; the raw strings cannot lie about what is on offer.
 */
function modelWords(model: SessionModelInfo): {
  label: string;
  hint: string;
} {
  return { label: model.displayName, hint: model.description };
}

/**
 * The row that names the current model, tolerating either spelling the CLI
 * may have handed back (the alias the planner picked, or the id it resolved
 * to).
 */
export function modelRowOf(
  models: SessionModelInfo[],
  picked: string | null,
): SessionModelInfo | undefined {
  return models.find((model) => model.value === picked || model.resolvedModel === picked);
}

/**
 * The CLI lists an alias row and the pinned id it resolves to as two rows that
 * read alike — a planner would see "Opus" twice with nothing to choose between.
 * First one wins. Rows that read alike but say different ids stay: omp's
 * catalog repeats a displayName across providers, and the id is the only
 * thing telling those rows apart.
 */
export function modelOptions(
  models: SessionModelInfo[],
  current: SessionModelInfo | undefined,
): Array<{
  value: string | null;
  label: string;
  hint?: string;
  picked: boolean;
}> {
  return models
    .map((model) => {
      const words = modelWords(model);
      return {
        value: model.value,
        label: words.label,
        ...(words.hint ? { hint: words.hint } : {}),
        picked: model === current,
      };
    })
    .filter(
      (row, index, all) =>
        all.findIndex((other) => other.label === row.label && other.hint === row.hint) === index,
    );
}
