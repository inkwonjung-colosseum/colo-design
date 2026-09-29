/**
 * The preview driver contract (게이트 재배선 2026-09-17): the one window the
 * daemon borrows to LOOK at the connected repo's running app. Its consumers
 * are the screen gate (턴 끝 재검증) and the handoff captures — the desktop
 * injects a factory, the browser dev path injects nothing and a gate simply
 * never fires. 인앱 브라우저부터 이 모듈은 두 번째 계약 —
 * 에이전트가 pane 의 페이지를 만지는 `BrowserDriver` — 도 선언한다.
 */
import type { NovaDesignCommentTarget } from "@nova-design/protocol";

/** The widths a screen can be looked at in — the 폭 toggle's, shared. */
export type PreviewViewport = "mobile" | "tablet" | "desktop";

/** How the window is set up before a screen loads. */
export interface PreviewOpenOptions {
  viewport?: PreviewViewport;
  colorScheme?: "light" | "dark";
  /**
   * 이 열기에서 접근성의 재료(PreviewA11y)도 모은다. 브라우저에 여러 번 묻는 값이라 필요한
   * 열기만 켠다 — 게이트의 데스크톱 폭 열기와 screen_check 가 켠다.
   */
  a11y?: boolean;
}

/**
 * What `open` answers. `settled` false means the document never fully
 * loaded — the check that follows may be of a half-built screen, and the
 * gate says so instead of pretending. (2026-09-21 상태 축 철거: 화면마다
 * 표식을 기다리던 settle 은 물러나고 "문서가 완전히 로드됨" 만이 기준이다.)
 *
 * D2: `blank` 는 다 로드된 문서가 글자도 그림도 없다는 뜻이다 — 콘솔이
 * 조용한 죽음(빈 라우트 · 렌더 실패)을 게이트가 잡게 하는 필드다.
 *
 * `overflow` 는 휴대폰 폭으로 연 화면이 다 로드됐을 때만 온다 — 문서가 화면
 * 밖으로 밀리는지의 재료다(PreviewOverflow). 잴 수 없었으면 없다.
 *
 * `a11y` 는 `options.a11y` 로 부탁한 열기가 다 로드됐을 때만 온다 — 접근성의 재료다
 * (PreviewA11y). 브라우저가 답하지 못했으면 없다.
 */
export type PreviewOpenResult =
  | {
      ok: true;
      settled: boolean;
      blank?: boolean;
      overflow?: PreviewOverflow;
      a11y?: PreviewA11y;
    }
  | { ok: false; reason: string };

/**
 * 접근성의 재료 — 브라우저가 계산한 것만 담는다: 접근성 트리의 이름, 그리고 브라우저가
 * 페인트한 화면에서 잰 배경색. 문제인가의 판정(문턱 · 대비 비율 · 지난번과의 차)은 데몬의
 * 것이다(screen-gate.ts `a11yOf`) — 게이트와 screen_check 가 같은 말을 하도록.
 * 값은 페이지 안에서 돈 코드가 만든 것이라 데몬이 그대로 믿지 않는다.
 */
export interface PreviewA11y {
  /**
   * 이름이 빈 컨트롤 · 그림의 표본(최대 60) — 컨트롤은 브라우저의 접근성 트리가 계산한 이름이
   * 비었고, 그림은 `alt` 가 아예 없는 `<img>` 와 이름 없는 `role="img"` 다(role 은 `img`).
   */
  unnamed: Array<{ role: string; label: string }>;
  /** 이름이 빈 것의 전체 수 — 표본이 잘려도 셈은 온전하다. */
  unnamedTotal: number;
  /**
   * 글자 색 조합마다 하나(최대 60) — 같은 조합의 요소는 `count` 로 묶인다. 배경색은
   * 브라우저가 페인트한 화면에서 잰 것이다(그라디언트면 끝 색들). 재지 못한 것은 싣지 않는다.
   */
  texts: Array<{
    label: string;
    /** 글자색 `[r, g, b, a]` — sRGB, a 는 0~1. */
    color: [number, number, number, number];
    /** 조상까지 곱한 불투명도(0~1). */
    opacity: number;
    /** `rgb(r, g, b)` 꼴의 배경색들. */
    backgrounds: string[];
    fontSize: number;
    fontWeight: number;
    count: number;
  }>;
}

