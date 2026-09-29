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
  Lock,
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
export const LockIcon = make(Lock, 12);
export const FwdIcon = make(ChevronRight, 14, 2);

// 프로바이더 표식 — 모델 칩이 지금 AI 의 제 얼굴을 입어 Codex 대화가 Claude 의
// 것으로 읽히지 않게 한다. lucide 에는 상표 그림이 없어 두 벤더 표식을 그대로
// 옮겨 왔다: Claude 는 @vscode/codicons 의 `claude`(MIT), Codex 는 simple-icons 의
// OpenAI(CC0). 표식이 없는 AI 는 반짝이를 입는다.

const CLAUDE_MARK =
  "M6.96 15.2L7.184 14.208L7.44 12.928L7.648 11.904L7.84 10.64L7.952 10.224L7.936 10.192L7.856 10.208L6.896 11.52L5.44 13.488L4.288 14.704L4.016 14.816L3.536 14.576L3.584 14.128L3.856 13.744L5.44 11.712L6.4 10.448L7.024 9.728L7.008 9.632H6.976L2.752 12.384L2 12.48L1.664 12.176L1.712 11.68L1.872 11.52L3.136 10.64L6.288 8.88L6.336 8.72L6.288 8.64H6.128L5.6 8.608L3.808 8.56L2.256 8.496L0.736 8.416L0.352 8.336L0 7.856L0.032 7.616L0.352 7.408L0.816 7.44L1.824 7.52L3.344 7.616L4.448 7.68L6.08 7.856H6.336L6.368 7.744L6.288 7.68L6.224 7.616L4.64 6.56L2.944 5.44L2.048 4.784L1.568 4.448L1.328 4.144L1.232 3.472L1.664 2.992L2.256 3.04L2.4 3.072L2.992 3.536L4.256 4.512L5.92 5.744L6.16 5.936L6.272 5.872V5.824L6.16 5.648L5.264 4.016L4.304 2.352L3.872 1.664L3.76 1.248C3.7176 1.104 3.696 0.944 3.696 0.768L4.192 0.096L4.464 0L5.136 0.096L5.408 0.336L5.824 1.28L6.48 2.768L7.52 4.784L7.824 5.392L7.984 5.936L8.048 6.112H8.16V6.016L8.24 4.864L8.4 3.472L8.56 1.68L8.608 1.168L8.864 0.56L9.36 0.24L9.744 0.416L10.064 0.88L10.016 1.168L9.84 2.4L9.456 4.336L9.216 5.648H9.36L9.52 5.472L10.176 4.608L11.28 3.232L11.76 2.688L12.336 2.08L12.704 1.792H13.392L13.888 2.544L13.664 3.328L12.96 4.224L12.368 4.976L11.52 6.112L11.008 7.024L11.056 7.088H11.168L13.072 6.672L14.112 6.496L15.328 6.288L15.888 6.544L15.952 6.8L15.728 7.344L14.416 7.664L12.88 7.968L10.592 8.512L10.56 8.528L10.592 8.576L11.616 8.672L12.064 8.704H13.152L15.168 8.848L15.696 9.2L16 9.616L15.952 9.952L15.136 10.352L14.048 10.096L11.488 9.488L10.624 9.28H10.496V9.344L11.232 10.064L12.56 11.264L14.24 12.816L14.32 13.2L14.112 13.52L13.888 13.488L12.416 12.368L11.84 11.872L10.56 10.8H10.48V10.912L10.768 11.344L12.336 13.696L12.416 14.416L12.304 14.64L11.888 14.784L11.456 14.704L10.528 13.424L9.584 11.968L8.816 10.672L8.736 10.736L8.272 15.568L8.064 15.808L7.584 16L7.184 15.696L6.96 15.2Z";

const OPENAI_MARK =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

/** 지금 AI 의 표식 — 칩의 그림은 앱이 아니라 AI 를 이름한다. */
export function ProviderMark({ provider }: { provider: string }) {
  if (provider === "claude") {
    return (
      <svg
        className="nx-i nx-pmark nx-pmark--claude"
        width={14}
        height={14}
        viewBox="0 0 16 16"
        aria-hidden="true"
      >
        <path fill="currentColor" d={CLAUDE_MARK} />
      </svg>
    );
  }
  if (provider === "codex") {
    return (
      <svg className="nx-i nx-pmark" width={14} height={14} viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d={OPENAI_MARK} />
      </svg>
    );
  }
  return <SparkIcon />;
}
