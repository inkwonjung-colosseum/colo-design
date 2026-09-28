import { Component, type ErrorInfo, type ReactNode } from "react";
import type { CrashReport } from "./lib/crash";
import { crashStore, createReport, markAppCrashed, useLatestCrash } from "./lib/crash";
import { CrashScreen } from "./next/CrashScreen";

/**
 * 층 2 의 마지막 울타리(P-1) — `main.tsx` 가 `<App/>` 바깥에 심는다. App 이
 * 쥔 데몬 연결 · 설정에 의존하지 않게 하기 위해서다. React 18 은 렌더 예외에
 * 루트 전체를 내리므로 화면이 이미 없는 순간을 여기서 받아 전면 안내판 한 장
 * 으로 바꾼다. `getDerivedStateFromError` 는 부작용 없이 리포트만 만들고,
 * 기록(publish)은 `componentDidCatch` 가 componentStack 과 함께 남긴다 —
 * React 사양이 그 순서를 정한다.
 */
export class AppCrashBoundary extends Component<
  { children: ReactNode },
  { report: CrashReport | null }
> {
  state: { report: CrashReport | null } = { report: null };

  static getDerivedStateFromError(error: Error): { report: CrashReport } {
    return { report: createReport("render", error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 번들이 살아 있다는 신호 — 마운트 전 사고라도 와치독이 덮어 쓰지 않게.
    markAppCrashed();
    crashStore().publish({
      source: "render",
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
    });
  }

  render(): ReactNode {
    return this.state.report ? <RenderCrash seed={this.state.report} /> : this.props.children;
  }
}

/**
 * 전면 안내판의 데이터 원천은 저장소다 — 경계가 만든 씨앗 리포트로 즉시
 * 그리고(componentDidCatch 의 publish 보다 한 박자 빠르다), 같은 사고의
 * 저장소 판(componentStack 이 붙은 것)으로 바꿔 얹는다.
 */
function RenderCrash({ seed }: { seed: CrashReport }): ReactNode {
  const latest = useLatestCrash(crashStore());
  const report = latest && latest.source === "render" && latest.time >= seed.time ? latest : seed;
  return <CrashScreen report={report} />;
}

/**
 * 개발 실행의 눈 검증 probe(3.A 9 · §5) — `?crash=render` 로 첫 렌더에서
 * 던진다. `main.tsx` 가 `import.meta.env.DEV` 일 때만 심으므로 패키징 빌드에는
 * 이르지도 않는다.
 */
export function DevCrashProbe(): ReactNode {
  if (!import.meta.env.DEV) return null;
  if (new URLSearchParams(window.location.search).get("crash") !== "render") return null;
  throw new Error("dev crash probe (?crash=render)");
}
