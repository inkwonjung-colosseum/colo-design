import { useEffect, useRef, useState } from "react";
import type { CdsDesignCommentsEnvelope, CdsDesignScreen } from "@cds-design/protocol";
import { daemonLine, stateLabel } from "./format";
import { DesktopIcon, ExternalLinkIcon, MobileIcon, RefreshIcon, RestartIcon, ServerOffIcon } from "./icons";
import { IframeHost } from "./IframeHost";
import { NativeHost } from "./NativeHost";
import { parseAddress } from "./preview-address";

/**
 * Which screen, in which state, the planner asked to see. A free path (the
 * address bar, D66) is an ask too — the native view `open`s it.
 */
export type PreviewTarget =
  | { kind: "screen"; route: string; state: string | null }
  | { kind: "path"; path: string };

/** Where the native view actually is — its truth, not the tool's ask (D66). */
export interface PreviewLocation {
  path: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

/**
 * An error the planner can hand to Claude (PLAN D49). The native view's
 * events build it now (D69) — the repo hook is gone.
 */
export interface PreviewError {
  route: string;
  state: string;
  kind: "runtime" | "build";
  message: string;
}

/**
 * 모바일 constrains the frame to 390px — the logical viewport of the current
 * baseline iPhone — and 태블릿 to 768px (PLAN D47). On the native side these
 * names turn on real emulation (D69); here they only narrow the stage.
 */
type PreviewWidth = "mobile" | "tablet" | "desktop";

/**
 * The picker's groups: screens bucketed by the feature their routes name
 * (`/member/MemberList` → `member`), the planner's own features first and the
 * repo's reference material last (the old rail's rule, kept where the picking
 * happens).
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
 * The preview pane (PLAN D64): the toolbar, the browser-bar frame head and
 * the stage are common; the stage itself is a host. `native` picks
 * `NativeHost` — the desktop's own view, with the address bar, back ·
 * forward, the error banner, real 폭 emulation and the 💬 toggle — and a
 * plain browser keeps the iframe, which offers the declared screens and
 * nothing else (D70).
 */
export function PreviewHost({
  url,
  stopped,
  stoppedDetail,
  onRestart,
  onComments,
  onFixError,
  screens,
  target,
  onNavigate,
  onScreens,
  onLocation,
  location,
  commentsOn,
  onCommentsMode,
  unresolvedComments = 0,
  onLook,
  lookBusy = false,
  lookBlocked = null,
  pip,
  pipLarge,
  onPipToggle,
}: {
  url: string | null;
  /** The preview server died after being ready; the pane would show nothing. */
  stopped: boolean;
  /** Why it is not running, in the daemon's own words. */
  stoppedDetail?: string | null;
  onRestart: () => void;
  /** A pin bundle from the tool's overlay (D67) — the native path only. */
  onComments: (envelope: CdsDesignCommentsEnvelope) => void;
  /** The banner's `Claude에게 고쳐 달라고 하기` (PLAN D49). */
  onFixError: (error: PreviewError) => void;
  /** Screens the repo declared — empty until the bridge speaks. */
  screens: CdsDesignScreen[];
  /** The last ask; the caller answers by handing a new one back. */
  target: PreviewTarget | null;
  onNavigate: (target: PreviewTarget) => void;
  onScreens: (screens: CdsDesignScreen[]) => void;
  /** The native view's location reports arrive here (D66). */
  onLocation: (location: PreviewLocation) => void;
  location: PreviewLocation | null;
  /** 코멘트 모드(PLAN D58 → D67) — the toolbar owns the truth. */
  commentsOn: boolean;
  onCommentsMode: (on: boolean) => void;
  /** 미해결 코멘트 수(PLAN D57) — the toggle's badge. */
  unresolvedComments?: number;
  /**
   * 이 화면 Claude 에게 보여 주기 (PLAN D89): the whole frame, the route·
   * state and the console tail go up as one turn. Native only — the iframe
   * cannot be photographed from here.
   */
  onLook?: (note: string) => void;
  /** True while the snapshot is being taken and the turn composed. */
  lookBusy?: boolean;
  /** The 연타 notice (D89): 이미 보냈습니다 — 답을 기다려 주세요. */
  lookBlocked?: string | null;
  /** The docked Claude-view thumbnail (PLAN D63) — desktop only. */
  pip: { frame: string; label: string } | null;
  pipLarge: boolean;
  onPipToggle: () => void;
}) {
  const native = Boolean(window.cdsDesignDesktop?.preview?.native);
  const [width, setWidth] = useState<PreviewWidth>("desktop");
  /** Bumped by 새로 고침: a clean reload on whichever host is mounted. */
  const [reloadNonce, setReloadNonce] = useState(0);
  /** The last `cds-preview:error` (D69) — one at a time, the newest wins. */
  const [error, setError] = useState<PreviewError | null>(null);
  /** The banner's `자세히`: the message starts clamped to one line. */
  const [detail, setDetail] = useState(false);
  /** D68: what the repo bridge of THIS load spoke. */
  const [bridge, setBridge] = useState<"unknown" | "present" | "stale">("unknown");
  /** D89: the 보여 주기 form — the button opens it, the note rides along. */
  const [lookOpen, setLookOpen] = useState(false);
  const [lookNote, setLookNote] = useState("");
  /** D85 ⓐ: the view is loading — the reload button spins; clicking = 중단. */
  const [loading, setLoading] = useState(false);
  /** D85 ⓔ: the view's zoom — 100% hides the chip; the menu can move it. */
  const [zoom, setZoom] = useState(1);
  const addressInput = useRef<HTMLInputElement>(null);

  // The address bar (D66): local while focused, the view's truth otherwise.
  const [address, setAddress] = useState("");
  const [addressFocused, setAddressFocused] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);
  const addressTimer = useRef<number | null>(null);

