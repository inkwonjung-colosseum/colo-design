/**
 * Everything the planner's ACCOUNT spends, behind one chip — ex `Composer`
 * head. Pure presentation: numbers arrive as props,
 * the face reads the 5-hour window, the popover carries the whole budget
 * picture.
 */

import type { PlanUsage } from "@colo-design/protocol";
import { useEffect, useState } from "react";
import { GaugeIcon } from "../icons";
import { Tip } from "../shell/Tip";

/**
 * "언제 끝나나" reads best as time left, and one unit is enough on a chip —
 * the exact clock time stays in the tooltip.
 */
function timeLeft(at: string | null): string | null {
  if (!at) return null;
  const minutes = Math.round((new Date(at).getTime() - Date.now()) / 60000);
  if (minutes <= 0) return null;
  if (minutes < 60) return `${minutes}분 남음`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 남음`;
  return `${Math.round(hours / 24)}일 남음`;
}

/**
 * The exact moment a spent window comes back, in the planner's own clock.
 * `timeLeft` answers "얼마나"; this answers "언제".
 */
function clockTime(at: string): string {
  return new Date(at).toLocaleTimeString("ko-KR", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Popover note: how long is left, and when the window refills — one line. */
function resetNote(at: string | null | undefined): string {
  if (!at) return "";
  const left = timeLeft(at);
  return left ? `${left} · ${clockTime(at)}에 초기화` : `${clockTime(at)}에 초기화`;
}

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

function tone(pct: number): "" | "warn" | "danger" {
  return pct >= 85 ? "danger" : pct >= 60 ? "warn" : "";
}

export function UsageChip({
  plans,
  onRefresh,
}: {
  /**
   * One reading per enabled provider's account, the composer's own first —
   * claude's 43% and codex's are different budgets, so each arrives with its
   * account's display name already resolved. A provider with no reading yet
   * is simply absent.
   */
  plans: Array<{ plan: PlanUsage; label: string | null }>;
  onRefresh?: () => void;
}) {
  const [open, setOpen] = useState(false);
  /**
   * One entry per budget window, grouped under its account. `raw` stays
   * unclamped so "no reading yet" (null) can keep saying nothing instead of
   * claiming 0%.
   */
  interface Entry {
    label: string;
    raw: number | null;
    pct: number;
    resetsAt: string | null;
    note: string;
  }
  const groups = plans
    .map(({ plan, label }) => {
      const entries: Entry[] = [];
      if (plan.fiveHour) {
        entries.push({
          label: "5시간",
          raw: plan.fiveHour.utilization ?? null,
          pct: clamp(plan.fiveHour.utilization ?? 0),
          resetsAt: plan.fiveHour.resetsAt ?? null,
          note: resetNote(plan.fiveHour.resetsAt),
        });
      }
      if (plan.sevenDay) {
        entries.push({
          label: "이번 주",
          raw: plan.sevenDay.utilization ?? null,
          pct: clamp(plan.sevenDay.utilization ?? 0),
          resetsAt: plan.sevenDay.resetsAt ?? null,
          note: resetNote(plan.sevenDay.resetsAt),
        });
      }
      // The label arrives fully spelled from the producing driver — "Fable
      // 주간" from claude, "이번 달" from codex's free plan — because only
      // the driver knows the period the row actually runs on.
      for (const row of plan.modelWeekly) {
        entries.push({
          label: row.label,
          raw: row.utilization ?? null,
          pct: clamp(row.utilization ?? 0),
          resetsAt: row.resetsAt ?? null,
          note: resetNote(row.resetsAt),
        });
      }
      return { plan, label, entries };
    })
    // A reading with no windows is no reading — its account line would only
    // say nothing with confidence.
    .filter((group) => group.entries.length > 0);

  // The chip's face belongs to the composer's own account — the one the next
  // turn spends — and within it the 5-hour window, the row a planner checks
  // before one more turn. Its colour follows that same number, so the arc
  // and the reading never disagree. The overall state ("거의 찼어요") keeps
  // reading the worst budget across every shown account, where the full
  // picture lives.
  const allEntries = groups.flatMap((group) => group.entries);
  const worst = allEntries.length > 0 ? allEntries.reduce((a, b) => (b.pct > a.pct ? b : a)) : null;
  const lead =
    (groups[0]?.entries ?? []).find((entry) => entry.label === "5시간") ??
    groups[0]?.entries[0] ??
    null;
  const badge = lead ? tone(lead.pct) : "";
  const overall = worst ? tone(worst.pct) : "";
  /**
   * Which account's rows the popover is reading. Null means the composer's
   * own — the first group — so a fresh open always lands on the account the
   * next turn spends, and a provider that disappears mid-open falls back to
   * it instead of pointing at nothing.
   */
  const [tab, setTab] = useState<string | null>(null);
  // 칩의 얼굴은 말이다 — 숫자(퍼센트·시간)는 팝오버의 몫. 여유 구간에는 칩이
  // 아예 서지 않는다(B3): 계량은 `차오르는 중`부터 말을 시작한다.
  const faceWord = badge === "warn" ? "차오르는 중" : "거의 찼어요";
  // Time left is computed from `now`, so a rendered countdown goes stale;
  // re-render on the half-minute while one is on screen.
  const counting = Boolean(lead?.resetsAt);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open && !counting) return;
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, [open, counting]);

  // Escape closes — the one dismissal a keyboard-only planner will try first,
  // and the one every chip next to this one already answers.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // 여유 구간(badge 가 빈 칸)엔 칩이 아예 없다(B3) — 아래 렌더는 경고 톤부터다.
  if (!lead || !worst || badge === "") return null;
  const shown = groups.find((group) => (group.plan.provider ?? "") === tab) ?? groups[0];
  if (!shown) return null;
  const moveTab = (step: number) => {
    const at = groups.indexOf(shown);
    const next = groups[(at + step + groups.length) % groups.length];
    setTab(next?.plan.provider ?? null);
  };

  // The ring gauges whatever the chip is reading, so the arc and the number
  // beside it can never disagree. The budgets it is not showing keep their
  // rows in the popover.
  const ringPct = lead.raw != null ? lead.pct : null;
  const ringLength = 2 * Math.PI * 7.5;

  return (
    <span className="selector">
      {open && (
        <button
          type="button"
          className="selector__backdrop"
          aria-label="사용량 닫기"
          onClick={() => setOpen(false)}
        />
      )}
      <Tip
        label={
          open
            ? undefined
            : lead.resetsAt
              ? `${faceWord} · ${lead.label} 한도는 ${clockTime(lead.resetsAt)}에 다시 채워집니다`
              : `${faceWord} — AI를 얼마나 썼는지 봅니다`
        }
      >
        <button
          type="button"
          className={badge ? `usage__chip usage__chip--${badge}` : "usage__chip"}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`사용량 — ${faceWord}`}
          onClick={() => {
            const next = !open;
            setOpen(next);
            // A fresh open lands on the composer's own account — the one the
            // next turn spends — not whichever tab was left over.
            if (next) setTab(null);
            // Opening asks about right now: a 5-hour window that reset since
            // the last turn deserves its fresh number, not the stale one.
            if (next) onRefresh?.();
          }}
        >
          <span className="usage__ring" aria-hidden>
            <svg viewBox="0 0 20 20" width={18} height={18}>
              <circle className="usage__ringtrack" cx="10" cy="10" r="7.5" />
              {ringPct !== null && (
                <circle
                  className={
                    tone(ringPct)
                      ? `usage__ringarc usage__ringarc--${tone(ringPct)}`
                      : "usage__ringarc"
                  }
                  cx="10"
                  cy="10"
                  r="7.5"
                  strokeDasharray={`${(ringPct / 100) * ringLength} ${ringLength}`}
                  transform="rotate(-90 10 10)"
                />
              )}
            </svg>
          </span>
          {badge === "warn" ? (
            "차오르는 중"
          ) : (
            <>
              거의 찼어요
              {timeLeft(lead.resetsAt) && (
                <span className="usage__reading">{timeLeft(lead.resetsAt)}</span>
              )}
            </>
          )}
        </button>
      </Tip>
      {open && (
        <span className="selector__menu usage__menu" role="dialog" aria-label="사용량">
          <span className="usage__head">
            <span className="usage__title">
              <span className="ic ic--sm ic--quiet">
                <GaugeIcon />
              </span>{" "}
              사용량
            </span>
            <span className={overall ? `usage__state usage__state--${overall}` : "usage__state"}>
              <i className="usage__statedot" aria-hidden />
              {worst.pct >= 85 ? "거의 찼어요" : worst.pct >= 60 ? "차오르는 중" : "여유로워요"}
            </span>
          </span>
          {groups.length > 1 && (
            <span className="usage__tabs" role="tablist" aria-label="계정">
              {groups.map((group, gi) => {
                const id = group.plan.provider ?? `account-${gi}`;
                const picked = group === shown;
                const groupWorst = group.entries.reduce((a, b) => (b.pct > a.pct ? b : a));
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={picked}
                    className={picked ? "usage__tab usage__tab--picked" : "usage__tab"}
                    onClick={() => setTab(group.plan.provider ?? null)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowRight") moveTab(1);
                      if (event.key === "ArrowLeft") moveTab(-1);
                    }}
                  >
                    <i
                      className={
                        tone(groupWorst.pct)
                          ? `usage__dot usage__dot--${tone(groupWorst.pct)}`
                          : "usage__dot"
                      }
                      aria-hidden
                    />
                    {group.label ?? group.plan.provider ?? "계정"}
                  </button>
                );
              })}
            </span>
          )}
          {shown.plan.provider && (
            <span className="usage__note">
              {shown.label ?? shown.plan.provider} 계정
              {shown.plan.subscriptionType ? ` · ${shown.plan.subscriptionType}` : ""}
            </span>
          )}
          {shown.entries.map((row) => (
            <span key={row.label} className="usage__metric">
              <span className="usage__metric-head">
                <span className="usage__label">{row.label}</span>
                <span
                  className={
                    tone(row.pct) ? `usage__pct usage__pct--${tone(row.pct)}` : "usage__pct"
                  }
                >
                  {row.pct}%
                </span>
              </span>
              <span className="usage__track">
                <span
                  className={
                    tone(row.pct) ? `usage__fill usage__fill--${tone(row.pct)}` : "usage__fill"
                  }
                  style={{ width: `${row.pct}%` }}
                />
                {/* A threshold the gauge has already passed is told by the
                    colour itself; only the ones still ahead earn a tick. */}
                {row.pct < 60 && <i className="usage__tick usage__tick--warn" aria-hidden />}
                {row.pct < 85 && <i className="usage__tick usage__tick--danger" aria-hidden />}
              </span>
              {row.note && <span className="usage__note">{row.note}</span>}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
