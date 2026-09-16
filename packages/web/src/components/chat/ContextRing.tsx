/**
 * 컨텍스트 윈도우 — how full this conversation has grown, as one ring beside
 * the send button: the place the eye already is when it decides whether to
 * spend one more turn. Hover or focus opens the reading behind it — the
 * percent, and nothing else. Token counts and session cost stay out:
 * the product's promise is one subscription,
 * and the transcript's own rule is "Cost stays invisible."
 *
 * The reading rides the shared Tip: the bubble is a portal, so the send row's
 * own stacking never clips it, and aria-describedby is wired for free.
 */

import type { ContextUsage } from "@colo-design/protocol";
import { Tip } from "../shell/Tip";

export function ContextRing({ usage }: { usage: ContextUsage | null }) {
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

  return (
    <Tip
      className="ctx"
      bubbleClass="ctx__tip"
      align="end"
      label={
        <>
          <span className="ctx__tiptitle">컨텍스트 윈도우</span>
          <span className="ctx__tipreading">{pct}% 사용됨</span>
        </>
      }
    >
      <button
        type="button"
        className={shade ? `ctx__ring ring ctx__ring--${shade}` : "ctx__ring ring"}
        aria-label={`컨텍스트 윈도우 ${pct}% 사용됨`}
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
    </Tip>
  );
}
