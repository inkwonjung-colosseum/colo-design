/**
 * 인앱 브라우저 도구의 계약과 데몬 중계 — `browser-mcp.ts`(stdio MCP 서버,
 * claude · codex 가 자식 프로세스로 띄운다)가 읽는 한 벌. 목록을 `tools/list`로
 * 내고 `tools/call`을 중계한다.
 *
 * 상태 없음: 탭과 스냅샷의 진실은 데몬과 pane 이 소유하고, 여기는 와이어
 * 번역만 한다. 실패도 도구 결과다 — 데몬의 ok:false·401·404 와 도달 실패는
 * 모두 isError 텍스트로 내려가 턴을 죽이는 대신 모델이 읽고 고치게 한다.
 */
import { BROWSER_MCP_SERVER_NAME } from "./browser-launch.js";

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
  /**
   * 인자 스키마. 배열 인자는 `items` 를, 고른 칸은 `enum` 을 선언한다 —
   * OpenAI 계열(숫자만 있는 배열을 거절)과 Gemini 계열의 함수 스키마가
   * 이 두 칸을 요구하고, 정의 하나가 거절되면 그 세션의 브라우저 도구
   * 목록 전체가 막힌다. 시험이 이 계약을 지킨다.
   */
  properties: Record<
    string,
    { type: string; description: string; items?: { type: string }; enum?: string[] }
  >;
  required?: string[];
}

/** 데몬으로 가는 중계의 좌표 — MCP 자식이 env 에서 읽는다. */
export interface BrowserRelay {
  daemonUrl: string;
  secret: string;
}

/**
 * 계약의 23개 도구. 이름·인자는 도구셋 계약 그대로 — `browser_fill`이
 * op `type`으로, `browser_wait`가 op `waitFor`로, `browser_console`이 op
 * `consoleLines`로 걸리는 것만 이름 차이다. `browser_find`는 op 가 아니라
 * 스냅샷의 거름이고(PLAN-MCP §3.C), `browser_inspect`는 핀의 정체 조사를
 * 핀 없이 돌리는 op(§3.E-1)다. `screen_check`는 op `screenCheck`로 게이트와
 * 같은 판정을 턴 안에서 앞당겨 본다. pane 이 필요한 도구는 화면의 페이지를
 * 겨누고(pane 은 프로젝트당 페이지 하나라 탭 주소는 없다),
 * `screen_files` · `notify_developer` · `repo_diagnostics` 는 pane 없이 데몬만으로 답한다.
 */
