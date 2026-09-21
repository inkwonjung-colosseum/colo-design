/**
 * 인앱 브라우저 도구의 계약과 데몬 중계 — 두 소비자가 함께 읽는 한 벌.
 *
 * - `browser-mcp.ts`: stdio MCP 서버(claude · codex · ACP 에이전트가 자식
 *   프로세스로 띄운다). 목록을 `tools/list`로 내고 `tools/call`을 중계한다.
 * - `agent/drivers/omp/session.ts`: omp 의 rpc-ui 는 host tool 와이어
 *   (`set_host_tools` → `host_tool_call` → `host_tool_result`)를 가지므로
 *   자식 프로세스 없이 데몬이 같은 도구를 in-process 로 답한다.
 *
 * 상태 없음: 탭과 스냅샷의 진실은 데몬과 pane 이 소유하고, 여기는 와이어
 * 번역만 한다. 실패도 도구 결과다 — 데몬의 ok:false·401·404 와 도달 실패는
 * 모두 isError 텍스트로 내려가 턴을 죽이는 대신 모델이 읽고 고치게 한다.
 */

/** 느슨한 와이어 형태 — 줄 단위 JSON을 그대로 다룬다. */
export type Wire = Record<string, unknown>;

/** 도구 호출의 결과. MCP 의 `tools/call` 결과 형태 그대로 — 실패도 결과다. */
export interface ToolOutcome {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}

/** 도구 하나 = 이름·설명·중계할 op·인자 스키마. 인자는 데몬으로 그대로 간다. */
export interface ToolDef {
  name: string;
  description: string;
  op: string;
  properties: Record<string, { type: string; description: string }>;
  required?: string[];
}

/** 데몬으로 가는 중계의 좌표 — MCP 자식은 env 에서, omp 세션은 명세에서 읽는다. */
export interface BrowserRelay {
  daemonUrl: string;
  secret: string;
}

/**
 * 계약의 17개 도구. 이름·인자는 도구셋 계약 그대로 — `browser_fill`이
 * op `type`으로, `browser_wait`가 op `waitFor`로, `browser_console`이 op
 * `consoleLines`로 걸리는 것만 이름 차이다. `screen_check`는 op
 * `screenCheck`로 게이트와 같은 판정을 턴 안에서 앞당겨 본다. pane 은
 * 프로젝트당 페이지 하나라 탭 주소는 없다 — 모든 도구는 화면의 페이지를
 */
