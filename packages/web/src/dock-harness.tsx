import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HistoryDrawer } from "./components/shell/HistoryDrawer";
import type { Daemon } from "./lib/daemon-client";
import "./styles.css";

/** 저장 기록 도킹의 시각 하니스(버릴 것): 완폭 도킹과 좁은 폭 cover 폴백을
 *  한 화면에 나란히 띄운다. 데몬 없이 실제 컴포넌트+실제 CSS를 검증한다. */

const entries = [
  {
    sha: "c3",
    at: new Date(Date.now() - 3 * 60_000).toISOString(),
    message: "헤더 여백을 줄이고 버튼 크기를 키웠습니다",
    files: [{ path: "a.css", status: "modified" }],
  },
  {
    sha: "c2",
    at: new Date(Date.now() - 42 * 60_000).toISOString(),
    message: "로그인 화면을 새로 만들었습니다",
    files: [{ path: "login.tsx", status: "added" }, { path: "b.ts", status: "modified" }],
  },
  {
    sha: "c1",
    at: new Date(Date.now() - 5 * 3_600_000).toISOString(),
    message: "첫 화면 틀을 잡았습니다",
    files: [{ path: "x", status: "added" }, { path: "y", status: "added" }, { path: "z", status: "added" }, { path: "w", status: "added" }],
  },
];

const daemon = {
  diffStatus: null,
  api: {
    saveHistory: async () => ({ entries }),
    restore: async () => ({ stage: "published", detail: null }),
    repoStatus: async () => ({}),
  },
} as unknown as Daemon;

function stage(label: string) {
  return (
    <div
      style={{
        flex: 1,
        display: "grid",
        placeItems: "center",
        background:
          "repeating-linear-gradient(45deg, #f4efe6 0 14px, #efe8da 14px 28px)",
        color: "#8a7f6d",
        font: "600 14px sans-serif",
      }}
    >
      {label}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <div style={{ display: "flex", flexDirection: "column", gap: 24, padding: 24 }}>
      <h2 style={{ margin: 0, font: "650 16px sans-serif" }}>
        저장 기록 도킹 하니스 — 왼쪽: 완폭 도킹(미리보기 생입), 오른쪽: 좁은 폭 cover 폴백
      </h2>
      <div style={{ display: "flex", gap: 32, alignItems: "flex-start" }}>
        <div
          className="planner__previewcol"
          style={{ width: 860, height: 520, border: "1px solid #d8d0c0" }}
        >
          <div className="previewcol__row" style={{ flex: "0 0 460px" }}>
            <div className="previewcol__stage">{stage("미리보기 — 살아 있음")}</div>
            <HistoryDrawer open onClose={() => {}} daemon={daemon} />
          </div>
        </div>
        <div
          className="planner__previewcol"
          style={{ width: 520, height: 520, border: "1px solid #d8d0c0" }}
        >
          <div className="previewcol__row previewcol__row--cover" style={{ flex: "0 0 460px" }}>
            <div className="previewcol__stage">{stage("미리보기 — 얼음(폴백)")}</div>
            <HistoryDrawer open onClose={() => {}} daemon={daemon} cover />
          </div>
        </div>
      </div>
    </div>
  </StrictMode>,
);
