/**
 * 기계 동작의 한국어 이름 (PLAN D37). The transcript's tool rows and the
 * permission card show these instead of the CLI's English tool names; an
 * unknown name passes through unchanged. Lives in `protocol` because the
 * daemon's permission notices (daemon/src/translate.ts) and the web's
 * transcript need the same words — one file, or the two surfaces drift (the
 * M6 marker lesson).
 */
const NAMES: Record<string, string> = {
  Bash: "명령 실행",
  Read: "파일 읽기",
  Write: "파일 만들기",
  Edit: "파일 고치기",
  MultiEdit: "파일 고치기",
  NotebookEdit: "노트북 고치기",
  Glob: "파일 찾기",
  Grep: "파일 찾기",
  WebFetch: "웹 읽기",
  WebSearch: "웹 찾아보기",
  TodoWrite: "할 일 정리",
  Task: "보조 작업",
  AskUserQuestion: "질문",
  ExitPlanMode: "계획 승인",
  // 화면 세션의 colo-preview 도구들(PLAN D61): 전부 대화에서는 하나의 동작으로
  // 읽힌다 — "화면 보기". 실제 이름은 `mcp__colo-preview__screen_*` 로 오므로
  // toolLabel 이 접두를 떼고 찾는다.
  screen_list: "화면 보기",
  screen_open: "화면 보기",
  screen_screenshot: "화면 보기",
  screen_read: "화면 보기",
  screen_click: "화면 보기",
  screen_type: "화면 보기",
  screen_press: "화면 보기",
  screen_scroll: "화면 보기",
  screen_hover: "화면 보기",
  screen_console: "화면 보기",
};

/**
 * 계획 모드의 승인 도구. 권한 카드가 아니라 '만들 것' 카드로 그려야 하므로
 * 데몬(요청의 종별 판정)과 웹(카드 분기)이 같은 이름을 본다 — 두 표면이
 * 각자의 문자열로 판정하면 카드가 갈라진다(M6 마커의 교훈).
 */
export const PLAN_TOOL = "ExitPlanMode";

/** The Korean action name for a tool, or the raw name when unknown. */
export function toolLabel(name: string): string {
  // SDK 가 올린 MCP 도구는 `mcp__<서버>__<이름>` 로 온다: the server prefix
  // is plumbing, so the dictionary keys on the tool's own name. An unknown
  // tool still passes through with its full name — nothing here invents a
  // label the dictionary does not have.
  const bare = name.startsWith("mcp__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  return NAMES[bare] ?? name;
}