export const BROWSER_TOOLS: ToolDef[] = [
  {
    name: "browser_navigate",
    op: "navigate",
    description: "화면의 페이지를 주소로 이동하고 새 스냅샷을 돌려준다 — 페이지가 없으면 연다.",
    properties: {
      url: { type: "string", description: "이동할 주소 (http·https)." },
    },
    required: ["url"],
  },
  {
    name: "browser_snapshot",
    op: "snapshot",
    description:
      "페이지의 접근성 스냅샷 — ref가 붙은 요소 트리. 액션 전후에 읽고, 액션에는 그 ref를 쓴다.",
    properties: {},
  },
  {
    name: "browser_screenshot",
    op: "screenshot",
    description: "페이지(또는 ref 하나)의 화면을 캡처한다.",
    properties: {
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
    },
    required: ["ref", "text"],
  },
  {
    name: "browser_type",
    op: "type",
    description: "지금 포커스된 곳에 텍스트를 쓴다 — ref 없이 키보드 입력만.",
    properties: {
      text: { type: "string", description: "쓸 텍스트." },
    },
    required: ["text"],
  },
  {
    name: "browser_press",
    op: "press",
    description: "키보드 입력을 보낸다 (예: Enter, Escape, ArrowDown).",
    properties: {
      key: { type: "string", description: "키 이름." },
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
    },
    required: ["dy"],
  },
  {
    name: "browser_hover",
    op: "hover",
    description: "ref 요소에 마우스를 올리고 새 스냅샷을 돌려준다.",
    properties: {
      ref: { type: "string", description: "스냅샷의 요소 ref." },
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
    },
    required: ["ref", "value"],
  },
  {
    name: "browser_drag",
    op: "drag",
    description: "ref 요소를 다른 ref 요소 위로 끌어 놓고 새 스냅샷을 돌려준다.",
    properties: {
      fromRef: { type: "string", description: "끌 요소의 ref." },
      toRef: { type: "string", description: "놓을 자리 요소의 ref." },
    },
    required: ["fromRef", "toRef"],
  },
  {
    name: "browser_wait",
    op: "waitFor",
    description: "조건을 기다린다 — 텍스트·주소·밀리초 중 하나 이상. ms는 최대 30초.",
    properties: {
      text: { type: "string", description: "이 텍스트가 보일 때까지." },
      url: { type: "string", description: "주소가 이것(부분 일치)이 될 때까지." },
      ms: { type: "number", description: "이 밀리초만 기다린다 — 조건 없이 쓰면 그냥 잔다." },
    },
  },
  {
    name: "browser_console",
    op: "consoleLines",
    description: "페이지의 콘솔·네트워크 기록을 읽는다 — 오류 확인에 쓴다.",
    properties: {},
  },
  {
    name: "browser_evaluate",
    op: "evaluate",
    description:
      "페이지에서 자바스크립트 함수를 실행한다 (반환은 8KB로 잘린다). 연결 레포의 화면 바깥을 겨누면 권한 카드가 온다.",
    properties: {
      fn: {
        type: "string",
        description: "실행할 함수 본문 — 예: () => document.title. 식이 아니라 함수다.",
      },
    },
    required: ["fn"],
  },
  {
    name: "browser_back",
    op: "back",
    description: "뒤로 가고 새 스냅샷을 돌려준다.",
    properties: {},
  },
  {
    name: "browser_forward",
    op: "forward",
    description: "앞으로 가고 새 스냅샷을 돌려준다.",
    properties: {},
  },
  {
    name: "screen_check",
    op: "screenCheck",
    description:
      "화면을 확인한다 — 주소로 열어 자리 잡음과 콘솔 오류만 돌려준다. " +
      "돌려오는 `url` 이 그 화면의 전체 주소다 — 답변의 하이퍼링크에 그대로 쓴다. " +
      "스냅샷은 없다. 화면을 고친 뒤 답하기 전에 부른다 — 미리보기 안의 화면 경로만 받는다.",
    properties: {
      route: {
        type: "string",
        description: "확인할 화면의 경로 — 예: /member/MemberList",
      },
    },
    required: ["route"],
  },
];

/** 데몬의 `/internal/browser`가 답을 먹고 버티는 유예 — waitFor의 5초 폴링과 스크린샷 인코딩까지 담는다. */
const CALL_TIMEOUT_MS = 60_000;

/** 도구 결과의 생성자 — MCP 결과와 host tool 결과가 같은 형태를 쓴다. */
export function text(body: string, isError = false): ToolOutcome {
  return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}

/** 액션 실패 — isError 텍스트. 던지는 대신 결과로 내려가야 모델이 고친다. */
export function refused(message: string): ToolOutcome {
  return text(message, true);
}

/**
 * 도구 호출 → 데몬 중계. HTTP 상태·ok:false·도달 실패 모두 도구 결과로
 * 맞춘다 — MCP 자식이든 omp 세션이든 모델이 읽는 실패 문장은 하나다.
 */
export async function callBrowserTool(
  tool: ToolDef,
  args: Wire,
  relay: BrowserRelay,
): Promise<ToolOutcome> {
  let response: Response;
  try {
    response = await fetch(`${relay.daemonUrl}/internal/browser`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${relay.secret}` },
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
  // 스크린샷은 MCP 의 image 블록으로 내려간다 — base64 를 텍스트로 싣으면
  // 모델이 그림을 못 보고 컨텍스트만 태운다.
  if (tool.op === "screenshot") {
    const shot = payload.result as { data?: unknown; mediaType?: unknown } | null;
    if (shot && typeof shot.data === "string" && typeof shot.mediaType === "string") {
      return { content: [{ type: "image", data: shot.data, mimeType: shot.mediaType }] };
    }
  }
  return text(JSON.stringify(payload.result ?? null));
}
