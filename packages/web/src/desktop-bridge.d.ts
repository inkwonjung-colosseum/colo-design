import type {
  ColoDesignPinEnvelope,
  ColoDesignPinsSync,
  UpdateCheckResult,
} from "@colo-design/protocol";

/**
 * The desktop app's preload bridge (packages/desktop/src/preload.ts) — the
 * one surface the renderer reaches the main process through. Absent in a
 * plain browser; every access guards on it.
 *
 * `preview` grows with the native preview view: `native` is
 * how PreviewHost picks NativeHost over the iframe, and the rest are
 * the IPC channels — commands down, subscriptions up (each returns its
 * unsubscribe).
 */
type Unsubscribe = () => void;

declare global {
  interface Window {
    coloDesignDesktop?: {
      /** The OS the app runs on — mac and win replace themselves; anything
       * else goes to the releases page. */
      platform: string;
      /** `url`/`sha256` arrive already resolved for this platform (main picks
       * the mac zip or the Windows installer), so the renderer stays blind. */
      updateCheck: () => Promise<UpdateCheckResult>;
      /** The feed — not the renderer — decides what gets downloaded; the
       * request takes no arguments by design (a compromised renderer must not
       * be able to point the updater at its own zip). */
      selfUpdate: () => Promise<
        | { planned: unknown; guarded: string } // 개발 실행 — 계획만
        | { deferred: true; version: string } // 세션이 돌고 있어 모두 끝나는 순간으로 연기
        | { prepared: true; version: string } // 내려받기·검증 끝 — 재시작 동의를 기다림
        | { started: boolean; downloadPath: string; steps: string[] } // 재시작 동의됨, 곧 종료
        | { error: string }
      >;
      /** Opens ~/.colo-design in the OS file manager; `logs` opens
       * the daemon's daily logs instead. */
      openHome?: (target?: "logs") => Promise<unknown>;
      /** 알림 정책(시점·소리)을 메인에 반영 — 창이 닫혀도 정책이 살게. */
      setNotificationPrefs?: (prefs: { done: string; sound: boolean }) => Promise<unknown>;
      /** 메인이 영속한 알림 정책 — 부팅 때 읽어 렌더러 설정에 맞춘다. */
      getNotificationPrefs?: () => Promise<{ done: string; sound: boolean }>;
      /**
       * 설정의 `테스트 알림 보내기`. `shown` 은 **OS 가 이 알림을 그렸는가** —
       * 서명이 없는 실행(개발 실행)에서는 `false` 와 함께 이유가 온다. 사용자가
       * OS 에서 알림을 꺼 둔 경우는 여기 잡히지 않는다(`shown: true` 인데 배너가
       * 없다) — 그 길은 `openNotificationSettings` 뿐이다.
       */
      notifyTest?: () => Promise<{ shown: boolean; error?: string }>;
      /** 설정의 `시스템 알림 설정 열기` — OS 의 알림 허용 스위치로 데려간다. */
      openNotificationSettings?: () => Promise<{ opened?: string; error?: string }>;
      /** 알림 클릭 → 그 대화 열기: the session id to open. */
      onOpenSession?: (callback: (sessionId: string) => void) => Unsubscribe;
      /** 알림 클릭 → 그 프로젝트로 — slug 를 건넨다. */
      onOpenProject?: (callback: (slug: string) => void) => Unsubscribe;
      preview?: {
        /** The native view exists — NativeHost, not the iframe. */
        native?: boolean;
        /**
         * Puts the page for this preview on screen; `epoch` names the server
         * process behind it (RepoStatus.previewEpoch). A page kept from an
         * earlier visit comes back as it was — under a new epoch it reloads.
         */
        mount?: (url: string, epoch: number | null) => Promise<unknown>;
        /** Takes the page off screen; it stays alive for the return. */
        unmount?: () => Promise<unknown>;
        bounds?: (rect: {
          x: number;
          y: number;
          width: number;
          height: number;
        }) => Promise<unknown>;
        cover?: (on: boolean) => Promise<unknown>;
        open?: (path: string) => Promise<unknown>;
        /**
         * 설정 `앱에서 링크 열기`: a clicked link browses in the pane — any
         * http(s) origin, no repo overlay — or the OS browser when no slot
         * is on screen.
         */
        openExternal?: (url: string) => Promise<unknown>;
        navigate?: (route: string, state: string | null) => Promise<unknown>;
        history?: (delta: -1 | 1) => Promise<unknown>;
        reload?: () => Promise<unknown>;
        /** 로딩 중 새로 고침 버튼의 두 번째 클릭 — 중단. */
        stop?: () => Promise<unknown>;
        /** 배율. */
        zoom?: (kind: "in" | "out" | "reset") => Promise<unknown>;
        commentsMode?: (on: boolean) => Promise<unknown>;
        emulate?: (width: "mobile" | "tablet" | null) => Promise<unknown>;
        /** 핀 동기화: the web's whole pin list — the overlay's badges are its projection. */
        pins?: (sync: ColoDesignPinsSync) => Promise<unknown>;
        /** 칩 클릭: the matching badge on the page flashes. */
        pinFlash?: (id: string) => Promise<unknown>;
        /** 화면 보여 주기: the frame plus the recent console lines. */
        snapshot?: () => Promise<{ jpeg: string | null; console: string[] }>;
        onLocation?: (
          callback: (payload: {
            /** The preview-relative path of the loaded page. */
            path: string;
            /** The full address — 외부 페이지는 주소창에 통째로 보여 준다. */
            url?: string;
            /** repo origin 위면 preview, 링크의 나라면 web — 외부 페이지 표시의 자리. */
            kind: "preview" | "web";
            canGoBack: boolean;
            canGoForward: boolean;
          }) => void,
        ) => Unsubscribe;
        onPin?: (callback: (payload: ColoDesignPinEnvelope) => void) => Unsubscribe;
        onPinFocus?: (callback: (payload: { id: string }) => void) => Unsubscribe;
        onError?: (
          callback: (payload: {
            kind: "runtime" | "build";
            message: string;
            route: string;
            state: string;
          }) => void,
        ) => Unsubscribe;
        onFreeze?: (callback: (jpeg: string) => void) => Unsubscribe;
        onKey?: (
          callback: (payload: { key: string; meta: boolean; shift: boolean }) => void,
        ) => Unsubscribe;
        onLoading?: (callback: (payload: { on: boolean }) => void) => Unsubscribe;
        /** 배율 되알림 — the menu changed it, the web redraws. */
        onZoom?: (callback: (payload: { factor: number }) => void) => Unsubscribe;
      };
    };
  }
}
