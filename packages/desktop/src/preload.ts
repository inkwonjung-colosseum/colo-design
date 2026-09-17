import type {
  ColoDesignPinEnvelope,
  ColoDesignPinsSync,
  PreviewTabMeta,
} from "@colo-design/protocol";
import { contextBridge, ipcRenderer } from "electron";

/**
 * 렌더러에 노출되는 데스크톱 다리: 수동 업데이트 확인(DESIGN §7)과 `폴더
 * 열기`(PLAN D2[폴더 열기]). 자격 증명·페어링 토큰은 절대 건너가지 않는다 — 렌더러는
 * 존재만 안다.
 *
 * `preview` 는 사용자의 미리보기 뷰(PLAN D64–D71): `native` 가 있으면 웹은
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
  /** 설치 문단은 플랫폼을 안다 — mac·win 은 설치 단추, 나머지는 릴리스 페이지로. */
  platform: process.platform,
  updateCheck: () => ipcRenderer.invoke("desktop:update-check"),
  selfUpdate: () => ipcRenderer.invoke("desktop:self-update"),
  openHome: (target?: "logs") => ipcRenderer.invoke("desktop:open-home", target),
  /** 알림 정책(시점·소리)을 메인에 반영한다 — 창이 닫혀도 정책이 살아 있게. */
  setNotificationPrefs: (prefs: { done: string; sound: boolean }) =>
    ipcRenderer.invoke("desktop:notify-prefs", prefs),
  /**
   * 메인이 영속한 알림 정책을 읽는다 — 새 origin 으로 뜬 렌더러의 기본값이
   * 디스크의 저장값을 덮지 않게 부팅 때 한 번 묻는다.
   */
  getNotificationPrefs: () => ipcRenderer.invoke("desktop:notify-prefs:get"),
  /** 설정의 `테스트 알림 보내기` — OS 가 받았는지(shown)까지 돌려준다. */
  notifyTest: () => ipcRenderer.invoke("desktop:notify-test"),
  /** 설정의 `시스템 알림 설정 열기` — OS 의 알림 허용 스위치로 데려간다. */
  openNotificationSettings: () => ipcRenderer.invoke("desktop:open-notification-settings"),
  /** 알림 클릭 → 그 대화 열기(리뷰 B7): 메인이 세션 아이디를 건넨다. */
  onOpenSession: subscribe<string>("colodesign:open-session"),
  /** 커미티 B1 (2026-09-15): 알림 클릭 → 그 프로젝트로 — slug 가 건너온다. */
  onOpenProject: subscribe<string>("colodesign:open-project"),
  preview: {
    native: true as const,
    mount: (url: string, epoch: number | null, origins?: string[]) =>
      ipcRenderer.invoke("preview:mount", { url, epoch, origins }),
    /** Takes the page off screen — it stays alive for the planner's return. */
    unmount: () => ipcRenderer.invoke("preview:unmount"),
    bounds: (rect: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke("preview:bounds", rect),
    cover: (on: boolean) => ipcRenderer.invoke("preview:cover", { on }),
    open: (path: string) => ipcRenderer.invoke("preview:open", { path }),
    /** 설정 `앱에서 링크 열기` — a clicked link browses in the pane, or the
        OS browser when no slot is on screen. */
    openExternal: (url: string) => ipcRenderer.invoke("preview:open-external", { url }),
    navigate: (route: string, state: string | null) =>
      ipcRenderer.invoke("preview:navigate", { route, state }),
    /**
     * 탭 스트립 (인앱 브라우저 1단계): the view owns the tab list — the web
     * only asks. `tabClose`·`tabNew` 생략 인자는 활성 탭·빈 탭을 뜻한다.
     */
    tabs: () =>
      ipcRenderer.invoke("preview:tabs") as Promise<{
        tabs: PreviewTabMeta[];
        activeTabId: string | null;
      }>,
    tabActivate: (tabId: string) => ipcRenderer.invoke("preview:tab-activate", { tabId }),
    tabClose: (tabId?: string) => ipcRenderer.invoke("preview:tab-close", { tabId }),
    tabNew: (url?: string) => ipcRenderer.invoke("preview:tab-new", { url }),
    history: (delta: -1 | 1) => ipcRenderer.invoke("preview:history", { delta }),
    reload: () => ipcRenderer.invoke("preview:reload"),
    /** 로딩 중 새로 고침 버튼의 두 번째 클릭 — 중단 (PLAN D85 ⓐ). */
    stop: () => ipcRenderer.invoke("preview:stop"),
    /** 배율 (PLAN D85 ⓔ) — in/out/reset; 뷰가 colo-preview:zoom 으로 되알린다. */
    zoom: (kind: "in" | "out" | "reset") => ipcRenderer.invoke("preview:zoom", { kind }),
    commentsMode: (on: boolean) => ipcRenderer.invoke("preview:comments-mode", { on }),
    emulate: (width: "mobile" | "tablet" | null) =>
      ipcRenderer.invoke("preview:emulate", { width }),
    /** 핀 동기화 (재설계 C1): the web's whole pin list — the overlay redraws its badges from it. */
    pins: (sync: ColoDesignPinsSync) => ipcRenderer.invoke("preview:pins", sync),
    /** 칩 클릭 (재설계 C1) — the matching badge on the page flashes. */
    pinFlash: (id: string) => ipcRenderer.invoke("preview:pin-flash", { id }),
    /** 화면 보여 주기 (PLAN D89): the whole frame plus the recent console. */
    snapshot: () => ipcRenderer.invoke("preview:snapshot"),
    onLocation: subscribe<{
      path: string;
      /** The full address — web 탭은 주소창에 통째로 보여 준다. */
      url?: string;
      /** 어느 탭의 보고인지 — 늦게 도착한 비활성 탭의 보고를 걸러 낸다. */
      tabId: string;
      kind: "preview" | "web";
      canGoBack: boolean;
      canGoForward: boolean;
    }>("colo-preview:location"),
    /** 탭 목록이 바뀔 때마다 통째로 — 스트립은 이 한 채널로 그린다. */
    onTabs: subscribe<{ tabs: PreviewTabMeta[]; activeTabId: string | null }>("colo-preview:tabs"),
    onScreens: subscribe<{ screens: unknown[] }>("colo-preview:screens"),
    onPin: subscribe<ColoDesignPinEnvelope>("colo-preview:pin"),
    onPinFocus: subscribe<{ id: string }>("colo-preview:pin-focus"),
    onError: subscribe<{
      kind: string;
      message: string;
      route: string;
      state: string;
    }>("colo-preview:error"),
    onFreeze: subscribe<string>("colo-preview:freeze"),
    onKey: subscribe<{ key: string; meta: boolean; shift: boolean }>("colo-preview:key"),
    onLoading: subscribe<{ on: boolean }>("colo-preview:loading"),
    /** 배율 되알림 (PLAN D85 ⓔ) — the menu changed it, the web redraws. */
    onZoom: subscribe<{ factor: number }>("colo-preview:zoom"),
  },
});
