import type { EffortLevel, PermissionMode, SessionModelInfo } from "@colo-design/protocol";

/**
 * How the three conversation settings are named.
 *
 * Two places offer them — 설정 and the composer's own toolbar — from one
 * list, so the two can never disagree about what "Bypass" means.
 *
 * The names are the CLI's own, not translations of it: a chip reading
 * `Opus 5 · High · Bypass` says exactly what was sent, and the words survive
 * being searched for, pasted into an issue, or matched against the terminal.
 * The per-option prose that used to ride beside them is gone — 설정 still
 * carries one line per field, which is where an explanation belongs.
 */

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

export const MODE_LABEL: Record<PermissionMode, string> = {
  default: "Default",
  plan: "Plan",
  acceptEdits: "Accept Edits",
  dontAsk: "Don't Ask",
  bypassPermissions: "Bypass",
};

/**
 * The 확인 방식 choices both menus offer — 설정 and the composer popover
 * alike. `dontAsk` and `acceptEdits` stay reachable through the API but off
 * the menus. acceptEdits left the menus because the CLI auto-approves "safe
 * Bash" under it without ever consulting the daemon's canUse gate — the one
 * place this tool refuses git history writes and tool-owned files. What the
 * row promised ("edits are quiet") Default already delivers in-process, so
 * the row sold nothing and unlocked the fence.
 */
export const SETTINGS_MODES: PermissionMode[] = ["default", "plan", "bypassPermissions"];

/**
 * What the conversation starts on when nobody has chosen (PLAN D10). Bypass
 * (`--dangerously-skip-permissions`) is the owner's call: a planner's first
 * turn must not stall on a 확인 카드 they never knew about. Anyone who wants
 * the questions back picks Default, and that choice is remembered.
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "bypassPermissions";

/**
 * What a model row says, exactly as the CLI said it: `displayName` leads the
 * row, `description` rides along as the hint 설정 reads. This app rewrites
 * neither — a hand-tuned label ("Sonnet 5", "자동 (추천)") or a hand-written
 * hint goes stale the day the CLI's list changes, and says something the CLI
 * never said; the raw strings cannot lie about what is on offer.
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
