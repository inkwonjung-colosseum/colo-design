import type { ColoDesignNavigateEnvelope } from "@colo-design/protocol";
import { useEffect, useRef, useState } from "react";
import type { PreviewTarget } from "./PreviewHost";

/**
 * 브라우저 개발 경로의 미리보기: the repo's dev server framed
 * as-is, speaking the repo bridge contract only — `colo-design.navigate`
 * out. Comments, the address bar and the error banner are the native
 * view's and are simply absent here; a plain browser is the developer's
 * path, and it is not told what it lacks.
 *
 * NAVIGATION IS A PROP, NOT A HANDLE — `target` comes down because nothing in
 * this package exposes an imperative handle (PreviewHost's rule). The re-send
 * below keeps a navigate posted at a booting page from looking broken: the
 * planner picks a screen while the repo is still starting, and every load
 * re-delivers the last ask.
 */
export function IframeHost({
  url,
  target,
  reloadKey,
  /** 로드의 시작과 끝을 프레임 머리에 알린다 — 스핀과 진행 바의 iframe 절반. */
  onLoading,
}: {
  url: string;
  /** The last screen asked for; free paths cannot be followed here. */
  target: PreviewTarget | null;
  /** Bumped by 새로 고침 — remounts the iframe for a clean reload. */
  reloadKey: number;
  onLoading?: (busy: boolean) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  /** 스킵 링크의 착지점 — iframe 바로 뒤의 빈 자리. 포커스가 여기 오면
      다음 Tab 은 미리보기 앱이 아니라 도구의 나머지로 이어진다. */
  const afterFrame = useRef<HTMLSpanElement>(null);
  const [loads, setLoads] = useState(0);
  /** 로드가 끝나 페이드인 — 리마운트(새로 고침)마다 다시 0. */
  const [loaded, setLoaded] = useState(false);

  // A remount is a fresh load — and so is a bumped key (새로 고침): the
  // chrome's spin and sweep run until the frame reports back; the cleanup
  // covers a mid-load remount.
  useEffect(() => {
    setLoaded(false);
    onLoading?.(true);
    return () => onLoading?.(false);
  }, [onLoading, reloadKey]);


  const screen = target?.kind === "screen" ? target : null;

  useEffect(() => {
    if (!url || !screen || loads === 0) return;
    const contentWindow = frame.current?.contentWindow;
    if (!contentWindow) return;
    const envelope: ColoDesignNavigateEnvelope = {
      type: "colo-design.navigate",
      route: screen.route,
      state: screen.state,
    };
    // Addressed to the preview's own origin, never "*".
    contentWindow.postMessage(envelope, new URL(url).origin);
  }, [url, screen, loads]);

  return (
    <>
      {/* 키보드 탈출구: Tab 이 미리보기 안으로 빠지면 그 앱의
          모든 링크를 지나야 도구로 돌아온다. iframe 바로 앞의 이 버튼이
          지름길 — 포커스될 때만 보인다(스킵 링크 규칙). */}
      <button type="button" className="skippreview" onClick={() => afterFrame.current?.focus()}>
        미리보기 건너뛰기
      </button>
      <iframe
        key={reloadKey}
        className={loaded ? "preview__frame preview__frame--in" : "preview__frame"}
        title="미리보기"
        ref={frame}
        src={url}
        onLoad={() => {
          // 로드가 끝났다 — 머리의 스핀과 진행 바를 거둔다.
          onLoading?.(false);
          setLoaded(true);
          setLoads((count) => count + 1);
        }}
      />
      <span ref={afterFrame} tabIndex={-1} className="skippreview__after" />
    </>
  );
}