/**
 * 문서가 화면 밖으로 밀리는지의 재료. 드라이버는 페이지가 아는 것만 말하고,
 * 문턱을 넘었는가의 판정은 데몬의 것이다(screen-gate.ts `overflowOf`) — 판정이
 * 게이트와 screen_check 에서 갈라지지 않게.
 *
 * 휴대폰 폭에서만 잰다: 휴대폰 에뮬레이션만 겹치는(overlay) 스크롤바를 흉내 내서,
 * 그 밖의 폭에서는 `100vw` 처럼 멀쩡한 화면도 스크롤바 폭만큼 넘쳐 보인다.
 */
export interface PreviewOverflow {
  /** 화면 폭(px) — 레이아웃 뷰포트의 폭이다. */
  viewportWidth: number;
  /** 문서 폭(px) — 문서의 스크롤 폭이다. */
  documentWidth: number;
  /**
   * 사용자가 문서를 옆으로 밀 수 있는가. 뷰포트가 `overflow-x: hidden | clip`
   * 이면 거짓이다 — 넘치는 것이 가려질 뿐 문서가 밀리지는 않는다.
   */
  scrollable: boolean;
  /**
   * 화면 밖으로 삐져나온 요소 — 바깥쪽 것만, 오른쪽 끝이 먼 순서로 최대 세 개.
   * 고칠 자리의 단서다.
   */
  offenders: Array<{ label: string; right: number }>;
}

/** One line of what the page said — console levels, plus `net` and `dialog`. */
export interface PreviewConsoleLine {
  level: string;
  text: string;
}

/**
 * One capture. The driver owns the encoder, so it says what the bytes are —
 * a caller that assumed a format would mislabel the picture (and the handoff
 * would commit it under the wrong extension).
 */
export interface PreviewCapture {
  /** base64, no data-url prefix. */
  data: string;
  mediaType: string;
}

/**
 * The one window the daemon looks through. Implemented by the desktop with
 * an offscreen `BrowserWindow` (or the on-screen pane); unit tests implement
 * it with a fake.
 */
export interface PreviewDriver {
  /** Show `<baseUrl><route>` — 주소의 쿼리는 그냥 주소의 일부로 전달한다 (2026-09-21 상태 축 철거). */
  open(route: string, options?: PreviewOpenOptions): Promise<PreviewOpenResult>;
  /**
   * One picture of the window, downscaled so its long edge is `longEdge`.
   * Scaling happens AT capture time — a re-encode after the fact bakes one
   * generation's artifacts into the next.
   */
  screenshot(options?: { longEdge?: number }): Promise<PreviewCapture>;
  /** Console and network trouble since the last `open`. */
  consoleLines(): Promise<PreviewConsoleLine[]>;
  destroy(): Promise<void>;
}

export interface PreviewDriverFactory {
  /**
   * A driver for verification work (the screen gate, handoff captures) —
   * always an isolated window, never the pane the user is driving:
   * re-opening the user's own screen would steal their view.
   */
  forIsolated(baseUrl: string): PreviewDriver;
}

// ---------------------------------------------------------------------------
// 인앱 브라우저: 에이전트와 사용자가 같은 탭을 쓰는 드라이버
// 계약. 게이트용 `PreviewDriver` 가 화면을 "본다" 면, 이쪽은 "만진다" —
// 접근성 스냅샷과 ref 액션. 07bd3bf 의 화면 도구(PreviewAxNode · ref 세대 ·
// 액션 뒤 스냅샷)가 모태다 — pane 은 프로젝트당 페이지 하나라 탭 주소는 없다.
// 구현은 데스크톱(PaneBrowserDriver)만 한다 — 데몬은 Electron 을 모른다.
// ---------------------------------------------------------------------------

