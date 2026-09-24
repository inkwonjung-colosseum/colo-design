import { BROWSER_MCP_SERVER_NAME } from "../../../browser-launch.js";
import { BROWSER_TOOLS } from "../../../browser-tools.js";
import { OMP_EDIT_TOOLS, OMP_EXEC_TOOLS, OMP_READ_TOOLS } from "../../../tool-names.js";
import type { ToolClass } from "../../driver.js";

type Wire = Record<string, unknown>;

// 이름표는 코어(tool-names.ts)에 산다 — 턴 통계가 같은 표를 읽어야 omp 턴의
// 읽기·편집·실행이 `other` 로 뭉개지지 않는다(2026-09-23). 뜻은 그대로다:
// READ 는 카드 없이 지나고, EDIT 는 쓰기 정책이 답하고, EXEC 는 카드에 명령을 싣는다.
const READ_TOOLS = OMP_READ_TOOLS;
const EDIT_TOOLS = OMP_EDIT_TOOLS;
const EXEC_TOOLS = OMP_EXEC_TOOLS;

/**
 * `write` · `read` 의 대상이 파일이 아니라 xd:// 도구 장치일 수 있다 —
 * `write` 로 `xd://ast_edit` 에 인자를 적는 것이 omp 의 장치 호출 규약이다
 * (실측: 카드 제목이 `Allow tool: write / Path: xd://…`). 경로로 읽으면
 * 쓰기 정책이 존재하지 않는 파일을 판정하게 되므로, 스킴이 붙은 대상은
 * 파일이 아니라 실행으로 읽는다.
 */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** 인자에서 도구가 건드리는 파일 경로를 모은다 — 이름은 도구마다 다르다. */
function editPaths(args: Wire): string[] {
  const out: string[] = [];
  for (const key of ["path", "file", "file_path", "notebook_path"]) {
    const value = args[key];
    if (typeof value === "string" && value) out.push(value);
  }
  const many = args.paths;
  if (Array.isArray(many)) {
    for (const value of many) if (typeof value === "string" && value) out.push(value);
  }
  return out;
}

/**
 * omp 의 도구 이름 → 코어가 아는 정규 분류. 코어의 정책(쓰기 정책, git 이력
 * 거절)과 UI 의 카드가 공급자 어휘를 모르게 하는 번역이다.
 *
 * 브라우저 도구는 데몬이 host tool 로 실어 보낸 자기 도구라 `mcp` 로 읽는다 —
 * claude 의 `mcp__colo-browser__*` 와 같은 카드, 같은 항상 허용 기억.
 */
export function classifyOmpTool(name: string, args: Wire): ToolClass {
  if (BROWSER_TOOLS.some((tool) => tool.name === name)) {
    return { kind: "mcp", name, mcpServer: BROWSER_MCP_SERVER_NAME };
  }
  if (name.startsWith("mcp__")) {
    const server = name.split("__")[1];
    return { kind: "mcp", name, ...(server ? { mcpServer: server } : {}) };
  }
  if (name === "ask") return { kind: "question", name };
  if (EXEC_TOOLS[name]) {
    const command = String(args.command ?? args.code ?? args.expression ?? "");
    return { kind: "exec", name, ...(command ? { command } : {}) };
  }
  const paths = editPaths(args);
  const device = paths.find((value) => SCHEME.test(value));
  if (device) return { kind: "exec", name, command: device };
  if (EDIT_TOOLS[name]) return { kind: "edit", name, paths };
  if (READ_TOOLS[name]) return { kind: "read", name, paths };
  // lsp 의 rename·code_actions 는 apply 가 기본 참이라 파일을 고친다;
  // 나머지 액션은 읽기다. 경로를 모르므로 편집은 카드로만 답한다.
  if (name === "lsp") {
    const action = String(args.action ?? "");
    const writes = action === "rename" || action === "rename_file" || action === "code_actions";
    return writes && args.apply !== false
      ? { kind: "edit", name, paths: [] }
      : { kind: "read", name };
  }
  return { kind: "other", name, ...(paths.length ? { paths } : {}) };
}

/**
 * 승인 카드의 제목 첫 줄 — `Allow tool: <name>` — 에서 도구 이름을 꺼낸다.
 * omp 의 승인은 도구 호출과 별개의 UI 요청으로 오므로(실측: select 가
 * `tool_execution_start` 보다 먼저다), 어느 호출의 승인인지는 이 이름과
 * 직전 어시스턴트 메시지가 실은 호출 목록이 맞춘다.
 */
export function approvalToolName(title: string): string | null {
  const match = /^Allow tool:\s*(\S+)\s*$/m.exec(title.split("\n")[0] ?? "");
  return match?.[1] ?? null;
}
