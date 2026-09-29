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

    // Elements outside the tab order (tabindex -1) are not ends of the trap: a
    // roving group (radio cards, tabs) leaves only its checked item tabbable,
    // and if the last node in the DOM were an unreachable one, Tab would walk
    // out of the dialog instead of wrapping.
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
      ).filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);

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
 * Escape dismisses; with no palette open, the last overlay in the DOM is.
 *
 * Menus and folds are not overlays — they keep their own Escape handlers.
 */

/** 덮개의 뿌리가 되는 클래스 — 낡은 셸의 것과 새 셸의 창 · 확인판이 함께 산다. */
export const MODAL_ROOT_SELECTOR = [
  ".modal",
  ".nx-pal",
  ".onboarding",
  ".nx-set-back",
  ".nx-modal-back",
].join(", ");

/** Esc 닫힘의 층 판정에 필요한 최소 모양 — 시험이 DOM 없이 이 모양으로 갈아끼운다. */
export interface OverlayLike {
  classList: { contains(name: string): boolean };
}

/** 겹친 덮개 가운데 맨 위 층을 고른다 — 팔레트가 열려 있기만 해도 그것이 맨 위고, 없으면 문서 마지막이다. */
export function topmostOverlay<T extends OverlayLike>(overlays: readonly T[]): T | null {
  if (overlays.length === 0) return null;
  return (
    overlays.find((el) => el.classList.contains("nx-pal")) ?? overlays[overlays.length - 1] ?? null
  );
}

/** 이 판의 뿌리가 맨 위 층일 때만 Esc 가 닫는다 — 아래 층은 위의 것이 닫힐 때까지 기다린다. */
export function escapeCloses(root: OverlayLike | null, overlays: readonly OverlayLike[]): boolean {
  if (!root) return false;
  return topmostOverlay(overlays) === root;
}

export function useModalEscape(
  panel: RefObject<HTMLElement | null>,
  onClose: () => void,
  open: boolean = true,
): void {
  useEffect(() => {
    if (!open) return;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const overlays = Array.from(document.querySelectorAll(MODAL_ROOT_SELECTOR));
      // 규칙은 겹침이다, 마크 순서가 아니다 — 팔레트(z-70)는 대화상자(z-60)보다
      // 위에 칠해지는데 마크에서는 앞에 설 수 있다. 팔레트가 열려 있기만 해도
      // 그것이 맨 위 층이다; 없을 때만 DOM 마지막이 맨 위다.
      const root = panel.current?.closest(MODAL_ROOT_SELECTOR);
      if (!escapeCloses(root ?? null, overlays)) return;
      onClose();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [panel, onClose, open]);
}
