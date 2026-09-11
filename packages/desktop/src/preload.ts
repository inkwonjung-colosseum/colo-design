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

contextBridge.exposeInMainWorld("cdsDesignDesktop", {
  updateCheck: () => ipcRenderer.invoke("desktop:update-check"),
  macSelfUpdate: (input: { url: string; sha256: string }) =>
    ipcRenderer.invoke("desktop:mac-self-update", input),
  openHome: () => ipcRenderer.invoke("desktop:open-home"),
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
    commentsMode: (on: boolean) => ipcRenderer.invoke("preview:comments-mode", { on }),
    emulate: (width: "mobile" | "tablet" | null) => ipcRenderer.invoke("preview:emulate", { width }),
    /**
     * Claude 시점 보기 (PLAN D63): Claude 가 보는 화면의 프레임 — 8fps 로
     * 스로틀된 JPEG(base64). 구독만 있고 해제는 없다; 프레임은 미리보기
     * 세션이 살아 있는 동안만 흐른다. 렌더러→메인은 따로 없다.
     */
    onFrame: (callback: (frame: string) => void) => {
      ipcRenderer.on("cds-preview:frame", (_event, frame: string) => callback(frame));
    },
    onLocation: subscribe<{ path: string; canGoBack: boolean; canGoForward: boolean }>("cds-preview:location"),
    onBridge: subscribe<{ state: "unknown" | "present" | "stale" }>("cds-preview:bridge"),
    onScreens: subscribe<{ screens: unknown[] }>("cds-preview:screens"),
    onComments: subscribe<unknown>("cds-preview:comments"),
    onError: subscribe<{ kind: string; message: string; route: string; state: string }>("cds-preview:error"),
    onFreeze: subscribe<string>("cds-preview:freeze"),
    onKey: subscribe<{ key: string; meta: boolean }>("cds-preview:key"),
    onLoading: subscribe<{ on: boolean }>("cds-preview:loading"),
  },
});