/**
 * 접근성 트리 한 노드 (07bd3bf 계승). `ref`(`e12`)는 같은 DOM 노드이면
 * 세대가 바뀌어도 같다 (PLAN-MCP M-4) — 문서가 갈릴 때만 전부 죽는다.
 * 엉뚱한 곳을 누르는 일은 문서의 경계가 막는다.
 */
export interface PreviewAxNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  states: string[];
  children: PreviewAxNode[];
}

/**
 * 액션의 답 (PLAN-MCP M-3) — 전체 트리를 모델에게 직접 내리지 않고 요약의
 * 재료로 쓰라고 넓혔다. 드라이버는 트리를 그대로 돌리고, 줄이는 일은 데몬의
 * 순수 함수(browser-snapshot.ts)가 한다.
 */
export interface BrowserActionReport {
  url: string;
  title: string;
  snapshot: PreviewAxNode[];
}

/** The browser the agent shares with the user — 화면의 페이지 하나를 겨눈다. */
export interface BrowserDriver {
  navigate(url: string): Promise<{ settled: boolean } & BrowserActionReport>;
  back(): Promise<BrowserActionReport>;
  forward(): Promise<BrowserActionReport>;
  snapshot(): Promise<PreviewAxNode[]>;
  screenshot(opts?: { ref?: string; longEdge?: number }): Promise<PreviewCapture>;
  click(target: { ref: string }): Promise<BrowserActionReport>;
  type(input: { ref?: string; text: string; clear?: boolean }): Promise<BrowserActionReport>;
  press(key: string): Promise<BrowserActionReport>;
  scroll(target: { ref?: string; dy: number }): Promise<BrowserActionReport>;
  hover(target: { ref: string }): Promise<BrowserActionReport>;
  select(target: { ref: string; value: string }): Promise<BrowserActionReport>;
  drag(target: { fromRef: string; toRef: string }): Promise<BrowserActionReport>;
  consoleLines(): Promise<PreviewConsoleLine[]>;
  evaluate(fn: string): Promise<unknown>;
  waitFor(target: { text?: string; url?: string; ms?: number }): Promise<boolean>;
  /**
   * ref 하나의 정체 조사 (PLAN-MCP §3.E-1) — 핀 봉투의 element 칸
   * (NovaDesignCommentTarget) 와 같은 모양에 owners 까지 얹은 것. 낡은 ref 는
   * 액션과 같은 문장으로 던진다. 파일 후보 보강(enrichIdentity)은 데몬이
   * 덧입힌다 — 드라이버는 페이지가 아는 것만 말한다.
   */
  inspect(target: { ref: string }): Promise<{ url: string; element: NovaDesignCommentTarget }>;
  /**
   * op 가 데몬의 타임아웃을 넘겨도 끝나지 않을 때의 강제 복구 — 디버거를
   * 떼고 붙임 지킴이(keepAttached 인터벌)와 ref 세대를 비운다. 데몬의 큐
   * 꼬리 회수와 짝이다 — 둘이 없으면 한 번의 hang 이 세션의 브라우저와
   * 사용자의 DevTools 를 영구 봉쇄한다. 다음 op 는 새 붙임으로 정상 경로를
   * 다시 탄다.
   */
  recover(): void;
  destroy(): Promise<void>;
  /**
   * 지금 드라이버가 겨누는 페이지가 연결 레포의 것인지 — origin 지식은
   * 구현만 쥔다(미리보기 서버·선언 origins). 사용자가 링크를 타고 밖으로
   * 내보낸 페이지면 거짓이고, 그 표면에서의 모든 op 는 실행 직전 세션의
   * 권한 카드를 지난다.
   */
  isRepoSurface(): boolean;
}

export interface BrowserDriverFactory {
  /**
   * pane 이 화면에 있으면 그 브라우저 드라이버, 없으면 null — 숨은 창 폴백은
   * 없다. 에이전트의 브라우저 도구는 사용자가 보는 탭만 drive 한다; 사용자가
   * 없는 화면을 몰래 여는 것은 공유 브라우저의 약속을 깬다.
   */
  forPane(): BrowserDriver | null;
}
