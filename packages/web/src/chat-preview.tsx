/**
 * Dev-only harness (chatpreview.html): renders the real Transcript + Composer
 * with fixture blocks so the chat column's design can be iterated on without a
 * daemon or a Claude session. Not part of the build — delete or keep out of
 * dist freely.
 */

import type { EffortLevel, LostSend } from "@colo-design/protocol";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PermissionCard, QuestionCard, Transcript, WorkStrip } from "./components";
import { Composer } from "./components/chat/Composer";
import { TurnClock } from "./components/preview/TurnClock";
import type { PinAttachment } from "./hooks/usePins";
import type { Block } from "./lib/daemon-client";
import { THEMES } from "./lib/settings";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./styles.css";

const blocks: Block[] = [
  {
    type: "user",
    id: "u1",
    text: "admin에 사용자 관리 페이지에 화면 구현해줘\nhttps://colosseum.atlassian.net/wiki/spaces/PROD/pages/1785659411/Platform+v1.2",
    images: 0,
  },
  {
    type: "thinking",
    id: "t1",
    agentId: null,
    streaming: false,
    text: "I'll start by reading the skill procedure and the screens the ask names.\nThe four screens are clear. Now checking CDS catalog and existing screen conventions.",
  },
  {
    type: "tool",
    id: "k1",
    name: "Bash",
    input: { command: "pnpm -s typecheck" },
    agentId: null,
    done: true,
    result: "ok — 0 errors",
  },
  {
    // 실사의 모양: 한 턴의 생각은 도구를 부를 때마다 새 블록으로 끊긴다 —
    // 작업 과정이 꺼진 테이프에서 이 조각들이 이웃이 되어 접힌 줄로 쌓였다.
    type: "thinking",
    id: "t1b",
    agentId: null,
    streaming: false,
    text: "타입검사는 깨끗하다. 목록 화면의 관례를 먼저 읽고 CDS 카탈로그와 맞춰 본다.",
  },
  {
    type: "tool",
    id: "k2",
    name: "Read",
    input: { file_path: "src/screens/member/MemberList.screen.tsx" },
    agentId: null,
    done: true,
    result: "142 lines",
  },
  {
    type: "thinking",
    id: "t1c",
    agentId: null,
    streaming: false,
    text: "MemberTable 이라는 이름은 이 레포에 없다. 테이블은 CDS Table 을 직접 쓰는 관례다.",
  },
  {
    type: "tool",
    id: "k3",
    name: "Grep",
    input: { pattern: "MemberTable" },
    agentId: null,
    done: true,
    isError: true,
    result: "no matches",
  },
  {
    type: "text",
    id: "a1",
    agentId: null,
    streaming: false,
    text: "말씀하신 범위가 네 화면이네요 — **목록 · 등록 · 상세 · 수정**으로 나눠 만들겠습니다.\n\n- 목록: 회원번호·이름·가입일·상태를 한 줄로\n- 상세: 기본 정보와 상태 변경\n\nCDS `Table`, `TextField`, `Timeline` 컴포넌트를 그대로 사용합니다.",
  },
  {
    type: "tool",
    id: "k4",
    name: "Write",
    input: { file_path: "src/screens/member/MemberList.screen.tsx" },
    agentId: null,
    done: true,
    result: "written",
  },
  {
    type: "text",
    id: "a2",
    agentId: null,
    streaming: false,
    text: "네 화면 모두 만들어 등록했습니다. 미리보기에서 `/member/MemberList` 부터 확인해 보세요.",
  },
  {
    // ```mermaid — 다이어그램 렌더와, 파싱 실패 폴백(코드 블록)을 함께 본다.
    type: "text",
    id: "a3",
    agentId: null,
    streaming: false,
    text: '전체 흐름을 그림으로 정리하면 이렇습니다.\n\n```mermaid\nflowchart LR\n    ask["화면 요청"] --> chat["화면 대화"]\n    chat --> preview["미리보기"]\n    preview -->|"코멘트 핀"| chat\n    preview --> save["보관 · 제출"]\n```\n\n아래는 파싱에 실패한 다이어그램 — 원본 코드 블록으로 폴백한다.\n\n```mermaid\nflowchart LR\n    A[화면 요청 -->\n```',
  },
  {
    type: "thinking",
    id: "t2",
    agentId: null,
    streaming: false,
    text: "목록 테이블의 상태 뱃지는 CDS Badge 색상 토큰을 그대로 쓰고, 정지 회원 안내는 Alert 컴포넌트로 상단에 배치한다.",
  },
  {
    type: "turn",
    id: "end1",
    subtype: "success",
    isError: false,
    costUsd: null,
    durationMs: 42_000,
    resultText: null,
  },
  {
    type: "user",
    id: "u3",
    text: "목록 화면의 빈 상태도 함께 봐 주세요",
    images: 0,
  },
  {
    // 사람 메시지 — 검토 본문이 버블, 인라인 코멘트가 인용 행, 아래 답하기.
    // `devmsg__reply` 는 버튼 어휘의 일원이라 하니스에서 항상 보여야 한다.
    type: "human",
    id: "dev1",
    reviews: [
      {
        id: 1,
        kind: "review",
        author: "inkwonjung-colosseum",
        body: "목록 화면의 상태 뱃지 색이 디자인 시스템의 토큰과 다릅니다. 확인 부탁드려요.",
        pr: 12,
        at: new Date().toISOString(),
      },
      {
        id: 2,
        kind: "inline",
        author: "inkwonjung-colosseum",
        body: "빈 상태 문구는 두 줄을 넘지 않게",
        pr: 12,
        path: "src/screens/member/MemberList.screen.tsx",
        line: 42,
        at: new Date().toISOString(),
      },
      {
        id: 3,
        kind: "inline",
        author: "inkwonjung-colosseum",
        body: "검색창 폭은 툴바의 절반 이하로",
        pr: 12,
        path: "src/screens/member/MemberList.screen.tsx",
        line: 57,
        at: new Date().toISOString(),
      },
    ],
  },
  {
    // 중단 카드 — `고쳐서 다시 보내기`(컴포저의 restore 손)의 실물. 이 행이
    // 보이고 눌리려면 Transcript 의 onResendEdit 에 손이 등록되어 있어야 한다.
    type: "turn",
    id: "turn-interrupted",
    subtype: "interrupted",
    isError: true,
    costUsd: null,
    durationMs: null,
    resultText: null,
  },
];

