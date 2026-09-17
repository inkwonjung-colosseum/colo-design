/**
 * 인앱 브라우저 도구의 stdio MCP 서버 (인앱 브라우저 전환 3단계).
 *
 * claude·acp·codex 세션이 이 프로세스를 MCP 서버로 띄운다 — 기동 명세는
 * browser-launch.ts가 프로바이더별 와이어 형태(claude 레코드 / acp 배열 /
 * codex config 객체)로 빌드한다. 서버는 도구 호출을 데몬의 `/internal/browser`
 * 엔드포인트로 중계할 뿐이다. 상태 없음: 탭과 스냅샷의 진실은 데몬과 pane이
 * 소유하고, 여기는 와이어 번역만 한다.
 *
 * - env: COLO_DAEMON_URL (예: http://127.0.0.1:7823), COLO_BROWSER_SECRET
 *   (세션별 시크릿 — 데몬이 세션을 열 때 발급한다). 시크릿이 세션 스코프라
 *   이 프로세스는 자기 세션의 브라우저만 본다.
 * - 프로토콜: stdio 위 줄 단위 JSON-RPC 2.0 — initialize,
 *   notifications/initialized, tools/list, tools/call, ping. MCP SDK를 끌지
 *   않는다(의존성 없음): 이 파일은 데몬 번들과 분리된 별도 엔트리다.
 * - 실패도 도구 결과다: 데몬의 ok:false·401·404와 도달 실패는 모두 isError
 *   텍스트로 내려가 턴을 죽이는 대신 모델이 읽고 고치게 한다. 스냅샷 첨부
 *   (모든 액션 도구의 결과에 새 스냅샷)은 데몬 쪽 드라이버 계약이 담당한다.
 */

import { createInterface } from "node:readline";

/** 느슨한 와이어 형태 — 줄 단위 JSON을 그대로 다룬다. */
type Wire = Record<string, unknown>;