export const BROWSER_TOOLS: ToolDef[] = [
  {
    name: "browser_navigate",
    op: "navigate",
    description:
      "화면의 페이지를 주소로 이동하고 바뀐 줄의 요약을 돌려준다 — 페이지가 없으면 연다.",
    properties: {
      url: { type: "string", description: "이동할 주소 (http·https)." },
    },
    required: ["url"],
  },
  {
    name: "browser_snapshot",
    op: "snapshot",
    description:
      "페이지의 접근성 스냅샷 — 한 줄 표기 트리(기본 상한 400줄). 액션에는 줄의 ref를 쓴다. " +
      "ref를 주면 그 요소의 부분 트리만, maxLines로 줄 수를 줄인다.",
    properties: {
      ref: { type: "string", description: "그 요소의 부분 트리만 읽을 때의 ref." },
      maxLines: { type: "number", description: "최대 줄 수 (기본 400)." },
    },
  },
  {
    name: "browser_find",
    op: "find",
    description:
      "스냅샷에서 조건에 맞는 요소의 줄만 찾는다 — 이름의 부분 일치(대소문자 무시)와 역할. " +
      "전체를 다시 읽는 것보다 토큰이 싸다.",
    properties: {
      text: { type: "string", description: "요소 이름에 포함될 글자 (대소문자 무시)." },
      role: { type: "string", description: "정확히 맞출 역할 — 예: button, link." },
      limit: { type: "number", description: "최대 줄 수 (기본 10, 최대 30)." },
    },
  },
  {
    name: "browser_inspect",
    op: "inspect",
    description:
      "스냅샷의 ref 하나의 정체(컴포넌트 · testid · 경로 · 스타일)와 그 요소가 살 파일 후보를 돌려준다 — " +
      "사용자가 핀 없이 화면의 일부를 말로 가리킬 때 browser_find 로 찾은 뒤 부른다.",
    properties: {
      ref: { type: "string", description: "조사할 요소의 ref." },
    },
    required: ["ref"],
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
    description: "ref 요소를 누르고 바뀐 줄의 요약을 돌려준다.",
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
    description: "세로로 스크롤하고 바뀐 줄의 요약을 돌려준다.",
    properties: {
      dy: { type: "number", description: "픽셀 단위 세로 이동 (+아래 / −위)." },
      ref: { type: "string", description: "요소 안에서 스크롤할 때 그 ref." },
    },
    required: ["dy"],
  },
  {
    name: "browser_hover",
    op: "hover",
    description: "ref 요소에 마우스를 올리고 바뀐 줄의 요약을 돌려준다.",
    properties: {
      ref: { type: "string", description: "스냅샷의 요소 ref." },
    },
    required: ["ref"],
  },
  {
    name: "browser_select",
    op: "select",
    description: "select 요소의 값을 고르고 바뀐 줄의 요약을 돌려준다.",
    properties: {
      ref: { type: "string", description: "스냅샷의 요소 ref." },
      value: { type: "string", description: "고를 값." },
    },
    required: ["ref", "value"],
  },
  {
    name: "browser_drag",
    op: "drag",
    description: "ref 요소를 다른 ref 요소 위로 끌어 놓고 바뀐 줄의 요약을 돌려준다.",
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
    description: "뒤로 가고 바뀐 줄의 요약을 돌려준다.",
    properties: {},
  },
  {
    name: "browser_forward",
    op: "forward",
    description: "앞으로 가고 바뀐 줄의 요약을 돌려준다.",
    properties: {},
  },
  {
    name: "screen_check",
    op: "screenCheck",
    description:
      "화면들을 확인한다 — 주소로 열어 자리 잡음과 콘솔 오류만 돌려준다. " +
      "돌려오는 각 화면의 `url` 이 그 화면의 전체 주소다 — 답변의 하이퍼링크에 그대로 쓴다. " +
      "viewport 로 휴대폰 폭도 본다 — 휴대폰에서만 깨지는 화면을 잡는다. " +
      "capture 면 문제가 있는 화면의 그림만 돌려준다. " +
      "스냅샷은 없다. 화면을 고친 뒤 답하기 전에 부른다 — 미리보기 안의 화면 경로만 받는다.",
    properties: {
      route: {
        type: "string",
        description: "확인할 화면의 경로 — 예: /member/MemberList. routes 와 합쳐진다.",
      },
      routes: {
        type: "array",
        items: { type: "string" },
        description: "확인할 화면 경로의 목록 — route 와 합쳐 한 번에 최대 6개까지 본다.",
      },
      viewport: {
        type: "string",
        enum: ["mobile", "tablet", "desktop"],
        description: "화면 폭 — mobile | tablet | desktop (기본 desktop).",
      },
      capture: {
        type: "boolean",
        description: "true 면 문제가 있는 화면의 그림(긴 변 640)을 돌려준다.",
      },
    },
  },
  {
    name: "repo_diagnostics",
    op: "repoDiagnostics",
    description:
      "레포의 타입 검사를 돌려 이번에 바뀐 파일의 오류부터 돌려준다 — 두 번째부터는 바뀐 곳만 다시 보므로 " +
      "몇 초 안에 끝난다. 편집 사이사이의 확인은 이것으로 하고, 레포의 검사 명령 전체는 답하기 전에 한 번만 " +
      "돌린다. 미리보기가 없어도 돈다.",
    properties: {},
  },
  {
    name: "submit_for_review",
    op: "submitForReview",
    description:
      "이번 작업을 개발자에게 보낸다(제출). 사용자가 개발자에게 보내 달라고 " +
      "분명히 말했을 때만 부른다 — 짐작으로 부르지 않는다. 결과는 곧바로 오고 " +
      "진행은 화면의 상태 칩이 알려 준다. 사용자가 개발자에게 전할 한마디를 " +
      "말했으면 그 말을 note 에 담는다.",
    properties: {
      note: {
        type: "string",
        description: "개발자에게 한마디(선택) — 사용자가 한마디를 말했을 때만 그 말 그대로.",
      },
    },
  },
  {
    name: "screen_files",
    op: "screenFiles",
    description:
      "화면을 고친 파일 후보를 찾는다 — 레포의 파일 구조(주소와 같은 이름의 파일)와, " +
      "그 화면을 고친 커밋이 건드린 파일의 관찰 지도, 화면 제목이 코드에 적힌 자리에서. " +
      "미리보기를 띄우지 않아도 돈다. 화면을 고치기 전에 파일을 찾을 때 먼저 부른다.",
    properties: {
      route: {
        type: "string",
        description: "화면의 경로 — 예: /member/list · member/list (루트는 index).",
      },
      title: {
        type: "string",
        description: "화면 제목(선택) — 후보를 더 찾는 글자 힌트.",
      },
    },
    required: ["route"],
  },
  {
    name: "notify_developer",
    op: "notifyDeveloper",
    description:
      "개발자에게 쪽지를 보낸다 — AI 도 고칠 수 없는 문제(권한 · 인증 · 저장소 " +
      "상태)를 묻는 길이다. 사용자에게 묻지 말고 이 도구로 개발자에게 묻는다. " +
      "하루 3통이고, 결과는 곧바로 온다.",
    properties: {
      title: { type: "string", description: "문제의 한 줄 제목." },
      what: { type: "string", description: "무엇이 막혔는지." },
      ask: { type: "string", description: "개발자에게 무엇을 부탁하는지." },
    },
    required: ["title", "what", "ask"],
  },
];