const runningBlocks: Block[] = [
  ...blocks,
  {
    type: "user",
    id: "u2",
    text: "목록에 검색창도 추가해줘",
    images: 0,
  },
  {
    type: "thinking",
    id: "t3",
    agentId: null,
    streaming: true,
    text: "검색창은 CDS SearchField로. 상태 필터와 함께 툴바 오른쪽에 배치하는 게 CDS 목록 화면 관례다.",
  },
  {
    type: "tool",
    id: "k5",
    name: "Edit",
    input: { file_path: "src/screens/member/MemberList.screen.tsx" },
    agentId: null,
    done: false,
    startedAt: Date.now() - 5_000,
  },
  {
    // 보조 작업이 도는 중 — 근황 한 줄, 경과, 뒤로 보내기·중지 버튼.
    type: "tool",
    id: "k6",
    name: "Task",
    input: { description: "CDS 목록 화면 관례 조사" },
    agentId: null,
    done: false,
    startedAt: Date.now() - 42_000,
    progress: {
      task: {
        id: "task_1",
        description: "CDS 목록 화면 관례 조사",
        summary: "검색·필터 툴바 관례를 비교하는 중",
        lastTool: "Read",
        subagentType: "Explore",
        tokens: 12_400,
        toolUses: 6,
        backgrounded: false,
        status: "running",
      },
    },
  },
  {
    // 그 보조 작업이 한 말 — 답이 아니라 그 작업 아래의 기록이다.
    type: "text",
    id: "s1",
    agentId: "k6",
    streaming: false,
    text: "CDS 목록 화면 여섯 곳 모두 SearchField 를 툴바 오른쪽에 두고, 상태 필터를 그 왼쪽에 붙였습니다.",
  },
  {
    type: "tool",
    id: "s2",
    name: "Read",
    input: { file_path: "src/screens/order/OrderList.screen.tsx" },
    agentId: "k6",
    done: true,
    result: "88 lines",
  },
  {
    // 뒤로 보낸 명령 — 도구 결과는 자리표시자, 일은 아직 돈다.
    type: "tool",
    id: "k7",
    name: "Bash",
    input: { command: "pnpm -s build" },
    agentId: null,
    done: true,
    result: "백그라운드에서 계속 실행 중",
    startedAt: Date.now() - 300_000,
    progress: {
      task: {
        id: "task_2",
        description: "pnpm -s build",
        summary: null,
        lastTool: null,
        subagentType: null,
        tokens: 0,
        toolUses: 0,
        backgrounded: true,
        status: "running",
      },
    },
  },
  {
    // 스트립이 셀 할 일 — 도는 중인 턴의 최신 목록.
    type: "tool",
    id: "k8",
    name: "TodoWrite",
    input: {
      todos: [
        { content: "네 화면 관례 조사", status: "completed" },
        { content: "목록 화면 만들기", status: "in_progress" },
        { content: "상세 · 수정 화면 만들기", status: "pending" },
        { content: "미리보기에서 검증", status: "pending" },
      ],
    },
    agentId: null,
    done: false,
  },
];

