import { markTurn } from "@nova-design/protocol";
import type {
  PreviewCapture,
  PreviewConsoleLine,
  PreviewDriver,
  PreviewOpenOptions,
  PreviewViewport,
} from "./preview-driver.js";

/**
 * 화면 확인 게이트 — 턴이 끝나면 기계가 그 화면을 열어 본다.
 *
 * 게이트의 입력은 사람이 가리킨 화면이다 (게이트 재배선 2026-09-17): pin
 * 과 화면 캡처가 실은 route 가 `notePinned` 로 모이고, 턴이 끝나면
 * 그 화면들을 다시 열어 본다. 없는 것은 **반드시 본다**는 보장이다:
 * 지금은 AI 가 화면을 고치고 열어 보지 않은 채 답할 수 있고, 그러면
 * 콘솔에서 죽은 화면을 **비개발자가** 발견한다. 그 사람에게는 고칠 말이
 * 없다 — 그게 이 게이트가 있는 이유다.
 *
 * 판정은 기계의 것이다: 이 턴이 가리킨 화면을 다시 열어, 문서가 완전히
 * 로드되었는지(`settled`)와 콘솔의 error·실패한 요청만 본다. 경고는
 * 세지 않는다 — 레포의 개발 빌드는 원래 경고를 뱉고, 그것은 이 도구가
 * 만든 문제가 아니다. (2026-09-21 상태 축 철거: 표식 대기가 사라지고
 * settle 은 문서의 완전한 로드만을 뜻한다.)
 *
 * 범위가 "이 턴이 가리킨 화면" 인 이유: 바뀐 파일에서 화면 주소를 끌어낼
 * 길이 없다(경로↔라우트 지도가 어디에도 없다). 선언된 화면 전부를 쓸면
 * 이번 턴과 무관한 화면의 문제까지 AI 에게 떠넘기게 된다.
 */

/** 이 턴이 연 화면 하나. (2026-09-21 상태 축 철거 — 주소만 남는다.) */
export interface GateScreen {
  route: string;
}

/** 한 화면에서 기계가 본 것. (2026-09-21 상태 축 철거 — 주소만 남는다.) */
export interface ScreenTrouble {
  route: string;
  /** 문서가 끝내 완전히 로드되지 못했다. */
  unsettled: boolean;
  /** D2: 다 로드됐지만 글자도 그림도 없다 — 콘솔이 조용한 죽음. */
  blank: boolean;
  /** error·실패한 요청만 — 경고는 세지 않는다. */
  lines: PreviewConsoleLine[];
  /** 문제 줄의 전체 수(2026-09-22) — 브리프에 실리는 8줄과는 다른 질문이다. */
  consoleCount: number;
  /** 실패한 요청의 전체 수(2026-09-22) — 같은 이유로 slice 전의 수다. */
  netCount: number;
  /** D3 재시도로 열린 화면(2026-09-22) — 한 번 넘어져서 일어난 판정이다. */
  rescued: boolean;
  /**
   * 문제 화면의 그림(2026-09-22) — 글자만 있는 브리프가 추측으로 고치던
   * 자리를 눈으로 본다. 캡처 실패는 판정에 영향 없다(없을 뿐이다).
   */
  capture?: PreviewCapture;
}

/** 한 번에 브리프에 실을 그림 수의 상한 — 브리프 예산을 지킨다. */
export const MAX_TROUBLE_CAPTURES = 3;

/** 게이트가 문제로 세는 줄. `warn` 은 빠진다(레포 개발 빌드의 기본 소음). */
export const TROUBLE_LEVELS: Record<string, true> = { error: true, net: true };
/** 한 화면이 실어 보낼 수 있는 줄 수 — 같은 오류의 반복이 브리프를 삼키지 않게. */
export const MAX_LINES_PER_SCREEN = 8;
/** 한 번에 다시 열어 보는 화면 수의 상한 — 게이트가 턴만큼 길어지지 않게. */
export const MAX_GATE_SCREENS = 6;
/**
 * 화면 하나의 판정 — 게이트(`inspectScreens`)와 `screen_check`(`runScreenCheck`)
 * 가 함께 쓴다. 판정이 두 군데서 갈라지면 같은 화면에 대해 기계 둘이 다른
 * 말을 하게 되므로, 열기 · D3 한 번 재시도 · 콘솔 줄 걸러내기 · 상한까지가
 * 이 함수의 몫이다. 그림은 부르는 쪽의 몫이다 — 게이트는 긴 변 1024에 브리프
 * 상한(MAX_TROUBLE_CAPTURES)을 두고, screen_check 는 긴 변 640에 문제 화면만
 * 찍는다. `options` 는 `open` 에 그대로 간다 — 게이트는 주지 않고(지금까지와
 * 같다), screen_check 는 viewport 를 준다.
 *
 * 드라이버의 `open` 이 그 화면의 콘솔 기록을 먼저 비우므로(desktop 의 구현),
 * 여기서 읽는 줄은 정확히 **그 화면의 것**이다 — 세션이 쓰던 창을 빌려 읽으면
 * "AI 가 마지막으로 연 이후" 라는 흐릿한 창을 보게 된다.
 */