/**
 * 세션에 실을 도구 목록 (PLAN L6 · O6) — `submit_for_review` 는 프로젝트의
 * `lifecycle.submitFromChat`(초대 v4, 기본 true)이 켜진 세션에만 실린다.
 * MCP 자식은 같은 판정을 env 플래그(NOVA_BROWSER_SUBMIT)로 받는다 — 둘 다
 * 같은 근거를 쓴다.
 */
export function browserTools(submitFromChat: boolean): ToolDef[] {
  return submitFromChat
    ? BROWSER_TOOLS
    : BROWSER_TOOLS.filter((tool) => tool.op !== "submitForReview");
}

/** 제출 한마디의 상한 — 영수증 한 줄의 크기(PLAN-MCP §3.B, HANDOFF_BODY_MAX_CHARS 보다 훨씬 짧다). */
export const SUBMIT_NOTE_MAX_CHARS = 200;

/**
 * 제출 한마디의 정규화 — 앞뒤 공백을 걷고 상한에서 자르며, 빈 문자열은
 * 한마디 없음(undefined)으로 둔다. 도구 인자와 감독자(`submit(via, sessionId,
 * note)`) 사이에서 같은 뜻으로 넘기기 위한 한 곳 — 감독자도 빈손을 무시하지만
 * 여기서 한 번 걷어 둔다.
 */
export function submitNoteOf(params: Record<string, unknown>): string | undefined {
  if (typeof params.note !== "string") return undefined;
  const trimmed = params.note.trim().slice(0, SUBMIT_NOTE_MAX_CHARS);
  return trimmed === "" ? undefined : trimmed;
}

/** screen_files 의 후보 수 상한 — 후보는 힌트지 답이 아니다(관찰 지도의 결과 같이). */
export const SCREEN_FILES_MAX = 6;

/**
 * screen_files 의 판정 (PLAN-MCP §3.E · PLAN-HARNESS §3.B B-2) — 레포 구조의
 * 파일을 먼저, 관찰 지도의 파일을 그 뒤에, 제목 글자의 적합을 마지막에.
 * 겹치는 파일은 앞 줄에 한 번만 남고, 합이 상한을 넘으면 앞줄이 먼저다.
 * 출처 표식이 순위를 말한다: `(주소)` 는 주소와 같은 이름의 파일(레포 구조),
 * `(관찰)` 은 그 화면을 고친 커밋이 건드린 파일이고, `(글자 "…")` 은 화면
 * 제목이 코드에 적힌 자리다. 빈손은 오류가 아니다 — 화면을 고친 기록이 아직
 * 없을 뿐이다.
 */
