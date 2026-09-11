// The icon gate: every glyph in the app comes from lucide-react through this
// module, so one stroke weight (1.8, heavier on the tiny utilities) and one
// size vocabulary (12–16px) hold wherever the next designer adds another.
// All icons are decorative (aria-hidden) — interactive elements carry their
// own aria-labels, and buttons that tests select by accessible name keep
// visible text labels instead of icon-only names.

import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Copy,
  ExternalLink,
  File,
  Folder,
  GitPullRequest,
  Link,
  Monitor,
  Paperclip,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  ServerOff,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";

interface IconProps {
  size?: number;
}

/** Wraps a lucide glyph at the house stroke and the glyph's own default size. */
function make(Glyph: LucideIcon, defaultSize: number, strokeWidth = 1.8) {
  return function Icon({ size = defaultSize }: IconProps) {
    return <Glyph size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
  };
}

// --- transcript & composer ------------------------------------------------

export const ArrowUpIcon = make(ArrowUp, 14);
export const PaperclipIcon = make(Paperclip, 15);
export const ChevronRightIcon = make(ChevronRight, 12, 2);
export const ChevronDownIcon = make(ChevronDown, 12, 2);
export const FileIcon = make(File, 13);
export const FolderIcon = make(Folder, 13);
export const CheckIcon = make(Check, 12, 2.2);
export const CloseIcon = make(X, 12, 2.2);
export const ShieldIcon = make(ShieldCheck, 16);

// --- workspace chrome -------------------------------------------------------

export const GearIcon = make(Settings, 14);
export const PlusIcon = make(Plus, 12);
export const RefreshIcon = make(RefreshCw, 13);
export const ClipboardCheckIcon = make(ClipboardCheck, 13);
export const SaveIcon = make(Save, 13);
/** 개발자에게 넘기기: the cycle ends in the developer's pull request. */
export const HandoffIcon = make(GitPullRequest, 13);
export const MobileIcon = make(Smartphone, 12);
export const DesktopIcon = make(Monitor, 12);
export const ExternalLinkIcon = make(ExternalLink, 12);
export const RestartIcon = make(RotateCcw, 13);
export const CopyIcon = make(Copy, 12);
export const LinkIcon = make(Link, 12);
export const WarnIcon = make(TriangleAlert, 12);
/** 미리보기 서버 중단: the server itself is down — distinct from 재시작's rotate. */
export const ServerOffIcon = make(ServerOff, 15);

// --- the two glyphs lucide does not own -------------------------------------
// The filled stop square and the tool's eight-ray spark are drawn by hand so
// they stay exactly as drawn: a stop button reads filled, and the spark is
// the mark the tool asks permission with.

export function StopIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
    </svg>
  );
}

export function SparkIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 4v16M4 12h16M6.8 6.8l10.4 10.4M17.2 6.8 6.8 17.2"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
      />
    </svg>
  );
}
