import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock,
  Copy,
  Ellipsis,
  ExternalLink,
  Eye,
  FileText,
  GitFork,
  Image,
  type LucideIcon,
  Mail,
  MapPin,
  Paperclip,
  Pencil,
  Plug,
  Sparkle,
  Square,
  X,
  Zap,
} from "lucide-react";

/**
 * 대화 칸의 그림 — `ui/icons.tsx` 와 같은 선 굵기 · 크기 규칙. 칸마다 제 파일을
 * 두어 단계들이 한 파일을 함께 고치지 않게 했다. 모두 장식(aria-hidden)이다.
 */
function make(Glyph: LucideIcon, size: number, strokeWidth = 1.8) {
  return function Icon() {
    return <Glyph className="nx-i" size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
  };
}

export const ClipIcon = make(Paperclip, 16);
export const PinIcon = make(MapPin, 15);
export const BoltIcon = make(Zap, 14);
export const UpIcon = make(ArrowUp, 16, 2.2);
export const StopIcon = make(Square, 12, 2.4);
export const CopyIcon = make(Copy, 13);
export const MoreIcon = make(Ellipsis, 14);
export const ForkIcon = make(GitFork, 14);
export const EyeIcon = make(Eye, 15);
export const AlertIcon = make(CircleAlert, 14);
export const MailIcon = make(Mail, 14);
export const PlugIcon = make(Plug, 14);
export const XIcon = make(X, 12, 2);
export const ExtIcon = make(ExternalLink, 12);
export const EditIcon = make(Pencil, 12);
export const ClockIcon = make(Clock, 13);
export const FileIcon = make(FileText, 16);
export const ImageIcon = make(Image, 16);
export const SparkIcon = make(Sparkle, 13);
export const CheckIcon = make(Check, 13, 2.2);
export const ChevIcon = make(ChevronDown, 12, 2);
export const FwdIcon = make(ChevronRight, 14, 2);
