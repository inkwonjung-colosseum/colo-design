import type {
  ColoDesignCommentsEnvelope,
  ColoDesignScreen,
  UpdateCheckResult,
} from "@colo-design/protocol";

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
    coloDesignDesktop?: {
      /** The OS the app runs on — the install button is mac-only; win goes
       * to the releases page. */
      platform: string;
      updateCheck: () => Promise<UpdateCheckResult>;
      /** The feed — not the renderer — decides what gets downloaded; the
       * request takes no arguments by design (a compromised renderer must not
       * be able to point the updater at its own zip). */
      macSelfUpdate: () => Promise<
        | { planned: unknown; guarded: string } // 개발 실행 — 계획만
        | { started: boolean; downloadPath: string; steps: string[] } // 내려받기·검증 끝, 곧 종료
        | { error: string }
      >;
      /** Opens ~/.colo-design in the OS file manager (PLAN D2). */
      openHome?: () => Promise<unknown>;
      /** 알림 클릭 → 그 대화 열기(리뷰 B7): the session id to open. */
      onOpenSession?: (callback: (sessionId: string) => void) => Unsubscribe;
      preview?: {
        /** Claude 시점 보기(PLAN D63) — 8fps JPEG(base64), 구독만. */
        onFrame: (callback: (jpeg: string) => void) => void;
        /** D64: the native view exists — NativeHost, not the iframe. */
        native?: boolean;
        /**
         * Puts the page for this preview on screen; `epoch` names the server
         * process behind it (RepoStatus.previewEpoch). A page kept from an
         * earlier visit comes back as it was — under a new epoch it reloads.
         */
        mount?: (url: string, epoch: number | null) => Promise<unknown>;
        /** Takes the page off screen; it stays alive for the return. */
        unmount?: () => Promise<unknown>;
        bounds?: (rect: {
          x: number;
          y: number;
          width: number;
          height: number;
        }) => Promise<unknown>;
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
        /** 턴 실행 중 표식 (PLAN D86) — the overlay's send-toast reads it. */
        busy?: (on: boolean) => Promise<unknown>;
        /** 화면 보여 주기 (PLAN D89): the frame plus the recent console lines. */
        snapshot?: () => Promise<{ jpeg: string | null; console: string[] }>;
        onLocation?: (
          callback: (payload: { path: string; canGoBack: boolean; canGoForward: boolean }) => void,
        ) => Unsubscribe;
        onScreens?: (callback: (payload: { screens: ColoDesignScreen[] }) => void) => Unsubscribe;
        onComments?: (callback: (payload: ColoDesignCommentsEnvelope) => void) => Unsubscribe;
        onError?: (
          callback: (payload: {
            kind: "runtime" | "build";
            message: string;
            route: string;
            state: string;
          }) => void,
        ) => Unsubscribe;
        onFreeze?: (callback: (jpeg: string) => void) => Unsubscribe;
        onKey?: (callback: (payload: { key: string; meta: boolean }) => void) => Unsubscribe;
        onLoading?: (callback: (payload: { on: boolean }) => void) => Unsubscribe;
        /** 배율 되알림 (PLAN D85 ⓔ) — the menu changed it, the web redraws. */
        onZoom?: (callback: (payload: { factor: number }) => void) => Unsubscribe;
      };
    };
  }
}