export function screenFilesAnswer(
  observed: string[],
  hunted: string[],
  title: string,
  routed: string[] = [],
): string {
  const seen = new Set<string>();
  const onlyOf = (files: string[]): string[] => {
    const only: string[] = [];
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      only.push(file);
    }
    return only;
  };
  const routedOnly = onlyOf(routed);
  const observedOnly = onlyOf(observed);
  const huntedOnly = onlyOf(hunted);
  const routedCapped = routedOnly.slice(0, SCREEN_FILES_MAX);
  const observedCapped = observedOnly.slice(0, Math.max(0, SCREEN_FILES_MAX - routedCapped.length));
  const huntedCapped = huntedOnly.slice(
    0,
    Math.max(0, SCREEN_FILES_MAX - routedCapped.length - observedCapped.length),
  );
  const lines: string[] = [];
  if (routedCapped.length > 0) {
    lines.push(`파일 후보: ${routedCapped.join(" · ")} (주소)`);
  }
  if (observedCapped.length > 0) {
    lines.push(`파일 후보: ${observedCapped.join(" · ")} (관찰)`);
  }
  if (huntedCapped.length > 0) {
    lines.push(`파일 후보: ${huntedCapped.join(" · ")} (글자 "${title}")`);
  }
  if (lines.length === 0) return "이 화면을 고친 기록이 아직 없습니다";
  return lines.join("\n");
}

/** notify_developer 인자의 상한 — 쪽지는 알림 본문의 네 줄에 실리는 몫이다. */
export const NOTIFY_TITLE_MAX = 80;
export const NOTIFY_WHAT_MAX = 600;
export const NOTIFY_ASK_MAX = 300;

/**
 * notify_developer 의 인자 정규화 (PLAN-MCP §3.E) — 앞뒤 공백을 걷고 각각의
 * 상한에서 자른다. 셋 중 하나라도 비면 null — 쪽지의 네 줄이 다 채워져야
 * 개발자가 무엇을 부탁받는지 안다.
 */
export function normalizeNotifyArgs(
  params: Record<string, unknown>,
): { title: string; what: string; ask: string } | null {
  const cut = (value: unknown, max: number): string =>
    typeof value === "string" ? value.trim().slice(0, max) : "";
  const title = cut(params.title, NOTIFY_TITLE_MAX);
  const what = cut(params.what, NOTIFY_WHAT_MAX);
  const ask = cut(params.ask, NOTIFY_ASK_MAX);
  if (title === "" || what === "" || ask === "") return null;
  return { title, what, ask };
}

/**
 * 제목의 짧은 해시 — 알림 키의 뒷부분. 같은 제목의 쪽지는 같은 키로 서서
 * DeveloperNotice 의 다시 쓰기 창이 겹치는 쓰기를 막고, 제목이 다르면 다른
 * 문제로 갈라진다. FNV-1a 의 32비트를 여덟 글자 16진수로.
 */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * notify_developer 의 결과 문장 (PLAN-MCP §3.E) — via 가 어느 길로든 닿으면
 * 알린 것이고, none 은 어느 채널도 닿지 못한 것이다. 둘 다 답변에 이유를
 * 적게 하는 문으로 끝난다 — 사용자가 결과를 알아야 하기 때문이다.
 */
export function notifyDeveloperAnswer(via: "pr" | "issue" | "slack" | "none"): string {
  return via === "none"
    ? "개발자에게 닿지 못했어요 — 답변에 이유를 적어 두십시오"
    : "개발자에게 알렸어요";
}

/**
 * browser_wait 의 예산 규칙(밀리초) — 드라이버(preview-driver.ts)의 기본
 * 5초 · 상한 30초와 같은 수를 데몬이 따로 알고 있어야, 실패 문장이 실제로
 * 기다린 시간을 말한다. ms 는 상한에서 깎일 뿐 거절되지 않는다(드라이버와
 * 같은 규칙), 없거나 음수면 기본 예산이다.
 */
export const WAIT_DEFAULT_MS = 5_000;
export const WAIT_MAX_MS = 30_000;

/** browser_wait 가 실제로 기다리는 예산 — 드라이버의 계산을 데몬이 같은 식으로 한다. */
export function waitForBudgetMs(ms: number | undefined): number {
  return typeof ms === "number" && ms >= 0 ? Math.min(ms, WAIT_MAX_MS) : WAIT_DEFAULT_MS;
}

/**
 * browser_wait 의 결과 문장 (PLAN-MCP §3.F) — 참은 사실 한 줄이다. 거짓은
 * 오류가 아니라 사실이므로 isError 도 아니고 true/false 로도 답하지 않는다:
 * 실제로 기다린 예산을 말해 모델이 화면을 다시 읽을지 조건을 바꿀지 정하게
 * 한다. 초는 소수 첫 자리까지 — 1.5초의 기다림이 "2초" 로 불어나지 않게.
 */
