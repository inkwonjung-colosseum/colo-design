/**
 * 미리보기의 선로 타입 — 무대(`PreviewFrame` · `next/preview/PreviewHost`)와
 * 판정(`lib/preview-turns` · `next/preview/use-preview-errors`)이 함께 읽는다.
 */

/**
 * Which path the planner asked to see (the address bar's ask — the native
 * view `open`s it).
 */
export type PreviewTarget = { kind: "path"; path: string };

/** Where the native view actually is — its truth, not the tool's ask. */
export interface PreviewLocation {
  path: string;
  /** The full address — 외부 페이지는 주소창에 통째로 보여 준다. */
  url?: string;
  /** repo origin 위면 `preview`, 그 밖이면 `web` — 외부 페이지 모드의 자리. */
  kind: "preview" | "web";
  canGoBack: boolean;
  canGoForward: boolean;
}

/**
 * An error the preview hands to the agent — never to the planner: the column's
 * verdict pipeline turns it into a fix turn or puts it away. The native view's
 * events build it.
 */
export interface PreviewError {
  route: string;
  kind: "runtime" | "build";
  message: string;
  /**
   * 콘솔의 한 줄이 아니라 패인 스스로 화면을 못 띄운 것(30초 멈춤) — 검증 창도
   * 못 열었다면 그것이 곧 확인이다(판정 파이프의 확인 불능 규칙).
   */
  stalled?: true;
}
