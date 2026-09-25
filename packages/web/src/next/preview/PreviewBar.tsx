import { type ReactNode, useEffect, useRef, useState } from "react";
import { composing } from "../../lib/ime";
import { L } from "../labels";
import { Popover } from "../ui/Popover";
import {
  AddrChevronIcon,
  BackIcon,
  CameraIcon,
  ClockIcon,
  EyeIcon,
  ForwardIcon,
  KeyboardIcon,
  MinusIcon,
  MoreIcon,
  PcIcon,
  PhoneIcon,
  PinIcon,
  PlusIcon,
  ReloadIcon,
  TabletIcon,
} from "./icons";
import type { PreviewDevice } from "./PreviewHost";

/** 주소 목록의 한 줄 — 화면 이름과 그 주소(주소는 목록 안에서만 보인다, U10). */
export interface ScreenRow {
  path: string;
  name: string;
}

/**
 * 미리보기 막대 — 목업 `.pvbar`: ‹ › ⟳ · 주소(=화면 이름, 누르면 화면 목록) ·
 * PC/태블릿/휴대폰 · 찍기 · 기록 · `···`(배율 · AI에게 이 화면 보여 주기 ·
 * 제출한 때의 화면 · 단축키).
 */
export function PreviewBar({
  canBack,
  canForward,
  onBack,
  onForward,
  onReload,
  screenName,
  mine,
  others,
  onGo,
  onAddress,
  device,
  onDevice,
  pinOn,
  pinLocked,
  onPin,
  historyOpen,
  onHistory,
  native,
  zoom,
  onZoom,
  frozenReady,
  onFrozen,
  onShowAi,
  showAiBusy,
  onShortcuts,
  addrSignal,
}: {
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  screenName: string;
  mine: ScreenRow[];
  others: ScreenRow[];
  onGo: (path: string) => void;
  /** `/` 로 시작하는 주소 — 옮겼으면 null, 거절이면 그 이유 한 줄. */
  onAddress: (raw: string) => string | null;
  device: PreviewDevice;
  onDevice: (device: PreviewDevice) => void;
  pinOn: boolean;
  /** 찍기가 잠긴 이유(준비 중) — 있으면 누름이 이유를 말한다. */
  pinLocked: string | null;
  onPin: () => void;
  historyOpen: boolean;
  onHistory: () => void;
  native: boolean;
  zoom: number;
  onZoom: (kind: "in" | "out" | "reset") => void;
  /** 제출한 때의 화면을 볼 수 있는가 — 개발자에게 가 있는 동안만. */
  frozenReady: boolean;
  onFrozen: () => void;
  onShowAi: () => void;
  showAiBusy: boolean;
  onShortcuts: () => void;
  /** ⌘L — 오를 때마다 주소 목록을 연다. */
  addrSignal: number;
}) {
  const [addrOpen, setAddrOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const addrRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (addrSignal > 0) setAddrOpen(true);
  }, [addrSignal]);

  // 게스트(webview) 안의 누름은 문서의 mousedown 에 닿지 않는다 — 게스트가 포커스를
  // 가져가는 순간을 「바깥을 눌렀다」로 본다.
  useEffect(() => {
    if (!addrOpen && !moreOpen) return;
    const onFocusIn = (event: FocusEvent) => {
      if ((event.target as HTMLElement | null)?.tagName !== "WEBVIEW") return;
      setAddrOpen(false);
      setMoreOpen(false);
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [addrOpen, moreOpen]);

  const deviceButton = (value: PreviewDevice, label: string, icon: ReactNode) => (
    <button
      type="button"
      className={device === value ? "nx-seg--on" : ""}
      title={label}
      aria-label={label}
      aria-pressed={device === value}
      onClick={() => onDevice(value)}
    >
      {icon}
    </button>
  );

  return (
    <div className="nx-pvbar">
      <button
        type="button"
        className="nx-ibtn"
        title={L.preview.back}
        aria-label={L.preview.back}
        disabled={!canBack}
        onClick={onBack}
      >
        <BackIcon />
      </button>
      <button
        type="button"
        className="nx-ibtn"
        title={L.preview.forward}
        aria-label={L.preview.forward}
        disabled={!canForward}
        onClick={onForward}
      >
        <ForwardIcon />
      </button>
      <button
        type="button"
        className="nx-ibtn"
        title={L.preview.reload}
        aria-label={L.preview.reload}
        onClick={onReload}
      >
        <ReloadIcon />
      </button>

      <div className="nx-anchor nx-addrwrap" ref={addrRef}>
        <button
          type="button"
          className="nx-addr"
          aria-label={L.preview.addrLabel}
          aria-haspopup="dialog"
          aria-expanded={addrOpen}
          data-testid="preview-address"
          onClick={() => setAddrOpen((open) => !open)}
        >
          <b>{screenName}</b>
          <AddrChevronIcon />
        </button>
        {addrOpen && (
          <Popover anchor={addrRef} onClose={() => setAddrOpen(false)} className="nx-addr-pop">
            <AddressList
              mine={mine}
              others={others}
              onGo={(path) => {
                setAddrOpen(false);
                onGo(path);
              }}
              onAddress={(raw) => {
                const why = onAddress(raw);
                if (why === null) setAddrOpen(false);
                return why;
              }}
            />
          </Popover>
        )}
      </div>

      <fieldset className="nx-seg" aria-label={L.preview.device}>
        {deviceButton("desktop", L.preview.devicePc, <PcIcon />)}
        {deviceButton("tablet", L.preview.deviceTablet, <TabletIcon />)}
        {deviceButton("mobile", L.preview.devicePhone, <PhoneIcon />)}
      </fieldset>

      <button
        type="button"
        className={`nx-tbtn nx-pin-t${pinOn ? " nx-tbtn--on" : ""}${pinLocked ? " nx-tbtn--locked" : ""}`}
        title={pinLocked ?? (pinOn ? L.preview.pinOffTip : L.preview.pinTip)}
        aria-label={L.preview.pin}
        aria-pressed={pinOn}
        aria-disabled={pinLocked !== null}
        onClick={onPin}
      >
        <PinIcon />
        <span>{L.preview.pin}</span>
      </button>
      <button
        type="button"
        className={`nx-ibtn${historyOpen ? " nx-ibtn--on" : ""}`}
        title={L.preview.history}
        aria-label={L.preview.history}
        aria-pressed={historyOpen}
        onClick={onHistory}
      >
        <ClockIcon />
      </button>

      <div className="nx-anchor" ref={moreRef}>
        <button
          type="button"
          className="nx-ibtn"
          title={L.preview.more}
          aria-label={L.preview.more}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((open) => !open)}
        >
          <MoreIcon />
        </button>
        {moreOpen && (
          <Popover
            anchor={moreRef}
            onClose={() => setMoreOpen(false)}
            align="end"
            className="nx-more-pop"
          >
            {native && (
              <>
                <div className="nx-mh">{L.preview.zoom}</div>
                <div className="nx-mseg">
                  <button
                    type="button"
                    title={L.preview.zoomOut}
                    aria-label={L.preview.zoomOut}
                    onClick={() => onZoom("out")}
                  >
                    <MinusIcon />
                  </button>
                  <button
                    type="button"
                    className="nx-mseg--on"
                    title={L.preview.zoomReset}
                    aria-label={L.preview.zoomReset}
                    onClick={() => onZoom("reset")}
                  >
                    {Math.round(zoom * 100)}%
                  </button>
                  <button
                    type="button"
                    title={L.preview.zoomIn}
                    aria-label={L.preview.zoomIn}
                    onClick={() => onZoom("in")}
                  >
                    <PlusIcon />
                  </button>
                </div>
                <div className="nx-msep" />
              </>
            )}
            {native && (
              <button
                type="button"
                className="nx-mi"
                disabled={showAiBusy}
                onClick={() => {
                  setMoreOpen(false);
                  onShowAi();
                }}
              >
                <CameraIcon />
                <span className="nx-mt">
                  <b>{showAiBusy ? L.preview.showAiBusy : L.preview.showAi}</b>
                  <small>{L.preview.showAiSub}</small>
                </span>
              </button>
            )}
            <button
              type="button"
              className={`nx-mi${frozenReady ? "" : " nx-mi--dis"}`}
              aria-disabled={!frozenReady}
              onClick={() => {
                if (!frozenReady) return;
                setMoreOpen(false);
                onFrozen();
              }}
            >
              <EyeIcon />
              <span className="nx-mt">
                <b>{L.preview.frozenOpen}</b>
                <small>{frozenReady ? L.preview.frozenOpenSub : L.preview.frozenLocked}</small>
              </span>
            </button>
            <div className="nx-msep" />
            <button
              type="button"
              className="nx-mi"
              onClick={() => {
                setMoreOpen(false);
                onShortcuts();
              }}
            >
              <KeyboardIcon />
              {L.preview.shortcuts}
            </button>
          </Popover>
        )}
      </div>
    </div>
  );
}