function PlannerShell({
  live,
  showThinking,
  showTools,
  crowded = false,
}: {
  live: boolean;
  showThinking: boolean;
  showTools: boolean;
  /** 상태 가득 — 핀·대기·유실을 다 채워 밴드와 접개의 모양을 본다. */
  crowded?: boolean;
}) {
  const [provider, setProvider] = useState("claude");
  // 칩의 고르기 걸음을 하니스 안에서도 진짜처럼 — 고른 값이 selector 로
  // 되돌아와야 메뉴의 연결 걸음(모델 → 생각)과 칩 요약이 검증된다.
  const [pick, setPick] = useState<{
    model: string | null;
    effort: EffortLevel | null;
  }>({ model: "opus", effort: "high" });
  // 실제 ChatColumn 과 같은 등록 패턴 — 컴포저의 restore 손을 빌려
  // 테이프의 고쳐서 다시 보내기를 살린다.
  const resendRef = useRef<((text: string) => void) | null>(null);
  // 핀·대기는 다섯 줄 — 접개의 자동 판정(네 줄 초과)이 걸리는 양.
  const crowdPins: PinAttachment[] = crowded
    ? ["로그인 버튼", "회원가입 링크", "검색창", "상단 내비게이션", "푸터 안내 문구"].map(
        (text, index) => ({
          id: `pin-${index + 1}`,
          screen: "login",
          note: index === 0 ? "누르고 나서 반응이 늦어요" : "",
          element: {
            component: "button",
            text,
            path: `main > form > button:nth-of-type(${index + 1})`,
            rect: { x: 120, y: 320, width: 160, height: 40 },
            kind: "element",
            source: "src/screens/Login.screen.tsx:42",
          },
        }),
      )
    : [];
  const crowdDropped: LostSend[] = crowded
    ? [
        {
          id: "lost-1",
          text: "로그아웃 후에도 토큰이 남는 시나리오도 봐 주세요",
          images: 0,
          files: 1,
          lostAt: Date.now() - 60_000,
        },
      ]
    : [];
  return (
    <main className="planner__chat">
      <header className="thread">
        {live && <span className="thread__lamp" aria-hidden />}
        <button type="button" className="thread__title">
          admin · 사용자 관리 화면
        </button>
        <span className="thread__spacer" />
        <button type="button" className="ghost thread__more" aria-label="대화 메뉴">
          ···
          <span />
        </button>
      </header>
      <div className="chatstack">
        <section className="scroll">
          <Transcript
            blocks={live ? runningBlocks : blocks}
            live={live}
            showThinking={showThinking}
            showTools={showTools}
            onBranch={() => undefined}
            onResendEdit={(text) => resendRef.current?.(text)}
            onReplyReview={() => undefined}
          />
        </section>
        {live && (
          <button type="button" className="chatstack__pill chatstack__pill--live">
            새 내용
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        )}
      </div>
      {/* 컴포저 위의 목차 스트립 — ChatColumn 이 놓는 자리와 같다. */}
      <WorkStrip blocks={live ? runningBlocks : blocks} />
      <Composer
        disabled={false}
        draftKey="preview"
        registerResend={(fn) => {
          resendRef.current = fn;
        }}
        placeholder="메시지를 보내 보세요 — @로 파일을, /로 명령을 불러올 수 있어요"
        usage={{
          totalTokens: 106_000,
          maxTokens: 1_000_000,
          percentage: 11,
          model: "claude-opus-5",
          plan: null,
          sessionCostUsd: 1.66,
        }}
        plans={[
          {
            plan: {
              provider: "claude",
              subscriptionType: "max",
              fiveHour: { utilization: 42, resetsAt: null },
              sevenDay: { utilization: 21, resetsAt: null },
              modelWeekly: [{ label: "Fable 주간", utilization: 68, resetsAt: null }],
            },
            label: "Claude",
          },
          {
            plan: {
              provider: "codex",
              subscriptionType: "free",
              fiveHour: null,
              sevenDay: null,
              modelWeekly: [{ label: "이번 달", utilization: 0, resetsAt: null }],
            },
            label: "Codex",
          },
        ]}
        suggestion={live ? null : "정지 회원 안내 문구를 Alert 로 바꿔 줄까요?"}
        onDismissSuggestion={() => undefined}
        tasks={live ? [{ taskId: "task_2", type: "shell", description: "pnpm -s build" }] : []}
        onStopTask={() => undefined}
        pins={crowdPins}
        dropped={crowdDropped}
        onTakeDropped={async () => null}
        onDismissDropped={() => undefined}
        onPinRemove={() => undefined}
        onPinNote={() => undefined}
        onPinFocus={() => undefined}
        titleForScreen={(screen) => (screen === "login" ? "로그인" : null)}
        running={live}
        sendKey="enter"
        selector={{
          provider,
          model: pick.model,
          effort: pick.effort,
          fastMode: false,
          fastModeBlocked: null,
          models: [
            {
              value: "opus",
              displayName: "Opus 5",
              description: "가장 어려운 작업을 위한 가장 강력한 모델",
              resolvedModel: "claude-opus-5",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high", "max"],
              supportsFastMode: true,
            },
            {
              value: "sonnet",
              displayName: "Sonnet 5",
              description: "속도와 지능의 균형",
              resolvedModel: "claude-sonnet-5",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high", "max"],
              supportsFastMode: false,
            },
            {
              value: "haiku",
              displayName: "Haiku 5",
              description: "생각 단계 없이 즉답하는 가장 빠른 모델",
              resolvedModel: "claude-haiku-5",
              supportsEffort: false,
              supportedEffortLevels: null,
              supportsFastMode: false,
            },
          ],
        }}
        providers={[
          {
            id: "claude",
            label: "Claude",
            available: true,
            capabilities: {},
          },
          {
            id: "codex",
            label: "Codex",
            available: false,
            reason: "Codex CLI 를 찾지 못했습니다 — 설치한 뒤 다시 확인해 주세요.",
            capabilities: {},
          },
          {
            id: "omp",
            label: "omp",
            available: true,
            capabilities: {},
          },
        ]}
        onPickProvider={setProvider}
        // 칩의 두 얼굴을 하니스에서도 — 실행 중(열린 대화)에는 고름의 범위가
        // 다음 새 대화임을 노트로 말하고, 준비 자리에서는 고름이 곧 이 컴포저의
        // 프로바이더다. 두 값이 같은 한 곳(setProvider)을 쓰므로 고른 값이
        // 행과 표식에 그대로 되돌아온다.
        nextProvider={provider}
        providerLocked={live}
        commands={[]}
        onSetModel={(model) => setPick((prev) => ({ ...prev, model }))}
        onSetEffort={(effort) => setPick((prev) => ({ ...prev, effort }))}
        onSend={() => undefined}
        onInterrupt={() => undefined}
        onFindFiles={async () => ["src/screens/MemberList.screen.tsx", "src/screens/"]}
      />
    </main>
  );
}

