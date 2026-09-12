import { type RefObject, useEffect } from "react";

/**
 * The keyboard side of `aria-modal="true"`: while the dialog is open, Tab
 * wraps inside the panel instead of wandering the page it claims to cover,
 * and closing hands focus back to the element that opened it — so the
 * planner's next keystroke lands where their attention already is.
 *
 * Focus SEEDING stays with the caller (some panels want the panel itself,
 * the palette wants its search field); this hook only traps and restores.
 */
export function useModalFocus(panel: RefObject<HTMLElement | null>, open: boolean = true): void {
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;

    const focusables = (root: HTMLElement): HTMLElement[] =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          [
            "a[href]",
            "button:not([disabled])",
            "input:not([disabled])",
            "select:not([disabled])",
            "textarea:not([disabled])",
            "details > summary",
            '[tabindex]:not([tabindex="-1"])',
          ].join(", "),
        ),
      ).filter((el) => el.getClientRects().length > 0);

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const root = panel.current;
      if (!root) return;
      const within = focusables(root);
      if (within.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = within[0]!;
      const last = within[within.length - 1]!;
      const at = document.activeElement;
      // Focus that escaped the panel (a click into the backdrop, a bug)
      // re-enters at the ends rather than being lost behind the modal.
      if (!(at instanceof HTMLElement) || !root.contains(at)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (!event.shiftKey && at === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && at === first) {
        event.preventDefault();
        last.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [panel, open]);
}