export function waitForAnswer(ok: boolean, ms: number | undefined): string {
  if (ok) return "조건을 만족했습니다";
  const seconds = waitForBudgetMs(ms) / 1000;
  const shown = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
  return `조건을 ${shown}초 안에 만족하지 못했습니다 — 화면을 다시 읽거나 조건을 바꾸십시오`;
}

/**
 * 브라우저 도구의 이름 전부 (PLAN-MCP M-7) — 통계가 도구 묶음을 가리는
 * 잣대. 접두 문자열과 달리 `browser_` 로 시작하는 우연한 이름이나 다른 MCP
 * 서버의 도구를 세지 않는다.
 */
export const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set(
  BROWSER_TOOLS.map((tool) => tool.name),
);

/**
 * 도구 이름이 브라우저 도구인가 — 프로바이더마다 다르게 부르는 이름 셋을
 * 본다: 맨 이름, `mcp__<server>__<name>`(claude),
 * `<server>/<name>`(codex). 서버 이름은 상수만 본다 — RENAME 계획이 값을
 * 바꿔도 이 판정은 흔들리지 않는다.
 *
 */
export function isBrowserToolName(name: string): boolean {
  if (BROWSER_TOOL_NAMES.has(name)) return true;
  const claudePrefix = `mcp__${BROWSER_MCP_SERVER_NAME}__`;
  if (name.startsWith(claudePrefix)) {
    return BROWSER_TOOL_NAMES.has(name.slice(claudePrefix.length));
  }
  const codexPrefix = `${BROWSER_MCP_SERVER_NAME}/`;
  if (name.startsWith(codexPrefix)) {
    return BROWSER_TOOL_NAMES.has(name.slice(codexPrefix.length));
  }
  return false;
}

/** 브라우저 op 실패의 종류 (PLAN-MCP M-8) — 통계 행과 데몬 로그가 함께 쓴다. */
export type BrowserFailKind = "stale-ref" | "timeout" | "refused" | "no-pane" | "other";

/**
 * 실패 문장 → 종류. 순수 함수라 시험이 문장을 직접 본다 — 문장은 드라이버와
 * 서버가 제갈래로 내지만, 종류는 그중 안정적인 부분만으로 판정한다.
 */
export function classifyBrowserFailure(message: string): BrowserFailKind {
  if (message.includes("지금 화면의 것이 아닙니다")) return "stale-ref";
  if (message.includes("시간을 넘겼습니다")) return "timeout";
  if (message.includes("거절")) return "refused";
  if (
    message.includes("브라우저 드라이버가 없습니다") ||
    message.includes("브라우저 창이 아직 없습니다") ||
    // 데스크톱 드라이버가 pane 이 사라졌을 때 던지는 문장도 같은 종류다.
    message.includes("미리보기 화면이 없습니다")
  ) {
    return "no-pane";
  }
  return "other";
}

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
 * 맞춘다 — 모델이 읽는 실패 문장은 하나다.
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
  // screen_check 의 문제 화면 그림도 같은 길로 내려간다 — 첫 블록은 그림
  // 칸을 뗀 screens 의 JSON, 그 뒤가 그림 블록들이다.
  if (tool.op === "screenCheck") {
    const report = payload.result as { screens?: unknown[]; truncated?: unknown } | null;
    if (report && Array.isArray(report.screens)) {
      const images: Array<{ data: string; mimeType: string }> = [];
      const screens = report.screens.map((entry) => {
        const screen = { ...((entry ?? {}) as Record<string, unknown>) };
        const capture = screen.capture as { data?: unknown; mediaType?: unknown } | undefined;
        if (capture && typeof capture.data === "string" && typeof capture.mediaType === "string") {
          images.push({ data: capture.data, mimeType: capture.mediaType });
        }
        delete screen.capture;
        return screen;
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              typeof report.truncated === "number" && report.truncated > 0
                ? { screens, truncated: report.truncated }
                : { screens },
            ),
          },
          ...images.map((image) => ({ type: "image" as const, ...image })),
        ],
      };
    }
  }
  // 결과가 이미 문자열이면 그대로 text 로 싣는다 — 스냅샷 렌더 · 액션 요약 ·
  // 찾기의 한 줄 표기가 따옴표와 \n 이스케이프에 갇혀 모델에게 가지 않게.
  if (typeof payload.result === "string") return text(payload.result);
  return text(JSON.stringify(payload.result ?? null));
}
