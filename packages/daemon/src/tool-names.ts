/**
 * 도구 이름표 (2026-09-23): 두 프로바이더가 같은 일을 다른 이름으로 부른다 —
 * Claude 의 `Edit`, Codex 의 `fileChange`. 턴 통계(측정 — 읽기·편집·실행
 * 묶음)가 그 이름을 모르면 그 턴은 전부 `other` 로 세고, 첫 편집까지의 시간과
 * 핀 적중은 늘 null 이 된다.
 *
 * 그래서 이름은 여기 한 곳에 산다. 코어에 두는 이유는 tool-paths 와 같다 —
 * 드라이버가 코어를 import 하는 방향만 허용된다. 통계는 두 표의 합을 가져간다.
 */

/** Claude Code SDK 의 도구 이름 — CLI 가 쓰는 대소문자 그대로. */
const CLAUDE_READ_TOOLS: Record<string, true> = {
  Read: true,
  Grep: true,
  Glob: true,
  LS: true,
  WebSearch: true,
};
const CLAUDE_EDIT_TOOLS: Record<string, true> = {
  Edit: true,
  Write: true,
  MultiEdit: true,
  NotebookEdit: true,
};
const CLAUDE_EXEC_TOOLS: Record<string, true> = { Bash: true };

/**
 * Codex — app-server 의 item 종류가 곧 이름이다(`drivers/codex/store.ts` ·
 * `session.ts` 가 tool.start 에 싸는 값). `execCommand` · `applyPatch` 는
 * 승인 요청의 이름이고, `commandExecution` · `fileChange` 는 진행 item 의
 * 이름이다 — 둘 다 같은 일이라 같은 묶음이다.
 */
const CODEX_READ_TOOLS: Record<string, true> = {
  webSearch: true,
  view: true,
  view_file: true,
  read_file: true,
};
const CODEX_EDIT_TOOLS: Record<string, true> = {
  fileChange: true,
  applyPatch: true,
  apply_patch: true,
  edit_file: true,
  write_file: true,
};
const CODEX_EXEC_TOOLS: Record<string, true> = {
  commandExecution: true,
  execCommand: true,
  Shell: true,
  shell: true,
  exec_command: true,
  run_command: true,
};

/**
 * 통계용 합표 — 두 프로바이더의 이름을 한 묶음으로 본다. 통계는 "그 턴이
 * 레포를 읽고 · 고치고 · 돌렸는가" 를 센다.
 */
export const STATS_READ_TOOLS: Record<string, true> = {
  ...CLAUDE_READ_TOOLS,
  ...CODEX_READ_TOOLS,
};
export const STATS_EDIT_TOOLS: Record<string, true> = {
  ...CLAUDE_EDIT_TOOLS,
  ...CODEX_EDIT_TOOLS,
};
export const STATS_EXEC_TOOLS: Record<string, true> = {
  ...CLAUDE_EXEC_TOOLS,
  ...CODEX_EXEC_TOOLS,
};
