import type {
  ColoDesignPinEnvelope,
  ColoDesignPinsSync,
  ColoDesignScreen,
  PreviewTabMeta,
} from "@colo-design/protocol";
import { useEffect, useRef, useState } from "react";
import type { Daemon } from "../../lib/daemon-client";
import { daemonLine, stateLabel } from "../../lib/format";
import { parseAddress } from "../../lib/preview-address";
import {
  AppWindowIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  DesktopIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LockIcon,
  MapPinIcon,
  MobileIcon,
  PlusIcon,
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
 * Which screen, in which state, the planner asked to see. A free path (the
 * address bar) is an ask too — the native view `open`s it.
 */
export type PreviewTarget =
  | { kind: "screen"; route: string; state: string | null }
  | { kind: "path"; path: string };
/** Two asks land at the same place — the trail's consecutive-dedup. */
function sameTarget(a: PreviewTarget, b: PreviewTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "screen" && b.kind === "screen") return a.route === b.route && a.state === b.state;
  if (a.kind === "path" && b.kind === "path") return a.path === b.path;
  return false;
}

/** Where the native view actually is — its truth, not the tool's ask. */
export interface PreviewLocation {
  path: string;
  /** The full address — external pages show it whole in the bar. */
  url?: string;
  /** The pane is browsing a clicked link, not the preview (설정 `앱에서 링크 열기`). */
  external?: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/**
 * An error the planner can hand to the agent. The native view's
 * events build it now — the repo hook is gone.
 */
export interface PreviewError {
  route: string;
  state: string;
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
 * 탭 스트립 (인앱 브라우저 1단계): the browser's tabs, drawn from the view's
 * `colo-preview:tabs` truth — the web only renders and asks. A tab activates
 * on click, closes on its ×, and `+` opens a fresh web tab (`tabNew` with no
 * url). 탭이 하나도 없어도 스트립은 그린다 — `+` 가 유일한 탈출구니까.
 */
function TabStrip({ tabs, activeTabId }: { tabs: PreviewTabMeta[]; activeTabId: string | null }) {
  const bridge = window.coloDesignDesktop?.preview;
  return (
    <div className="frame__tabs" role="tablist" aria-label="탭">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={
            tab.id === activeTabId
              ? "frame__tab frame__tab--on"
              : tab.discarded
                ? "frame__tab frame__tab--asleep"
                : "frame__tab"
          }
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab.id === activeTabId}
            className="frame__tabbtn"
            title={tab.url ?? undefined}
            onClick={() => void bridge?.tabActivate?.(tab.id)}
          >
            {tab.kind === "web" ? <GlobeIcon /> : <AppWindowIcon />}
            <span className="frame__tabtitle">{tab.title}</span>
          </button>
          <button
            type="button"
            className="frame__tabclose"
            aria-label={`${tab.title} 탭 닫기`}
            onClick={() => void bridge?.tabClose?.(tab.id)}
          >
            <CloseIcon />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="frame__tabnew"
        aria-label="새 탭"
        onClick={() => void bridge?.tabNew?.()}
      >
        <PlusIcon />
      </button>
    </div>
  );
}

/**
 * The preview pane: the toolbar, the browser-bar frame head and
 * the stage are common; the stage itself is a host. `native` picks
 * `NativeHost` — the desktop's own view, with the address bar, back ·
 * forward, the error banner, real 폭 emulation and the 💬 toggle — and a
 * plain browser keeps the iframe — the declared screens, the ask's address
 * in the pill, and a back·forward that walks the asks themselves.
 */
export function PreviewHost({
  url,
  epoch = null,
  origins,
  stopped,
  stoppedDetail,
  onRestart,
  onPinFocus,
  sync,
  onPin,
  onFixError,
  screens,
  target,
  onNavigate,
  onScreens,
  onLocation,
  location,
  visitedCells,
  commentsOn,
  onCommentsMode,
  onLook,
  lookBusy = false,
  frozen = null,
  frozenApi = null,
}: {
  url: string | null;
  /** The server process behind `url` (RepoStatus.previewEpoch); the native page reloads under a new one. */
  epoch?: number | null;
  /** Extra origins the repo allows the pane to open (RepoStatus.previewOrigins). */
  origins?: string[];
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
  /** Screens the repo declared — empty until the bridge speaks. */
  screens: ColoDesignScreen[];
  /** The last ask; the caller answers by handing a new one back. */
  target: PreviewTarget | null;
  onNavigate: (target: PreviewTarget) => void;
  onScreens: (screens: ColoDesignScreen[]) => void;
  /** The native view's location reports arrive here; null when the pane
      closes its page (외부 페이지 닫기). */
  onLocation: (location: PreviewLocation | null) => void;
  location: PreviewLocation | null;
  /**
   * 본 곳 표식: 이번 수정 이후 기획자의 눈이
   * 닿은 화면·상태 키(`${route}|${state}`) — 패널이 위치 보고로 채우고,
   * 파일을 쓴 턴이 끝나면 비운다. 칸은 "존재한다"가 아니라 "봤다"를 말한다.
   */
  visitedCells?: Set<string>;
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
   * 보낸 화면 동결 (preview.md §1-E): while set, the stage wears the frozen
   * face — FrozenStage's bar and the committed capture over the view, with
   * 시점 빌드 재현 (§3 2단계) one press away. Null: the plain live stage.
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
}) {
  const native = Boolean(window.coloDesignDesktop?.preview?.native);
  const [width, setWidth] = useState<PreviewWidth>("desktop");
  /** Bumped by 새로 고침: a clean reload on whichever host is mounted. */
  const [reloadNonce, setReloadNonce] = useState(0);
  /**
   * 탭 모델 (인앱 브라우저 1단계): the view owns the list — the strip and
   * every kind 분기는 이 스냅샷을 읽는다. `preview:tabs` 가 첫 스냅샷이고
   * `colo-preview:tabs` 가 이후를 밀어 준다.
   */
  const [tabState, setTabState] = useState<{
    tabs: PreviewTabMeta[];
    activeTabId: string | null;
  }>({ tabs: [], activeTabId: null });
  useEffect(() => {
    if (!native) return;
    const bridge = window.coloDesignDesktop?.preview;
    if (!bridge) return;
    let live = true;
    void bridge.tabs?.().then((snapshot) => {
      if (live && snapshot) setTabState(snapshot);
    });
    const off = bridge.onTabs?.((payload) => setTabState(payload));
    return () => {
      live = false;
      off?.();
    };
  }, [native]);
  const activeTab = tabState.tabs.find((tab) => tab.id === tabState.activeTabId) ?? null;
  /** The last `colo-preview:error` — one at a time, the newest wins. */

  /** 화면·상태 매트릭스: 선언 전부와 본 곳 표식. */
  const [matrixOpen, setMatrixOpen] = useState(false);
  /** 매트릭스의 "안 본 상태만" — 커버리지 도구의 필터: 기본은 전체 보기. */
  const [unseenOnly, setUnseenOnly] = useState(false);
  const cellSeen = (route: string, state: string) =>
    visitedCells?.has(`${route}|${state}`) ?? false;
  const unseenTotal = screens.reduce(
    (count, screen) =>
      count + screen.states.filter((state) => !cellSeen(screen.route, state)).length,
    0,
  );
  /** 토글이 켜지면 본 칸은 빠진다 — 행에 남은 칸이 없으면 행도 함께. */
  const matrixScreens = unseenOnly
    ? screens
        .map((screen) => ({
          ...screen,
          states: screen.states.filter((state) => !cellSeen(screen.route, state)),
        }))
        .filter((screen) => screen.states.length > 0)
    : screens;
  useEffect(() => {
    if (!matrixOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMatrixOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [matrixOpen]);
  // 고정 해제 Esc: 얼린 얼굴(보낸 화면)이 떠 있을 때 한 번 누르면 지금 화면으로
  // 돌아온다 — 세그먼트의 `지금 화면`과 같은 동작. 화면 목록이 열려 있으면
  // Esc 는 그쪽의 몫이다.
  const frozenOnMode = frozen?.onMode;
  const frozenSent = frozen?.mode === "sent";
  useEffect(() => {
    if (!frozenSent || !frozenOnMode || matrixOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") frozenOnMode("live");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [frozenSent, frozenOnMode, matrixOpen]);
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

  // 오류 배너는 활성 탭의 것 — `colo-preview:error` 는 활성 탭만 보내니
  // 탭을 바꾸면 지난 탭의 배너를 들고 가지 않는다.
  useEffect(() => {
    setError(null);
  }, [tabState.activeTabId]);
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

  // 외부 페이지 모드 (설정 `앱에서 링크 열기`): 활성 탭의 kind 가 말한다 —
  // web 탭이 뜬 pane 은 미리보기가 아니라 브라우저 탭이고, 주소창은 주소
  // 전체를 보여 준다. kind 가 진실이라 첫 위치 보고가 아직 없는 새 탭도
  // 빈 화면이 아니라 탐색 중으로 읽힌다.
  const externalMode = activeTab?.kind === "web";
  const externalUrl = externalMode ? (location?.url ?? activeTab?.url ?? null) : null;

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
    else if (target?.kind === "screen")
      setAddress(full(target.state ? `${target.route}?state=${target.state}` : target.route));
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
    // 규칙 9 — 주소창의 이동은 활성 탭의 몫이다. web 탭에서는 브라우저처럼
    // 제자리 이동(새 탭을 만들지 않는다); preview 탭에서 다른 origin 의
    // 전체 http(s) 주소는 새 web 탭으로 연다. 나머지 — 경로·`?state=`·
    // 같은 origin 의 주소 — 는 예전 parseAddress 흐름 그대로.
    const trimmed = raw.trim();
    if (externalMode) {
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
      setAddressError("http(s) 주소만 열 수 있습니다");
      if (addressTimer.current !== null) window.clearTimeout(addressTimer.current);
      addressTimer.current = window.setTimeout(() => setAddressError(null), 2500);
      return;
    }
    if (/^https?:\/\//i.test(trimmed)) {
      let offOrigin = false;
      try {
        offOrigin = !url || new URL(trimmed).origin !== new URL(url).origin;
      } catch {
        offOrigin = false;
      }
      if (offOrigin) {
        setAddressError(null);
        void window.coloDesignDesktop?.preview?.tabNew?.(trimmed);
        return;
      }
    }
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
    onNavigate(
      verdict.kind === "screen"
        ? { kind: "screen", route: verdict.route, state: verdict.state }
        : { kind: "path", path: verdict.path },
    );
  };

  // 서버 중단 카드는 preview 탭의 얼굴 — web 탭이 활성이면 pane 은 그 탭의
  // 것이니 정상 경로로 내려보낸다(스트립은 어느 경로든 그린다).
  if (stopped && !externalMode) {
    const stoppedLine = daemonLine(stoppedDetail);
    // The 준비/실패 card's language (progress__card): one framed surface
    // centered in the column. The daemon's own words drop to a clipped mono
    // line under the human sentence — never the headline.
    return (
      <div className="preview">
        {native && <TabStrip tabs={tabState.tabs} activeTabId={tabState.activeTabId} />}
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
                    route: target?.kind === "screen" ? target.route : "",
                    state: target?.kind === "screen" ? (target.state ?? "") : "",
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

  // web 탭이 하나라도 살아 있으면 pane 은 비어 있지 않다 — 스트립이 그
  // 탭들을 보여 주고, 활성화되면 슬롯이 그린다.
  if (!url && !externalMode && !tabState.tabs.some((tab) => tab.kind === "web")) {
    return (
      <div className="preview">
        {native && <TabStrip tabs={tabState.tabs} activeTabId={tabState.activeTabId} />}
        <div className="preview__blank">
          <p className="hint">화면이 바뀌면 여기에 뜹니다</p>
        </div>
      </div>
    );
  }

  // The picker follows where the view IS — the ask is only its opening
  // bid. No `?state=` is what the repo's ScreenRunner labels `default`.
  // An external page has no screens: the derivation stays out entirely.
  const activePath =
    !externalMode && location ? location.path : target?.kind === "path" ? target.path : null;
  const activeRouteState =
    !externalMode && target?.kind === "screen"
      ? { route: target.route, state: target.state }
      : activePath !== null
        ? (() => {
            const [route, query = ""] = activePath.split("?");
            const state = new URLSearchParams(query).get("state");
            return { route, state: state && state !== "" ? state : null };
          })()
        : null;
  const current = activeRouteState
    ? (screens.find((screen) => screen.route === activeRouteState.route) ?? null)
    : null;
  const activeState = activeRouteState?.state ?? "default";

  return (
    <div className="preview">
      <div className="preview__toolbar">
        {externalMode
          ? (() => {
              // web 탭 위의 두 손잡이: `미리보기` 는 첫 preview 탭으로 돌아가고
              // (살아 있는 탭이 없을 때만 mount 가 새로 만든다 — mount 는 멱등),
              // `닫기` 는 활성 web 탭을 닫는다 — 다음 탭의 위치 보고가 주소창을
              // 채우기 전까지 잠깐의 빈칸을 onLocation(null) 이 메운다.
              const previewTab = tabState.tabs.find((tab) => tab.kind === "preview");
              return previewTab || url ? (
                <Tip label="프로젝트 미리보기로 돌아갑니다" side="bottom" align="start">
                  <button
                    type="button"
                    className="preview__state"
                    onClick={() => {
                      if (previewTab)
                        void window.coloDesignDesktop?.preview?.tabActivate?.(previewTab.id);
                      else if (url)
                        void window.coloDesignDesktop?.preview?.mount?.(url, epoch, origins);
                    }}
                  >
                    <ChevronLeftIcon />
                    미리보기
                  </button>
                </Tip>
              ) : (
                <Tip label="이 탭을 닫습니다" side="bottom" align="start">
                  <button
                    type="button"
                    className="preview__state"
                    onClick={() => {
                      void window.coloDesignDesktop?.preview?.tabClose?.(activeTab?.id);
                      onLocation(null);
                    }}
                  >
                    닫기
                  </button>
                </Tip>
              );
            })()
          : null}
        {!externalMode && screens.length > 0 && (
          <div className="preview__matrixwrap">
            <Tip
              label={
                matrixOpen
                  ? undefined
                  : "선언된 화면과 상태를 한눈에 — 이 수정 이후 본 곳에 표식이 붙습니다. 화면 이름으로 찾으려면 ⌘K"
              }
              side="bottom"
              align="start"
            >
              <button
                type="button"
                className={matrixOpen ? "preview__state preview__state--on" : "preview__state"}
                aria-haspopup="true"
                aria-expanded={matrixOpen}
                onClick={() => setMatrixOpen((open) => !open)}
              >
                화면 목록
              </button>
            </Tip>
            {matrixOpen && (
              <>
                <button
                  type="button"
                  className="selector__backdrop"
                  aria-label="화면 목록 닫기"
                  onClick={() => setMatrixOpen(false)}
                />
                <div className="selector__menu preview__matrix" role="group" aria-label="화면 목록">
                  {/* 커버리지 필터: 이 패널의 질문은 "아직 안 본
                      곳이 어디냐" — 이름 검색은 ⌘K 가 이미 한다. 기본은 전체
                      보기: 한눈 커버리지가 이 패널의 본령이니. */}
                  <div className="preview__mfilter">
                    <Tip
                      label={
                        unseenOnly
                          ? "모든 화면과 상태를 봅니다"
                          : "이 수정 이후 아직 보지 않은 상태만 골라 봅니다"
                      }
                      side="bottom"
                      align="start"
                    >
                      <button
                        type="button"
                        className={
                          unseenOnly ? "preview__state preview__state--on" : "preview__state"
                        }
                        aria-pressed={unseenOnly}
                        onClick={() => setUnseenOnly((v) => !v)}
                      >
                        안 본 상태만{unseenTotal > 0 ? ` ${unseenTotal}` : ""}
                      </button>
                    </Tip>
                  </div>
                  {matrixScreens.map((screen) => (
                    <div
                      className="preview__mrow"
                      key={screen.route}
                      role="group"
                      aria-label={screen.title}
                    >
                      <span className="preview__mtitle">{screen.title}</span>
                      <span className="preview__mstates">
                        {screen.states.map((state) => {
                          const seen = cellSeen(screen.route, state);
                          const on = current?.route === screen.route && activeState === state;
                          return (
                            <Tip
                              key={state}
                              label={
                                seen
                                  ? "이 수정 이후에 본 상태입니다"
                                  : "아직 안 본 상태입니다 — 누르면 그 화면으로 갑니다"
                              }
                              side="bottom"
                            >
                              <button
                                type="button"
                                className={
                                  on ? "preview__state preview__state--on" : "preview__state"
                                }
                                onClick={() => {
                                  setMatrixOpen(false);
                                  onNavigate({ kind: "screen", route: screen.route, state });
                                }}
                              >
                                {seen ? "✓ " : ""}
                                {stateLabel(state)}
                              </button>
                            </Tip>
                          );
                        })}
                      </span>
                    </div>
                  ))}
                  {unseenOnly && matrixScreens.length === 0 && (
                    <p className="preview__mempty">모든 상태를 확인했습니다</p>
                  )}
                </div>
              </>
            )}
          </div>
        )}
        {current && current.states.length > 1 && (
          <div className="preview__states" role="group" aria-label="상태">
            {current.states.map((state) => (
              <Tip key={state} label={`이 화면의 ${stateLabel(state)} 상태를 봅니다`} side="bottom">
                <button
                  type="button"
                  className={
                    state === activeState ? "preview__state preview__state--on" : "preview__state"
                  }
                  aria-pressed={state === activeState}
                  onClick={() => onNavigate({ kind: "screen", route: current.route, state })}
                >
                  {stateLabel(state)}
                </button>
              </Tip>
            ))}
          </div>
        )}
        <span className="preview__spacer" />
        {native && !externalMode && (
          <Tip
            label={
              commentsOn
                ? "핀 모드를 끕니다"
                : "핀 모드 — 클릭이 화면에 전달되지 않고 핀만 찍힙니다. ⌥+클릭은 언제든 핀을 찍습니다"
            }
            side="bottom"
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
        {!externalMode && (
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
        <Tip
          label={externalMode ? "이 페이지를 OS 브라우저로" : "미리보기를 브라우저로"}
          side="bottom"
        >
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
          {/* 탭 스트립 — 진행 바 아래·크롬 줄 위, 브라우저의 탭 자리.
              네이티브만: iframe 경로는 탭이 없는 단일 화면이다. */}
          {native && <TabStrip tabs={tabState.tabs} activeTabId={tabState.activeTabId} />}
          <div className="frame__chrome">
            <div className="frame__side frame__side--left">
              <div className="frame__lights" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
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
                    list="colo-frame-routes"
                    ref={addressInput}
                    onFocus={() => setAddressFocused(true)}
                    onBlur={() => setAddressFocused(false)}
                    onChange={(event) => setAddress(event.target.value)}
                  />
                </span>
                {/* The address bar proposes — declared routes, and the
                    route·state pairs when a screen declares more than one. */}
                <datalist id="colo-frame-routes">
                  {(externalMode ? [] : screens).flatMap((screen) => [
                    <option key={screen.route} value={screen.route}>
                      {screen.title}
                    </option>,
                    ...screen.states
                      .filter((state) => state !== "default")
                      .map((state) => (
                        <option
                          key={`${screen.route}?state=${state}`}
                          value={`${screen.route}?state=${state}`}
                        >
                          {`${screen.title} · ${stateLabel(state)}`}
                        </option>
                      )),
                  ])}
                </datalist>
                {addressError && <span className="frame__addrerror">{addressError}</span>}
              </form>
            ) : (
              <span className="frame__pill">
                <LockIcon />
                <span className="frame__pill__text">{address !== "" ? address : "미리보기"}</span>
              </span>
            )}
            <div className="frame__side frame__side--right">
              {current && (
                <span className="frame__name frame__name--beside">
                  <b>{current.title}</b> · {stateLabel(activeState)}
                </span>
              )}
              {/* 좁혀진 폭은 숫자로 읽힌다 — 모바일·태블릿일 때만. */}
              {width !== "desktop" && !externalMode && (
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
              {native && onLook && !externalMode && (
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
          {lookOpen && native && onLook && !externalMode && (
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
                origins={origins}
                target={target}
                reloadKey={reloadNonce}
                width={width}
                commentsOn={commentsOn}
                activeTab={activeTab}
                onLocation={onLocation}
                onScreens={onScreens}
                sync={sync}
                onPin={onPin}
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
              <IframeHost
                url={url}
                target={target}
                reloadKey={reloadNonce}
                onScreens={onScreens}
                onLoading={setLoading}
              />
            ) : null;
            // 동결 (preview.md §1-E): the frozen face wraps the host — the
            // host always renders so the native view's slot never moves; the
            // capture covers it through `data-cover-stage`, and 실제로 열기
            // (§3 2단계) rides in the same cover when frozenApi is wired.
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
