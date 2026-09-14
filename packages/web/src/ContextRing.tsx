/**
 * 컨텍스트 윈도우 — how full this conversation has grown, as one ring beside
 * the send button: the place the eye already is when it decides whether to
 * spend one more turn. Hover or focus opens the numbers behind it — the
 * reading, the window it is measured against, and what this session run has
 * cost so far.
 *
 * Disclosure is CSS (`:hover` · `:focus-within`), not state: there is no
 * pointer bookkeeping to fall out of step with the pointer, and the panel
 * stays in the DOM so `aria-describedby` always has something to point at.
 */

import type { ContextUsage } from "@colo-design/protocol";
import { useId } from "react";

/** A window reads as a size, not a count: 106_000 → `106k`, 1_000_000 → `1m`. */
function tokens(count: number): string {
  const n = Math.max(0, Math.round(count));
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  const millions = n / 1_000_000;
  return `${millions >= 10 ? Math.round(millions) : Math.round(millions * 10) / 10}m`;
}

export function ContextRing({ usage }: { usage: ContextUsage | null }) {
  const tipId = useId();
  // Nothing has been measured yet — a thread with no settled turn. An empty
  // ring beside the send button would be a gauge reading zero, which is a
  // claim; showing nothing is the truth.
  if (!usage) return null;

  const pct = Math.max(0, Math.min(100, Math.round(usage.percentage)));
  // The two points the conversation itself changes at: past 60% it is long,
  // past 85% its opening is about to be summarised away. The plan budgets in
  // the chip above judge their own thresholds; these belong to the window.
  const shade = pct >= 85 ? "danger" : pct >= 60 ? "warn" : "";
  // r=7.5 in a 20-unit box, so a 3-wide stroke sits inside the viewBox.
  const circumference = 2 * Math.PI * 7.5;
  const cost = usage.sessionCostUsd;

  return (
    <span className="ctx">
      <button
        type="button"
        className={shade ? `ctx__ring ring ctx__ring--${shade}` : "ctx__ring ring"}
        aria-label={`컨텍스트 윈도우 ${pct}% 사용됨`}
        aria-describedby={tipId}
      >
        <svg viewBox="0 0 20 20" width={18} height={18} aria-hidden>
          <circle className="ctx__track" cx="10" cy="10" r="7.5" />
          <circle
            className="ctx__arc"
            cx="10"
            cy="10"
            r="7.5"
            strokeDasharray={`${(pct / 100) * circumference} ${circumference}`}
            transform="rotate(-90 10 10)"
          />
        </svg>
      </button>
      <span className="ctx__tip" id={tipId} role="tooltip">
        <span className="ctx__tiptitle">컨텍스트 윈도우</span>
        <span className="ctx__tipreading">{pct}% 사용됨</span>
        <span className="ctx__tipnote">
          {tokens(usage.totalTokens)} / {tokens(usage.maxTokens)} 토큰
        </span>
        {/* A run that has never answered has no price to report — the line
            stays away rather than claiming a measured $0.00. Under half a
            cent, two decimals would round to `$0.00` and read as free. */}
        {cost != null && (
          <span className="ctx__tipnote">
            세션 비용 {cost > 0 && cost < 0.005 ? "$0.01 미만" : `$${cost.toFixed(2)}`}
          </span>
        )}
      </span>
    </span>
  );
}
