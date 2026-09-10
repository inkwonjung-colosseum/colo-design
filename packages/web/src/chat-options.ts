import type { EffortLevel, PermissionMode, SessionModelInfo } from "@cds-design/protocol";

/**
 * How the three conversation settings are worded.
 *
 * Two places offer them — 설정 and the composer's own popover — from one
 * list, so the two can never disagree about what "전부 맡기기" means.
 *
 * Every label is read by a planner, not a developer: plain Korean only.
 */

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: "짧게",
  medium: "보통",
  high: "길게",
  xhigh: "더 길게",
  max: "가장 길게",
};

export const EFFORT_HINT: Record<EffortLevel, string> = {
  low: "빨리 답해요",
  medium: "무난하게 생각해요",
  high: "좀 더 생각하고 답해요",
  xhigh: "오래 생각해서 꼼꼼히 답해요",
  max: "가장 오래 생각해요. 그만큼 느려요",
};

export const MODE_LABEL: Record<PermissionMode, string> = {
  default: "물어보고 진행",
  plan: "계획만 세우기",
  acceptEdits: "화면 수정은 바로",
  dontAsk: "묻지 않기",
  bypassPermissions: "전부 맡기기",
};

export const MODE_HINT: Record<PermissionMode, string> = {
  default: "바꾸기 전에 먼저 확인해요",
  plan: "실제로 바꾸지 않고 무엇을 할지만 알려줘요",
  acceptEdits: "화면 파일 수정은 확인 없이, 나머지는 물어봐요",
  dontAsk: "확인 없이 진행해요",
  bypassPermissions: "확인 없이 알아서 진행해요. 빠른 대신 조심해야 해요",
};

/**
 * The 확인 방식 choices both menus offer — 설정 and the composer popover
 * alike. `dontAsk` stays reachable through the API but off the menus:
 * 전부 맡기기 covers it.
 */
export const SETTINGS_MODES: PermissionMode[] = [
  "default",
  "plan",
  "acceptEdits",
  "bypassPermissions",
];

/** What the conversation starts on when nobody has chosen (PLAN D10). */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "default";

/**
 * Planners asked to see which Claude they are choosing, by name. The CLI hands
 * over a short label ("Sonnet") plus a description whose head carries the
 * version the planner also sees in Claude Code ("Sonnet 5 · Efficient for
 * routine tasks"), so the name leads the row and the Korean guidance — the part
 * that tells a non-developer when to reach for it — rides along as the hint.
 */
const MODEL_HINT: Array<{ match: (id: string) => boolean; hint: string }> = [
  { match: (id) => id.includes("fable"), hint: "제일 어려운 작업용. 그만큼 느려요" },
  { match: (id) => id.includes("opus"), hint: "복잡하거나 긴 기획서에 좋아요" },
  { match: (id) => id.includes("sonnet"), hint: "속도와 결과가 균형 잡혀 있어요" },
  { match: (id) => id.includes("haiku"), hint: "간단한 수정에 좋아요" },
];

/** `Sonnet 5 · Efficient…` → `Sonnet 5`; `Opus 5 with 1M context` → `Opus 5 (1M)`. */
function modelName(model: SessionModelInfo): string {
  const head = model.description.split("·")[0]?.trim().replace(/\s+with 1M context$/i, " (1M)");
  return head || model.displayName;
}

export function modelWords(model: SessionModelInfo): { label: string; hint: string } {
  const name = modelName(model);
  // Alias rows ("sonnet") and id rows ("claude-sonnet-5") both have to find
  // their family, so whichever the CLI sent is what gets matched.
  const guide = MODEL_HINT.find((entry) =>
    entry.match(`${model.value} ${model.resolvedModel ?? ""}`.toLowerCase()),
  )?.hint;
  // `default` is the CLI's own recommendation, so that is what the row says;
  // the model it resolves to today rides in the hint, where it can change
  // without the chip ever lying about what was picked.
  if (model.value === "default") {
    return { label: "자동 (추천)", hint: `${name} · 대부분의 화면 작업에 알맞아요` };
  }
  return { label: name, hint: guide ?? "" };
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
 * The CLI lists an alias row and the pinned id it resolves to as two rows with
 * the same name; a planner would see "Opus 5 (1M)" twice with nothing to
 * choose between. First one wins.
 */
export function modelOptions(
  models: SessionModelInfo[],
  current: SessionModelInfo | undefined,
): Array<{ value: string | null; label: string; hint?: string; picked: boolean }> {
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
    .filter((row, index, all) => all.findIndex((other) => other.label === row.label) === index);
}
