import type { UpdateCheckResult } from "@cds-design/protocol";

/**
 * The desktop app's preload bridge (packages/desktop/src/preload.ts) — the
 * one surface the renderer reaches the main process through. Absent in a
 * plain browser; every access guards on it.
 */
declare global {
  interface Window {
    cdsDesignDesktop?: {
      updateCheck: () => Promise<UpdateCheckResult>;
      macSelfUpdate: (input: { url: string; sha256: string }) => Promise<unknown>;
      /** Opens ~/.cds-design in the OS file manager (PLAN D2). */
      openHome?: () => Promise<unknown>;
      /**
       * Claude 시점 보기(PLAN D63): the main process streams the offscreen
       * Claude window as 8fps-throttled JPEG frames (base64). Subscribe-only
       * — a callback cannot be removed — and a plain browser has no
       * `preview` at all, which is how the browser path stays silent.
       */
      preview?: {
        onFrame: (callback: (jpeg: string) => void) => void;
      };
    };
  }
}

export {};
