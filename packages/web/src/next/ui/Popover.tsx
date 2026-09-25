import { type ReactNode, type RefObject, useEffect, useRef } from "react";

/**
 * 누른 자리 아래에 뜨는 팝오버 한 장 — 목업의 `.pop`. 부르는 쪽이 누르는
 * 요소와 함께 `nx-anchor`(position: relative) 안에 둔다. 바깥을 누르거나
 * Esc 를 누르면 닫힌다; 누르는 요소 자체는 바깥으로 치지 않는다(다시 누르면
 * 부르는 쪽의 토글이 닫는다).
 */
export function Popover({
  anchor,
  onClose,
  className,
  align = "start",
  up = false,
  children,
}: {
  /** 팝오버를 연 요소 — 이 안의 누름은 바깥이 아니다. */
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  className?: string;
  /** 누른 요소의 왼쪽(start)에 맞출까 오른쪽(end)에 맞출까. */
  align?: "start" | "end";
  /** 위로 열기 — 바닥에 붙은 요소(사이드바 아래 · 입력창)의 팝오버. */
  up?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target) || anchor.current?.contains(target)) return;
      close.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor]);
  const classes = ["nx-pop", `nx-pop--${align}`, up ? "nx-pop--up" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div ref={ref} className={classes} role="dialog">
      {children}
    </div>
  );
}
