import type { ColoDesignPinEnvelope, ColoDesignPinsSync } from "@colo-design/protocol";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { PreviewFrame } from "../../components/preview/PreviewFrame";
import type { PreviewLocation, PreviewTarget } from "../../components/preview/PreviewHost";
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
      <div className="nx-pvdevice" ref={stageRef}>
        {native ? (
          <PreviewFrame
            url={url}
            epoch={epoch}
            target={target}
            reloadKey={reloadKey}
            width={device}
            commentsOn={commentsOn}
            onLocation={onLocation}
            sync={sync}
            onPin={onPin}
            onPinFocus={onPinFocus}
            onError={onError}
            onLoading={setLoading}
            onZoom={onZoom}
          />
        ) : frameSrc ? (
          <iframe
            key={`${reloadKey}|${frameNonce}`}
            className="nx-pvframe"
            title={L.preview.frameTitle}
            src={frameSrc}
            onLoad={() => setLoading(false)}
          />
        ) : null}
      </div>
      {loadPhase !== "ok" && (
        <span className="nx-pvlate" role="status">
          {L.preview.lateLoad}
        </span>
      )}
      {children}
    </div>
  );
}
