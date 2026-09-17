import type { ColoDesignPinEnvelope, ColoDesignPinsSync } from "@colo-design/protocol";
import { useEffect, useRef, useState } from "react";
import type { Daemon } from "../../lib/daemon-client";
import { daemonLine } from "../../lib/format";
import { parseAddress } from "../../lib/preview-address";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DesktopIcon,
  ExternalLinkIcon,
  LockIcon,
  MapPinIcon,
  MobileIcon,
  RefreshIcon,
  RestartIcon,
  ServerOffIcon,
  TabletIcon,
} from "../icons";
import { Tip } from "../shell/Tip";
import { FrozenStage } from "./FrozenStage";
import { IframeHost } from "./IframeHost";
import { NativeHost } from "./NativeHost";

/**
 * Which path the planner asked to see (the address bar's ask — the native
 * view `open`s it).
 */
export type PreviewTarget = { kind: "path"; path: string };
/** Two asks land at the same place — the trail's consecutive-dedup. */
function sameTarget(a: PreviewTarget, b: PreviewTarget): boolean {
  return a.kind === b.kind && a.path === b.path;
}

/** Where the native view actually is — its truth, not the tool's ask. */
export interface PreviewLocation {
  path: string;
  /** The full address — 외부 페이지는 주소창에 통째로 보여 준다. */
  url?: string;
  /** repo origin 위면 `preview`, 그 밖이면 `web` — 외부 페이지 모드의 자리. */
  kind: "preview" | "web";
  canGoBack: boolean;
  canGoForward: boolean;
}

/**
 * An error the planner can hand to the agent. The native view's
 * events build it now — the repo hook is gone.
 */
export interface PreviewError {
  route: string;
  /** 표식 없는 페이지의 오류는 null — 머리글은 상태 절을 생략한다. */
  state: string | null;
  kind: "runtime" | "build";
  message: string;
}

/**
 * 모바일 constrains the frame to 390px — the logical viewport of the current
 * baseline iPhone — and 태블릿 to 768px. On the native side these
 * names turn on real emulation; here they only narrow the stage.
 */
type PreviewWidth = "mobile" | "tablet" | "desktop";

/**
 * The preview pane: the toolbar, the browser-bar frame head and
 * the stage are common; the stage itself is a host. `native` picks
 * `NativeHost` — the desktop's own view, with the address bar, back ·
 * forward, the error banner, real 폭 emulation and the 💬 toggle — and a
 * plain browser keeps the iframe — the ask's address in the pill, and a
 * back·forward that walks the asks themselves.
 */
