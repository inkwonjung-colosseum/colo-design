// The icon gate: every glyph in the app comes from lucide-react through this
// module, so one stroke weight (1.8, heavier on the tiny utilities) and one
// size vocabulary (12–16px) hold wherever the next designer adds another.
// All icons are decorative (aria-hidden) — interactive elements carry their
// own aria-labels, and buttons that tests select by accessible name keep
// visible text labels instead of icon-only names.

import {
  AppWindow,
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
  Expand,
  ExternalLink,
  Eye,
  File,
  FileDiff,
  Folder,
  FolderPlus,
  Gauge,
  GitBranch,
  GitPullRequest,
  Globe,
  History,
  Home,
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
  Shrink,
  Smartphone,
  Tablet,
  Trash2,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";

export interface IconProps {
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
/** 잠깐 치워두기 — the box the current attempt goes into. */
export const ArchiveIcon = make(Archive, 13);
/** 핀 모드 토글 — the picker the preview toolbar wears. */
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
export const HomeIcon = make(Home, 13);
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
/** 크게 보기 (preview.md §1-D): the preview column takes the body's width. */
export const ExpandIcon = make(Expand, 12);
export const ShrinkIcon = make(Shrink, 12);
/** 탭 스트립의 kind 표식 (인앱 브라우저 1단계): preview 탭은 앱 창, web 탭은 지구본. */
export const AppWindowIcon = make(AppWindow, 12);
export const GlobeIcon = make(Globe, 12);

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

// --- provider marks ----------------------------------------------------------
// The model chip wears the connected agent's own mark, so a Codex thread never
// reads as a Claude one. lucide owns no brand glyphs: the two vendor marks are
// vendored verbatim from simple-icons (CC0), and omp's π is drawn at the house
// stroke. Claude wears the spark — the app's own mark already reads as Claude —
// and so does any provider that has no mark yet.

export function OpenAIIcon({ size = 13 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
      />
    </svg>
  );
}

/** OpenCode's mark — the square ring, exactly as the vendor draws it. */
export function OpenCodeIcon({ size = 13 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" fillRule="evenodd" d="M22 24H2V0h20zM17 4.8H7v14.4h10z" />
    </svg>
  );
}

/** omp 의 π — the name is the mark, drawn at the house stroke. */
export function PiIcon({ size = 13 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 20V10.4C7 8.8 5.9 7.6 4.2 7.6H3.2" />
      <path d="M3.2 7.6H20.8" />
      <path d="M14.2 20V7.6" />
    </svg>
  );
}

/** The connected provider's mark — the chip's glyph names the agent, not the app. */
export function ProviderIcon({ provider, size = 13 }: IconProps & { provider?: string | null }) {
  switch (provider) {
    case "codex":
      return <OpenAIIcon size={size} />;
    case "omp":
      return <PiIcon size={size} />;
    case "opencode":
      return <OpenCodeIcon size={size} />;
    default:
      return <SparkIcon size={size} />;
  }
}
