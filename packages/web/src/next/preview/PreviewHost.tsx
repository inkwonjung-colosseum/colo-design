import type { ColoDesignPinEnvelope, ColoDesignPinsSync } from "@colo-design/protocol";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { PreviewFrame, type PreviewOverlaySkin } from "../../components/preview/PreviewFrame";
import type { PreviewLocation, PreviewTarget } from "../../components/preview/types";
import { L } from "../labels";

/** 기기 — PC 는 칸 전체, 태블릿 · 휴대폰은 게스트에 실제 에뮬레이션이 걸린다. */
export type PreviewDevice = "desktop" | "tablet" | "mobile";

/** 게스트가 보고한 오류, 또는 이 무대의 「30초 넘게 안 뜬다」. */
export interface StageError {
  kind: "runtime" | "build";
  message: string;
  route: string;
  stalled?: true;
}

/** 데스크톱의 `<webview>` 무대인가 — 브라우저 개발 경로는 iframe 이다. */
export function nativePreview(): boolean {
  return Boolean(window.coloDesignDesktop?.preview?.native);
}

/**
 * 미리보기 무대(단계 3) — 옛 `PreviewHost` 에서 무대만 옮겨 왔다: 데스크톱은
 * `PreviewFrame`(게스트 요소 · 위치 · 핀 · 오류 · 배율 · 에뮬레이션의 선로),
 * 브라우저는 iframe. 막대 · 덮개 · 말풍선은 칸(`PreviewColumn`)의 것이다.
 *
 * 이 요소는 언제나 그려진다 — 게스트는 요소가 철거되는 순간 죽고, 그러면
 * `돌아오면 보던 자리 그대로` 가 무너진다. 준비 화면 · 다시 켜는 중 · 고치는 중은
 * 이 위의 불투명 덮개다(`children`).
 *
 * 느린 로딩: 10초에 한 줄(`화면이 늦게 뜨고 있어요`), 30초에 도구가 한 번 새로
 * 고치고, 그래도 멈추면 판정으로 넘긴다(`stalled`) — 사람에게 올리는 카드는 없다.
 */