export function PreviewHost({
  url,
  epoch = null,
  stopped,
  stoppedDetail,
  onRestart,
  onPinFocus,
  sync,
  onPin,
  onFixError,
  target,
  onNavigate,
  onLocation,
  location,
  commentsOn,
  onCommentsMode,
  onLook,
  lookBusy = false,
  frozen = null,
  frozenApi = null,
  driving,
}: {
  url: string | null;
  /** The server process behind `url` (RepoStatus.previewEpoch); the native page reloads under a new one. */
  epoch?: number | null;
  /** The preview server died after being ready; the pane would show nothing. */
  stopped: boolean;
  /** Why it is not running, in the daemon's own words. */
  stoppedDetail?: string | null;
  onRestart: () => void;
  /** The live pins — NativeHost projects them onto the overlay. */
  sync: ColoDesignPinsSync;
  /** A pin landed from the overlay; the workspace's usePins owns the list. */
  onPin: (pin: ColoDesignPinEnvelope["pin"]) => void;
  /** 배지 클릭 — the memo input of that pin's tray row takes the focus. */
  onPinFocus: (id: string) => void;
  /** The banner's `AI에게 고쳐 달라고 하기`. */
  onFixError: (error: PreviewError) => void;
  /** The last ask; the caller answers by handing a new one back. */
  target: PreviewTarget | null;
  onNavigate: (target: PreviewTarget) => void;
  /** The native view's location reports arrive here; null when the pane
      closes its page (외부 페이지 닫기). */
  onLocation: (location: PreviewLocation | null) => void;
  location: PreviewLocation | null;
  /** 코멘트 모드 — the toolbar owns the truth. */
  commentsOn: boolean;
  onCommentsMode: (on: boolean) => void;
  /**
   * 이 화면 AI 에게 보여 주기: the whole frame, the route·
   * state and the console tail go up as one turn. Native only — the iframe
   * cannot be photographed from here.
   */
  onLook?: (note: string) => void;
  /** True while the snapshot is being taken and the turn composed. */
  lookBusy?: boolean;
  /**
   * 보낸 화면 동결: while set, the stage wears the frozen
   * face — FrozenStage's bar and the committed capture over the view, with
   * 시점 빌드 재현 one press away. Null: the plain live stage.
   * The derivation lives with the panel that owns `delivery`; the host only
   * dresses the stage.
   */
  frozen?: {
    shot: { mediaType: string; data: string } | null;
    stamp: string;
    tone: "info" | "ok" | "warn";
    mode: "sent" | "live";
    onMode?: (mode: "sent" | "live") => void;
  } | null;
  /**
   * The wire 실제로 열기 speaks through — the api and the conversation that
   * owns the stage. Absent: the button is not on the bar.
   */
  frozenApi?: { api: Daemon["api"]; sessionId: string | null } | null;
  /**
   * 에이전트가 브라우저를 조작 중인 세션들 — 데몬의 `browser.driving`이
   * 채우는 `daemon.browserDriving`. 비어 있으면 아무도 조작 중이 아니다.
   */
  driving?: ReadonlySet<string>;
}) {
  const drivingNow = (driving?.size ?? 0) > 0;
  const native = Boolean(window.coloDesignDesktop?.preview?.native);
  const [width, setWidth] = useState<PreviewWidth>("desktop");
  /** Bumped by 새로 고침: a clean reload on whichever host is mounted. */
  const [reloadNonce, setReloadNonce] = useState(0);
  /** The last `colo-preview:error` — one at a time, the newest wins. */

  // 고정 해제 Esc: 얼린 얼굴(보낸 화면)이 떠 있을 때 한 번 누르면 지금 화면으로
  // 돌아온다 — 세그먼트의 `지금 화면`과 같은 동작.
  const frozenOnMode = frozen?.onMode;
  const frozenSent = frozen?.mode === "sent";
  useEffect(() => {
    if (!frozenSent || !frozenOnMode) return;
    const onKey = (event: KeyboardEvent) => {
      // 위에 대화상자나 팔레트가 떠 있으면 Escape 는 그쪽의 몫이다 — 얼린
      // 얼굴은 최상단이 아니다.
      if (document.querySelector(".modal, .palette") !== null) return;
      if (event.key === "Escape") frozenOnMode("live");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [frozenSent, frozenOnMode]);
  const [error, setError] = useState<PreviewError | null>(null);
  /** The banner's `자세히`: the message starts clamped to one line. */
  const [detail, setDetail] = useState(false);
  /** The 보여 주기 form — the button opens it, the note rides along. */
  const [lookOpen, setLookOpen] = useState(false);
  const [lookNote, setLookNote] = useState("");
  /** The view is loading — the reload button spins; clicking = 중단. */
  const [loading, setLoading] = useState(false);
  /** The view's zoom — 100% hides the chip; the menu can move it. */
  const [zoom, setZoom] = useState(1);
  /** 핀 코치 마크 — 이 기기에서 한 번만 뜬다(last-seen 과 같은 이유로
      localStorage 가 진실: 데몬은 "이 사람이 핀을 써 봤는지"를 모른다).
      첫 핀이 찍히거나 닫기를 누르면 사라지고 다시 오지 않는다. */
  const [pinCoach, setPinCoach] = useState(() => {
    try {
      return localStorage.getItem("colo-design.pin-coach-seen") !== "1";
    } catch {
      return true;
    }
  });
  /** 로딩이 길어질 때의 말: ok → 10초에 late(한 줄) → 30초에 stuck(카드).
      `loading` 은 iframe 의 onLoad 와 네이티브의 loading 이벤트가 함께
      채우는 하나의 진실이니 이 단계는 어느 호스트든 공통으로 적용된다. */
  const [loadPhase, setLoadPhase] = useState<"ok" | "late" | "stuck">("ok");
  const addressInput = useRef<HTMLInputElement>(null);

  // The address bar: local while focused, the view's truth otherwise.
  const [address, setAddress] = useState("");
  const [addressFocused, setAddressFocused] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);
  const addressTimer = useRef<number | null>(null);

  // A new load is innocent until it reports again — same rule the iframe's
  // banner lived by: a hot reload never wipes a just-reported error.
  useEffect(() => {
    setError(null);
  }, [url]);

  // 서버가 돌아오면 지난 화면을 버린다 (실사 결함): bring-up 이 `stopped` 를
  // 끄는 순간이 곧 재접속 신호고, iframe 이 브라우저 오류 페이지("웹페이지가
  // 일시적으로 다운되었…")를 쥐고 있으면 앱 전체 reload 로만 빠져나올 수
  // 없었다. 되돌아옴 = 한 번의 깨끗한 reload. The native page needs no nudge:
  // a server that came back is a new epoch, and the view reloads on that.
  const wasStopped = useRef(stopped);
  useEffect(() => {
    if (!native && wasStopped.current && !stopped) setReloadNonce((n) => n + 1);
    wasStopped.current = stopped;
  }, [native, stopped]);

  // 느린 로딩의 말: 스핀은 무한정 돌 수 있지만 사람은 기다리는 이유를
  // 모른다 — 10초에 한 줄(새로 고침·AI 제안), 30초에 카드(다시 고침·AI에게
  // 물어보기)로 올린다. 로딩이 끝나거나 새로 고침(nonce)이면 다시 ok 부터.
  useEffect(() => {
    if (!loading) {
      setLoadPhase("ok");
      return;
    }
    setLoadPhase("ok");
    const late = window.setTimeout(() => setLoadPhase("late"), 10_000);
    const stuck = window.setTimeout(() => setLoadPhase("stuck"), 30_000);
    return () => {
      window.clearTimeout(late);
      window.clearTimeout(stuck);
    };
  }, [loading, reloadNonce]);

  // 외부 페이지 모드 (설정 `앱에서 링크 열기`): 화면의 페이지가 repo origin
  // 밖으로 나가면 pane 은 미리보기가 아니라 브라우저다 — 주소창은 주소
  // 전체를 보여 준다. kind 는 위치 보고가 말한다.
  const webMode = location?.kind === "web";
  const externalUrl = webMode ? (location?.url ?? null) : null;

  // What the bar shows when nobody is typing: the view's full address —
  // origin included, a browser bar's shape — else the ask. Typing stays free:
  // bare paths, `?state=`, and same-origin urls all parse.
  useEffect(() => {
    if (addressFocused) return;
    if (externalUrl) {
      setAddress(externalUrl);
      return;
    }
    const origin = url ? new URL(url).origin : "";
    const full = (path: string) => (origin === "" ? path : `${origin}${path}`);
    if (location) setAddress(full(location.path));
    else if (target?.kind === "path") setAddress(full(target.path));
    else setAddress(full("/"));
  }, [url, location, target, addressFocused, externalUrl]);

  useEffect(() => {
    return () => {
      if (addressTimer.current !== null) window.clearTimeout(addressTimer.current);
    };
  }, []);

  // 주소로 이동 ⌘L — replayed by the menu through the key channel,
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

  // iframe의 궤적: a framed page reports no location of its own, so
  // the asks are the history — back·forward walk this trail, and a new ask
  // cuts the forward branch, as a browser would.
  const [trail, setTrail] = useState<{ list: PreviewTarget[]; at: number }>({
    list: [],
    at: -1,
  });
  useEffect(() => {
    setTrail({ list: [], at: -1 });
  }, [url]);
  useEffect(() => {
    if (native || !target) return;
    setTrail((t) => {
      const cur = t.list[t.at];
      if (cur && sameTarget(cur, target)) return t;
      return { list: [...t.list.slice(0, t.at + 1), target], at: t.at + 1 };
    });
  }, [native, target]);
  const goTrail = (delta: number) => {
    const entry = trail.list[trail.at + delta];
    if (!entry) return;
    setTrail((t) => ({ ...t, at: t.at + delta }));
    onNavigate(entry);
  };

  // 폭 is the device, 배율 is the eye — a width change resets the
  // eye to 100% (모바일 에뮬레이션 + 150% 는 가로 스크롤을 만든다).
  const zoomBridge = window.coloDesignDesktop?.preview;
  useEffect(() => {
    setZoom(1);
    void zoomBridge?.zoom?.("reset");
  }, [width]);

  const submitAddress = (raw: string) => {
    // 주소창의 이동은 화면의 페이지 몫이다. web 모드에서는 브라우저처럼
    // 제자리 이동; preview 모드에서 다른 origin 의 전체 http(s) 주소도
    // 같은 길로 간다 — 뷰의 openTab 이 repo origin 이면 그 프로젝트의
    // 페이지로, 그 밖이면 제자리 이동으로 판다. 나머지 — 경로·`?state=`·
    // 같은 origin 의 주소 — 는 예전 parseAddress 흐름 그대로.
    const trimmed = raw.trim();
    if (webMode || /^https?:\/\//i.test(trimmed)) {
      let target: URL | null = null;
      try {
        target = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
      } catch {
        target = null;
      }
      if (target && (target.protocol === "http:" || target.protocol === "https:")) {
        setAddressError(null);
        void window.coloDesignDesktop?.preview?.open?.(target.toString());
        return;
      }
      if (webMode) {
        setAddressError("http(s) 주소만 열 수 있습니다");
        if (addressTimer.current !== null) window.clearTimeout(addressTimer.current);
        addressTimer.current = window.setTimeout(() => setAddressError(null), 2500);
        return;
      }
    }
    if (!url) return;
    const verdict = parseAddress(raw, {
      origin: new URL(url).origin,
      currentPath: location?.path ?? "/",
    });
    if (verdict.kind === "error") {
      setAddressError(verdict.message);
      if (addressTimer.current !== null) window.clearTimeout(addressTimer.current);
      addressTimer.current = window.setTimeout(() => setAddressError(null), 2500);
      return;
    }
    setAddressError(null);
    onNavigate({ kind: "path", path: verdict.path });
  };

  // 코치 마크의 졸업: 첫 핀이 찍히거나 닫기를 누르면 임무 끝 — 이 기기에서
  // 다시 뜨지 않는다. 저장이 막혀 있으면 이번 세션에서만 물러난다.
  const dismissPinCoach = () => {
    setPinCoach(false);
    try {
      localStorage.setItem("colo-design.pin-coach-seen", "1");
    } catch {
      // 저장 실패는 치명적이지 않다 — 다음 실행에 한 번 더 보일 뿐.
    }
  };
  // 코치는 핀 모드가 켜져 있을 때만 말이 성립한다 — 꺼져 있으면 클릭은
  // 화면으로 그대로 간다.
  const coachOn = pinCoach && commentsOn;

  // 서버 중단 카드는 프로젝트 페이지의 얼굴 — 외부 페이지가 떠 있으면 pane 은
  // 그 페이지의 것이니 정상 경로로 내려보낸다.
  if (stopped && !webMode) {
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
            <p className="progress__body">
              화면을 그리는 서버가 멈췄습니다. 저장과 넘기기는 그대로입니다 — 화면만 쉬고 있습니다.
            </p>
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
                    route: location?.path ?? "/",
                    state: "",
                    kind: "build",
                    message: stoppedDetail || "화면을 그리는 서버가 멈췄습니다.",
                  })
                }
              >
                AI에게 고쳐 달라고 하기
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 프로젝트도 외부 페이지도 없으면 pane 은 비어 있다.
  if (!url && !webMode) {
    return (
      <div className="preview">
        <div className="preview__blank">
          <p className="hint">화면이 바뀌면 여기에 뜹니다</p>
        </div>
      </div>
    );
  }

  return (
    <div className="preview">
      <div className="preview__toolbar">
        {webMode ? (
          // 외부 페이지 위의 손잡이: `미리보기` 는 이 프로젝트의 페이지로
          // 돌아간다(mount 는 멱등 — 데워 둔 페이지가 있으면 그 자리로).
          // 프로젝트가 없는 loose 페이지라면 `닫기` 가 pane 을 접는다.
          url ? (
            <Tip label="프로젝트 미리보기로 돌아갑니다" side="bottom" align="start">
              <button
                type="button"
                className="preview__state"
                onClick={() => void window.coloDesignDesktop?.preview?.mount?.(url, epoch)}
              >
                <ChevronLeftIcon />
                미리보기
              </button>
            </Tip>
          ) : (
            <Tip label="이 페이지를 닫습니다" side="bottom" align="start">
              <button
                type="button"
                className="preview__state"
                onClick={() => void window.coloDesignDesktop?.preview?.unmount?.()}
              >
                닫기
              </button>
            </Tip>
          )
        ) : null}
        {/* 브라우저 경로의 결손 고지: 핀·보여 주기는 네이티브 뷰의 것이라
            iframe·외부 페이지 모드에서는 버튼 자체가 없다 — 없는 손잡이를
            찾게 두지 말고 한 줄로 말해 둔다. */}
        {(!native || webMode) && (
          <span className="hint">
            {webMode
              ? "외부 페이지에서는 핀·화면 보여 주기를 쓸 수 없어요"
              : "브라우저 미리보기에서는 핀·화면 보여 주기를 쓸 수 없어요"}
          </span>
        )}
        <span className="preview__spacer" />
        {native && !webMode && (
          <Tip
            label={
              coachOn ? (
                <>
                  화면을 클릭해 이 요소만 지목할 수 있어요
                  <button
                    type="button"
                    className="notice__close"
                    aria-label="핀 안내 닫기"
                    style={{ marginLeft: 6 }}
                    onClick={dismissPinCoach}
                  >
                    ×
                  </button>
                </>
              ) : commentsOn ? (
                "핀 모드를 끕니다"
              ) : (
                "핀 모드 — 클릭이 화면에 전달되지 않고 핀만 찍힙니다. ⌥+클릭은 언제든 핀을 찍습니다"
              )
            }
            side="bottom"
            open={coachOn}
          >
            <button
              type="button"
              className={
                commentsOn ? "preview__widthbtn preview__widthbtn--on" : "preview__widthbtn"
              }
              aria-pressed={commentsOn}
              onClick={() => onCommentsMode(!commentsOn)}
            >
              <MapPinIcon />핀
            </button>
          </Tip>
        )}
        {!webMode && (
          <div className="preview__width" role="group" aria-label="폭">
            <Tip label="휴대폰 폭으로 좁혀서 봅니다" side="bottom">
              <button
                type="button"
                className={
                  width === "mobile"
                    ? "preview__widthbtn preview__widthbtn--on"
                    : "preview__widthbtn"
                }
                aria-pressed={width === "mobile"}
                onClick={() => setWidth("mobile")}
              >
                <MobileIcon />
                모바일
              </button>
            </Tip>
            <Tip label="태블릿 폭(768px)으로 봅니다" side="bottom">
              <button
                type="button"
                className={
                  width === "tablet"
                    ? "preview__widthbtn preview__widthbtn--on"
                    : "preview__widthbtn"
                }
                aria-pressed={width === "tablet"}
                onClick={() => setWidth("tablet")}
              >
                <TabletIcon />
                태블릿
              </button>
            </Tip>
            <Tip label="화면 전체 폭으로 봅니다" side="bottom">
              <button
                type="button"
                className={
                  width === "desktop"
                    ? "preview__widthbtn preview__widthbtn--on"
                    : "preview__widthbtn"
                }
                aria-pressed={width === "desktop"}
                onClick={() => setWidth("desktop")}
              >
                <DesktopIcon />
                데스크톱
              </button>
            </Tip>
          </div>
        )}
        <Tip label={webMode ? "이 페이지를 OS 브라우저로" : "미리보기를 브라우저로"} side="bottom">
          <button
            type="button"
            className="preview__link"
            onClick={() => {
              // The OS browser opens WHERE THE PLANNER IS — the current
              // path rides along, not just the bare origin. External pages
              // hand over their whole address.
              if (externalUrl) {
                window.open(externalUrl, "_blank", "noopener");
                return;
              }
              const path = location?.path ?? address ?? "/";
              let full = url;
              try {
                full = new URL(path, url ?? undefined).toString();
              } catch {
                // a malformed path falls back to the bare origin
              }
              if (full) window.open(full, "_blank", "noopener");
            }}
          >
            <ExternalLinkIcon />새 창
          </button>
        </Tip>
      </div>
      {/* Width is CSS on this wrapper for the iframe; the native side turns
          the same name into emulation. Reloading never narrows the app
          itself — the frame is told nothing. */}
      <div
        className={
          width === "mobile"
            ? "preview__stage preview__stage--mobile"
            : width === "tablet"
              ? "preview__stage preview__stage--tablet"
              : "preview__stage preview__stage--desktop"
        }
      >
        <div className="preview__device">
          {/* 프레임 머리: a browser bar now — back ·
              forward · reload, the address on both hosts (the iframe pill
              shows the ask's address, its back·forward walks the trail of
              asks), and the docked PiP thumbnail. Always drawn, even
              before the first screen: a pane that grows a head only when a
              screen is picked reads as if it were hiding something. */}
          {loading && <div className="frame__progress" aria-hidden="true" />}
          <div className="frame__chrome">
            <div className="frame__side frame__side--left">
              <div className="frame__nav" role="group" aria-label="이동">
                <button
                  type="button"
                  className="frame__navbtn"
                  aria-label="뒤로"
                  disabled={native ? !location?.canGoBack : trail.at <= 0}
                  onClick={() => {
                    if (native) void window.coloDesignDesktop?.preview?.history?.(-1);
                    else goTrail(-1);
                  }}
                >
                  <ChevronLeftIcon />
                </button>
                <button
                  type="button"
                  className="frame__navbtn"
                  aria-label="앞으로"
                  disabled={native ? !location?.canGoForward : trail.at >= trail.list.length - 1}
                  onClick={() => {
                    if (native) void window.coloDesignDesktop?.preview?.history?.(1);
                    else goTrail(1);
                  }}
                >
                  <ChevronRightIcon />
                </button>
              </div>
              <Tip
                label={
                  loading
                    ? native
                      ? "불러오는 중 — 누르면 중단합니다"
                      : "불러오는 중 — 누르면 다시 불러옵니다"
                    : "미리보기 새로 고침"
                }
                side="bottom"
              >
                <button
                  type="button"
                  className={loading ? "frame__toolsbtn frame__toolsbtn--busy" : "frame__toolsbtn"}
                  aria-busy={loading || undefined}
                  /* 중단은 네이티브 뷰에만 있는 동작 — iframe 에서는 누르면
                     다시 불러오므로 말을 그 동작에 맞춘다. */
                  aria-label={loading && native ? "미리보기 불러오기 중단" : "미리보기 새로 고침"}
                  onClick={() => {
                    if (!native) {
                      setReloadNonce((n) => n + 1);
                      return;
                    }
                    if (loading) void window.coloDesignDesktop?.preview?.stop?.();
                    else setReloadNonce((n) => n + 1);
                  }}
                >
                  {loading ? <span className="frame__spin" /> : <RefreshIcon />}
                </button>
              </Tip>
            </div>
            {native ? (
              <form
                className="frame__addresswrap"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitAddress(address);
                }}
              >
                <span className="frame__addressbox">
                  <LockIcon />
                  <input
                    className="frame__address"
                    type="text"
                    aria-label="주소"
                    data-testid="preview-address"
                    spellCheck={false}
                    value={address}
                    ref={addressInput}
                    onFocus={() => setAddressFocused(true)}
                    onBlur={() => setAddressFocused(false)}
                    onChange={(event) => setAddress(event.target.value)}
                  />
                  {native && drivingNow && (
                    <span
                      className="frame__spin"
                      role="status"
                      aria-label="에이전트 조작 중"
                      title="에이전트 조작 중"
                    />
                  )}
                </span>
                {addressError && <span className="frame__addrerror">{addressError}</span>}
              </form>
            ) : (
              <span className="frame__pill">
                <LockIcon />
                <span className="frame__pill__text">{address !== "" ? address : "미리보기"}</span>
              </span>
            )}
            <div className="frame__side frame__side--right">
              {/* 좁혀진 폭은 숫자로 읽힌다 — 모바일·태블릿일 때만. */}
              {width !== "desktop" && !webMode && (
                <span className="frame__width">{width === "mobile" ? "390px" : "768px"}</span>
              )}
              {/* 100% 이 아니면 눈에 보인다 — 클릭이 실제 크기. */}
              {native && zoom !== 1 && (
                <Tip label="실제 크기로 돌아갑니다" side="bottom">
                  <button
                    type="button"
                    className="frame__zoom"
                    data-testid="preview-zoom"
                    onClick={() => void window.coloDesignDesktop?.preview?.zoom?.("reset")}
                  >
                    {Math.round(zoom * 100)}%
                  </button>
                </Tip>
              )}
              {native && onLook && !webMode && (
                <Tip
                  label={
                    lookOpen
                      ? undefined
                      : "화면 전체와 콘솔 기록을 AI에게 보여 줍니다 — 오류 배너도 핀도 없을 때"
                  }
                  side="bottom"
                  align="end"
                >
                  <button
                    type="button"
                    className="frame__look"
                    aria-expanded={lookOpen}
                    onClick={() => setLookOpen((open) => !open)}
                  >
                    이 화면 AI에게 보여 주기
                  </button>
                </Tip>
              )}
            </div>
          </div>
          {lookOpen && native && onLook && !webMode && (
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
          {(() => {
            const host = native ? (
              <NativeHost
                url={url}
                epoch={epoch}
                target={target}
                reloadKey={reloadNonce}
                width={width}
                commentsOn={commentsOn}
                onLocation={onLocation}
                sync={sync}
                onPin={(pin) => {
                  // 첫 핀 성공 = 코치 마크의 졸업 — 더 이상 가르칠 게 없다.
                  dismissPinCoach();
                  onPin(pin);
                }}
                onPinFocus={onPinFocus}
                onError={(payload) =>
                  setError({
                    ...payload,
                    kind: payload.kind === "build" ? "build" : "runtime",
                  })
                }
                onLoading={setLoading}
                onZoom={setZoom}
              />
            ) : url ? (
              <IframeHost url={url} reloadKey={reloadNonce} onLoading={setLoading} />
            ) : null;
            // 동결: the frozen face wraps the host — the
            // host always renders so the native view's slot never moves; the
            // capture covers it through `data-cover-stage`, and 실제로 열기
            // rides in the same cover when frozenApi is wired.
            return frozen ? (
              <FrozenStage
                shot={frozen.shot}
                stamp={frozen.stamp}
                tone={frozen.tone}
                mode={frozen.mode}
                onMode={frozen.onMode}
                api={frozenApi?.api ?? null}
                sessionId={frozenApi?.sessionId ?? null}
              >
                {host}
              </FrozenStage>
            ) : (
              host
            );
          })()}
          {/* 느린 로딩의 말 — 스핀만 무한정 도는 대신 10초에 한 줄,
              30초에 카드로 올린다. 어느 호스트든 `loading` 하나로 돈다. */}
          {loadPhase === "late" && (
            <span className="preview__unpin" role="status">
              화면이 늦게 뜨고 있어요 — 새로 고침하거나 AI에게 물어보세요
            </span>
          )}
          {loadPhase === "stuck" && !error && (
            <div className="preview__error" role="alert" data-testid="load-stuck">
              <div className="preview__error__text">
                <strong>화면이 뜨지 않고 있습니다</strong>
                <span className="hint">
                  서버가 응답하지 않는 것 같아요 — 다시 고치거나 AI에게 물어보세요.
                </span>
              </div>
              <div className="preview__error__actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => setReloadNonce((n) => n + 1)}
                >
                  다시 고침
                </button>
                <button
                  type="button"
                  className="machine__more"
                  onClick={() =>
                    onFixError({
                      route: location?.path ?? "/",
                      state: "",
                      kind: "runtime",
                      message: "미리보기 화면이 30초 넘게 뜨지 않았습니다.",
                    })
                  }
                >
                  AI에게 물어보기
                </button>
              </div>
            </div>
          )}
          {/* 오류 띠는 프레임 안쪽 — 스테이지 바닥에 얹힌다 (프레임 밖 띠는
              도구줄과 화면 사이에 끼어 화면의 일처럼 읽혔다). */}
          {error && (
            <div className="preview__error" role="alert" data-testid="error-banner">
              <div className="preview__error__text">
                <strong>화면에 오류가 났습니다</strong>
                <pre
                  className={
                    detail
                      ? "preview__error__message preview__error__message--open"
                      : "preview__error__message"
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
                  AI에게 고쳐 달라고 하기
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
          {/* 얼린 얼굴이 떠 있을 때만: 해제 손잡이(세그먼트의 지금 화면)가
              있으면 Esc 도 같은 일을 한다고 표면에 말한다. */}
          {frozenSent && frozenOnMode && <span className="preview__unpin">Esc로 고정 해제</span>}
        </div>
      </div>
    </div>
  );
}
