import { contextBridge, ipcRenderer } from "electron";

/**
 * 렌더러에 노출되는 데스크톱 다리: 수동 업데이트 확인(DESIGN §7)과 `폴더
 * 열기`(PLAN D2[폴더 열기]). 자격 증명·페어링 토큰은 절대 건너가지 않는다 — 렌더러는
 * 존재만 안다.
 *
 * `preview` 는 기획자의 미리보기 뷰(PLAN D64–D71): `native` 가 있으면 웹은
 * `NativeHost` 를 고르고, 없는 브라우저는 iframe 을 유지한다(D70). 구독은 모두
 * 해제 함수를 돌려준다 — 호스트가 언마운트된다.
 */
type Unsubscribe = () => void;

function subscribe<T>(channel: string): (callback: (payload: T) => void) => Unsubscribe {
  return (callback: (payload: T) => void) => {
    const listener = (_event: unknown, payload: T) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("coloDesignDesktop", {
  /** 설치 문단은 플랫폼을 안다 — mac 만 설치 단추, win 은 릴리스 페이지로. */
  platform: process.platform,
  updateCheck: () => ipcRenderer.invoke("desktop:update-check"),
  macSelfUpdate: () => ipcRenderer.invoke("desktop:mac-self-update"),
  openHome: () => ipcRenderer.invoke("desktop:open-home"),
  /** 알림 클릭 → 그 대화 열기(리뷰 B7): 메인이 세션 아이디를 건넨다. */
  onOpenSession: subscribe<string>("colodesign:open-session"),
  preview: {
    native: true as const,
    mount: (url: string) => ipcRenderer.invoke("preview:mount", { url }),
    unmount: () => ipcRenderer.invoke("preview:unmount"),
    bounds: (rect: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke("preview:bounds", rect),
    cover: (on: boolean) => ipcRenderer.invoke("preview:cover", { on }),
    open: (path: string) => ipcRenderer.invoke("preview:open", { path }),
    navigate: (route: string, state: string | null) =>
      ipcRenderer.invoke("preview:navigate", { route, state }),
    history: (delta: -1 | 1) => ipcRenderer.invoke("preview:history", { delta }),
    reload: () => ipcRenderer.invoke("preview:reload"),
    /** 로딩 중 새로 고침 버튼의 두 번째 클릭 — 중단 (PLAN D85 ⓐ). */
    stop: () => ipcRenderer.invoke("preview:stop"),
    /** 배율 (PLAN D85 ⓔ) — in/out/reset; 뷰가 colo-preview:zoom 으로 되알린다. */
    zoom: (kind: "in" | "out" | "reset") => ipcRenderer.invoke("preview:zoom", { kind }),
    commentsMode: (on: boolean) => ipcRenderer.invoke("preview:comments-mode", { on }),
    emulate: (width: "mobile" | "tablet" | null) =>
      ipcRenderer.invoke("preview:emulate", { width }),
    /**
     * 기록된 핀 (PLAN D78): the web pushes the project's whole comment list
     * down into the view; the view re-tells it on every load.
     */
    pins: (payload: unknown) => ipcRenderer.invoke("preview:pins", payload),
    /** 턴 실행 중 표식 (PLAN D86) — the overlay's send-toast reads it. */
    busy: (on: boolean) => ipcRenderer.invoke("preview:busy", { on }),
    /** 화면 보여 주기 (PLAN D89): the whole frame plus the recent console. */
    snapshot: () => ipcRenderer.invoke("preview:snapshot"),
    /**
     * Claude 시점 보기 (PLAN D63): Claude 가 보는 화면의 프레임 — 8fps 로
     * 스로틀된 JPEG(base64). 구독만 있고 해제는 없다; 프레임은 미리보기
     * 세션이 살아 있는 동안만 흐른다. 렌더러→메인은 따로 없다.
     */
    onFrame: (callback: (frame: string) => void) => {
      ipcRenderer.on("colo-preview:frame", (_event, frame: string) => callback(frame));
    },
    onLocation: subscribe<{
      path: string;
      canGoBack: boolean;
      canGoForward: boolean;
    }>("colo-preview:location"),
    onScreens: subscribe<{ screens: unknown[] }>("colo-preview:screens"),
    onComments: subscribe<unknown>("colo-preview:comments"),
    onError: subscribe<{
      kind: string;
      message: string;
      route: string;
      state: string;
    }>("colo-preview:error"),
    onFreeze: subscribe<string>("colo-preview:freeze"),
    onKey: subscribe<{ key: string; meta: boolean }>("colo-preview:key"),
    onLoading: subscribe<{ on: boolean }>("colo-preview:loading"),
    /** 배율 되알림 (PLAN D85 ⓔ) — the menu changed it, the web redraws. */
    onZoom: subscribe<{ factor: number }>("colo-preview:zoom"),
    onCommentResolve: subscribe<{ id: string; resolved: boolean }>("colo-preview:comment-resolve"),
    onCommentResend: subscribe<{ id: string }>("colo-preview:comment-resend"),
  },
});
