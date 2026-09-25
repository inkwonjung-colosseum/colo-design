/**
 * 세 프로바이더가 같은 일을 다른 이름으로 부른다 — Claude 의 `Edit`, Codex 의
 * `fileChange`, omp 의 `edit`. 이름의 원본은 데몬의 tool-names.ts 다(통계의
 * 읽기 · 편집 · 실행 묶음). 이 표는 그 묶음을 웹이 나눠 쓰는 사본이라 — 대화록의
 * 활동 머리줄(components/transcript/activity.tsx)과 상태 줄의 단계 말
 * (next/lib/making.ts)이 함께 읽는다. 그쪽에 이름이 늘면 여기에도 는다.
 */
const TOOL_BUCKETS: Record<string, "file" | "command" | "read"> = {
  // Claude Code
  Write: "file",
  Edit: "file",
  MultiEdit: "file",
  NotebookEdit: "file",
  Bash: "command",
  Read: "read",
  Glob: "read",
  Grep: "read",
  LS: "read",
  // Codex — app-server 의 item 종류와 승인 요청의 이름
  fileChange: "file",
  applyPatch: "file",
  apply_patch: "file",
  edit_file: "file",
  write_file: "file",
  commandExecution: "command",
  execCommand: "command",
  exec_command: "command",
  run_command: "command",
  shell: "command",
  Shell: "command",
  view: "read",
  view_file: "read",
  read_file: "read",
  // omp
  edit: "file",
  write: "file",
  ast_edit: "file",
  notebook_edit: "file",
  bash: "command",
  eval: "command",
  read: "read",
  glob: "read",
  grep: "read",
  ast_grep: "read",
};

/** 도구 이름의 묶음 — 표에 없는 이름(모르는 도구)은 null. */
export function bucketOf(name: string): "file" | "command" | "read" | null {
  return TOOL_BUCKETS[name] ?? null;
}
