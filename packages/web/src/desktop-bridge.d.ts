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
    };
  }
}

export {};
