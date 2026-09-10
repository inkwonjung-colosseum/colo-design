import { useEffect, useRef, useState } from "react";
import type {
  CdsDesignCommentsEnvelope,
  CdsDesignNavigateEnvelope,
  CdsDesignScreen,
  CdsDesignScreensEnvelope,
  CdsDesignScreensRequestEnvelope,
} from "@cds-design/protocol";
import { stateLabel } from "./format";
import { DesktopIcon, ExternalLinkIcon, MobileIcon, RestartIcon } from "./icons";

/** Which screen, in which state, the planner asked to see. */
export interface PreviewTarget {
  route: string;
  /** Null means the screen's own default — the app is left to pick. */
  state: string | null;
}

/**
 * 모바일 constrains the frame to 390px — the logical viewport of the current
 * baseline iPhone, and the number lives in `.preview__stage--mobile` because
 * the app is never told which width is selected; it only ever sees its own
 * viewport, exactly as it would on a phone. One narrow width rather than a
 * device menu: the phones a planner would check span 360–430 and a layout that
 * only works wide breaks at all of them, so a second one buys nothing.
 */
type PreviewWidth = "mobile" | "desktop";

/**
 * The picker's groups: screens bucketed by the feature their routes name
 * (`/member/MemberList` → `member`, a bare route under no group at all), the
 * planner's own features first and the repo's reference material — the
 * `_example` teaching folder a connected repo ships for its own rules —
 * last. The screen rail's old grouping, kept where the picking happens.
 */
function groupedScreens(screens: CdsDesignScreen[]): [string, CdsDesignScreen[]][] {
  const byFeature = new Map<string, CdsDesignScreen[]>();
  for (const screen of screens) {
    const segments = screen.route.split("/").filter(Boolean);
    const feature = segments.length > 1 ? (segments[0] ?? "") : "";
    const bucket = byFeature.get(feature) ?? [];
    bucket.push(screen);
    byFeature.set(feature, bucket);
  }
  const isReference = (feature: string) => feature.startsWith("_") || feature === "example";
  return [...byFeature.entries()].sort(
    ([a], [b]) => Number(isReference(a)) - Number(isReference(b)) || a.localeCompare(b),
  );
}

/**
 * The preview pane: the connected repo's own preview server, framed as-is.
 * What renders inside is the repo's business — the tool only waits for the
 * daemon to report a serving URL, and never parses the repo's code (PLAN D6).
 *
 * This is also the postMessage hub for both directions of PLAN D7. Envelopes
 * are accepted strictly from this iframe (source and origin both checked,
 * DESIGN §6) and `cds-design.navigate` is posted back at the preview's own
 * origin.
 *
 * NAVIGATION IS A PROP, NOT A HANDLE. `target` comes down and `onNavigate`
 * goes up, because nothing in this package exposes an imperative handle —
 * every component here is props-down/callbacks-up (`DocEditor`'s `path`,
 * `onDirty`, `onQuote`), and `ScreenPanel` is the only caller and already owns
 * the rest of the preview's state. It also makes the re-send below free: "the
 * last requested route+state" IS the prop, so there is no second copy of it in
 * a ref to drift from what the toolbar is drawing.
 */