function Preview() {
  const [theme, setTheme] = useState("light");
  const [live, setLive] = useState(false);
  const [surface, setSurface] = useState("chat");
  /** 설정의 `생각 과정 보기` 자리 — 접힌 생각 블록의 모양을 여기서도 본다. */
  const [showThinking, setShowThinking] = useState(false);
  /** 설정의 `작업 과정 보기` 자리 — 활동 카드의 모양을 여기서도 본다. */
  const [showTools, setShowTools] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return (
    <div className="planner" style={{ height: "100vh", gridTemplateColumns: "minmax(0, 1fr)" }}>
      <div className="planner__main">
        <div className="planner__body" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
          <div className="planner__chatcol">
            <div
              className="previewbar"
              style={{
                display: "flex",
                gap: 8,
                padding: "8px 12px",
                borderBottom: "1px solid var(--line-soft)",
                alignItems: "center",
              }}
            >
              <button onClick={() => setLive(!live)}>{live ? "정지 상태로" : "실행 중으로"}</button>
              <button onClick={() => setShowThinking(!showThinking)}>
                {showThinking ? "생각 과정 숨기기" : "생각 과정 보기"}
              </button>
              <button onClick={() => setShowTools(!showTools)}>
                {showTools ? "작업 과정 숨기기" : "작업 과정 보기"}
              </button>
              <select value={theme} onChange={(e) => setTheme(e.target.value)}>
                {THEMES.filter((t) => t !== "system").map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <select value={surface} onChange={(e) => setSurface(e.target.value)}>
                <option value="chat">대화</option>
                <option value="full">상태 가득</option>
                <option value="turnlive">첫 초</option>
                <option value="permission">허용 카드</option>
                <option value="question">질문 카드</option>
              </select>
            </div>
            {surface === "chat" && (
              <PlannerShell
                key={String(live)}
                live={live}
                showThinking={showThinking}
                showTools={showTools}
              />
            )}
            {surface === "full" && (
              <PlannerShell
                key="full"
                live={false}
                showThinking={showThinking}
                showTools={showTools}
                crowded
              />
            )}
            {surface === "turnlive" && (
              <main className="planner__chat">
                <div className="chatstack">
                  <section className="scroll">
                    <div className="transcript">
                      <div className="bubble bubble--user">회원 목록에 검색창 추가해줘</div>
                    </div>
                    <div className="turnlive" role="status" aria-label="작업 중">
                      <span className="turnlive__dots" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </span>
                      <TurnClock startedAt={Date.now()} />
                    </div>
                  </section>
                </div>
                <Composer
                  disabled={false}
                  draftKey="preview-live"
                  placeholder="메시지를 보내 보세요 — @로 파일을, /로 명령을 불러올 수 있어요"
                  usage={{
                    totalTokens: 178_000,
                    maxTokens: 200_000,
                    percentage: 89,
                    model: "claude-sonnet-5",
                    plan: null,
                    sessionCostUsd: 0.42,
                  }}
                  plans={[]}
                  running={true}
                  sendKey="enter"
                  selector={{
                    model: null,
                    effort: null,
                    fastMode: true,
                    fastModeBlocked: null,
                    models: [],
                  }}
                  commands={[]}
                  onSetModel={() => undefined}
                  onSetEffort={() => undefined}
                  onSend={() => undefined}
                  onInterrupt={() => undefined}
                  onFindFiles={async () => []}
                />
              </main>
            )}
            {surface === "permission" && (
              <div className="scroll" style={{ padding: 28 }}>
                <div style={{ maxWidth: 860, margin: "0 auto" }}>
                  <PermissionCard
                    request={{
                      requestId: "p1",
                      sessionId: "s1",
                      kind: "permission",
                      toolName: "Bash",
                      input: { command: "pnpm dlx shadcn@latest add dialog" },
                      suggestions: [
                        {
                          destination: "pnpm dlx",
                          label: "pnpm dlx",
                          raw: null,
                        },
                      ],
                    }}
                    onRespond={() => undefined}
                  />
                </div>
              </div>
            )}
            {surface === "question" && (
              <div className="scroll" style={{ padding: 28 }}>
                <div style={{ maxWidth: 860, margin: "0 auto" }}>
                  <QuestionCard
                    request={{
                      requestId: "q1",
                      sessionId: "s1",
                      kind: "question",
                      questions: [
                        {
                          question: "목록의 기본 정렬은 무엇으로 할까요?",
                          header: "정렬",
                          multiSelect: false,
                          options: [
                            {
                              label: "가입일 최신순",
                              description: "새 회원이 위로",
                              preview:
                                '<div style="border:1px solid #e5e5e8;border-radius:8px;overflow:hidden"><div style="display:flex;gap:8px;padding:8px 10px;background:#fafafa;font-size:11px;color:#71717a"><span style="flex:1">이름</span><span>가입일 ▼</span></div><div style="display:flex;gap:8px;padding:8px 10px;border-top:1px solid #f0f0f2"><span style="flex:1">김서연</span><span>2026-09-12</span></div><div style="display:flex;gap:8px;padding:8px 10px;border-top:1px solid #f0f0f2"><span style="flex:1">박도윤</span><span>2026-08-30</span></div></div>',
                            },
                            {
                              label: "이름순",
                              description: "가나다 순",
                              preview:
                                '<div style="border:1px solid #e5e5e8;border-radius:8px;overflow:hidden"><div style="display:flex;gap:8px;padding:8px 10px;background:#fafafa;font-size:11px;color:#71717a"><span style="flex:1">이름 ▲</span><span>가입일</span></div><div style="display:flex;gap:8px;padding:8px 10px;border-top:1px solid #f0f0f2"><span style="flex:1">김서연</span><span>2026-09-12</span></div><div style="display:flex;gap:8px;padding:8px 10px;border-top:1px solid #f0f0f2"><span style="flex:1">박도윤</span><span>2026-08-30</span></div></div>',
                            },
                          ],
                        },
                      ],
                    }}
                    onRespond={() => undefined}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