/**
 * 주소 목록 — `이 대화에서 만든 화면` 과 `다른 화면`. 글자를 치면 이름(과
 * 주소)으로 거르고, `/` 로 시작하면 Enter 가 그 주소로 간다. 화살표로 고른다.
 */
function AddressList({
  mine,
  others,
  onGo,
  onAddress,
}: {
  mine: ScreenRow[];
  others: ScreenRow[];
  onGo: (path: string) => void;
  onAddress: (raw: string) => string | null;
}) {
  const [query, setQuery] = useState("");
  const [pick, setPick] = useState(0);
  const [why, setWhy] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const typedPath = q.startsWith("/");
  const match = (row: ScreenRow) =>
    q === "" || row.name.toLowerCase().includes(q) || row.path.toLowerCase().includes(q);
  const mineShown = mine.filter(match);
  const othersShown = others.filter(match);
  const flat = [...mineShown, ...othersShown];

  const row = (entry: ScreenRow, index: number) => (
    <button
      type="button"
      key={`${entry.path}-${index}`}
      className={`nx-mi${index === pick && !typedPath ? " nx-mi--pick" : ""}`}
      onMouseEnter={() => setPick(index)}
      onClick={() => onGo(entry.path)}
    >
      <EyeIcon />
      <b>{entry.name}</b>
      <span className="nx-mi-r">{entry.path}</span>
    </button>
  );

  return (
    <>
      <input
        className="nx-addr-in"
        placeholder={L.preview.addrPlaceholder}
        aria-label={L.preview.addrPlaceholder}
        autoComplete="off"
        spellCheck={false}
        // biome-ignore lint/a11y/noAutofocus: 목록을 연 손은 곧 글자를 친다.
        autoFocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setPick(0);
          setWhy(null);
        }}
        onKeyDown={(event) => {
          if (composing(event)) return;
          if (event.key === "ArrowDown" && flat.length > 0) {
            event.preventDefault();
            setPick((index) => (index + 1) % flat.length);
          } else if (event.key === "ArrowUp" && flat.length > 0) {
            event.preventDefault();
            setPick((index) => (index <= 0 ? flat.length - 1 : index - 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (typedPath) {
              setWhy(onAddress(query));
              return;
            }
            const picked = flat[pick] ?? flat[0];
            if (picked) onGo(picked.path);
          }
        }}
      />
      {why && (
        <div className="nx-addr-why" role="status">
          {why}
        </div>
      )}
      <div className="nx-addr-list">
        {mineShown.length > 0 && <div className="nx-mh">{L.preview.addrMine}</div>}
        {mineShown.map((entry, index) => row(entry, index))}
        {othersShown.length > 0 && <div className="nx-mh">{L.preview.addrOthers}</div>}
        {othersShown.map((entry, index) => row(entry, mineShown.length + index))}
        {flat.length === 0 && !typedPath && (
          <div className="nx-addr-none">{L.preview.addrEmpty}</div>
        )}
      </div>
      <div className="nx-addr-foot">{L.preview.addrFoot}</div>
    </>
  );
}
