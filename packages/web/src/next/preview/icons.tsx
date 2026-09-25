import {
  ArrowRight,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Ellipsis,
  Eye,
  Keyboard,
  type LucideIcon,
  MapPin,
  Minus,
  Monitor,
  Plus,
  RotateCw,
  Smartphone,
  Tablet,
  Trash2,
  Undo2,
  X,
} from "lucide-react";

/**
 * 미리보기 칸의 그림 — `ui/icons.tsx` 와 같은 규약(선 굵기 1.8, 장식)이지만
 * 이 칸의 파일에 둔다: 단계마다 자기 파일을 고쳐 병합이 겹치지 않게.
 */
function make(Glyph: LucideIcon, size: number, strokeWidth = 1.8) {
  return function Icon() {
    return <Glyph className="nx-i" size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
  };
}

export const BackIcon = make(ChevronLeft, 17);
export const ForwardIcon = make(ChevronRight, 17);
export const ReloadIcon = make(RotateCw, 15);
export const AddrChevronIcon = make(ChevronDown, 14, 2);
export const PcIcon = make(Monitor, 15);
export const TabletIcon = make(Tablet, 15);
export const PhoneIcon = make(Smartphone, 15);
export const PinIcon = make(MapPin, 15);
export const PinSmallIcon = make(MapPin, 14);
export const ClockIcon = make(Clock, 16);
export const MoreIcon = make(Ellipsis, 16);
export const EyeIcon = make(Eye, 14);
export const CameraIcon = make(Camera, 14);
export const KeyboardIcon = make(Keyboard, 14);
export const TrashIcon = make(Trash2, 13);
export const CloseIcon = make(X, 16);
export const UndoIcon = make(Undo2, 13);
export const SmallCheckIcon = make(Check, 12, 2.2);
export const MinusIcon = make(Minus, 14);
export const PlusIcon = make(Plus, 14);
export const ArrowIcon = make(ArrowRight, 14);
