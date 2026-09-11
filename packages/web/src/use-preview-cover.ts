import { useEffect } from "react";

/**
 * D65 — the one z-order rule. The native preview view is always above
 * renderer DOM, so any layer that draws over the stage must hide it. This
 * hook is the single watcher: `.modal`(z60) · `.palette`(z70) ·
 * `.selector__backdrop`(z40) · `.pip--large` appearing anywhere in the body
 * covers the view; the main process freezes the last frame first, so the
 * slot under a modal reads as dimmed content, not a hole.
 *
 * The reverse rule lives in styles.css's z-index note: a new layer that
 * draws over the stage uses one of these classes — that is how it gets
 * covered for free.
 */
export function usePreviewCover(): void {
  useEffect(() => {
    const bridge = window.cdsDesignDesktop?.preview;
    if (!bridge?.native || !bridge.cover) return;
    const LAYERS = ".modal, .palette, .selector__backdrop, .pip--large";
    let covering = false;
    const apply = () => {
      const on = document.body.querySelector(LAYERS) !== null;
      if (on === covering) return;
      covering = on;
      void bridge.cover?.(on);
    };
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
    apply();
    return () => {
      observer.disconnect();
      if (covering) void bridge.cover?.(false);
    };
  }, []);
}
