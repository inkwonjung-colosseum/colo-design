import { contextBridge, ipcRenderer } from "electron";

/**
 * 렌더러에 노출되는 데스크톱 다리: 수동 업데이트 확인(DESIGN §7)과 `폴더
 * 열기`(PLAN D2[폴더 열기]). 자격 증명·페어링 토큰은 절대 건너가지 않는다 — 렌더러는
 * 존재만 안다.
 */
contextBridge.exposeInMainWorld("cdsDesignDesktop", {
  updateCheck: () => ipcRenderer.invoke("desktop:update-check"),
  macSelfUpdate: (input: { url: string; sha256: string }) =>
    ipcRenderer.invoke("desktop:mac-self-update", input),
  openHome: () => ipcRenderer.invoke("desktop:open-home"),
  /**
   * Claude 시점 보기 (PLAN D63): Claude 가 보는 화면의 프레임 — 8fps 로
   * 스로틀된 JPEG(base64). 구독만 있고 해제는 없다; 프레임은 미리보기
   * 세션이 살아 있는 동안만 흐른다. 렌더러→메인은 따로 없다.
   */
  preview: {
    onFrame: (callback: (frame: string) => void) => {
      ipcRenderer.on("cds-preview:frame", (_event, frame: string) => callback(frame));
    },
  },
});
