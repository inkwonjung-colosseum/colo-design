import { markTurn } from "@nova-design/protocol";
import type {
  PreviewA11y,
  PreviewCapture,
  PreviewConsoleLine,
  PreviewDriver,
  PreviewOpenOptions,
  PreviewOverflow,
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
 * 휴대폰 폭도 한 번 본다(2026-09-29): 데스크톱에서 멀쩡한 화면을 휴대폰 폭으로
 * 다시 열어 문서가 옆으로 밀리는지 잰다 — 휴대폰에서 넘치는 화면을 **비개발자가**
 * 손가락으로 밀어 보고서야 발견하지 않게. 문서 전체가 밀리는 것만 센다: 표가 제
 * 안에서 가로로 스크롤되는 것도, 뷰포트가 넘침을 가려 문서가 밀리지 않는 것도
 * 세지 않는다. 데스크톱 판정에서 이미 문제인 화면은 다시 열지 않는다 — 고침 턴이
 * 그 문제부터 본다.
 *
 * 접근성도 본다(2026-09-29) — 이름 없는 컨트롤 · 그림과 너무 흐린 글자. 소음이 이
 * 게이트의 가장 큰 위험이라 좁게 센다: 이름은 브라우저의 접근성 트리가 계산한 것이 빈
 * 경우만, 대비는 큰 글자의 기준(3:1)에도 못 미쳐 읽기 어려운 글자만 문제다. 그리고
 * 같은 화면에서 **지난번에 이미 본 문제는 다시 말하지 않는다** — 레포가 원래 갖고
 * 있던 문제(레포의 공용 컴포넌트 · 테마가 낳은 것 포함)가 턴마다 고침 턴을 여는 일을
 * 막는다(처음 본 화면의 원래 문제는 한 번은 말한다 — 브리프가 "이번 턴에 만들거나 고친
 * 것만" 이라고 범위를 좁힌다). 데스크톱 폭의 열기에서 재므로 여는 값은 늘지 않는다. 휴대폰
 * 폭 넘침과 한 화면의 한 묶음으로 간다.
 *
 * 이 도구의 목표는 **연결 레포가 정한 규칙**으로 화면을 만드는 것이다 — 특정 디자인
 * 시스템을 씌우는 것이 아니다. 그래서 브리프가 고치는 방향을 말할 때는 늘 "이 레포가 그
 * 방식을 이미 갖고 있으면 그것을 따르라" 를 함께 말한다: 접근성 · 반응형은 레포의 규칙
 * 위에서 지키는 것이고, 일반 규칙이 레포의 규칙을 덮어쓰지 않는다.
 *
 * 범위가 "이 턴이 가리킨 화면" 인 이유: 바뀐 파일에서 화면 주소를 끌어낼
 * 길이 없다(경로↔라우트 지도가 어디에도 없다). 선언된 화면 전부를 쓸면
 * 이번 턴과 무관한 화면의 문제까지 AI 에게 떠넘기게 된다.
 */

/** 이 턴이 연 화면 하나. (2026-09-21 상태 축 철거 — 주소만 남는다.) */
export interface GateScreen {
  route: string;
}

/**
 * 휴대폰 폭에서 문서가 화면 밖으로 밀리는 것 — 드라이버의 재료(PreviewOverflow)를
 * 문턱으로 거른 판정이다. 게이트와 screen_check 가 같은 말을 하도록 둘 다
 * judgeScreen 을 거쳐 여기서 난다.
 */
export interface ScreenOverflow {
  /** 화면 폭(px). */
  viewportWidth: number;
  /** 문서 폭(px). */
  documentWidth: number;
  /** 삐져나온 요소, 한 줄씩 — `table.member-list — 오른쪽 끝 812px`. */
  offenders: string[];
}

/**
 * 접근성의 문제 — 드라이버의 재료(PreviewA11y)를 문턱으로 거르고 같은 것끼리 묶은 판정이다.
 * 게이트와 screen_check 가 같은 말을 하도록 둘 다 judgeScreen 을 거쳐 여기서 난다.
 */
export interface ScreenA11y {
  /** 이름 없는 컨트롤 · 그림 — 같은 것끼리 묶어 많은 순. role 은 그림이면 `img`. */
  unnamed: Array<{ role: string; label: string; count: number }>;
  /** 너무 흐린 글자 — 대비가 낮은 순. `ratio` 는 글자와 가장 나쁜 배경의 비율이다. */
  contrast: Array<{ label: string; ratio: number; fontSize: number; count: number }>;
  /** 드라이버가 표본만 주었다 — 이름 없는 것이 여기 적힌 것보다 더 있다. */
  truncated: boolean;
}

/**
 * 화면 주소별로 지난번에 본 접근성 문제의 지문 — `a11yOf` 뒤의 `freshA11y` 가 "새로 생긴 것"만
 * 가려내는 기억이다. 데몬이 살아 있는 동안만 산다(프로젝트마다 하나, PreviewDrivers 가 쥔다).
 */
export type A11yBaseline = Map<string, Set<string>>;

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
  /** 휴대폰 폭에서 문서가 옆으로 밀린다(2026-09-29) — 다른 문제 없이 이것만일 수도 있다. */
  overflow?: ScreenOverflow;
  /** 지난번에 못 본 새 접근성 문제(2026-09-29) — 다른 문제 없이 이것만일 수도 있다. */
  a11y?: ScreenA11y;
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
 * 문서 폭이 화면 폭을 이만큼(px)까지 넘는 것은 반올림의 흔들림이지 밀림이 아니다 —
 * 세지 않는다. 이보다 크면 손가락으로 밀어 보이는 만큼 넘친 것이다.
 */
export const OVERFLOW_TOLERANCE_PX = 2;
/** 브리프에 실을 삐져나온 요소의 수 — 드라이버가 셋까지 주고 여기서 한 번 더 지킨다. */
export const MAX_OVERFLOW_OFFENDERS = 3;

/**
 * 드라이버의 재료를 문턱으로 거른다 — 밀릴 수 없는 뷰포트(`scrollable` 거짓)와
 * 반올림 안쪽의 차이는 문제가 아니다. 재료는 페이지가 내놓은 값이라 그대로 믿지
 * 않는다: 숫자가 아니면 버리고, 요소 줄은 개수 · 길이 · 공백을 여기서 다시 조인다.
 */
export function overflowOf(measure: PreviewOverflow | undefined): ScreenOverflow | null {
  if (measure === undefined || measure.scrollable !== true) return null;
  const { viewportWidth, documentWidth } = measure;
  if (!Number.isFinite(viewportWidth) || !Number.isFinite(documentWidth)) return null;
  if (documentWidth - viewportWidth <= OVERFLOW_TOLERANCE_PX) return null;
  const offenders = (Array.isArray(measure.offenders) ? measure.offenders : [])
    .filter((entry) => typeof entry?.label === "string" && Number.isFinite(entry.right))
    .slice(0, MAX_OVERFLOW_OFFENDERS)
    .map(
      (entry) =>
        `${entry.label.replace(/\s+/g, " ").trim().slice(0, 60)} — 오른쪽 끝 ${Math.round(entry.right)}px`,
    );
  return {
    viewportWidth: Math.round(viewportWidth),
    documentWidth: Math.round(documentWidth),
    offenders,
  };
}

/**
 * 글자 대비가 이 비율 아래면 문제다. WCAG AA 는 보통 글자에 4.5:1, 큰 글자에 3:1 을
 * 요구하지만, 레포가 정한 색(토큰 · 테마)이 살짝 못 미치는 것까지 AI 에게 고치라 하면
 * 레포의 규칙을 덮어쓰게 된다 — 큰 글자의 기준에도 못 미쳐 누구에게나 읽기 어려운 글자만
 * 센다.
 */
export const CONTRAST_SEVERE_RATIO = 3;
/** 브리프 · screen_check 에 싣는 접근성 줄의 수 — 종류마다. 넘는 것은 "더 있다" 한 줄이 된다. */
export const MAX_A11Y_LINES = 5;
/** 지난번 기억을 붙들어 두는 화면 주소의 수 — 넘으면 가장 오래된 것부터 잊는다. */
export const MAX_A11Y_BASELINE_ROUTES = 200;

type Rgba = [number, number, number, number];

/** 브라우저가 돌려주는 `rgb(r, g, b)` · `rgba(r, g, b, a)` · `rgb(r g b / a)` 를 읽는다. */
function parseRgb(css: string): Rgba | null {
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(
    css.trim(),
  );
  if (match === null) return null;
  const [r, g, b] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
  const alphaText = match[4];
  const alpha =
    alphaText === undefined
      ? 1
      : alphaText.endsWith("%")
        ? Number(alphaText.slice(0, -1)) / 100
        : Number(alphaText);
  const parsed: Rgba = [r, g, b, alpha];
  return parsed.every(Number.isFinite) && r <= 255 && g <= 255 && b <= 255 ? parsed : null;
}

/** 반투명한 색을 그 밑의 불투명한 색 위에 얹은 결과. */
function blend(top: [number, number, number], alpha: number, under: [number, number, number]) {
  const a = Math.min(1, Math.max(0, alpha));
  return top.map((channel, i) => channel * a + (under[i] ?? 0) * (1 - a)) as [
    number,
    number,
    number,
  ];
}

/** WCAG 의 상대 휘도. */
function luminance([r, g, b]: [number, number, number]): number {
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * 글자 색 조합 하나의 대비 — 글자와 **가장 나쁜** 배경의 비율(그라디언트면 끝 색들 중에서).
 * 글자의 투명도(글자색의 알파 × 조상의 불투명도)는 배경 위에 얹어 셈하고, 배경이 반투명이면
 * 흰 종이 위에 놓인 것으로 본다. 색을 못 읽으면 null — 못 센 침묵이 잘못된 지적보다 싸다.
 */
export function contrastOf(text: PreviewA11y["texts"][number]): number | null {
  const color = Array.isArray(text.color) ? text.color : [];
  const [r, g, b, a] = color;
  if (![r, g, b, a].every((value) => typeof value === "number" && Number.isFinite(value))) {
    return null;
  }
  const opacity =
    typeof text.opacity === "number" && Number.isFinite(text.opacity) ? text.opacity : 1;
  const alpha = (a as number) * Math.min(1, Math.max(0, opacity));
  let worst = Number.POSITIVE_INFINITY;
  for (const css of (Array.isArray(text.backgrounds) ? text.backgrounds : []).slice(0, 4)) {
    const parsed = typeof css === "string" ? parseRgb(css) : null;
    if (parsed === null) continue;
    const paper = blend([parsed[0], parsed[1], parsed[2]], parsed[3], [255, 255, 255]);
    const ink = blend([r as number, g as number, b as number], alpha, paper);
    const [lighter, darker] = [luminance(ink), luminance(paper)].sort((x, y) => y - x) as [
      number,
      number,
    ];
    worst = Math.min(worst, (lighter + 0.05) / (darker + 0.05));
  }
  return Number.isFinite(worst) ? worst : null;
}

/**
 * 드라이버의 접근성 재료를 문턱으로 거르고 같은 것끼리 묶는다. 재료가 없으면(부탁하지 않았거나
 * 브라우저가 답하지 못했으면) null, 잰 결과 문제가 없으면 빈 목록이다 — screen_check 가 "확인했고
 * 깨끗하다"와 "확인하지 못했다"를 가를 수 있게. 재료는 페이지 안에서 돈 코드의 값이라 그대로
 * 믿지 않는다: 모양이 틀린 항목은 버리고 글자는 다시 조인다.
 */
export function a11yOf(raw: PreviewA11y | undefined): ScreenA11y | null {
  if (raw === undefined || raw === null) return null;
  const groups = new Map<string, { role: string; label: string; count: number }>();
  for (const entry of Array.isArray(raw.unnamed) ? raw.unnamed : []) {
    if (typeof entry?.role !== "string" || typeof entry.label !== "string") continue;
    const role = entry.role.trim().slice(0, 30);
    const label = entry.label.replace(/\s+/g, " ").trim().slice(0, 80);
    if (role === "" || label === "") continue;
    const key = `${role}\u0000${label}`;
    const known = groups.get(key);
    if (known) known.count += 1;
    else groups.set(key, { role, label, count: 1 });
  }
  const unnamed = [...groups.values()].sort(
    (x, y) => y.count - x.count || x.label.localeCompare(y.label),
  );
  const contrast: ScreenA11y["contrast"] = [];
  for (const text of Array.isArray(raw.texts) ? raw.texts : []) {
    if (typeof text?.label !== "string") continue;
    const ratio = contrastOf(text);
    if (ratio === null || ratio >= CONTRAST_SEVERE_RATIO) continue;
    const label = text.label.replace(/\s+/g, " ").trim().slice(0, 80);
    if (label === "") continue;
    const count = Number.isInteger(text.count) && text.count > 0 ? text.count : 1;
    const fontSize = Number.isFinite(text.fontSize) ? Math.round(text.fontSize) : 0;
    contrast.push({ label, ratio: Math.round(ratio * 10) / 10, fontSize, count });
  }
  contrast.sort((x, y) => x.ratio - y.ratio || x.label.localeCompare(y.label));
  const sampled = unnamed.reduce((sum, group) => sum + group.count, 0);
  return {
    unnamed,
    contrast,
    truncated: Number.isFinite(raw.unnamedTotal) && raw.unnamedTotal > sampled,
  };
}

/** 문제 하나를 화면 주소 안에서 알아보는 지문 — 비율이나 개수는 넣지 않는다(움직여도 같은 문제다). */
function a11yPrints(a11y: ScreenA11y): { unnamed: string[]; contrast: string[] } {
  return {
    unnamed: a11y.unnamed.map((group) => `unnamed|${group.role}|${group.label}`),
    contrast: a11y.contrast.map((group) => `contrast|${group.label}|${group.fontSize}`),
  };
}

/**
 * 지난번에 이 화면에서 본 문제를 빼고 **새로 생긴 것**만 가려낸다. `seen` 은 이번 점검의 지문
 * 전부다 — 부르는 쪽이 이것을 다음번의 기억으로 갈아 끼운다(합치지 않는다: 고쳐서 사라졌다가
 * 되돌아온 문제는 다시 새것이어야 한다). 새것이 없으면 fresh 는 null 이다.
 */
export function freshA11y(
  previous: ReadonlySet<string> | undefined,
  a11y: ScreenA11y | null,
): { fresh: ScreenA11y | null; seen: Set<string> } {
  if (a11y === null) return { fresh: null, seen: new Set() };
  const prints = a11yPrints(a11y);
  const seen = new Set([...prints.unnamed, ...prints.contrast]);
  const unnamed = a11y.unnamed.filter((_, i) => !previous?.has(prints.unnamed[i] ?? ""));
  const contrast = a11y.contrast.filter((_, i) => !previous?.has(prints.contrast[i] ?? ""));
  if (unnamed.length === 0 && contrast.length === 0) return { fresh: null, seen };
  return { fresh: { unnamed, contrast, truncated: a11y.truncated }, seen };
}

/** 접근성 문제를 한 줄씩 — 브리프와 screen_check 가 같은 문장을 쓴다. */
export function a11yLines(a11y: ScreenA11y): { unnamed: string[]; contrast: string[] } {
  const more = "그 밖에도 더 있습니다";
  const unnamed = a11y.unnamed
    .slice(0, MAX_A11Y_LINES)
    .map((group) => (group.count > 1 ? `${group.label} — ${group.count}곳` : group.label));
  if (a11y.unnamed.length > MAX_A11Y_LINES || (a11y.truncated && a11y.unnamed.length > 0)) {
    unnamed.push(more);
  }
  const contrast = a11y.contrast
    .slice(0, MAX_A11Y_LINES)
    .map(
      (group) =>
        `${group.label} — 대비 ${group.ratio}:1 (${group.fontSize}px${group.count > 1 ? `, ${group.count}곳` : ""})`,
    );
  if (a11y.contrast.length > MAX_A11Y_LINES) contrast.push(more);
  return { unnamed, contrast };
}

/**
 * 화면 하나의 판정 — 게이트(`inspectScreens`)와 `screen_check`(`runScreenCheck`)
 * 가 함께 쓴다. 판정이 두 군데서 갈라지면 같은 화면에 대해 기계 둘이 다른
 * 말을 하게 되므로, 열기 · D3 한 번 재시도 · 콘솔 줄 걸러내기 · 밀림의 문턱 ·
 * 접근성의 문턱 · 상한까지가 이 함수의 몫이다. 그림은 부르는 쪽의 몫이다 — 게이트는 긴 변
 * 1024에 브리프 상한(MAX_TROUBLE_CAPTURES)을 두고, screen_check 는 긴 변 640에
 * 문제 화면만 찍는다. `options` 는 `open` 에 그대로 간다 — 게이트는 첫 열기에는
 * 주지 않고(데스크톱 폭) 휴대폰 폭의 두 번째 열기에만 viewport 를 주며,
 * screen_check 는 부탁받은 viewport 를 준다.
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
      /**
       * 휴대폰 폭으로 열었고 문서가 옆으로 밀릴 때만 있다(2026-09-29) — 다른 폭이거나
       * 안 밀리거나 잴 수 없었으면 칸이 없다.
       */
      overflow?: ScreenOverflow;
      /**
       * 접근성을 부탁해 열었고 브라우저가 답했을 때만 있다(2026-09-29) — 문제가 없어도
       * 빈 목록으로 있다("깨끗하다"와 "못 쟀다"를 가른다). 지난번과의 차는 이 판정이
       * 아니라 부르는 쪽(inspectScreens)의 일이다.
       */
      a11y?: ScreenA11y;
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
  // 다 로드되지 못한 문서의 폭 · 색은 중간 상태다 — 재지 않은 것으로 친다.
  const overflow = opened.settled ? overflowOf(opened.overflow) : null;
  const a11y = opened.settled ? a11yOf(opened.a11y) : null;
  return {
    route,
    opened: true,
    unsettled: !opened.settled,
    blank: opened.settled && opened.blank === true,
    lines: troubleLines.slice(0, MAX_LINES_PER_SCREEN),
    consoleCount,
    netCount: troubleLines.length - consoleCount,
    rescued,
    ...(overflow !== null ? { overflow } : {}),
    ...(a11y !== null ? { a11y } : {}),
  };
}

/** `inspectScreens` 의 선택 사항. */
export interface InspectOptions {
  /**
   * 접근성 점검을 켠다 — 화면 주소별로 지난번에 본 문제의 기억이다. 데스크톱 폭의 열기에서
   * 접근성의 재료를 모으고, 지난번에 못 본 **새** 문제만 문제로 센다. 없으면 접근성은 보지 않는다.
   */
  a11y?: A11yBaseline;
}

/** 이번 점검의 지문으로 그 화면의 기억을 갈아 끼운다 — 가장 오래된 화면부터 잊는다. */
function rememberA11y(baseline: A11yBaseline, route: string, seen: Set<string>): void {
  baseline.delete(route);
  baseline.set(route, seen);
  while (baseline.size > MAX_A11Y_BASELINE_ROUTES) {
    const oldest = baseline.keys().next().value;
    if (oldest === undefined) break;
    baseline.delete(oldest);
  }
}

/**
 * 화면들을 다시 열어 본다. 부르는 쪽이 제 드라이버를 만들어 넘긴다 — 게이트가
 * 쓰는 창은 세션이 쓰는 창이 아니어야 하기 때문이다. 열지 못한 화면은 게이트의
 * 판정이 아니므로 조용히 건너뛴다.
 *
 * 데스크톱 폭에서 멀쩡한 화면은 휴대폰 폭으로 한 번 더 연다(2026-09-29) — 값은
 * 화면당 열기 한 번이다. 이 두 번째 열기에서는 문서가 밀리는지만 본다: 휴대폰
 * 폭에서만 나는 콘솔 오류나 빈 화면은 이 게이트의 판정이 아니다.
 *
 * 접근성은 첫 번째(데스크톱 폭) 열기에서 함께 잰다 — 여는 값이 늘지 않는다. 데스크톱
 * 판정에서 이미 문제인 화면은 접근성을 보지도 기억하지도 않는다(고침 턴이 그 문제부터
 * 본다). 재료를 못 얻은 점검은 기억을 갈아 끼우지 않는다 — 못 잰 것을 "문제가 없었다"로
 * 기록하면 다음 점검이 옛 문제를 새것으로 되풀이한다.
 */
export async function inspectScreens(
  driver: PreviewDriver,
  screens: GateScreen[],
  options: InspectOptions = {},
): Promise<ScreenTrouble[]> {
  const troubles: ScreenTrouble[] = [];
  // 문제 화면의 그림(2026-09-22) — 콘솔 링이 갈리기 전(다음 화면을 열기
  // 전)에 찍는다. 실패는 판정에 영향 없다. 상한을 넘으면 그림 없이 글자만
  // 간다 — 브리프 예산이 그림보다 먼저다. 지금 창이 서 있는 폭 그대로 찍히므로
  // 휴대폰 폭의 문제는 휴대폰 폭의 그림이 된다.
  const captureOfTrouble = async (): Promise<{ capture?: PreviewCapture }> => {
    if (
      troubles.filter((trouble) => trouble.capture !== undefined).length >= MAX_TROUBLE_CAPTURES
    ) {
      return {};
    }
    const capture = await driver.screenshot({ longEdge: 1024 }).catch(() => null);
    return capture !== null ? { capture } : {};
  };
  for (const screen of screens.slice(0, MAX_GATE_SCREENS)) {
    const verdict = await judgeScreen(
      driver,
      screen.route,
      options.a11y !== undefined ? { a11y: true } : undefined,
    );
    if (!verdict.opened) continue;
    if (verdict.unsettled || verdict.blank || verdict.lines.length > 0) {
      troubles.push({
        route: verdict.route,
        unsettled: verdict.unsettled,
        blank: verdict.blank,
        lines: verdict.lines,
        consoleCount: verdict.consoleCount,
        netCount: verdict.netCount,
        rescued: verdict.rescued,
        ...(await captureOfTrouble()),
      });
      continue;
    }
    let a11y: ScreenA11y | undefined;
    if (options.a11y !== undefined && verdict.a11y !== undefined) {
      const { fresh, seen } = freshA11y(options.a11y.get(screen.route), verdict.a11y);
      rememberA11y(options.a11y, screen.route, seen);
      if (fresh !== null) a11y = fresh;
    }
    const phone = await judgeScreen(driver, screen.route, { viewport: "mobile" });
    const overflow = phone.opened ? phone.overflow : undefined;
    if (a11y === undefined && overflow === undefined) continue;
    troubles.push({
      route: verdict.route,
      unsettled: false,
      blank: false,
      lines: [],
      consoleCount: 0,
      netCount: 0,
      rescued: verdict.rescued || (phone.opened && phone.rescued),
      ...(overflow !== undefined ? { overflow } : {}),
      ...(a11y !== undefined ? { a11y } : {}),
      // 그림은 눈에 보이는 문제에만 — 넘침이 그렇다(휴대폰 폭 그대로 찍힌다). 이름 · 대비는
      // 요소 줄이 말하는 것이 그림보다 정확하고, 그림 예산은 넘침이 쓴다.
      ...(overflow !== undefined ? await captureOfTrouble() : {}),
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
      /** 다크 모드로 본다(2026-09-29) — 없으면 밝은 모드. */
      colorScheme?: "light" | "dark";
      /** 접근성의 재료도 모은다(2026-09-29) — 이름 없는 컨트롤 · 그림과 너무 흐린 글자. */
      a11y: boolean;
      capture: boolean;
      /** 상한을 넘어 잘린 주소의 수 — 0 이면 답에 실지 않는다. */
      truncated: number;
    }
  | { ok: false; error: string };

const SCREEN_CHECK_VIEWPORTS: readonly PreviewViewport[] = ["mobile", "tablet", "desktop"];
const SCREEN_CHECK_SCHEMES: readonly string[] = ["light", "dark"];

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
  const schemeRaw = params.colorScheme;
  if (
    schemeRaw !== undefined &&
    (typeof schemeRaw !== "string" || !SCREEN_CHECK_SCHEMES.includes(schemeRaw))
  ) {
    return {
      ok: false,
      error: `colorScheme 는 light · dark 중 하나여야 합니다: ${String(schemeRaw)}`,
    };
  }
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
    ...(schemeRaw !== undefined ? { colorScheme: schemeRaw as "light" | "dark" } : {}),
    a11y: params.a11y === true,
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
    if (trouble.overflow !== undefined) {
      // 요소 줄은 화면의 DOM 표기(태그 · id · class)다 — 파일 경로나 컴포넌트
      // 이름이 아니라 고칠 자리를 찾는 단서다. 마지막 줄은 게으른 고침 둘을
      // 막는다: 넘침을 body 에서 가리는 것, 그리고 PC 화면까지 뜯어고치는 것.
      const { viewportWidth, documentWidth, offenders } = trouble.overflow;
      reasons.push(
        `휴대폰 화면에서 문서 폭이 ${documentWidth}px 로 화면 폭 ${viewportWidth}px 보다 넓어 옆으로 밀립니다.${
          offenders.length > 0 ? " 화면 밖으로 삐져나온 요소:" : ""
        }`,
        ...offenders.map((line) => `- ${line}`),
        "PC 화면은 그대로 두고 휴대폰 폭에서만 고쳐 주세요 — 넘치는 요소를 화면 폭 안에 맞추고(표처럼 넓은 것은 그 안에서만 가로로 스크롤되게), body 의 overflow-x: hidden 으로 가리지 마세요. 이 레포가 반응형을 다루는 방식(브레이크포인트 · 유틸리티 · 공용 컴포넌트)이 있으면 그것을 따르세요.",
      );
    }
    if (trouble.a11y !== undefined) {
      // 요소 줄은 overflow 와 같은 DOM 표기다. 마지막 줄이 범위를 좁힌다 — 화면에 원래 있던
      // 요소(레포의 공용 컴포넌트 것 포함)의 문제까지 고치러 나서지 않게. 고치는 방향의 줄은
      // 레포가 이미 가진 방식을 먼저 따르라고 한다 — 이름 다는 방식도 색 정하는 방식도 레포마다
      // 다르다(컴포넌트의 속성 · 토큰 · 테마 · 유틸리티 클래스).
      const lines = a11yLines(trouble.a11y);
      if (lines.unnamed.length > 0) {
        reasons.push(
          "이름이 없는 컨트롤 · 그림이 있습니다 — 화면 낭독기가 읽어 줄 이름이 없습니다:",
          ...lines.unnamed.map((line) => `- ${line}`),
          "글자가 없는 버튼 · 링크에는 이름을, 입력칸에는 label 을, 그림에는 alt 를 달아 주세요. 이 레포가 이름을 다는 방식(컴포넌트의 속성 · aria-label · 숨김 글자)이 있으면 그것을 따르세요.",
        );
      }
      if (lines.contrast.length > 0) {
        reasons.push(
          `글자와 배경의 대비가 너무 낮은 곳이 있습니다 — ${CONTRAST_SEVERE_RATIO}:1 도 안 되어 읽기 어렵습니다:`,
          ...lines.contrast.map((line) => `- ${line}`),
          "글자색을 배경에서 더 벌려 주세요. 이 레포가 색을 정하는 방식(토큰 · 테마 · 클래스)이 있으면 그 안에서 더 진한 색을 고르고, 레포의 규칙이 정해 둔 색이라 바꿀 수 없으면 바꾸지 말고 답에 그 사실을 한 줄 남겨 주세요.",
        );
      }
      reasons.push(
        "이번 턴에 만들거나 고친 요소의 문제만 고치고, 원래 있던 요소는 그대로 두세요. 고친 뒤에는 screen_check 의 a11y: true 로 확인해 주세요.",
      );
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
