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

const MODE_LABEL: Record<PermissionMode, string> = {
  default: "Default",
  plan: "Plan",
  acceptEdits: "Accept Edits",
  dontAsk: "Don't Ask",
  bypassPermissions: "Bypass",
};

/**
 * 확인 방식의 사람 말 — 칩과 설정이 쓰는 어휘다. CLI 원명은 버리지 않는다 —
 * 메뉴 행에서 괄호 안 부제로 남아 검색·붙여넣기·터미널 매칭이 계속 먹히게
 * (위 MODE_LABEL 주석의 근거는 유효하다).
 */
export const MODE_LABEL_KO: Record<PermissionMode, string> = {
  default: "물어보고 실행",
  plan: "계획만 세우기",
  acceptEdits: "편집은 바로 실행",
  dontAsk: "물어보지 않기",
  bypassPermissions: "바로 실행",
};

/** 메뉴 행이 말하는 이름: 사람 말이 앞서고 CLI 원명이 조용히 따라간다. */
export function modeMenuLabel(mode: PermissionMode): string {
  return `${MODE_LABEL_KO[mode]} (${MODE_LABEL[mode]})`;
}

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
 * 생각 시간 행의 한 줄 — Low/High 만으로는 무엇이 달라지는지 알 수 없어서,
 * 오를수록 꼼꼼하고 느려진다는 축을 각 행이 말한다.
 */
export const EFFORT_MENU_HINT: Record<EffortLevel, string> = {
  low: "빠르게 답합니다",
  medium: "보통의 꼼꼼함",
  high: "더 오래, 더 꼼꼼하게",
  xhigh: "가장 꼼꼼한 단계 아래",
  max: "가장 오래, 가장 꼼꼼하게",
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
 * 빠르게를 지금 쓸 수 없는 이유를 사람의 말로. 키는 CLI 의
 * `fast_mode_disabled_reason` 그대로다 — 모르는 사유가 오면 옮기지 않고
 * 일반적인 한 줄로 말한다(지어낸 번역보다 낫다).
 */
export const FAST_BLOCKED_WORDS: Record<string, string> = {
  free: "지금 요금제로는 빠르게를 쓸 수 없습니다",
  extra_usage_disabled: "추가 사용이 꺼져 있어 빠르게를 쓸 수 없습니다",
  not_first_party: "이 API 제공자에서는 빠르게를 쓸 수 없습니다",
  disabled_by_env: "환경 설정이 빠르게를 막아 두었습니다",
  model_not_allowed: "이 모델은 빠르게를 받지 않습니다",
};

/**
 * 버튼이 풀 수 없는 사유들 — 여기 있는 것만 토글을 잠근다.
 *
 * 나머지는 잠글 이유가 없다: `preference` 와 `sdk_opt_in_required` 는 이
 * 버튼이 하는 일이 바로 그것이고(누르면 풀린다), `pending` 은 아직 답이
 * 오지 않은 것이며, `network_error` 와 `unknown` 은 지나간다. 그것들까지
 * 잠갔다면 빠르게는 켤 방법이 없는 기능이 된다.
 */
export const FAST_HARD_BLOCKS = new Set([
  "free",
  "extra_usage_disabled",
  "not_first_party",
  "disabled_by_env",
  "model_not_allowed",
]);

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
