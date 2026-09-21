import type { EffortLevel, PermissionMode, SessionModelInfo } from "@colo-design/protocol";

/**
 * How the three conversation settings are named.
 *
 * Two places offer them — 설정 and the composer's own toolbar — from one
 * list, so the two can never disagree about what a mode means.
 *
 * 확인 방식의 이름은 **결과의 말**이다(P3-1). 예전에는 CLI 의 단어를 그대로
 * 세웠고, 그 논거는 "칩이 무엇을 보냈는지 정확히 말한다" 였다 — 터미널을 아는
 * 사람에게는 맞는 말이다. 이 도구의 사용자는 그 사람이 아니다: `Bypass` 는
 * 무엇을 우회하는지, `Accept Edits` 는 무엇을 받아들이는지 화면 어디에도 없는
 * 말이고, 고르는 순간 무슨 일이 일어날지 아무것도 알려 주지 않는다. 값과
 * 동작은 그대로다 — 선로로 나가는 것은 여전히 `bypassPermissions` 다. 바뀐
 * 것은 사람이 읽는 글자뿐이다.
 *
 * 모델과 생각 시간의 이름은 CLI 의 것으로 남는다: 그 둘은 이 도구가 고른 말이
 * 아니라 벤더가 파는 이름이고, 바꿔 적으면 릴리스 노트와 어긋난다.
 */

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

export const MODE_LABEL: Record<PermissionMode, string> = {
  default: "실행 전에 물어보기",
  plan: "계획 먼저 보기",
  acceptEdits: "화면 수정은 바로",
  dontAsk: "묻지 않기",
  bypassPermissions: "바로 진행",
};

/**
 * 확인 방식 메뉴 행의 한 줄 설명 — 칩 팝오버가 읽는다(설정의 Choice 는
 * 자기 문단을 이미 갖는다). 행동 옆 설명은 인라인이라는 규칙의 몫: 모드가
 * 무엇을 묻고 무엇을 그냥 하는지, 고르기 전에 행이 말한다.
 */
export const MODE_MENU_HINT: Record<PermissionMode, string> = {
  default: "명령을 돌리기 전에 카드로 물어봅니다",
  plan: "만들기 전에 무엇을 만들지 보여 줍니다",
  acceptEdits: "안전한 수정은 묻지 않고 진행합니다",
  dontAsk: "아무것도 묻지 않습니다",
  bypassPermissions: "아무것도 묻지 않습니다",
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