export function PreviewHost({
  url,
  epoch,
  target,
  reloadKey,
  device,
  commentsOn,
  overlaySkin,
  sweep,
  sync,
  location,
  onPin,
  onPinFocus,
  onLocation,
  onZoom,
  onError,
  onSelfReload,
  stageRef,
  children,
}: {
  url: string | null;
  epoch: number | null;
  target: PreviewTarget | null;
  /** 새로 고침마다 오른다 — 게스트는 main 이 다시 읽고, iframe 은 새로 선다. */
  reloadKey: number;
  device: PreviewDevice;
  commentsOn: boolean;
  /** 오버레이가 입는 말과 색 — 게스트 preload 는 웹의 문장을 못 읽어 선로로 건넨다. */
  overlaySkin: PreviewOverlaySkin;
  /** 답이 끝나 화면이 옮겨 간 순간의 신호 — 오를 때마다 빛줄기가 한 번 훑는다. */
  sweep: number;
  sync: ColoDesignPinsSync;
  location: PreviewLocation | null;
  onPin: (pin: ColoDesignPinEnvelope["pin"]) => void;
  onPinFocus: (id: string) => void;
  onLocation: (location: PreviewLocation | null) => void;
  onZoom: (factor: number) => void;
  onError: (error: StageError) => void;
  /** 30초의 멈춤 — 도구가 먼저 한 번 새로 고친다. */
  onSelfReload: () => void;
  /** 기기 틀 — 말풍선이 게스트의 화면 위치를 읽는 자리. */
  stageRef: RefObject<HTMLDivElement | null>;
  children?: ReactNode;
}) {
  const native = nativePreview();
  const [loading, setLoading] = useState(false);
  const [loadPhase, setLoadPhase] = useState<"ok" | "late" | "stuck">("ok");

  // 데스크톱의 로딩 신호 — PreviewFrame 은 이 선로를 구독하지 않으므로 여기서 한 번.
  useEffect(() => {
    const bridge = window.coloDesignDesktop?.preview;
    return bridge?.onLoading?.((payload) => setLoading(payload.on));
  }, []);

  // 브라우저 경로의 iframe: 물음(target)이 곧 주소다. 새 물음 · 새로 고침은 로딩이다.
  const frameSrc = (() => {
    if (!url) return null;
    if (!target) return url;
    try {
      return new URL(target.path, url).toString();
    } catch {
      return url;
    }
  })();
  // biome-ignore lint/correctness/useExhaustiveDependencies: 새 주소 · 새로 고침의 순간만 본다.
  useEffect(() => {
    if (!native && frameSrc) setLoading(true);
  }, [native, frameSrc, reloadKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 새로 고침(reloadKey)마다 느린 로딩의 시계를 처음부터 다시 잰다.
  useEffect(() => {
    setLoadPhase("ok");
    if (!loading) return;
    const late = window.setTimeout(() => setLoadPhase("late"), 10_000);
    const stuck = window.setTimeout(() => setLoadPhase("stuck"), 30_000);
    return () => {
      window.clearTimeout(late);
      window.clearTimeout(stuck);
    };
  }, [loading, reloadKey]);
  // 잠깐의 이동은 조용히 — 150ms 를 넘기면 무대 가장자리에 흐르는 선이
  // 답한다(눈 깜짝할 새의 새로 고침에 표시가 뜨는 소음은 없앤다).
  const [busy, setBusy] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 새 주소 · 새로 고침마다 허용 시간의 시계를 다시 잰다.
  useEffect(() => {
    if (!loading) {
      setBusy(false);
      return;
    }
    const show = window.setTimeout(() => setBusy(true), 150);
    return () => window.clearTimeout(show);
  }, [loading, frameSrc, reloadKey]);

  // 기기 틀이 바뀌는 동안 내용을 잠깐 흐리게 — 에뮬레이션이 닿았다는
  // 신호가 선로에 없으니 시간(틀의 전환과 같은 결)로 되돌린다.
  const [swap, setSwap] = useState(false);
  const lastDevice = useRef(device);
  useEffect(() => {
    if (lastDevice.current === device) return;
    lastDevice.current = device;
    setSwap(true);
    const back = window.setTimeout(() => setSwap(false), 320);
    return () => window.clearTimeout(back);
  }, [device]);

  // 30초의 멈춤: 서버 · 화면마다 도구가 먼저 한 번 새로 고치고, 그다음은 판정.
  const stuckReloads = useRef(new Set<string>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: 멈춤에 들어서는 순간만 본다.
  useEffect(() => {
    if (loadPhase !== "stuck") return;
    const path = location?.path ?? target?.path ?? "/";
    const key = `${url ?? ""}|${epoch ?? ""}|${path}`;
    if (!stuckReloads.current.has(key)) {
      stuckReloads.current.add(key);
      onSelfReload();
      return;
    }
    onError({
      kind: "runtime",
      message: L.preview.stalledReport,
      // 웹뷰의 오류 보고와 같은 철자 — 앞 슬래시도 쿼리도 없는 경로.
      route: path.replace(/[?#].*$/, "").replace(/^\//, ""),
      stalled: true,
    });
  }, [loadPhase]);

  // 서버가 돌아오면(새 에포크) iframe 은 한 번 깨끗하게 다시 읽는다 — 브라우저의
  // 오류 페이지를 쥐고 있으면 앱 전체를 새로 고치지 않고는 빠져나올 길이 없었다.
  const [frameNonce, setFrameNonce] = useState(0);
  const lastEpoch = useRef(epoch);
  useEffect(() => {
    if (!native && lastEpoch.current !== epoch) setFrameNonce((n) => n + 1);
    lastEpoch.current = epoch;
  }, [native, epoch]);

  return (
    <div className="nx-pvstage" data-device={device}>
      <div className={`nx-pvdevice${swap ? " nx-pvdevice--swap" : ""}`} ref={stageRef}>
        {native ? (
          <PreviewFrame
            url={url}
            epoch={epoch}
            target={target}
            reloadKey={reloadKey}
            width={device}
            commentsOn={commentsOn}
            overlaySkin={overlaySkin}
            onLocation={onLocation}
            sync={sync}
            onPin={onPin}
            onPinFocus={onPinFocus}
            onError={onError}
            onLoading={setLoading}
            onZoom={onZoom}
          />
        ) : frameSrc ? (
          // biome-ignore lint/a11y/noNoninteractiveElementInteractions: onLoad 는 사람의 조작이 아니라 문서가 다 읽혔다는 신호다.
          <iframe
            key={`${reloadKey}|${frameNonce}`}
            className="nx-pvframe"
            title={L.preview.frameTitle}
            src={frameSrc}
            onLoad={() => setLoading(false)}
          />
        ) : null}
      </div>
      {/* 찍기가 켜진 동안 무대 둘레에 서는 안쪽 고리 — 화면을 가리지 않는 옅은 물들임. */}
      {commentsOn && <div className="nx-pvring" aria-hidden="true" />}
      {busy && <i className="nx-pvbusy" aria-hidden="true" />}
      {/* 답이 끝나 도착한 화면 위로 빛줄기가 한 번 지난다 — 신호마다 다시. */}
      {sweep > 0 && <div className="nx-pvsweep" key={sweep} aria-hidden="true" />}
      {loadPhase !== "ok" && (
        <span className="nx-pvlate" role="status">
          {L.preview.lateLoad}
        </span>
      )}
      {children}
    </div>
  );
}