  // A new load is innocent until it reports again — same rule the iframe's
  // banner lived by: a hot reload never wipes a just-reported error.
  useEffect(() => {
    setError(null);
  }, [url]);
  useEffect(() => {
    setBridge("unknown");
  }, [url]);

  // What the bar shows when nobody is typing: where the view is, else the ask.
  useEffect(() => {
    if (addressFocused) return;
    if (location) setAddress(location.path);
    else if (target?.kind === "path") setAddress(target.path);
    else if (target?.kind === "screen")
      setAddress(target.state ? `${target.route}?state=${target.state}` : target.route);
    else setAddress("/");
  }, [location, target, addressFocused]);

  useEffect(() => {
    return () => {
      if (addressTimer.current !== null) window.clearTimeout(addressTimer.current);
    };
  }, []);

  // D85 ⓒ: 주소로 이동 ⌘L — replayed by the menu through the key channel,
  // so it works whether the focus sits in the chat or in the view.
  useEffect(() => {
    if (!native) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && (event.key === "l" || event.key === "L")) {
        event.preventDefault();
        addressInput.current?.focus();
        addressInput.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [native]);

  // D85 ⓔ: 폭 is the device, 배율 is the eye — a width change resets the
  // eye to 100% (모바일 에뮬레이션 + 150% 는 가로 스크롤을 만든다).
  const zoomBridge = window.cdsDesignDesktop?.preview;
  useEffect(() => {
    setZoom(1);
    void zoomBridge?.zoom?.("reset");
  }, [width]);

  const submitAddress = (raw: string) => {
    if (!url) return;
    const verdict = parseAddress(raw, {
      origin: new URL(url).origin,
      currentPath: location?.path ?? "/",
      routes: screens.map((screen) => screen.route),
    });
    if (verdict.kind === "error") {
      setAddressError(verdict.message);
      if (addressTimer.current !== null) window.clearTimeout(addressTimer.current);
      addressTimer.current = window.setTimeout(() => setAddressError(null), 2500);
      return;
    }
    setAddressError(null);
    onNavigate(verdict.kind === "screen" ? { kind: "screen", route: verdict.route, state: verdict.state } : { kind: "path", path: verdict.path });
  };

  if (stopped) {
    const stoppedLine = daemonLine(stoppedDetail);
    // The 준비/실패 card's language (progress__card): one framed surface
    // centered in the column. The daemon's own words drop to a clipped mono
    // line under the human sentence — never the headline.
    return (
      <div className="preview">
        <div className="progress progress--error">
          <div className="progress__card">
            <div className="progress__head">
              <span className="preview__stopglyph">
                <ServerOffIcon />
              </span>
              <h2>미리보기 서버 중단</h2>
            </div>
            <p className="progress__body">화면을 그리는 서버가 멈췄습니다. 대화 내용은 그대로입니다.</p>
            {stoppedLine && <div className="progress__detail">{stoppedLine}</div>}
            <div className="preview__stopactions">
              <button type="button" className="primary" onClick={onRestart}>
                <RestartIcon />
                다시 시작
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  onFixError({
                    route: target?.kind === "screen" ? target.route : "",
                    state: target?.kind === "screen" ? (target.state ?? "") : "",
                    kind: "build",
                    message: stoppedDetail || "화면을 그리는 서버가 멈췄습니다.",
                  })
                }
              >
                Claude에게 고쳐 달라고 하기
              </button>
            </div>
          </div>
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

  // The picker follows where the view IS (D66) — the ask is only its opening
  // bid. No `?state=` is what the repo's ScreenRunner labels `default`.
  const activePath = location?.path ?? (target?.kind === "path" ? target.path : null);
  const activeRouteState =
    target?.kind === "screen"
      ? { route: target.route, state: target.state }
      : activePath !== null
        ? (() => {
            const [route, query = ""] = activePath.split("?");
            const state = new URLSearchParams(query).get("state");
            return { route, state: state && state !== "" ? state : null };
          })()
        : null;
  const current = activeRouteState ? (screens.find((screen) => screen.route === activeRouteState.route) ?? null) : null;
  const activeState = activeRouteState?.state ?? "default";

  return (
    <div className="preview">
      <div className="preview__toolbar">
        {screens.length > 0 || bridge !== "stale" ? (
          bridge === "stale" ? (
            <span className="preview__unlisted" data-testid="bridge-stale">
              이 레포의 미리보기 브리지가 옛 이름을 씁니다 — 브리지를 올려야 화면 목록이 동작합니다
            </span>
          ) : screens.length > 0 ? (
            <select
              className="preview__screens"
              aria-label="화면"
              value={current?.route ?? ""}
              onChange={(event) => onNavigate({ kind: "screen", route: event.target.value, state: null })}
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
          ) : (
            <span className="preview__unlisted">
              이 레포는 아직 화면을 선언하지 않았습니다 — 첫 화면을 만들면 여기에 목록이 생깁니다.
            </span>
          )
        ) : null}
        {current && current.states.length > 1 && (
          <div className="preview__states" role="group" aria-label="상태">
            {current.states.map((state) => (
              <button
                key={state}
                type="button"
                className={state === activeState ? "preview__state preview__state--on" : "preview__state"}
                aria-pressed={state === activeState}
                title={`이 화면의 ${stateLabel(state)} 상태를 봅니다`}
                onClick={() => onNavigate({ kind: "screen", route: current.route, state })}
              >
                {stateLabel(state)}
              </button>
            ))}
          </div>
        )}
        <span className="preview__spacer" />
        {native && (
          <button
            type="button"
            className={commentsOn ? "preview__widthbtn preview__widthbtn--on" : "preview__widthbtn"}
            aria-pressed={commentsOn}
            title={
              commentsOn
                ? "핀만 찍는 모드를 끕니다"
                : "핀만 찍는 모드 — 클릭이 화면에 전달되지 않습니다. ⌥+클릭은 언제든 핀을 찍습니다"
            }
            onClick={() => onCommentsMode(!commentsOn)}
          >
            💬 코멘트{unresolvedComments > 0 ? ` ${unresolvedComments}` : ""}
          </button>
        )}
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
            className={width === "tablet" ? "preview__widthbtn preview__widthbtn--on" : "preview__widthbtn"}
            aria-pressed={width === "tablet"}
            title="태블릿 폭(768px)으로 봅니다"
            onClick={() => setWidth("tablet")}
          >
            태블릿
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
        <button
          type="button"
          className="preview__link"
          title="미리보기를 브라우저로"
          onClick={() => {
            // D85 ⓑ: the OS browser opens WHERE THE PLANNER IS — the current
            // path rides along, not just the bare origin.
            const path = location?.path ?? address ?? "/";
            let full = url;
            try {
              full = new URL(path, url).toString();
            } catch {
              // a malformed path falls back to the bare origin
            }
            window.open(full, "_blank", "noopener");
          }}
        >
          <ExternalLinkIcon />
          새 창
        </button>
      </div>
      {error && (
        <div className="preview__error" role="alert" data-testid="error-banner">
          <div className="preview__error__text">
            <strong>화면에 오류가 났습니다</strong>
            <pre
              className={
                detail ? "preview__error__message preview__error__message--open" : "preview__error__message"
              }
            >
              {error.message}
            </pre>
          </div>
          <div className="preview__error__actions">
            <button
              type="button"
              className="primary"
              onClick={() => {
                onFixError(error);
                setError(null);
              }}
            >
              Claude에게 고쳐 달라고 하기
            </button>
            <button
              type="button"
              className="machine__more"
              aria-expanded={detail}
              onClick={() => setDetail((v) => !v)}
            >
              {detail ? "접기" : "자세히"}
            </button>
          </div>
        </div>
      )}
      {/* Width is CSS on this wrapper for the iframe; the native side turns
          the same name into emulation (D69). Reloading never narrows the app
          itself — the frame is told nothing. */}
      <div
        className={
          width === "mobile"
            ? "preview__stage preview__stage--mobile"
            : width === "tablet"
              ? "preview__stage preview__stage--tablet"
              : "preview__stage"
        }
      >
        <div className="preview__device">
          {/* 프레임 머리 (PLAN D44 → D66): a browser bar now — back ·
              forward · reload, the address (native) or the screen name
              (iframe), and the docked PiP thumbnail. Always drawn, even
              before the first screen: a pane that grows a head only when a
              screen is picked reads as if it were hiding something. */}
          <div className="frame__chrome">
            {native && (
              <div className="frame__nav" role="group" aria-label="이동">
                <button
                  type="button"
                  className="frame__navbtn"
                  aria-label="뒤로"
                  title="뒤로"
                  disabled={!location?.canGoBack}
                  onClick={() => void window.cdsDesignDesktop?.preview?.history?.(-1)}
                >
                  ◀
                </button>
                <button
                  type="button"
                  className="frame__navbtn"
                  aria-label="앞으로"
                  title="앞으로"
                  disabled={!location?.canGoForward}
                  onClick={() => void window.cdsDesignDesktop?.preview?.history?.(1)}
                >
                  ▶
                </button>
              </div>
            )}
            <button
              type="button"
              className={loading ? "frame__toolsbtn frame__toolsbtn--busy" : "frame__toolsbtn"}
              aria-busy={loading || undefined}
              title={loading ? "불러오는 중 — 누르면 중단합니다" : "미리보기 새로 고침"}
              onClick={() => {
                if (!native) {
                  setReloadNonce((n) => n + 1);
                  return;
                }
                if (loading) void window.cdsDesignDesktop?.preview?.stop?.();
                else setReloadNonce((n) => n + 1);
              }}
            >
              {loading ? <span className="frame__spin" /> : <RefreshIcon />}
            </button>
            {native ? (
              <form
                className="frame__addresswrap"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitAddress(address);
                }}
              >
                <input
                  className="frame__address"
                  type="text"
                  aria-label="주소"
                  data-testid="preview-address"
                  spellCheck={false}
                  value={address}
                  list="cds-frame-routes"
                  ref={addressInput}
                  onFocus={() => setAddressFocused(true)}
                  onBlur={() => setAddressFocused(false)}
                  onChange={(event) => setAddress(event.target.value)}
                />
                {/* D85 ⓓ: the address bar proposes — declared routes, and the
                    route·state pairs when a screen declares more than one. */}
                <datalist id="cds-frame-routes">
                  {screens.flatMap((screen) => [
                    <option key={screen.route} value={screen.route}>
                      {screen.title}
                    </option>,
                    ...screen.states
                      .filter((state) => state !== "default")
                      .map((state) => (
                        <option key={`${screen.route}?state=${state}`} value={`${screen.route}?state=${state}`}>
                          {`${screen.title} · ${stateLabel(state)}`}
                        </option>
                      )),
                  ])}
                </datalist>
                {addressError && <span className="frame__addrerror">{addressError}</span>}
              </form>
            ) : (
              <span className="frame__name">
                {current ? (
                  <>
                    <b>{current.title}</b> · {stateLabel(activeState)}
                  </>
                ) : (
                  "미리보기"
                )}
              </span>
            )}
            {native && current && (
              <span className="frame__name frame__name--beside">
                <b>{current.title}</b> · {stateLabel(activeState)}
              </span>
            )}
            {/* D85 ⓔ: 100% 이 아니면 눈에 보인다 — 클릭이 실제 크기. */}
            {native && zoom !== 1 && (
              <button
                type="button"
                className="frame__zoom"
                data-testid="preview-zoom"
                title="실제 크기로 돌아갑니다"
                onClick={() => void window.cdsDesignDesktop?.preview?.zoom?.("reset")}
              >
                {Math.round(zoom * 100)}%
              </button>
            )}
            {native && onLook && (
              <button
                type="button"
                className="frame__look"
                aria-expanded={lookOpen}
                title="화면 전체와 콘솔 기록을 Claude 에게 보여 줍니다 — 오류 배너도 핀도 없을 때"
                onClick={() => setLookOpen((open) => !open)}
              >
                이 화면 Claude 에게 보여 주기
              </button>
            )}
            {native && pip && (
              <button
                type="button"
                className="pip--docked"
                title={pip.label}
                aria-expanded={pipLarge}
                onClick={onPipToggle}
              >
                <img src={`data:image/jpeg;base64,${pip.frame}`} alt="" />
                <span className="pip--docked__label">{pip.label}</span>
              </button>
            )}
          </div>
          {lookOpen && native && onLook && (
            <form
              className="frame__lookform"
              onSubmit={(event) => {
                event.preventDefault();
                setLookOpen(false);
                onLook(lookNote);
                setLookNote("");
              }}
            >
              <input
                type="text"
                aria-label="화면 보여 주기에 덧붙이는 말"
                placeholder="무엇이 어떻게 이상한지 한 줄 덧붙일 수 있어요 (선택)"
                value={lookNote}
                autoFocus
                onChange={(event) => setLookNote(event.target.value)}
              />
              <button type="submit" className="primary" disabled={lookBusy}>
                {lookBusy ? "보내는 중…" : "보내기"}
              </button>
              <button type="button" className="ghost" onClick={() => setLookOpen(false)}>
                취소
              </button>
            </form>
          )}
          {native ? (
            <NativeHost
              url={url}
              target={target}
              reloadKey={reloadNonce}
              width={width}
              commentsOn={commentsOn}
              onLocation={onLocation}
              onBridge={setBridge}
              onScreens={onScreens}
              onComments={onComments}
              onError={(payload) => setError({ ...payload, kind: payload.kind === "build" ? "build" : "runtime" })}
              onLoading={setLoading}
              onZoom={setZoom}
            />
          ) : (
            <IframeHost url={url} target={target} reloadKey={reloadNonce} onScreens={onScreens} />
          )}
        </div>
      </div>
    </div>
  );
}
