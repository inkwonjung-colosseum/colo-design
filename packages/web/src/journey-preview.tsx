/**
 * Dev-only harness (journeypreview.html): renders the real JourneyBoard +
 * JourneyDots + a sidebar leaf row's trail with fixture data so the journey
 * surfaces can be verified without a daemon or a Claude session. Not part of
 * the build — delete or keep out of dist freely.
 */

import type { ProjectSummary, ThreadSummary } from "@colo-design/protocol";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { JourneyBoard } from "./components/journey/JourneyBoard";
import { JourneyDots } from "./components/journey/JourneyDots";
import { Tip } from "./components/shell/Tip";
import type { Block, Daemon } from "./lib/daemon-client";
import type { Journey } from "./lib/journey";
import { trailFor, trailWords } from "./lib/journey-board";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./styles.css";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const threads: ThreadSummary[] = [
  { id: "t1", title: "결제 모듈 리팩터링", state: "awaiting", cycle: "review", updatedAt: ago(4) },
  { id: "t2", title: "온보딩 화면 문구 정리", state: "idle", cycle: "handed", updatedAt: ago(22) },
  { id: "t3", title: "검색 성능 프로파일", state: "running", updatedAt: ago(1) },
  { id: "t4", title: "로그인 버튼 색 수정", state: "idle", cycle: "saved", updatedAt: ago(48) },
  {
    id: "t5",
    title: "배포 파이프라인 정리",
    state: "finished",
    cycle: "merged",
    updatedAt: ago(130),
  },
  { id: "t6", title: "새 대화", state: "idle", updatedAt: ago(300) },
];

const detailBlocks: Block[] = [
  {
    type: "save",
    id: "s1",
    at: ago(40),
    commit: "a1b2c3d",
    message: "결제 모듈 리팩터링",
    files: ["pay.ts"],
  },
  { type: "milestone", id: "m1", subtype: "handed", at: ago(30), pr: 42, reviewer: "민수" },
  {
    type: "human",
    id: "h1",
    reviews: [
      {
        id: 1,
        kind: "inline",
        author: "민수",
        body: "여기 널 체크가 빠졌어요",
        pr: 42,
        path: "methods.ts",
        line: 42,
        at: ago(4),
      },
      {
        id: 2,
        kind: "inline",
        author: "민수",
        body: "이 분기는 테스트가 없네요",
        pr: 42,
        path: "methods.ts",
        line: 88,
        at: ago(4),
      },
    ],
  },
];

const project: ProjectSummary = {
  slug: "durable-spider",
  name: "durable-spider",
  baseBranch: "main",
  phase: "ready",
  pendingChanges: 0,
  working: true,
  handoff: null,
  threads,
  pendingCount: 1,
};

const daemon = {
  connection: "open",
  activeSlug: "durable-spider",
  projects: [project],
  sessions: { t1: { blocks: detailBlocks } },
} as unknown as Daemon;

const journeys: { label: string; journey: Journey; title?: string }[] = [
  {
    label: "프로젝트 — 넘기기 경고",
    journey: {
      stop: 2,
      reached: [true, true, false, false],
      arrived: false,
      warn: true,
      scope: "project",
    },
  },
  {
    label: "대화 — 저장 정류장",
    journey: {
      stop: 1,
      reached: [true, false, false, false],
      arrived: false,
      warn: false,
      scope: "thread",
    },
    title: "로그인 버튼 색 수정",
  },
  {
    label: "프로젝트 — 반영 도착",
    journey: {
      stop: 3,
      reached: [true, true, true, true],
      arrived: true,
      warn: false,
      scope: "project",
    },
  },
];

const TRAIL_STOPS = ["만들기", "저장", "넘기기", "반영"] as const;

function LeafTrail({ thread }: { thread: ThreadSummary }) {
  const trail = trailFor(thread);
  if (!trail) return null;
  return (
    <Tip label={trailWords(thread)} side="right">
      <span className="trail" aria-hidden="true">
        {trail.map((stop, index) => (
          <i key={TRAIL_STOPS[index]} className={stop === "empty" ? "" : `trail__${stop}`} />
        ))}
      </span>
    </Tip>
  );
}

function App() {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <div
        className="screenpanel__bar"
        style={{
          padding: "0 14px",
          borderBottom: "1px solid var(--line)",
          height: 48,
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <strong style={{ font: "600 var(--font-ui-125) var(--sans)" }}>durable-spider</strong>
        {journeys.map(({ label, journey, title }) => (
          <span
            key={label}
            title={label}
            style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
          >
            <JourneyDots journey={journey} title={title} />
          </span>
        ))}
      </div>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <aside
          className="sidebar"
          style={{ width: 240, borderRight: "1px solid var(--line)", padding: 8 }}
        >
          {threads.map((thread) => (
            <div
              key={thread.id}
              className="leaf__row"
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px" }}
            >
              <span className="leaf__dot" />
              <span
                className="leaf__title"
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {thread.title}
              </span>
              <LeafTrail thread={thread} />
              <span className="leaf__meta">3m</span>
            </div>
          ))}
        </aside>
        <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <JourneyBoard
            daemon={daemon}
            sessionTitles={{ t6: "이름을 바꾼 대화" }}
            activeThreadId="t1"
            onOpenThread={() => {}}
          />
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
