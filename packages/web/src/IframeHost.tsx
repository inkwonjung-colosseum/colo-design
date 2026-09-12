import type {
  ColoDesignNavigateEnvelope,
  ColoDesignScreen,
  ColoDesignScreensEnvelope,
  ColoDesignScreensRequestEnvelope,
} from "@colo-design/protocol";
import { useEffect, useRef, useState } from "react";
import type { PreviewTarget } from "./PreviewHost";

/**
 * 브라우저 개발 경로의 미리보기 (PLAN D70): the repo's dev server framed
 * as-is, speaking the repo bridge contract only — `colo-design.screens` in,
 * `colo-design.navigate` out. Comments, the address bar and the error banner
 * are the native view's (D67 · D66 · D69) and are simply absent here; a plain
 * browser is the developer's path, and it is not told what it lacks.
 *
 * NAVIGATION IS A PROP, NOT A HANDLE — `target` comes down because nothing in
 * this package exposes an imperative handle (PreviewHost's rule). The re-send
 * below keeps a navigate posted at a booting page from looking broken: the
 * planner picks a screen while the repo is still starting, and every load
 * re-delivers the last ask.
 */
export function IframeHost({
  url,
  target,
  reloadKey,
  onScreens,
}: {
  url: string;
  /** The last screen asked for; free paths cannot be followed here (D70). */
  target: PreviewTarget | null;
  /** Bumped by 새로 고침 — remounts the iframe for a clean reload. */
  reloadKey: number;
  onScreens: (screens: ColoDesignScreen[]) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [loads, setLoads] = useState(0);

  useEffect(() => {
    if (!url) return;
    const expectedOrigin = new URL(url).origin;
    const onMessage = (event: MessageEvent) => {
      // Only this iframe may speak; anything else in the page is noise.
      if (event.source !== frame.current?.contentWindow) return;
      if (event.origin !== expectedOrigin) return;
      const data = event.data as ColoDesignScreensEnvelope | null;
      if (data?.type === "colo-design.screens" && Array.isArray(data.screens))
        onScreens(data.screens);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [url, onScreens]);

  const screen = target?.kind === "screen" ? target : null;

  useEffect(() => {
    if (!url || !screen || loads === 0) return;
    const contentWindow = frame.current?.contentWindow;
    if (!contentWindow) return;
    const envelope: ColoDesignNavigateEnvelope = {
      type: "colo-design.navigate",
      route: screen.route,
      state: screen.state,
    };
    // Addressed to the preview's own origin, never "*".
    contentWindow.postMessage(envelope, new URL(url).origin);
  }, [url, screen, loads]);

  return (
    <iframe
      key={reloadKey}
      className="preview__frame"
      title="미리보기"
      ref={frame}
      src={url}
      onLoad={() => {
        setLoads((count) => count + 1);
        // The bridge posts its list once on its own mount and never retries,
        // so the two orderings cover each other (D7).
        const request: ColoDesignScreensRequestEnvelope = {
          type: "colo-design.screens?",
        };
        frame.current?.contentWindow?.postMessage(request, new URL(url).origin);
      }}
    />
  );
}
