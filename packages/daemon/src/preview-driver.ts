/**
 * The preview driver contract (게이트 재배선 2026-09-17): the one window the
 * daemon borrows to LOOK at the connected repo's running app. Its consumers
 * are the screen gate (턴 끝 재검증) and the handoff captures — the desktop
 * injects a factory, the browser dev path injects nothing and a gate simply
 * never fires. 인앱 브라우저부터 이 모듈은 두 번째 계약 —
 * 에이전트가 pane 의 페이지를 만지는 `BrowserDriver` — 도 선언한다.
 */

/** The widths a screen can be looked at in — the 폭 toggle's, shared. */
export type PreviewViewport = "mobile" | "tablet" | "desktop";

/** How the window is set up before a screen loads. */
export interface PreviewOpenOptions {
  viewport?: PreviewViewport;
  colorScheme?: "light" | "dark";
}

/**
 * What `open` answers. `settled` false means the document never fully
 * loaded — the check that follows may be of a half-built screen, and the
 * gate says so instead of pretending. (2026-09-21 상태 축 철거: 화면마다
 * 표식을 기다리던 settle 은 물러나고 "문서가 완전히 로드됨" 만이 기준이다.)
 *
 * D2: `blank` 는 다 로드된 문서가 글자도 그림도 없다는 뜻이다 — 콘솔이
 * 조용한 죽음(빈 라우트 · 렌더 실패)을 게이트가 잡게 하는 필드다.
 */
export type PreviewOpenResult =
  | { ok: true; settled: boolean; blank?: boolean }
  | { ok: false; reason: string };

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
 * 접근성 트리 한 노드 (07bd3bf 계승). `ref`(`e12`)는 한 스냅샷 세대 안에서만
 * 산다 — 액션과 다음 스냅샷이 세대를 갈아치우므로, 낡은 ref 는 "다시 읽으라"
 * 는 오류가 된다. 엉뚱한 곳을 누르는 일을 세대가 막는다.
 */
export interface PreviewAxNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  states: string[];
  children: PreviewAxNode[];
}

/** The browser the agent shares with the user — 화면의 페이지 하나를 겨눈다. */
export interface BrowserDriver {
  navigate(url: string): Promise<{ settled: boolean; snapshot: PreviewAxNode[] }>;
  back(): Promise<PreviewAxNode[]>;
  forward(): Promise<PreviewAxNode[]>;
  snapshot(): Promise<PreviewAxNode[]>;
  screenshot(opts?: { ref?: string; longEdge?: number }): Promise<PreviewCapture>;
  click(target: { ref: string }): Promise<PreviewAxNode[]>;
  type(input: { ref?: string; text: string; clear?: boolean }): Promise<PreviewAxNode[]>;
  press(key: string): Promise<PreviewAxNode[]>;
  scroll(target: { ref?: string; dy: number }): Promise<PreviewAxNode[]>;
  hover(target: { ref: string }): Promise<PreviewAxNode[]>;
  select(target: { ref: string; value: string }): Promise<PreviewAxNode[]>;
  drag(target: { fromRef: string; toRef: string }): Promise<PreviewAxNode[]>;
  consoleLines(): Promise<PreviewConsoleLine[]>;
  evaluate(fn: string): Promise<unknown>;
  waitFor(target: { text?: string; url?: string; ms?: number }): Promise<boolean>;
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
