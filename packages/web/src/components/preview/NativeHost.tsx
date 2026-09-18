import type { ColoDesignPinEnvelope, ColoDesignPinsSync } from "@colo-design/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PreviewLocation, PreviewTarget } from "./PreviewHost";

/**
 * 데스크톱의 미리보기 칸: an empty slot the main process lays its
 * `WebContentsView` over. All knowing flows through the IPC channels — bounds
 * up (`ResizeObserver` → `preview:bounds`), location · pins · errors ·
 * freeze · keys down. The slot shows the freeze frame while a
 * modal covers the view, so the pane never reads as a hole.
 *
 * The view is above every DOM node — nothing may be drawn over the slot
 * except through `usePreviewCover`; the PiP thumbnail therefore docks in the
 * frame header, not here.
 */
export function NativeHost({
  url,
  epoch,
  target,
  reloadKey,
  width,
  commentsOn,
  onLocation,
  sync,
  onPin,
  onPinFocus,
  onError,
  onLoading,
  onZoom,
}: {
  /** The preview server's url — null while the pane browses a clicked link
      (설정 `앱에서 링크 열기`) or no server is up; the slot still draws. */
  url: string | null;
  /** The server process behind `url` (RepoStatus.previewEpoch) — a kept page under a new one reloads. */
  epoch: number | null;
  /** The last ask — a screen rides the bridge, a path rides `open`. */
  target: PreviewTarget | null;
  reloadKey: number;
  width: "mobile" | "tablet" | "desktop";
  commentsOn: boolean;
  onLocation: (location: PreviewLocation | null) => void;
  /**
   * The badge projection — the web's ghosts-then-pins list as
   * `pinsSync` built it; resent after every navigation so a reload or an
   * SPA move re-anchors the badges (region pins on their page rect).
   */
  sync: ColoDesignPinsSync;
  /** A pin landed from the overlay; a repeated id is usePins's to ignore. */
  onPin: (pin: ColoDesignPinEnvelope["pin"]) => void;
  /** 배지 클릭 — the planner wants that pin's memo input (PageWorkspace holds the state). */
  onPinFocus: (id: string) => void;
  onError: (error: {
    kind: "runtime" | "build";
    message: string;
    route: string;
    state: string;
  }) => void;
  /** The view is loading — the frame's reload button spins. */
  onLoading: (on: boolean) => void;
  /** The zoom moved (the menu can move it) — the chip follows. */
  onZoom: (factor: number) => void;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const [freeze, setFreeze] = useState<string | null>(null);

  // The overlay's badge projection: resent after every location
  // report — a reload or an SPA navigation forgets the anchors, and the
  // sync (ghosts included) is how they come back.
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const syncPins = useCallback(() => {
    void window.coloDesignDesktop?.preview?.pins?.(syncRef.current);
  }, []);
  useEffect(() => {
    syncPins();
  }, [sync, syncPins]);

  // The slot's rect is the view's bounds. DIP in CSS pixels — Electron maps
  // the ratio; one observer covers the sidebar drag and the window resize.
  useEffect(() => {
    const node = slot.current;
    const bounds = window.coloDesignDesktop?.preview?.bounds;
    if (!node || !bounds) return;
    const send = () => {
      const rect = node.getBoundingClientRect();
      void bounds({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    };
    send();
    const observer = new ResizeObserver(send);
    observer.observe(node);
    return () => {
      observer.disconnect();
      // The slot is gone — a zero rect is the pane's word for "nothing may
      // draw here", so a link opened later (preview:open-external) falls
      // back to the OS browser instead of landing over another surface.
      void bounds({ x: 0, y: 0, width: 0, height: 0 });
    };
  }, []);
  // Mount puts this preview's page on screen — kept from an earlier visit or
  // loaded once; unmount only parks it. The epoch rides along so a page whose
  // server was restarted (or whose port now serves another project) reloads.
  //
  // The freeze frame goes with the page it was taken from. This component
  // survives a project switch (nothing keys it upstream), so a kept frame
  // would sit under the NEXT project's modal as if it were that project's
  // screen — and hiding the view before the capture widens the moment
  // where that stale frame is exactly what shows.
  useEffect(() => {
    // 얼린 얼굴은 그 페이지에서 찍은 것이므로 페이지가 바뀌기 전에 거둔다.
    // 가드 뒤에 두면 url 이 없어지는 전환에서 얼음이 지나가고, 남은 프레임이
    // 다음 프로젝트의 모달 밑에 그 프로젝트의 화면인 양 앉는다.
    setFreeze(null);
    if (!url) return;
    void window.coloDesignDesktop?.preview?.mount?.(url, epoch);
    return () => void window.coloDesignDesktop?.preview?.unmount?.();
  }, [url, epoch]);

  // The last ask re-rides on every change — the prop IS the ask. Mount
  // first: a link page may be on screen (설정 `앱에서 링크 열기`), and the
  // ask belongs to the preview page — mount discards the link page and
  // brings the project's page back before the route lands on it.
  useEffect(() => {
    if (!url || !target) return;
    const bridge = window.coloDesignDesktop?.preview;
    void bridge?.mount?.(url, epoch).then(() => {
      void bridge?.open?.(target.path);
    });
  }, [url, epoch, target]);

  useEffect(() => {
    if (reloadKey > 0) void window.coloDesignDesktop?.preview?.reload?.();
  }, [reloadKey]);

  useEffect(() => {
    void window.coloDesignDesktop?.preview?.commentsMode?.(commentsOn);
  }, [commentsOn]);

  // 폭 is emulation on the native side, not CSS names.
  useEffect(() => {
    void window.coloDesignDesktop?.preview?.emulate?.(width === "desktop" ? null : width);
  }, [width]);

  // The channels subscribe ONCE: PreviewHost passes fresh inline callbacks
  // every render, so keying the effect on them re-subscribed per render —
  // and an event fired in an unsubscribe gap (a fast did-navigate between
  // renders) was lost. The ref always holds the latest handlers; the
  // subscription itself never churns. `syncPins` is stable, so it can ride
  // the location report without resubscribing anything.
  const handlers = useRef({
    onLocation,
    onPin,
    onPinFocus,
    onError,
    onLoading,
    onZoom,
  });
  handlers.current = {
    onLocation,
    onPin,
    onPinFocus,
    onError,
    onLoading,
    onZoom,
  };
  useEffect(() => {
    const bridge = window.coloDesignDesktop?.preview;
    if (!bridge) return;
    const offs = [
      bridge.onLocation?.(
        (payload: {
          path: string;
          url?: string;
          kind: "preview" | "web";
          canGoBack: boolean;
          canGoForward: boolean;
        }) => {
          handlers.current.onLocation(payload);
          // 리로드·SPA 이동 뒤 재앵커 — the page just forgot
          // its badges; the sync is the only thing that brings them back.
          syncPins();
        },
      ),
      // A pin lands whole — no empty-envelope guard anymore, and a repeated
      // id is usePins's to ignore.
      bridge.onPin?.((payload: ColoDesignPinEnvelope) => handlers.current.onPin(payload.pin)),
      bridge.onPinFocus?.((payload: { id: string }) => handlers.current.onPinFocus(payload.id)),
      bridge.onError?.(
        (payload: { kind: "runtime" | "build"; message: string; route: string; state: string }) =>
          handlers.current.onError(payload),
      ),
      bridge.onFreeze?.((jpeg: string) => setFreeze(jpeg)),
      bridge.onLoading?.((payload: { on: boolean }) => handlers.current.onLoading(payload.on)),
      bridge.onZoom?.((payload: { factor: number }) => handlers.current.onZoom(payload.factor)),
      // The view holds the keys while focused — replayed here so the
      // window's own listeners (⌘K, ⌘,) fire as if the planner never left.
      bridge.onKey?.((payload) => {
        if (payload.key === "Escape") return;
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: payload.key,
            metaKey: payload.meta,
            // ⌘⇧P: shift 가 살아 있어야 워크스페이스의 토글이
            // 미리보기 포커스 중에도 먹는다.
            shiftKey: payload.shift,
            // Windows/Linux의 ⌘ 자리는 control 이다 — 뷰가 같은 수정자로
            // 골라 보내므로 여기서 살려야 첼드가 워크스페이스에 닿는다.
            ctrlKey: payload.control,
            bubbles: true,
          }),
        );
      }),
    ].filter((off): off is () => void => typeof off === "function");
    return () =>
      offs.forEach((off) => {
        off();
      });
  }, [syncPins]);

  return (
    <div className="preview__slot" ref={slot} data-testid="preview-slot">
      {freeze && (
        <img className="preview__freeze" src={`data:image/jpeg;base64,${freeze}`} alt="" />
      )}
    </div>
  );
}
