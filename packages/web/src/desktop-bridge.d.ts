import type { UpdateCheckResult } from "@cds-design/protocol";
import type {
  CdsDesignCommentsEnvelope,
  CdsDesignPinsPayload,
  CdsDesignScreen,
  CommentItem,
} from "@cds-design/protocol";

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
        /** 로딩 중 새로 고침 버튼의 두 번째 클릭 — 중단 (PLAN D85 ⓐ). */
        stop?: () => Promise<unknown>;
        /** 배율 (PLAN D85 ⓔ). */
        zoom?: (kind: "in" | "out" | "reset") => Promise<unknown>;
        commentsMode?: (on: boolean) => Promise<unknown>;
        emulate?: (width: "mobile" | "tablet" | null) => Promise<unknown>;
        /** 기록된 핀 (PLAN D78): the whole list, pushed down into the view. */
        pins?: (payload: CdsDesignPinsPayload) => Promise<unknown>;
        /** 턴 실행 중 표식 (PLAN D86) — the overlay's send-toast reads it. */
        busy?: (on: boolean) => Promise<unknown>;
        /** 화면 보여 주기 (PLAN D89): the frame plus the recent console lines. */
        snapshot?: () => Promise<{ jpeg: string | null; console: string[] }>;
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
        /** 배율 되알림 (PLAN D85 ⓔ) — the menu changed it, the web redraws. */
        onZoom?: (callback: (payload: { factor: number }) => void) => Unsubscribe;
        /** D78: the overlay bubble's 해결, relayed verbatim from the view. */
        onCommentResolve?: (callback: (payload: { id: string; resolved: boolean }) => void) => Unsubscribe;
        /** D78: the attention bubble's 다시 요청. */
        onCommentResend?: (callback: (payload: { id: string }) => void) => Unsubscribe;
      };
    };
  }
}

export {};
