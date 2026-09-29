import {
  Bell,
  CircleArrowDown,
  Link2,
  type LucideIcon,
  Palette,
  Sparkles,
  Wrench,
} from "lucide-react";

/**
 * 설정 왼쪽 목록의 그림 — `next/ui/icons.tsx` 와 같은 규칙(굵기 1.8, 장식이므로
 * aria-hidden). 이 대화상자에만 쓰는 것을 여기에 둔다.
 */
function make(Glyph: LucideIcon, size = 16, strokeWidth = 1.8) {
  return function Icon() {
    return <Glyph className="nx-i" size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
  };
}

export const AiPageIcon = make(Sparkles);
export const ThemePageIcon = make(Palette);
export const NotifyPageIcon = make(Bell);
export const ConnectPageIcon = make(Link2);
export const UpdatePageIcon = make(CircleArrowDown);
export const DevPageIcon = make(Wrench);
