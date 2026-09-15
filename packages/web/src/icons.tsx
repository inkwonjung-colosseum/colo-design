// The icon gate: every glyph in the app comes from lucide-react through this
// module, so one stroke weight (1.8, heavier on the tiny utilities) and one
// size vocabulary (12–16px) hold wherever the next designer adds another.
// All icons are decorative (aria-hidden) — interactive elements carry their
// own aria-labels, and buttons that tests select by accessible name keep
// visible text labels instead of icon-only names.

import {
  Archive,
  ArrowUp,
  Bell,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clock,
  Command,
  Copy,
  Download,
  ExternalLink,
  Eye,
  File,
  FileDiff,
  Folder,
  FolderPlus,
  Gauge,
  GitBranch,
  GitPullRequest,
  History,
  Info,
  KeyRound,
  Link,
  ListChecks,
  Lock,
  type LucideIcon,
  MapPin,
  MessageSquarePlus,
  Minus,
  Monitor,
  Palette,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ServerOff,
  Settings,
  Shield,
  ShieldCheck,
  ShieldOff,
  Smartphone,
  Tablet,
  Trash2,
  TriangleAlert,
  X,
  Zap,
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
export const PencilIcon = make(Pencil, 13);
export const ChevronRightIcon = make(ChevronRight, 12, 2);
export const ChevronDownIcon = make(ChevronDown, 12, 2);
export const FileIcon = make(File, 13);
export const FolderIcon = make(Folder, 13);
export const CheckIcon = make(Check, 12, 2.2);
export const CloseIcon = make(X, 12, 2.2);
export const ShieldIcon = make(ShieldCheck, 16);

// --- composer toolbar chips -------------------------------------------------
// Each chip leads with the glyph for what it governs, so the row reads as
// three controls rather than three words. The 확인 방식 chip is the one whose
// glyph carries a reading: the slash means nothing is being asked.

export const GaugeIcon = make(Gauge, 13);
export const ShieldPlainIcon = make(Shield, 13);
export const ShieldOffIcon = make(ShieldOff, 13);
export const ZapIcon = make(Zap, 14);

// --- action bar & menus (디자인 패스) ---------------------------------------
// The cycle's verbs and the menus' rows, one glyph each. A row's glyph names
// the row; the tone (in .ic) carries whether it is ordinary, warning, or a
// thing that destroys.

export const SaveIcon = make(Save, 13);
export const HandoffIcon = make(GitPullRequest, 13);
export const EyeIcon = make(Eye, 12);
export const HistoryIcon = make(History, 13);
export const TrashIcon = make(Trash2, 13);
/** 잠깐 치워두기 (보관함 토론) — the box the current attempt goes into. */
export const ArchiveIcon = make(Archive, 13);
/** 핀 모드 토글 (재설계 §3.9) — the picker the preview toolbar wears. */
export const MapPinIcon = make(MapPin, 13);
export const DiffIcon = make(FileDiff, 13);
export const MinusIcon = make(Minus, 12, 2);
export const ExportIcon = make(Download, 13);
export const NewChatIcon = make(MessageSquarePlus, 13);
export const FolderPlusIcon = make(FolderPlus, 13);
export const BranchIcon = make(GitBranch, 12, 2);
export const TabletIcon = make(Tablet, 12);
export const ClockIcon = make(Clock, 12);
export const SearchIcon = make(Search, 13);
export const CircleCheckIcon = make(CircleCheck, 13);
export const KeyIcon = make(KeyRound, 12);
export const PlugIcon = make(PlugZap, 14);
export const CommandIcon = make(Command, 12);
export const BellIcon = make(Bell, 13);
export const ThemeIcon = make(Palette, 13);
export const BrainIcon = make(Brain, 13);
export const InfoIcon = make(Info, 13);
export const StepsIcon = make(ListChecks, 13);

// --- workspace chrome -------------------------------------------------------

export const GearIcon = make(Settings, 14);
export const PlusIcon = make(Plus, 12);
export const RefreshIcon = make(RefreshCw, 13);
export const MobileIcon = make(Smartphone, 12);
export const DesktopIcon = make(Monitor, 12);
export const ExternalLinkIcon = make(ExternalLink, 12);
export const RestartIcon = make(RotateCcw, 13);
export const ChevronLeftIcon = make(ChevronLeft, 14, 2);
export const LockIcon = make(Lock, 11);
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
