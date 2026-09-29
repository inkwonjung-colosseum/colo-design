/**
 * 모델 칩 견본 — 데몬 없이 `Composer`(모델 칩 · ⚡ 토글 · 툴팁 카드)를 눈으로
 * 보는 페이지(PLAN-MODEL-CHIP D4). 앱과 같은 CSS(테마 · styles.css ·
 * next.css→chat.css)를 올린다. `vite build` 의 입력은 index.html 뿐이라 제품에
 * 실리지 않고, tsconfig 가 dev/ 를 보지 않는다.
 *
 *   pnpm --filter @nova-design/web exec vite --port 29185 --strictPort
 *   → http://127.0.0.1:29185/dev/chip-fixture.html
 *
 * 벌 a–d 는 묶음 D 의 검수 항목: next 의 카드 · 켜짐 · 막힘 이유 · 받지 않는
 * 모델(번개가 사라짐). 툴팁 카드는 번개에 마우스를 올리거나 Tab 으로
 * 포커스하면 뜬다.
 */

import type { SessionModelInfo } from "@nova-design/protocol";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { ChipTarget, Sessions } from "../src/hooks/useSessions";
import type { Daemon } from "../src/lib/daemon-client";
import { applyStoredTheme, applyStoredTypeScale } from "../src/lib/settings";
import { Composer } from "../src/next/chat/Composer";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "../src/styles.css";
import "../src/next/next.css";

applyStoredTheme();
applyStoredTypeScale();

const row = (parts: Partial<SessionModelInfo>): SessionModelInfo => ({
  value: "opus",
  displayName: "Opus 5.5",
  resolvedModel: null,
  description: "",
  supportsEffort: true,
  supportedEffortLevels: ["low", "medium", "high"],
  supportsFastMode: true,
  ...parts,
});

const CLAUDE_MODELS = [
  row({ value: "opus", displayName: "Opus 5.5", description: "가장 똑똑해요" }),
  row({
    value: "sonnet",
    displayName: "Sonnet 5",
    description: "빠르고 가벼워요",
    supportsFastMode: false,
  }),
];

/** 가짜 데몬 — 칩이 실제로 읽는 칸(providers · planUsageByProvider)만 채운다. */
const daemon = {
  status: {
    providers: [
      {
        id: "claude",
        label: "Claude",
        available: true,
        loggedIn: true,
        capabilities: { fastMode: true },
      },
      { id: "codex", label: "Codex", available: true, loggedIn: true, capabilities: {} },
    ],
    planUsageByProvider: {},
  },
} as unknown as Daemon;

/** 벌마다 다른 주인 — 상태를 바꾸지는 않으므로 칩을 눌러도 제자리다. */
const target = (parts: Partial<ChipTarget>): ChipTarget => ({
  subject: "session",
  key: "fixture",
  provider: "claude",
  model: "opus",
  effort: "high",
  fastMode: false,
  fastModeBlocked: null,
  models: CLAUDE_MODELS,
  setModel: () => Promise.resolve(),
  setEffort: () => Promise.resolve(),
  setFast: (on) => Promise.resolve({ on, blocked: null, key: "fixture" }),
  pickProvider: null,
  ...parts,
});

const sessionsOf = (chip: ChipTarget) =>
  ({ chipTarget: () => chip, refreshUsage: () => {} }) as unknown as Sessions;

/** 벌 하나 — 입력창 한 벌과 그 위의 표식. */
function Case({
  id,
  title,
  variant,
  chip,
}: {
  id: string;
  title: string;
  variant: "thread" | "home";
  chip: ChipTarget;
}) {
  return (
    <div id={`fixture-${id}`} style={{ width: 460, margin: "28px auto" }}>
      <h3 style={{ margin: "0 0 8px" }}>{title}</h3>
      <div className="nx-cmp-wrap">
        <Composer
          daemon={daemon}
          sessions={sessionsOf(chip)}
          variant={variant}
          subject={chip.subject}
          draftKey={`fixture-${id}`}
          placeholder="무엇을 만들까요?"
          onSend={async () => {}}
        />
      </div>
    </div>
  );
}

function Fixture() {
  return (
    /* .nx 는 견본에서 토큰 범위만 빌린다 — 셸의 그리드는 풀어 평범한 문서로. */
    <div
      className="nx"
      style={{ display: "block", height: "auto", minHeight: "100vh", overflow: "visible" }}
    >
      <Case
        id="a"
        title="a · 홈 next · Claude Opus · 꺼짐"
        variant="home"
        chip={target({
          subject: "next",
          key: "next:claude",
          pickProvider: () => {},
        })}
      />
      <Case
        id="b"
        title="b · 대화 칸 session · Claude Opus · 켜짐"
        variant="thread"
        chip={target({ subject: "session", fastMode: true })}
      />
      <Case
        id="c"
        title="c · 대화 칸 session · Claude Opus · 막힘(usage credits)"
        variant="thread"
        chip={target({ fastModeBlocked: "Fast mode requires usage credits" })}
      />
      <Case
        id="d"
        title="d · 대화 칸 session · Claude Sonnet · 번개 없음"
        variant="thread"
        chip={target({ model: "sonnet" })}
      />
    </div>
  );
}
const rootNode = document.getElementById("root");
if (rootNode) {
  createRoot(rootNode).render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
}
