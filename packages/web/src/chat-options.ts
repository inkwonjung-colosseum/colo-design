import type { EffortLevel, PermissionMode, SessionModelInfo } from "@colo-design/protocol";

/**
 * How the three conversation settings are worded.
 *
 * Two places offer them — 설정 and the composer's own popover — from one
 * list, so the two can never disagree about what "전부 맡기기" means.
 *
 * Every label is read by a planner, not a developer: plain Korean only —
 * except the model rows, which quote the CLI verbatim (see modelWords).
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

/**
 * What the conversation starts on when nobody has chosen (PLAN D10). 전부 맡기기
 * (`--dangerously-skip-permissions`) is the owner's call: a planner's first
 * turn must not stall on a 확인 카드 they never knew about. Anyone who wants
 * the questions back picks 물어보고 진행, and that choice is remembered.
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "bypassPermissions";

/**
 * What a model row says, exactly as the CLI said it: `displayName` leads the
 * row, `description` rides along as the hint. This app rewrites neither — a
 * hand-tuned label ("Sonnet 5", "자동 (추천)") or a hand-written hint goes
 * stale the day the CLI's list changes, and says something the CLI never
 * said; the raw strings cannot lie about what is on offer.
 */
export function modelWords(model: SessionModelInfo): {
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
 * The CLI lists an alias row and the pinned id it resolves to as two rows with
 * the same displayName; a planner would see "Opus" twice with nothing to
 * choose between. First one wins.
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
    .filter((row, index, all) => all.findIndex((other) => other.label === row.label) === index);
}
