import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

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
  float = false,
  label,
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
  /**
   * 조상의 굴리는 면에서 벗어나 창 기준으로 선다 — 대화록처럼 좁은 굴림 칸 안에서 팝이
   * 칸 끝에 잘리는 자리용. 앱 뿌리(`.nx`)로 옮겨 그려 고정 배치하고, 놓인 방향에 자리가
   * 모자라면 넓은 쪽으로 뒤집는다(`up` 은 먼저 시도할 방향이다).
   */
  float?: boolean;
  /** 대화상자의 이름 — 화면 낭독이 이 팝이 무엇인지 말해 준다. */
  label?: string;
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
      if (event.key !== "Escape") return;
      /* 다른 Esc 처리기(서랍 닫기 등)까지 내려가지 않게 여기서 멈춘다. */
      event.stopPropagation();
      close.current();
      /* 닫힌 뒤 초점이 허공에 남지 않게 여는 요소로 되돌린다. 앵커가 단추를 감싼 상자
         (`nx-anchor`)면 초점을 받을 수 없으니 그 안의 첫 초점 요소 — 여는 단추 — 로. */
      const opener = anchor.current;
      (opener?.matches(FOCUSABLE)
        ? opener
        : opener?.querySelector<HTMLElement>(FOCUSABLE)
      )?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor]);
  /**
   * 팝이 위로(`up`)든 아래로든 앵커가 놓인 방향의 남은 공간보다 크면 팝 한쪽
   * 끝이 자르는 면 밖으로 나가, 굴려도 닿을 수 없는 부분이 된다. 자르는 면은
   * 둘이다 — 창 가장자리와, 팝을 안쪽에서 자르는 조상 상자(홈처럼 overflow
   * 가 굴리는 면). 창만 재면 문제 문장이 조상의 위끝을 눌러 내린 만큼 팝이
   * 솟아 잘린다. 팝을 여는 순간 앵커와 그 면들을 함께 재서 높이 상한을 안쪽에
   * 묶고, 창이 바뀌거나 어느 조상이 굴러도 다시 잰다.
   */
  useLayoutEffect(() => {
    const el = ref.current;
    const anchorEl = anchor.current;
    if (!el || !anchorEl) return;
    if (float) {
      const place = () => {
        const rect = anchorEl.getBoundingClientRect();
        const gap = 6;
        const edge = 12;
        // 원래 크기를 다시 재려고 이전에 묶은 상한을 푼다.
        el.style.maxHeight = "";
        el.style.maxWidth = `${Math.max(200, window.innerWidth - edge * 2)}px`;
        const natural = el.offsetHeight;
        const above = rect.top - gap - edge;
        const below = window.innerHeight - rect.bottom - gap - edge;
        const goUp = up ? above >= natural || above >= below : below < natural && above > below;
        const room = Math.max(96, Math.floor(goUp ? above : below));
        el.style.maxHeight = `${room}px`;
        const width = el.offsetWidth;
        const left = align === "end" ? rect.right - width : rect.left;
        el.style.position = "fixed";
        el.style.left = `${Math.round(Math.min(Math.max(edge, left), window.innerWidth - width - edge))}px`;
        el.style.right = "auto";
        if (goUp) {
          el.style.top = "auto";
          el.style.bottom = `${Math.round(window.innerHeight - rect.top + gap)}px`;
        } else {
          el.style.bottom = "auto";
          el.style.top = `${Math.round(rect.bottom + gap)}px`;
        }
      };
      place();
      window.addEventListener("resize", place);
      document.addEventListener("scroll", place, true);
      return () => {
        window.removeEventListener("resize", place);
        document.removeEventListener("scroll", place, true);
      };
    }
    const clamp = () => {
      const rect = anchorEl.getBoundingClientRect();
      let limitTop = 0;
      let limitBottom = window.innerHeight;
      let limitLeft = 0;
      let limitRight = window.innerWidth;
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === "contents") continue;
        const box = parent.getBoundingClientRect();
        if (style.overflowY !== "visible") {
          limitTop = Math.max(limitTop, box.top);
          limitBottom = Math.min(limitBottom, box.bottom);
        }
        if (style.overflowX !== "visible") {
          limitLeft = Math.max(limitLeft, box.left);
          limitRight = Math.min(limitRight, box.right);
        }
      }
      // 여백 12px — 가장자리에 딱 붙이지 않는다.
      const space = Math.max(140, (up ? rect.top - limitTop : limitBottom - rect.bottom) - 12);
      el.style.maxHeight = `${Math.floor(space)}px`;
      /* 위 계산은 누른 단추의 자리를 기준으로 하지만 팝은 그 단추를 감싼 인라인 상자
         (`nx-anchor`)에서 6px 떨어져 서므로 두 기준이 몇 px 어긋나 팝 끝이 자르는 면 밖으로
         나간다(정산 줄의 `···` 메뉴 첫 줄이 위에서 잘렸다). 서 버린 팝을 다시 재어 남는
         만큼 높이를 더 줄인다 — 팝은 안에서 굴러가므로 줄여도 닿을 수 없는 곳은 없다. */
      const placed = el.getBoundingClientRect();
      const bleed = up ? limitTop + 8 - placed.top : placed.bottom - (limitBottom - 8);
      if (bleed > 0) {
        el.style.maxHeight = `${Math.max(96, Math.floor(placed.height - bleed))}px`;
      }
      /* 옆으로도 같다 — 오른쪽에 맞춘(end) 넓은 팝은 대화 칸을 좁히면 왼쪽 끝이
         창 밖으로 나가 잘렸다(모델 팝, 실사). 팝이 서는 기준은 부모(`nx-anchor`)
         의 한쪽 끝이라 그 끝에서 반대쪽 면까지를 폭 상한으로 묶는다. */
      const base = el.parentElement?.getBoundingClientRect() ?? rect;
      const room = Math.max(
        200,
        (align === "end" ? base.right - limitLeft : limitRight - base.left) - 12,
      );
      el.style.maxWidth = `${Math.floor(room)}px`;

      // 가로도 같다 — 좁은 창 칸(대화 칸)에서 팝이 옆 칸 아래로 들어가 잘린다.
      // 자르는 면 안쪽으로 팝을 밀어 넣는다(오른쪽 우선, 그다음 왼쪽).
      el.style.marginLeft = "";
      el.style.marginRight = "";
      const box = el.getBoundingClientRect();
      const margin = 8;
      const overRight = box.right - (limitRight - margin);
      const overLeft = limitLeft + margin - box.left;
      const shift =
        overRight > 0
          ? -Math.min(overRight, box.left - limitLeft - margin)
          : overLeft > 0
            ? overLeft
            : 0;
      if (shift !== 0) {
        if (align === "end") el.style.marginRight = `${-shift}px`;
        else el.style.marginLeft = `${shift}px`;
      }
    };
    clamp();
    window.addEventListener("resize", clamp);
    document.addEventListener("scroll", clamp, true);
    return () => {
      window.removeEventListener("resize", clamp);
      document.removeEventListener("scroll", clamp, true);
    };
  }, [anchor, up, align, float]);
  const classes = ["nx-pop", `nx-pop--${align}`, up ? "nx-pop--up" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  const panel = (
    <div ref={ref} className={classes} role="dialog" aria-label={label}>
      {children}
    </div>
  );
  if (!float) return panel;
  // 앱 뿌리(`.nx`) 안이어야 테마 변수와 `.nx …` 규칙이 그대로 닿는다.
  const root = anchor.current?.closest<HTMLElement>(".nx") ?? document.body;
  return createPortal(panel, root);
}