/** tools/call의 MCP 결과. 실패도 결과다 — isError 텍스트로 모델이 읽는다. */
interface ToolOutcome {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** 도구 하나 = 이름·설명·중계할 op·인자 스키마. 인자는 데몬으로 그대로 간다. */
interface ToolDef {
  name: string;
  description: string;
  op: string;
  properties: Record<string, { type: string; description: string }>;
  required?: string[];
}

/** tabId 인자의 공통 형태 — 생략하면 활성 탭(2단계 BrowserDriver 계약). */
const TAB_ID = {
  type: "string",
  description: "탭 id — 생략하면 활성 탭.",
};

/**
 * 계약의 17개 도구. 이름·인자는 3단계 도구셋 계약 그대로 — `browser_fill`이
 * op `type`으로, `browser_wait`가 op `waitFor`로, `browser_console`이 op
 * `consoleLines`로 걸리는 것만 이름 차이라.
 */
const TOOLS: ToolDef[] = [
  {
    name: "browser_list_tabs",
    op: "listTabs",
    description: "인앱 브라우저의 열린 탭 목록 (id·제목·주소·활성 여부).",
    properties: {},
  },
  {
    name: "browser_new_tab",
    op: "openTab",
    description: "새 탭을 열고 그 탭의 스냅샷을 돌려준다.",
    properties: {
      url: { type: "string", description: "열 주소 (http·https)." },
      background: { type: "boolean", description: "true면 뒤에서 연다 (활성화하지 않음)." },
    },
    required: ["url"],
  },
  {
    name: "browser_navigate",
    op: "navigate",
    description: "탭을 주소로 이동하고 새 스냅샷을 돌려준다.",
    properties: {
      url: { type: "string", description: "이동할 주소 (http·https)." },
      tabId: TAB_ID,
    },
    required: ["url"],
  },
  {
    name: "browser_snapshot",
    op: "snapshot",
    description:
      "탭의 접근성 스냅샷 — ref가 붙은 요소 트리. 액션 전후에 읽고, 액션에는 그 ref를 쓴다.",
    properties: { tabId: TAB_ID },
  },
  {
    name: "browser_screenshot",
    op: "screenshot",
    description: "탭(또는 ref 하나)의 화면을 캡처한다.",
    properties: {
      tabId: TAB_ID,
      ref: { type: "string", description: "요소 하나만 찍을 때 그 ref." },
      longEdge: { type: "number", description: "긴 변 픽셀 — 생략하면 기본값." },
    },
  },
  {
    name: "browser_click",
    op: "click",
    description: "ref 요소를 누르고 새 스냅샷을 돌려준다.",
    properties: {
      ref: { type: "string", description: "스냅샷의 요소 ref." },
      tabId: TAB_ID,
    },
    required: ["ref"],
  },
  {
    name: "browser_fill",
    op: "type",
    description: "ref 요소에 텍스트를 채운다 — 필요하면 기존 값을 지운다.",
    properties: {
      ref: { type: "string", description: "스냅샷의 요소 ref." },
      text: { type: "string", description: "채울 텍스트." },
      clear: { type: "boolean", description: "true면 기존 값을 지우고 채운다 (기본 true)." },
      tabId: TAB_ID,
    },
    required: ["ref", "text"],
  },
  {
    name: "browser_press",
    op: "press",
    description: "키보드 입력을 보낸다 (예: Enter, Escape, ArrowDown).",
    properties: {
      key: { type: "string", description: "키 이름." },
      tabId: TAB_ID,
    },
    required: ["key"],
  },
  {
    name: "browser_scroll",
    op: "scroll",
    description: "세로로 스크롤하고 새 스냅샷을 돌려준다.",
    properties: {
      dy: { type: "number", description: "픽셀 단위 세로 이동 (+아래 / −위)." },
      ref: { type: "string", description: "요소 안에서 스크롤할 때 그 ref." },
      tabId: TAB_ID,
    },
    required: ["dy"],
  },
  {
    name: "browser_hover",
    op: "hover",
    description: "ref 요소에 마우스를 올리고 새 스냅샷을 돌려준다.",
    properties: {
      ref: { type: "string", description: "스냅샷의 요소 ref." },
      tabId: TAB_ID,
    },
    required: ["ref"],
  },
  {
    name: "browser_select",
    op: "select",
    description: "select 요소의 값을 고르고 새 스냅샷을 돌려준다.",
    properties: {
      ref: { type: "string", description: "스냅샷의 요소 ref." },
      value: { type: "string", description: "고를 값." },
      tabId: TAB_ID,
    },
    required: ["ref", "value"],
  },
  {
    name: "browser_wait",
    op: "waitFor",
    description: "조건을 기다린다 — 텍스트·주소·밀리초 중 하나 이상.",
    properties: {
      text: { type: "string", description: "이 텍스트가 보일 때까지." },
      url: { type: "string", description: "주소가 이것(부분 일치)이 될 때까지." },
      ms: { type: "number", description: "이 밀리초만 기다린다." },
      tabId: TAB_ID,
    },
  },
  {
    name: "browser_console",
    op: "consoleLines",
    description: "탭의 콘솔·네트워크 기록을 읽는다 — 오류 확인에 쓴다.",
    properties: { tabId: TAB_ID },
  },
  {
    name: "browser_evaluate",
    op: "evaluate",
    description: "페이지에서 자바스크립트 함수를 실행한다 (반환은 8KB로 잘린다). 권한 카드가 온다.",
    properties: {
      fn: { type: "string", description: "실행할 함수 본문 — 예: () => document.title. 식이 아니라 함수다." },
      tabId: TAB_ID,
    },
    required: ["fn"],
  },
  {
    name: "browser_close_tab",
    op: "closeTab",
    description: "탭을 닫는다.",
    properties: { tabId: { ...TAB_ID, description: "닫을 탭 id." } },
    required: ["tabId"],
  },
  {
    name: "browser_back",
    op: "back",
    description: "뒤로 가고 새 스냅샷을 돌려준다.",
    properties: { tabId: TAB_ID },
  },
  {
    name: "browser_forward",
    op: "forward",
    description: "앞으로 가고 새 스냅샷을 돌려준다.",
    properties: { tabId: TAB_ID },
  },
];

/** 데몬의 `/internal/browser`가 답을 먹고 버티는 유예 — waitFor의 5초 폴링과 스크린샷 인코딩까지 담는다. */
const CALL_TIMEOUT_MS = 60_000;

const daemonUrl = process.env.COLO_DAEMON_URL;
const secret = process.env.COLO_BROWSER_SECRET;
if (!daemonUrl || !secret) {
  console.error(
    "COLO_DAEMON_URL·COLO_BROWSER_SECRET 환경 변수가 필요하다 — 이 프로세스는 데몬이 띄우는 MCP 자식이다.",
  );
  process.exit(1);
}

function send(message: Wire): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function answer(id: string | number | null, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function refuse(id: string | number | null, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function text(body: string, isError = false): ToolOutcome {
  return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}

/** 액션 실패 — isError 텍스트. 던지는 대신 결과로 내려가야 모델이 고친다. */
function refused(message: string): ToolOutcome {
  return text(message, true);
}

/** tools/call → 데몬 중계. HTTP 상태·ok:false·도달 실패 모두 도구 결과로 맞춘다. */
async function callTool(tool: ToolDef, args: Wire): Promise<ToolOutcome> {
  let response: Response;
  try {
    response = await fetch(`${daemonUrl}/internal/browser`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ op: tool.op, params: args }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (error) {
    return refused(
      `데몬의 브라우저 엔드포인트에 도달하지 못했다: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim();
    return refused(
      `브라우저 엔드포인트가 ${response.status}로 거절했다${detail ? `: ${detail}` : ""}`,
    );
  }
  const payload = (await response.json().catch(() => null)) as Wire | null;
  if (!payload || typeof payload.ok !== "boolean") {
    return refused("브라우저 엔드포인트의 응답이 계약에 없는 형태다 (ok 없음).");
  }
  if (!payload.ok) return refused(String(payload.error ?? "알 수 없는 오류"));
  return text(JSON.stringify(payload.result ?? null));
}

async function handle(message: Wire): Promise<void> {
  const params = (message.params ?? {}) as Wire;
  // 알림(id 없음 — notifications/initialized 포함)은 응답하지 않는다.
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      // 클라이언트가 제안한 프로토콜 버전을 그대로 따른다 — 협상의 한쪽
      // 절반을 서버가 굳히면 낡은 클라이언트와 악수가 깨진다.
      answer(message.id as string | number | null, {
        protocolVersion:
          typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "colo-browser", title: "콜로디자인 인앱 브라우저", version: "0" },
        instructions:
          "인앱 브라우저 도구 — 사용자가 보고 있는 탭을 드라이브한다. browser_snapshot의 ref로 " +
          "요소를 가리키며, 모든 액션의 결과에 새 스냅샷이 실려 온다. 탭 생략은 활성 탭이다.",
      });
      return;
    case "notifications/initialized":
      return;
    case "ping":
      answer(message.id as string | number | null, {});
      return;
    case "tools/list":
      answer(message.id as string | number | null, {
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: {
            type: "object",
            properties: tool.properties,
            ...(tool.required?.length ? { required: tool.required } : {}),
          },
        })),
      });
      return;
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) {
        // 모르는 도구도 프로토콜 오류가 아니라 도구 결과로 — 모델이 목록을
        // 다시 읽고 고칠 수 있어야 한다.
        answer(
          message.id as string | number | null,
          text(`알 수 없는 도구: ${name || "(이름 없음)"}`, true),
        );
        return;
      }
      answer(
        message.id as string | number | null,
        await callTool(tool, (params.arguments ?? {}) as Wire),
      );
      return;
    }
    default:
      refuse(
        message.id as string | number | null,
        -32601,
        `Method not found: ${String(message.method)}`,
      );
  }
}

const lines = createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: Wire;
  try {
    message = JSON.parse(trimmed) as Wire;
  } catch {
    refuse(null, -32700, "Parse error");
    return;
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    refuse(null, -32600, "Invalid Request");
    return;
  }
  void handle(message).catch((error: unknown) => {
    if (message.id !== undefined) {
      refuse(
        message.id as string | number | null,
        -32603,
        `Internal error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
});
lines.on("close", () => process.exit(0));