export type ScreenVerdict =
  | {
      route: string;
      opened: false;
      /** 드라이버가 열기 실패의 이유를 말해 줬을 때 — 확인 불능의 이유다. */
      reason?: string;
    }
  | {
      route: string;
      opened: true;
      /** 문서가 끝내 완전히 로드되지 못했다. */
      unsettled: boolean;
      /** D2: 다 로드됐지만 글자도 그림도 없다 — 콘솔이 조용한 죽음. */
      blank: boolean;
      /** error·실패한 요청만, 상한 8줄 — 경고는 세지 않는다. */
      lines: PreviewConsoleLine[];
      consoleCount: number;
      netCount: number;
      /** D3 재시도로 열린 화면(2026-09-22) — 한 번 넘어져서 일어난 판정이다. */
      rescued: boolean;
    };

/** D3 재시도 전의 한숨 — 창 세우기와 로드의 일시적 흔들림이 지나가길 기다린다. */
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function judgeScreen(
  driver: PreviewDriver,
  route: string,
  options?: PreviewOpenOptions,
): Promise<ScreenVerdict> {
  let opened = await driver.open(route, options).catch(() => null);
  // D3: 열기가 한 번 넘어지는 것은 판정이 아니다 — 창 세우기와 로드의
  // 일시적 흔들림이 그 자리를 지나가게 한 번만 다시 본다.
  let rescued = false;
  if (opened === null) {
    await sleep(1_000);
    opened = await driver.open(route, options).catch(() => null);
    rescued = opened !== null;
  }
  // 열지 못한 것은 판정이 아니다 — 미리보기 서버가 방금 죽었거나 주소가
  // 사라진 것이고, 그 사실은 다른 자리(레포 상태)가 이미 말한다. 게이트는
  // 조용히 건너뛰고, screen_check 는 그 사실을 답에 실어 AI 가 읽게 한다.
  if (opened === null) return { route, opened: false };
  if (opened.ok !== true) return { route, opened: false, reason: opened.reason };
  const troubleLines = (await driver.consoleLines().catch(() => [])).filter(
    (line) => TROUBLE_LEVELS[line.level.toLowerCase()] === true,
  );
  // 세는 수는 slice 전의 전체(2026-09-22) — 브리프에 실리는 8줄과 통계가
  // 세는 전체는 다른 질문이다.
  const consoleCount = troubleLines.filter((line) => line.level.toLowerCase() === "error").length;
  return {
    route,
    opened: true,
    unsettled: !opened.settled,
    blank: opened.settled && opened.blank === true,
    lines: troubleLines.slice(0, MAX_LINES_PER_SCREEN),
    consoleCount,
    netCount: troubleLines.length - consoleCount,
    rescued,
  };
}

/**
 * 화면들을 다시 열어 본다. 부르는 쪽이 제 드라이버를 만들어 넘긴다 — 게이트가
 * 쓰는 창은 세션이 쓰는 창이 아니어야 하기 때문이다. 열지 못한 화면은 게이트의
 * 판정이 아니므로 조용히 건너뛴다.
 */
export async function inspectScreens(
  driver: PreviewDriver,
  screens: GateScreen[],
): Promise<ScreenTrouble[]> {
  const troubles: ScreenTrouble[] = [];
  for (const screen of screens.slice(0, MAX_GATE_SCREENS)) {
    const verdict = await judgeScreen(driver, screen.route);
    if (!verdict.opened) continue;
    if (!verdict.unsettled && !verdict.blank && verdict.lines.length === 0) continue;
    // 문제 화면의 그림(2026-09-22) — 콘솔 링이 갈리기 전(다음 화면을 열기
    // 전)에 찍는다. 실패는 판정에 영향 없다. 상한을 넘으면 그림 없이 글자만
    // 간다 — 브리프 예산이 그림보다 먼저다.
    const capture =
      troubles.filter((trouble) => trouble.capture !== undefined).length < MAX_TROUBLE_CAPTURES
        ? await driver.screenshot({ longEdge: 1024 }).catch(() => null)
        : null;
    troubles.push({
      route: verdict.route,
      unsettled: verdict.unsettled,
      blank: verdict.blank,
      lines: verdict.lines,
      consoleCount: verdict.consoleCount,
      netCount: verdict.netCount,
      rescued: verdict.rescued,
      ...(capture !== null ? { capture } : {}),
    });
  }
  return troubles;
}

/**
 * `screen_check` 도구 인자의 정규화(PLAN-MCP §3.D) — route(옛 인자)와
 * routes 의 합집합을 preview origin 안에서 경로로 접는다. 같은 화면의 다른
 * 표기(`/a` 와 전체 주소)가 두 번 열리지 않게 하는 것은 게이트(runGate)의
 * 중복 접기와 같은 기준이다. 상한 MAX_GATE_SCREENS 를 넘으면 잘라서 잘린
 * 수를 돌려준다 — 답의 마지막 줄이 그 수를 말하게.
 */
