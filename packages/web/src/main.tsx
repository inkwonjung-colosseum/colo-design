import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppCrashBoundary, DevCrashProbe } from "./AppCrashBoundary";
import { crashStore, installGlobalHandlers } from "./lib/crash";
import { applyStoredTheme, applyStoredTypeScale } from "./lib/settings";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./styles.css";

// 마운트 전에 죽는 가장 흔한 원인이 손상된 저장값이다(3.A 층 1-3) — 기본
// 테마로라도 계속 간다. 그마저 실패하는 부팅은 boot-watchdog.js 가 받는다.
try {
  applyStoredTheme();
  applyStoredTypeScale();
} catch (error) {
  console.error("stored theme/type-scale apply failed", error);
}

const store = crashStore();
// 전역 오류는 기록만 남긴다(P-2) — 화면을 덮하지 않는다.
installGlobalHandlers(window, store);
// 층 3 의 기록 — 데스크톱이 직전 부팅의 렌더러 사망을 건네면 링에만 남긴다.
window.coloDesignDesktop?.lastRendererCrash?.()
  .then((record) => {
    if (record) store.publish({ source: "boot", message: `renderer ${record.reason}` });
  })
  .catch(() => {
    // 읽지 못한 기록은 없는 것과 같다.
  });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppCrashBoundary>
      {import.meta.env.DEV ? <DevCrashProbe /> : null}
      <App />
    </AppCrashBoundary>
  </StrictMode>,
);
