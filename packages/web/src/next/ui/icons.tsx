import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  House,
  type LucideIcon,
  Menu,
  PanelLeft,
  Plus,
  Search,
  Settings,
  Sparkle,
} from "lucide-react";

/**
 * 새 셸의 그림 한 곳 — 목업의 선 굵기(1.8)와 크기(12~16px)를 여기서 정한다.
 * 모두 장식이다(aria-hidden): 누르는 요소는 자기 이름을 따로 단다.
 */
function make(Glyph: LucideIcon, size: number, strokeWidth = 1.8) {
  return function Icon() {
    return <Glyph className="nx-i" size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
  };
}

export const PlusIcon = make(Plus, 16);
export const HomeIcon = make(House, 16);
export const SearchIcon = make(Search, 16);
export const GearIcon = make(Settings, 16);
export const MenuIcon = make(Menu, 17);
export const PanelIcon = make(PanelLeft, 16);
export const ChevronDownIcon = make(ChevronDown, 14, 2);
export const ChevronRightIcon = make(ChevronRight, 12, 2);
export const CheckIcon = make(Check, 14, 2.2);
export const CalmIcon = make(CircleCheck, 16);
export const SendIcon = make(ArrowUp, 16, 2.2);
export const SparkIcon = make(Sparkle, 14);

/** 도는 표식 — 목업의 `.spin.sm`. */
export function Spin() {
  return <i className="nx-spin" aria-hidden="true" />;
}
