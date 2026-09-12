import { useEffect, useRef, useState } from "react";
import type { CdsDesignCommentsEnvelope, CdsDesignScreen } from "@cds-design/protocol";
import type { PreviewLocation, PreviewTarget } from "./PreviewHost";

/**
 * 데스크톱의 미리보기 칸 (PLAN D64): an empty slot the main process lays its
 * `WebContentsView` over. All knowing flows through the §2 channels — bounds
 * up (`ResizeObserver` → `preview:bounds`), location · screens · comments ·
 * errors · freeze · keys down. The slot shows the freeze frame (D65) while a
 * modal covers the view, so the pane never reads as a hole.
 *
 * The view is above every DOM node (D65) — nothing may be drawn over the slot
 * except through `usePreviewCover`; the PiP thumbnail therefore docks in the
 * frame header, not here.
 */
export function NativeHost({
  url,
  target,
  reloadKey,
  width,
  commentsOn,
  onLocation,
  onBridge,
  onScreens,
  onComments,
  onError,
  onLoading,
  onZoom,
}: {
  url: string;
  /** The last ask — a screen rides the bridge, a path rides `open` (D66). */
  target: PreviewTarget | null;
  reloadKey: number;
  width: "mobile" | "tablet" | "desktop";
  commentsOn: boolean;
  onLocation: (location: PreviewLocation) => void;
  onBridge: (state: "unknown" | "present" | "stale") => void;
  onScreens: (screens: CdsDesignScreen[]) => void;
  onComments: (envelope: CdsDesignCommentsEnvelope) => void;
  onError: (error: { kind: "runtime" | "build"; message: string; route: string; state: string }) => void;
  /** D85 ⓐ: the view is loading — the frame's reload button spins. */
  onLoading: (on: boolean) => void;
  /** D85 ⓔ: the zoom moved (the menu can move it) — the chip follows. */
  onZoom: (factor: number) => void;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const [freeze, setFreeze] = useState<string | null>(null);

  // The slot's rect is the view's bounds. DIP in CSS pixels — Electron maps
  // the ratio; one observer covers the sidebar drag and the window resize.
  useEffect(() => {
    const node = slot.current;
    const bounds = window.cdsDesignDesktop?.preview?.bounds;
    if (!node || !bounds) return;
    const send = () => {
      const rect = node.getBoundingClientRect();
      void bounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    };
    send();
    const observer = new ResizeObserver(send);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!url) return;
    void window.cdsDesignDesktop?.preview?.mount?.(url);
    return () => void window.cdsDesignDesktop?.preview?.unmount?.();
  }, [url]);

  // The last ask re-rides on every change — the prop IS the ask (D66).
  useEffect(() => {
    if (!url || !target) return;
    if (target.kind === "screen")
      void window.cdsDesignDesktop?.preview?.navigate?.(target.route, target.state);
    else void window.cdsDesignDesktop?.preview?.open?.(target.path);
  }, [url, target]);

  useEffect(() => {
    if (reloadKey > 0) void window.cdsDesignDesktop?.preview?.reload?.();
  }, [reloadKey]);

  useEffect(() => {
    void window.cdsDesignDesktop?.preview?.commentsMode?.(commentsOn);
  }, [commentsOn]);

  // 폭 is emulation on the native side (D69), not CSS names.
  useEffect(() => {
    void window.cdsDesignDesktop?.preview?.emulate?.(width === "desktop" ? null : width);
  }, [width]);

  // The nine channels subscribe ONCE: PreviewHost passes fresh inline
  // callbacks every render, so keying the effect on them re-subscribed per
  // render — and an event fired in an unsubscribe gap (a fast did-navigate
  // between renders) was lost. The ref always holds the latest handlers;
  // the subscription itself never churns.
  const handlers = useRef({
    onLocation,
    onBridge,
    onScreens,
    onComments,
    onError,
    onLoading,
    onZoom,
  });
  handlers.current = { onLocation, onBridge, onScreens, onComments, onError, onLoading, onZoom };
  useEffect(() => {
    const bridge = window.cdsDesignDesktop?.preview;
    if (!bridge) return;
    const offs = [
      bridge.onLocation?.((payload: { path: string; canGoBack: boolean; canGoForward: boolean }) =>
        handlers.current.onLocation(payload),
      ),
      bridge.onBridge?.((payload: { state: "unknown" | "present" | "stale" }) =>
        handlers.current.onBridge(payload.state),
      ),
      bridge.onScreens?.((payload: { screens: CdsDesignScreen[] }) => {
        if (Array.isArray(payload.screens)) handlers.current.onScreens(payload.screens);
      }),
      bridge.onComments?.((payload: CdsDesignCommentsEnvelope) => {
        if (Array.isArray(payload.items)) handlers.current.onComments(payload);
      }),
      bridge.onError?.((payload: { kind: "runtime" | "build"; message: string; route: string; state: string }) =>
        handlers.current.onError(payload),
      ),
      bridge.onFreeze?.((jpeg: string) => setFreeze(jpeg)),
      bridge.onLoading?.((payload: { on: boolean }) => handlers.current.onLoading(payload.on)),
      bridge.onZoom?.((payload: { factor: number }) => handlers.current.onZoom(payload.factor)),
      // D71: the view holds the keys while focused — replayed here so the
      // window's own listeners (⌘K, ⌘,) fire as if the planner never left.
      bridge.onKey?.((payload: { key: string; meta: boolean }) => {
        if (payload.key === "Escape") return;
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: payload.key, metaKey: payload.meta, bubbles: true }),
        );
      }),
    ].filter((off): off is () => void => typeof off === "function");
    return () => offs.forEach((off) => off());
  }, []);

  return (
    <div className="preview__slot" ref={slot} data-testid="preview-slot">
      {freeze && <img className="preview__freeze" src={`data:image/jpeg;base64,${freeze}`} alt="" />}
    </div>
  );
}
