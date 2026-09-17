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

/**
 * The Escape side of `aria-modal="true"`: only the TOPMOST overlay answers.
 * Every dialog used to listen on `document` unconditionally, so a confirm
 * stacked on a settings or review surface closed both at once — the planner
 * pressed Escape once and lost two layers. The rule is stacking, not
 * registration order: the palette (z-70) paints above a dialog (z-60) even
 * when the markup puts the modal last, so an open palette is the layer
 * Escape dismisses; with no palette open, the last `.modal` / `.palette` /
 * `.onboarding` in the DOM is.
 *
 * Menus and folds are not overlays — they keep their own Escape handlers.
 */
export function useModalEscape(
  panel: RefObject<HTMLElement | null>,
  onClose: () => void,
  open: boolean = true,
): void {
  useEffect(() => {
    if (!open) return;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const overlays = document.querySelectorAll(".modal, .palette, .onboarding");
      if (overlays.length === 0) return;
      // 규칙은 겹침이다, 마크 순서가 아니다 — 팔레트(z-70)는 대화상자(z-60)보다
      // 위에 칠해지는데 마크에서는 앞에 설 수 있다. 팔레트가 열려 있기만 해도
      // 그것이 맨 위 층이다; 없을 때만 DOM 마지막이 맨 위다.
      const palette = [...overlays].find((el) => el.classList.contains("palette"));
      const top = palette ?? overlays[overlays.length - 1]!;
      const root = panel.current?.closest(".modal, .palette, .onboarding");
      if (root !== top) return;
      onClose();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [panel, onClose, open]);
}
