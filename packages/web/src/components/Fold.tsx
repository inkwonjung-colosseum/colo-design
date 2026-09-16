import { type ReactNode, useState } from "react";

/**
 * 접힘 슬롯 — 자식을 그리드 행에 담아 닫힘 전이(1fr→0fr)를 재생하고, 끝나면
 * onCollapsed 로 내린다. 화면 아래의 내용이 끌려 올라와 빈 자리가 점프로
 * 사라지지 않게 하는 게 전부다. styles.css 의 .fold 와 한 쌍이다.
 */
export function Fold({
  closing,
  onCollapsed,
  children,
}: {
  closing: boolean;
  onCollapsed: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fold"
      data-closing={closing || undefined}
      onTransitionEnd={(event) => {
        // 슬롯 자신의 그리드 접힘(가장 긴 전이)만 센다 — 자식에서 버블된
        // 전이는 닫기와 무관하다.
        if (event.target !== event.currentTarget) return;
        if (event.propertyName !== "grid-template-rows" || !closing) return;
        onCollapsed();
      }}
    >
      {children}
    </div>
  );
}

/**
 * 닫힘 전이를 거치는 한 줄 노티스의 상태. show 는 내용을 열며 접는 중이라도
 * 다시 편다(새 소식이 진행 중인 접힘을 이어받지 않게), close 는 사용자의
 * 닫기로 접기를 시작하고, clear 는 내린다 — 접힘이 끝났거나 시스템이
 * 대체할 때(재시도, 다음 알림).
 */
export function useFoldNotice() {
  const [text, setText] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  return {
    text,
    closing,
    show: (next: string) => {
      setText(next);
      setClosing(false);
    },
    close: () => setClosing(true),
    clear: () => {
      setText(null);
      setClosing(false);
    },
  };
}
