import { AlertTriangle, Copy, FolderOpen, type LucideIcon, Upload, X } from "lucide-react";

/**
 * 처음 한 번 · 초대 확인판의 그림 — `next/ui/icons.tsx` 와 같은 규칙(굵기 1.8,
 * 장식이므로 aria-hidden). 이 판에만 쓰는 것을 여기에 둔다.
 */
function make(Glyph: LucideIcon, size: number, strokeWidth = 1.8) {
  return function Icon() {
    return <Glyph className="nx-i" size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
  };
}

export const CloseIcon = make(X, 16, 2);
export const UploadIcon = make(Upload, 22);
export const CopyIcon = make(Copy, 14);
export const AlertIcon = make(AlertTriangle, 13, 1.8);
export const FolderIcon = make(FolderOpen, 14);
