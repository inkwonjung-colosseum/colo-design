import {
  Check,
  CircleAlert,
  Clock,
  ExternalLink,
  type LucideIcon,
  Mail,
  RefreshCw,
} from "lucide-react";
import { L } from "../labels";
import { type CycleScreen, clockParts } from "../lib/work-ledger";

/**
 * 상태 줄의 두 팝오버(제출 확인 · 이번 작업)가 함께 쓰는 조각 — 목업의 `.thumb`
 * 화면 줄, 시각 한 칸, 그림. 그림은 ui/icons 와 같은 선 굵기로 여기서만 쓴다.
 */
function make(Glyph: LucideIcon, size: number, strokeWidth = 1.8) {
  return function Icon() {
    return <Glyph className="nx-i" size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
  };
}

export const SentIcon = make(Check, 14, 2.2);
export const FailIcon = make(CircleAlert, 14);
export const ExtIcon = make(ExternalLink, 12);
export const ClockIcon = make(Clock, 13);
export const MailIcon = make(Mail, 13);
export const FixingIcon = make(RefreshCw, 11, 2);

/** 시각 한 칸 — 오늘이면 `10:12`, 아니면 `9월 24일 10:12`. 읽을 수 없으면 빈 칸. */
export function whenText(iso: string | null | undefined): string {
  if (!iso) return "";
  const parts = clockParts(iso, new Date());
  return parts ? L.work.time(parts.today, parts.hhmm, parts.month, parts.day) : "";
}

/** 시작일 — `9월 25일`. */
export function dayText(iso: string | null): string | null {
  if (!iso) return null;
  const parts = clockParts(iso, new Date());
  return parts ? L.work.day(parts.month, parts.day) : null;
}

/** 화면 한 줄 — 작은 그림 · 제목 · 그 화면을 만든 말 · 시각(목업 `.wp-row`). */
export function ScreenRow({ screen }: { screen: CycleScreen }) {
  return (
    <div className="nx-wp-row" title={screen.route}>
      <span className="nx-thumb" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="nx-wp-t">
        <b>{screen.title}</b>
        {screen.note && <span>{screen.note}</span>}
      </span>
      <span className="nx-wp-r">{whenText(screen.at)}</span>
    </div>
  );
}
