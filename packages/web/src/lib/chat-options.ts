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
 * 확인 방식 메뉴 행의 한 줄 설명 — 칩 팝오버가 읽는다(설정의 Choice 는
 * 자기 문단을 이미 갖는다). 행동 옆 설명은 인라인이라는 규칙의 몫: 모드가
 * 무엇을 묻고 무엇을 그냥 하는지, 고르기 전에 행이 말한다.
 */
export const MODE_MENU_HINT: Record<PermissionMode, string> = {
  default: "명령 실행 전에 물어봅니다",
  plan: "만들기 전에 계획을 먼저 보여 줍니다",
  acceptEdits: "안전하다고 본 명령까지 묻지 않고 실행합니다",
  dontAsk: "아무것도 묻지 않습니다",
  bypassPermissions: "아무것도 묻지 않고 바로 진행합니다",
};

/**
 * The 확인 방식 choices both menus offer — 설정 and the composer popover
 * alike, in widening order. `dontAsk` stays reachable through the API but off
 * the menus.
 *
 * acceptEdits is back on the menu by the owner's call, and it is the one row
 * here that is wider than its name: under it current CLI builds auto-approve
 * "safe Bash" without ever consulting the daemon's canUse gate — the one
 * place this tool refuses git history writes and tool-owned files. So the row
 * buys quiet edits (which Default already gives in-process) at the price of
 * shell commands nobody answered for. A planner who wants only the quiet
 * edits wants Default; this row is for one who also wants the shell quiet but
 * not as quiet as Bypass. 설정 says so in its own hint.
 */
export const SETTINGS_MODES: PermissionMode[] = [
  "default",
  "plan",
  "acceptEdits",
  "bypassPermissions",
];

/**
 * What the conversation starts on when nobody has chosen. Bypass
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