export type NormalizedScreenCheckArgs =
  | {
      ok: true;
      routes: string[];
      viewport: PreviewViewport;
      capture: boolean;
      /** 상한을 넘어 잘린 주소의 수 — 0 이면 답에 실지 않는다. */
      truncated: number;
    }
  | { ok: false; error: string };

const SCREEN_CHECK_VIEWPORTS: readonly PreviewViewport[] = ["mobile", "tablet", "desktop"];

export function normalizeScreenCheckArgs(
  params: Record<string, unknown>,
  previewUrl: string,
): NormalizedScreenCheckArgs {
  const viewportRaw = params.viewport;
  if (viewportRaw !== undefined) {
    if (
      typeof viewportRaw !== "string" ||
      !SCREEN_CHECK_VIEWPORTS.includes(viewportRaw as PreviewViewport)
    ) {
      return {
        ok: false,
        error: `viewport 는 mobile · tablet · desktop 중 하나여야 합니다: ${String(viewportRaw)}`,
      };
    }
  }
  const viewport = (typeof viewportRaw === "string" ? viewportRaw : "desktop") as PreviewViewport;
  const candidates: string[] = [];
  if (typeof params.route === "string" && params.route.trim() !== "") candidates.push(params.route);
  if (Array.isArray(params.routes)) {
    for (const item of params.routes) {
      if (typeof item === "string" && item.trim() !== "") candidates.push(item);
    }
  }
  if (candidates.length === 0) {
    return { ok: false, error: "확인할 화면 주소(route 또는 routes)가 필요합니다." };
  }
  const origin = new URL(previewUrl).origin;
  const routes: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    let target: URL;
    try {
      target = new URL(candidate, origin);
    } catch {
      return { ok: false, error: `화면 주소를 읽지 못했습니다: ${candidate}` };
    }
    // 미리보기 안의 화면만 — 검증 창이 열 수 있는 것은 이 미리보기뿐이다.
    if (target.origin !== origin) {
      return { ok: false, error: "미리보기 안의 화면만 확인할 수 있습니다." };
    }
    // 사람의 pin 은 경로로, 에이전트는 전체 주소로 보낼 수 있다 — 경로로
    // 정규화해 같은 화면을 두 번 열지 않는다(runGate 와 같은 접기).
    const route = target.pathname + target.search + target.hash;
    if (seen.has(route)) continue;
    seen.add(route);
    routes.push(route);
  }
  const truncated = Math.max(0, routes.length - MAX_GATE_SCREENS);
  return {
    ok: true,
    routes: routes.slice(0, MAX_GATE_SCREENS),
    viewport,
    capture: params.capture === true,
    truncated,
  };
}

/**
 * AI 에게 가는 턴. `gate` 마커를 달아 대화록이 카드로 그리고(components
 * 의 `${step}에서 멈췄습니다`), 본문은 화면 하나당 한 묶음이다. 파일 경로도
 * 컴포넌트 이름도 쓰지 않는다 — 다른 기계 턴들과 같은 규칙이다.
 * typeLines(PLAN-HARNESS §3.D D-2)는 이번 턴이 고친 TypeScript 파일의
 * 타입 오류 — 화면 문제 뒤의 `### 타입 검사` 절로 실리며, 화면 문제가
 * 없으면 그 절만으로 게이트가 선다.
 */
export function gateBrief(troubles: ScreenTrouble[], typeLines: string[] = []): string {
  const blocks = troubles.map((trouble) => {
    const head = trouble.route;
    const reasons: string[] = [];
    if (trouble.unsettled) {
      reasons.push("화면이 끝내 로드되지 못했습니다 — 문서가 완전히 오지 않았습니다.");
    }
    if (trouble.blank) {
      reasons.push("화면이 비어 있습니다 — 글자도 그림도 그려지지 않았습니다.");
    }
    for (const line of trouble.lines) reasons.push(`${line.level}: ${line.text}`);
    return [`### ${head}`, ...reasons].join("\n");
  });
  // 화면 문제가 없고 타입 절만 있으면 머리 문장이 그 사실을 말한다 —
  // 둘째 인자가 없는 옛 호출은 지금의 문장 그대로를 받는다.
  const head =
    troubles.length > 0 || typeLines.length === 0
      ? "사용자가 가리킨 화면을 도구가 다시 열어 봤습니다. 아래를 고친 뒤 답해 주세요."
      : "이번 턴에 고친 파일을 도구가 타입 검사했습니다. 아래를 고친 뒤 답해 주세요.";
  const typeBlock =
    typeLines.length > 0
      ? [
          "### 타입 검사",
          "이번 턴에 고친 파일에서 타입 검사가 찾은 오류입니다.",
          ...typeLines,
        ].join("\n")
      : null;
  return markTurn(
    { kind: "gate", step: "화면 확인" },
    [head, ...blocks, ...(typeBlock !== null ? [typeBlock] : [])].join("\n\n"),
  );
}
