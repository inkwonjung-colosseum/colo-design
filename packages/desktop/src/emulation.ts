/**
 * The widths a screen is looked at in — one table, two windows.
 *
 * The planner's own preview narrows with Electron's `enableDeviceEmulation`
 * (PLAN D69, `PlannerPreviewView.emulate`); the agent.s hidden window narrows
 * with CDP `Emulation.setDeviceMetricsOverride` (PLAN D61, the preview
 * driver). Two APIs, but the same three widths — a screen the agent called
 * mobile must be the width the user sees when they press 모바일.
 */
export interface ViewportMetrics {
  size: [number, number];
  /** Mobile framing: touch, `screenPosition: "mobile"`, the phone UA. */
  mobile: boolean;
  userAgent?: string;
}

export const VIEWPORT_METRICS: Record<"mobile" | "tablet" | "desktop", ViewportMetrics> = {
  mobile: {
    size: [390, 844],
    mobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  },
  tablet: { size: [768, 1024], mobile: false },
  /** The default window — what the agent.s driver opens with. */
  desktop: { size: [1280, 800], mobile: false },
};
