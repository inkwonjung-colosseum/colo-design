/**
 * 도구 이름표 (2026-09-23): 세 프로바이더가 같은 일을 다른 이름으로 부른다 —
 * Claude 의 `Edit`, Codex 의 `fileChange`, omp 의 `edit`. 이름을 아는 자리가
 * 둘이었다: omp 분류기(정책 — 카드를 받을지)와 턴 통계(측정 — 읽기·편집·
 * 실행 묶음). 통계 쪽 표가 omp 이름을 몰라 omp 턴은 전부 `other` 로 세고,
 * 첫 편집까지의 시간과 핀 적중은 늘 null 이었다(베타 9/20~9/23, 핀 턴 13개
 * 전부). README 가 "CLAUDE.md 의 성적표" 라 부르는 잣대가 실제로 쓰는
 * 프로바이더에서 눈을 감고 있던 것이다.
 *
 * 그래서 이름은 여기 한 곳에 산다. 코어에 두는 이유는 tool-paths 와 같다 —
 * 드라이버가 코어를 import 하는 방향만 허용된다. omp 분류기는 자기 표를
 * 여기서 가져가고, 통계는 세 표의 합을 가져간다.
 */

/** omp — 읽기만 하는 도구. 이 밖은 카드를 받는다(알 수 없는 도구는 위험한 쪽). */
export const OMP_READ_TOOLS: Record<string, true> = {
  read: true,
  glob: true,
  grep: true,
  ast_grep: true,
  web_search: true,
  recall: true,
};

/** omp — 파일 경로를 인자로 드는 편집 도구. 데몬의 쓰기 정책이 직접 답한다. */
export const OMP_EDIT_TOOLS: Record<string, true> = {
  edit: true,
  write: true,
  ast_edit: true,
  notebook_edit: true,
  memory_edit: true,
};

/** omp — 코드를 돌리는 도구. 카드의 본문에 명령/코드를 싣는다. */
export const OMP_EXEC_TOOLS: Record<string, true> = {
  bash: true,
  eval: true,
  computer: true,
  debug: true,
};

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
 * 통계용 합표 — 세 프로바이더의 이름을 한 묶음으로 본다. 통계는 "그 턴이
 * 레포를 읽고 · 고치고 · 돌렸는가" 를 세는 것이라, 레포 파일이 아닌 것을
 * 고치는 omp 의 `memory_edit` 는 편집에서 뺀다 — 그것이 첫 편집으로 잡히면
 * 방향 잡기가 끝난 시각이 거짓이 된다.
 */
export const STATS_READ_TOOLS: Record<string, true> = {
  ...CLAUDE_READ_TOOLS,
  ...CODEX_READ_TOOLS,
  ...OMP_READ_TOOLS,
};
export const STATS_EDIT_TOOLS: Record<string, true> = (() => {
  const { memory_edit: _memory, ...repoEdits } = OMP_EDIT_TOOLS;
  return { ...CLAUDE_EDIT_TOOLS, ...CODEX_EDIT_TOOLS, ...repoEdits };
})();
export const STATS_EXEC_TOOLS: Record<string, true> = {
  ...CLAUDE_EXEC_TOOLS,
  ...CODEX_EXEC_TOOLS,
  ...OMP_EXEC_TOOLS,
};
