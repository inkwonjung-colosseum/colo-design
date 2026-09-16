import { useEffect } from "react";
import { COVER_LAYERS, createCoverReconciler } from "../lib/cover-reconciler";

/**
 * The one z-order rule. The native preview view is always above
 * renderer DOM, so any layer that draws over the stage must hide it. This
 * hook is the single watcher: every DOM change re-reads whether a covering
 * layer is up and asserts that to the main process, which hides the view
 * before it answers (`PlannerPreviewView.cover`) and freezes the last frame
 * behind — so the slot under a modal reads as dimmed content, not a hole.
 *
 * The assertion is state, not a toggle: `cover-reconciler` compares against
 * what main CONFIRMED, so a call that never landed is re-sent instead of
 * being remembered as done — the failure that leaves the stage painted over
 * an open modal. The first assertion is unconditional, because main's pane
 * outlives this document (a reopened window) and may still hold the cover
 * state of a renderer that no longer exists.
 *
 * The reverse rule lives in styles.css's z-index note: a new layer that
 * draws over the stage uses one of these classes — or `data-cover-stage` —
 * and is covered for free.
 */
export function usePreviewCover(): void {
  useEffect(() => {
    const bridge = window.coloDesignDesktop?.preview;
    const cover = bridge?.native ? bridge.cover : undefined;
    if (!cover) return;
    const reconciler = createCoverReconciler({
      desired: () => document.body.querySelector(COVER_LAYERS) !== null,
      apply: (on) => Promise.resolve(cover(on)),
    });
    const observer = new MutationObserver(() => reconciler.sync());
    observer.observe(document.body, { childList: true, subtree: true });
    reconciler.sync();
    return () => {
      observer.disconnect();
      reconciler.stop();
      // Only undo what main confirmed — an unknown state is main's to keep
      // until the next watcher asserts against it.
      if (reconciler.applied() === true) void cover(false);
    };
  }, []);
}
