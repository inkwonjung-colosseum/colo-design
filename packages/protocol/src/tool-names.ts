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
};

/** The Korean action name for a tool, or the raw name when unknown. */
export function toolLabel(name: string): string {
  // SDK 가 올린 MCP 도구는 `mcp__<서버>__<이름>` 로 온다: the server prefix
  // is plumbing, so the dictionary keys on the tool's own name. An unknown
  // tool still passes through with its full name — nothing here invents a
  // label the dictionary does not have.
  const bare = name.startsWith("mcp__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  return NAMES[bare] ?? name;
}
