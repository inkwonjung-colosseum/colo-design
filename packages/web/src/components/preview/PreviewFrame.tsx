import type { ColoDesignPinEnvelope, ColoDesignPinsSync } from "@colo-design/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PreviewLocation, PreviewTarget } from "./PreviewHost";

/**
 * 미리보기 무대 (webview 전환): the repo's app lives in a `<webview>` element
 * this component owns — an ordinary DOM node, so every planner layer (modals,
 * popovers, the PiP) draws above it without a cover subsystem, and the pane
 * resizes with CSS alone. The main process claims each guest
 * (`did-attach-webview`), fences its src to the loopback preview servers and
 * forces the preload · partition; this side only decides WHICH guests exist
 * and which one is on screen.
 *
 * ONE PAGE PER PROJECT — 요소는 origin 을 key 로 세우고 프로젝트를 떠나도
 * 마운트를 유지한다(warm park): 돌아오는 것은 repaint 이지 reload 가 아니다.
 * park 은 `display:none` 금지 — 문서가 언로드된다. 숨김은 visibility 로 한다.
 * 살아 있는 요소는 최대 MAX_LIVE_PAGES — 넘치는 것부터 LRU 로 철거하고,
 * 철거된 게스트는 main 이 `destroyed`로 잊는다.
 *
 * 요소의 `src`는 태어날 때 한 번만 정한다 — 이후의 이동(로밍·epoch 리셋·
 * 핀의 화면 이동)은 전부 main이 게스트에 loadURL 하는 것이고, 요소는 그
 * 게스트를 따라간다. React가 src prop을 다시 쓰면 그것만으로 reload 가
 * 되므로, prop 변화는 의도적으로 무시한다.
 *
 * The view is no longer above the DOM — nothing to relay for z-order. The
 * channels below are the pane's facts: location · pins · errors · loading ·
 * zoom, and the key replay (the guest holds focus while the planner's own
 * chords must still fire).
 */
