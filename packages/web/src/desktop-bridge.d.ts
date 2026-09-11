import type { UpdateCheckResult } from "@cds-design/protocol";
import type { CdsDesignCommentsEnvelope, CdsDesignScreen } from "@cds-design/protocol";

/**
 * The desktop app's preload bridge (packages/desktop/src/preload.ts) — the
 * one surface the renderer reaches the main process through. Absent in a
 * plain browser; every access guards on it.
 *
 * `preview` grows with the native preview view (PLAN D64–D71): `native` is
 * how PreviewHost picks NativeHost over the iframe (D70), and the rest are
 * the §2 IPC channels — commands down, subscriptions up (each returns its
 * unsubscribe).
 */
type Unsubscribe = () => void;

declare global {
  interface Window {
    cdsDesignDesktop?: {
      updateCheck: () => Promise<UpdateCheckResult>;
      macSelfUpdate: (input: {
        url: string;
        sha256: string;
      }) => Promise<
        | { planned: unknown; guarded: string } // 개발 실행 — 계획만
        | { started: boolean; downloadPath: string; steps: string[] } // 내려받기·검증 끝, 곧 종료
        | { error: string }
      >;
      /** Opens ~/.cds-design in the OS file manager (PLAN D2). */
      openHome?: () => Promise<unknown>;
      preview?: {
        /** Claude 시점 보기(PLAN D63) — 8fps JPEG(base64), 구독만. */
        onFrame: (callback: (jpeg: string) => void) => void;
        /** D64: the native view exists — NativeHost, not the iframe. */
        native?: boolean;
        mount?: (url: string) => Promise<unknown>;
        unmount?: () => Promise<unknown>;
        bounds?: (rect: { x: number; y: number; width: number; height: number }) => Promise<unknown>;
        cover?: (on: boolean) => Promise<unknown>;
        open?: (path: string) => Promise<unknown>;
        navigate?: (route: string, state: string | null) => Promise<unknown>;
        history?: (delta: -1 | 1) => Promise<unknown>;
        reload?: () => Promise<unknown>;
        commentsMode?: (on: boolean) => Promise<unknown>;
        emulate?: (width: "mobile" | "tablet" | null) => Promise<unknown>;
        onLocation?: (callback: (payload: { path: string; canGoBack: boolean; canGoForward: boolean }) => void) => Unsubscribe;
        onBridge?: (callback: (payload: { state: "unknown" | "present" | "stale" }) => void) => Unsubscribe;
        onScreens?: (callback: (payload: { screens: CdsDesignScreen[] }) => void) => Unsubscribe;
        onComments?: (callback: (payload: CdsDesignCommentsEnvelope) => void) => Unsubscribe;
        onError?: (
          callback: (payload: { kind: "runtime" | "build"; message: string; route: string; state: string }) => void,
        ) => Unsubscribe;
        onFreeze?: (callback: (jpeg: string) => void) => Unsubscribe;
        onKey?: (callback: (payload: { key: string; meta: boolean }) => void) => Unsubscribe;
        onLoading?: (callback: (payload: { on: boolean }) => void) => Unsubscribe;
      };
    };
  }
}

export {};