export function Preview({
  url,
  stopped,
  stoppedDetail,
  onRestart,
  onComments,
  screens,
  target,
  onNavigate,
  onScreens,
}: {
  url: string | null;
  /** The preview server died after being ready; the iframe would show nothing. */
  stopped: boolean;
  /**
   * Why it is not running, in the daemon's own words. Without it the planner
   * reads "the server stopped" and has no idea a port is taken.
   */
  stoppedDetail?: string | null;
  onRestart: () => void;
  /** Validated `cds-design.comments` envelope from the preview app. */
  onComments: (envelope: CdsDesignCommentsEnvelope) => void;
  /** Screens the repo declared. Empty until the app speaks — see the toolbar. */
  screens: CdsDesignScreen[];
  /** The screen and state to show, or null while nothing has been asked for. */
  target: PreviewTarget | null;
  /** A toolbar control was used; the caller answers by handing back `target`. */
  onNavigate: (route: string, state: string | null) => void;
  /** Validated `cds-design.screens` payload from the preview app. */
  onScreens: (screens: CdsDesignScreen[]) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState<PreviewWidth>("desktop");
  /**
   * How many times the framed document has loaded. Zero means there is nobody
   * to talk to yet, and every increment re-sends `target`: the planner picks a
   * 기획서 while the repo is still starting (or Claude's edit hot-reloads the
   * app), and either way a navigate posted at a booting page reaches no
   * listener. Re-sending on load is what keeps that from looking broken.
   */
  const [loads, setLoads] = useState(0);

  useEffect(() => {
    if (!url) return;
    const expectedOrigin = new URL(url).origin;
    const onMessage = (event: MessageEvent) => {
      // Only this iframe may speak; anything else in the page is noise.
      if (event.source !== frame.current?.contentWindow) return;
      if (event.origin !== expectedOrigin) return;
      const data = event.data as CdsDesignCommentsEnvelope | CdsDesignScreensEnvelope | null;
      if (!data) return;
      if (data.type === "cds-design.comments" && Array.isArray(data.items)) onComments(data);
      if (data.type === "cds-design.screens" && Array.isArray(data.screens)) onScreens(data.screens);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [url, onComments, onScreens]);

  useEffect(() => {
    if (!url || !target || loads === 0) return;
    const contentWindow = frame.current?.contentWindow;
    if (!contentWindow) return;
    const envelope: CdsDesignNavigateEnvelope = {
      type: "cds-design.navigate",
      route: target.route,
      state: target.state,
    };
    // Addressed to the preview's own origin, never "*": this envelope says
    // what the planner is looking at, and only the app it came from should
    // ever be able to read it.
    contentWindow.postMessage(envelope, new URL(url).origin);
  }, [url, target, loads]);

  if (stopped) {
    return (
      <div className="preview">
        <div className="preview__blank">
          <h2>미리보기 서버 중단</h2>
          <p className="hint">{stoppedDetail || "화면을 그리는 서버가 멈췄습니다."} 대화 내용은 그대로입니다.</p>
          <button type="button" className="primary" onClick={onRestart}>
            <RestartIcon />
            다시 시작
          </button>
        </div>
      </div>
    );
  }

  if (!url) {
    return (
      <div className="preview">
        <div className="preview__blank">
          <p className="hint">미리보기 주소를 기다리는 중입니다.</p>
        </div>
      </div>
    );
  }

  const current = target ? (screens.find((screen) => screen.route === target.route) ?? null) : null;
  /**
   * No `?state=` is what the repo's ScreenRunner labels `default`, so that is
   * the chip to light up when the planner has not picked one.
   */
  const activeState = target?.state ?? "default";

  return (
    <div className="preview">
      <div className="preview__toolbar">
        {/* The repo declares its screens or it does not; there is no empty
            picker, because an empty dropdown reads as "this repo has no
            screens" when the truth is usually "the app has not loaded yet".
            This select is the screens' only door, so it carries the rail's
            old grouping: the planner's features lead, reference sinks. */}
        {screens.length > 0 && (
          <select
            className="preview__screens"
            aria-label="화면"
            value={current?.route ?? ""}
            onChange={(event) => onNavigate(event.target.value, null)}
          >
            {!current && (
              <option value="" disabled>
                화면 선택
              </option>
            )}
            {groupedScreens(screens).map(([feature, groupScreens]) =>
              feature ? (
                <optgroup key={feature} label={feature}>
                  {groupScreens.map((screen) => (
                    <option key={screen.route} value={screen.route}>
                      {screen.title}
                    </option>
                  ))}
                </optgroup>
              ) : (
                groupScreens.map((screen) => (
                  <option key={screen.route} value={screen.route}>
                    {screen.title}
                  </option>
                ))
              ),
            )}
          </select>
        )}
        {/* A screen with one state has nothing to switch between, so a lone
            chip would be furniture that reads like a choice. */}
        {current && current.states.length > 1 && (
          <div className="preview__states" role="group" aria-label="상태">
            {current.states.map((state) => (
              <button
                key={state}
                type="button"
                className={
                  state === activeState ? "preview__state preview__state--on" : "preview__state"
                }
                aria-pressed={state === activeState}
                title={`이 화면의 ${stateLabel(state)} 상태를 봅니다`}
                onClick={() => onNavigate(current.route, state)}
              >
                {stateLabel(state)}
              </button>
            ))}
          </div>
        )}
        <span className="preview__spacer" />
        <div className="preview__width" role="group" aria-label="폭">
          <button
            type="button"
            className={width === "mobile" ? "preview__widthbtn preview__widthbtn--on" : "preview__widthbtn"}
            aria-pressed={width === "mobile"}
            title="휴대폰 폭으로 좁혀서 봅니다"
            onClick={() => setWidth("mobile")}
          >
            <MobileIcon />
            모바일
          </button>
          <button
            type="button"
            className={width === "desktop" ? "preview__widthbtn preview__widthbtn--on" : "preview__widthbtn"}
            aria-pressed={width === "desktop"}
            title="화면 전체 폭으로 봅니다"
            onClick={() => setWidth("desktop")}
          >
            <DesktopIcon />
            데스크톱
          </button>
        </div>
        <a className="preview__link" href={url} target="_blank" rel="noreferrer">
          <ExternalLinkIcon />
          새 창
        </a>
      </div>
      {/* Width is CSS on this wrapper only. Reloading the frame or telling the
          app about it would throw away whatever the planner had typed into the
          screen just to make it narrower. */}
      <div className={width === "mobile" ? "preview__stage preview__stage--mobile" : "preview__stage"}>
        <iframe
          ref={frame}
          className="preview__frame"
          title="미리보기"
          src={url}
          onLoad={() => {
            setLoads((count) => count + 1);
            // The overlay posts its list once on its own mount and never
            // retries, so the two orderings cover each other: its post lands
            // at a hub that is already listening, and this request catches the
            // case where the app was up before we were.
            const request: CdsDesignScreensRequestEnvelope = { type: "cds-design.screens?" };
            frame.current?.contentWindow?.postMessage(request, new URL(url).origin);
          }}
        />
      </div>
    </div>
  );
}