export function PreviewFrame({
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
      (설정 `앱에서 링크 열기`) or no server is up; the stage still renders. */
  url: string | null;
  /** The server process behind `url` (RepoStatus.previewEpoch) — a kept page
      under a new one reloads (main's refresh). */
  epoch: number | null;
  /** The last ask — a screen rides the bridge, a path rides `open`. */
  target: PreviewTarget | null;
  /** Bumped by 새로 고침 — main reloads the guest; the element is untouched. */
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
  /** 살아 있는 프로젝트 origin들 — 마운트 순서. LRU 철거의 기준. */
  const [live, setLive] = useState<string[]>([]);
  /** 활성 페이지 없이 열린 loose 페이지의 요소 하나 — main이 부탁하면 세운다. */
  const [looseSrc, setLooseSrc] = useState<string | null>(null);
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const syncPins = useCallback(() => {
    void window.coloDesignDesktop?.preview?.pins?.(syncRef.current);
  }, []);

  // The web's whole pin list is the truth — re-send it whenever it changes
  // (add · remove · note · intent · sent-ghosts), not only on navigation.
  // ScreenPanel memoizes pinsFrame, so this fires exactly on real changes.
  useEffect(() => {
    syncPins();
  }, [sync, syncPins]);

  // The active project's origin — guests are keyed by it.
  const origin = url ? new URL(url).origin : null;

  // 요소의 수명 원장 — shownAt 은 main의 것과 같은 LRU 규약.
  const shownAt = useRef(new Map<string, number>());
  useEffect(() => {
    if (!origin) return;
    shownAt.current.set(origin, Date.now());
    setLive((list) => {
      if (list.includes(origin)) return list;
      const next = [...list, origin];
      // MAX_LIVE_PAGES: 활성 것은 남기고 오래된 것부터 철거한다(요소가
      // 사라지면 게스트도 죽고 main이 잊는다).
      while (next.length > MAX_LIVE_PAGES) {
        const oldest = [...next]
          .filter((o) => o !== origin)
          .sort((a, b) => (shownAt.current.get(a) ?? 0) - (shownAt.current.get(b) ?? 0))[0];
        if (oldest === undefined) break;
        next.splice(next.indexOf(oldest), 1);
      }
      return next;
    });
  }, [origin]);

  // PreviewFrame이 무대를 쥐고 있음을 main에 알린다 — 링크·외부 열기의
  // OS 브라우저 폴백 판정 재료(옛 bounds 0의 자리).
  useEffect(() => {
    const bridge = window.coloDesignDesktop?.preview;
    void bridge?.hostReady?.(true);
    return () => {
      void bridge?.hostReady?.(false);
    };
  }, []);

  // Mount puts this preview's page on screen — main activates the claimed
  // guest (or waits for the attach). The cleanup does NOT unmount: the
  // element and its guest stay warm for the project's return. Unmount rides
  // only on the whole stage going away (below).
  useEffect(() => {
    if (!url) return;
    void window.coloDesignDesktop?.preview?.mount?.(url, epoch);
  }, [url, epoch]);

  // The stage is gone — the guests die with their elements; main forgets
  // them via `destroyed`. unmount also parks main's active pointer so the
  // address bar doesn't carry a dead page's words.
  useEffect(() => {
    const bridge = window.coloDesignDesktop?.preview;
    return () => void bridge?.unmount?.();
  }, []);

  // The last ask re-rides on every change — the prop IS the ask. Mount
  // first: a link page may be on screen (설정 `앱에서 링크 열기`), and the
  // ask belongs to the preview page — mount discards the link page and
  // brings the project's page back before the route lands on it.
  useEffect(() => {
    if (!url || !target) return;
    const bridge = window.coloDesignDesktop?.preview;
    void bridge
      ?.mount?.(url, epoch)
      .then(() => bridge?.open?.(target.path))
      .catch(() => {
        // mount·open 의 실패는 main 의 오류 배너·게이트가 이미 말한다 —
        // 여기서는 조용히 거둔다(무음 재시도는 target 변화가 다시 건다).
      });
  }, [url, epoch, target]);

  useEffect(() => {
    if (reloadKey > 0) void window.coloDesignDesktop?.preview?.reload?.();
  }, [reloadKey]);

  useEffect(() => {
    void window.coloDesignDesktop?.preview?.commentsMode?.(commentsOn);
  }, [commentsOn]);

  // 폭 is emulation on the guest, not CSS names — the element narrows with
  // the stage's own width, the guest believes it is the device.
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
      bridge.onLoading?.((payload: { on: boolean }) => handlers.current.onLoading(payload.on)),
      bridge.onZoom?.((payload: { factor: number }) => handlers.current.onZoom(payload.factor)),
      // 활성 페이지 없이 열린 링크 — loose 요소를 세운다. 프로젝트 무대가
      // 이미 있으면 main이 부탁하지 않는다(제자리 로밍이니까).
      bridge.onHost?.((payload: { url: string }) => setLooseSrc(payload.url)),
      bridge.onClose?.(() => setLooseSrc(null)),
      // The guest holds the keys while focused — replayed here so the
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
            // Windows/Linux의 ⌘ 자리는 control 이다 — 게스트가 같은 수정자로
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

  // 프로젝트 무대가 서면 loose 자리는 그 프로젝트의 것이 된다 — 요소를 거둔다.
  useEffect(() => {
    if (url) setLooseSrc(null);
  }, [url]);

  const active = origin ?? (looseSrc ? new URL(looseSrc).origin : null);

  return (
    <div className="preview__slot" data-testid="preview-slot">
      {live.map((liveOrigin) => (
        <Guest
          key={liveOrigin}
          initialSrc={liveOrigin === origin && url ? url : liveOrigin}
          live={active === liveOrigin && looseSrc === null}
        />
      ))}
      {looseSrc !== null && <Guest key={looseSrc} initialSrc={looseSrc} live={origin === null} />}
    </div>
  );
}

/**
 * 프로젝트 하나의 게스트 요소. `src`는 태어날 때 한 번 — 이후의 이동은
 * main이 게스트에 한다. park은 visibility로 한다(display:none 금지 —
 * 문서가 언로드되어 warm이 깨진다).
 */
function Guest({ initialSrc, live }: { initialSrc: string; live: boolean }) {
  // The element's src is written once at birth; prop changes are ignored on
  // purpose (see the component comment).
  const [src] = useState(initialSrc);
  return (
    <webview
      src={src}
      /** 팝업은 main의 setWindowOpenHandler가 심판한다(OS 브라우저로 넘기고
          게스트는 막는다) — 이 속성이 없으면 window.open이 조용히 무시되어
          오늘의 동작(팝업 → OS 브라우저)이 사라진다. */
      allowpopups={true}
      className={
        live ? "preview__frame preview__frame--live" : "preview__frame preview__frame--parked"
      }
    />
  );
}

/** 이 pane 이 한 번에 살려 두는 요소 수 — 화면의 것과 뒤에 park 된 것까지.
    하나하나가 게스트 프로세스라 이 cap 이 사이드바 클릭의 비용을 묶는다
    (옛 main의 MAX_LIVE_PAGES 가 이관된 자리). */
const MAX_LIVE_PAGES = 8;
