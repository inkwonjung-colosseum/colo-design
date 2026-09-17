/**
 * Dev-only harness (chatpreview.html): renders the real Transcript + Composer
 * with fixture blocks so the chat column's design can be iterated on without a
 * daemon or a Claude session. Not part of the build — delete or keep out of
 * dist freely.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { PermissionCard, QuestionCard, Transcript } from "./components";
import { Composer } from "./components/chat/Composer";
import type { Block } from "./lib/daemon-client";
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
    text: '전체 흐름을 그림으로 정리하면 이렇습니다.\n\n```mermaid\nflowchart LR\n    ask["화면 요청"] --> chat["화면 대화"]\n    chat --> preview["미리보기"]\n    preview -->|"코멘트 핀"| chat\n    preview --> save["저장 · 넘기기"]\n```\n\n아래는 파싱에 실패한 다이어그램 — 원본 코드 블록으로 폴백한다.\n\n```mermaid\nflowchart LR\n    A[화면 요청 -->\n```',
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
  },
  {
    // 보조 작업이 도는 중 — 근황 한 줄, 경과, 뒤로 보내기·중지 버튼.
    type: "tool",
    id: "k6",
    name: "Task",
    input: { description: "CDS 목록 화면 관례 조사" },
    agentId: null,
    done: false,
    progress: {
      elapsedSeconds: 42,
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
];

function PlannerShell({
  live,
  showThinking,
  showTools,
}: {
  live: boolean;
  showThinking: boolean;
  showTools: boolean;
}) {
  // 진행 시계의 자리: 이 창이 열린 순간을 턴의 시작으로 삼는다 — 미리보기는
  // 실제로 초가 도는 모습까지 보여야 그 자리가 맞는지 알 수 있다.
  const [startedAt] = useState(() => Date.now() - 95_000);
  /** 에이전트 칩의 재료 — 데몬 없이도 칩의 모양과 고르기를 본다. */
  const [provider, setProvider] = useState("claude");
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
            checkpoints={[{ id: "cp1", turn: 1 }]}
            onRestoreCheckpoint={() => undefined}
            onRewind={() => undefined}
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
      <Composer
        disabled={false}
        draftKey="preview"
        placeholder="메시지를 보내 보세요 — @로 파일을, /로 명령을 불러올 수 있어요"
        usage={{
          totalTokens: 106_000,
          maxTokens: 1_000_000,
          percentage: 11,
          model: "claude-opus-5",
          plan: null,
          sessionCostUsd: 1.66,
        }}
        plan={{
          provider: "claude",
          subscriptionType: "max",
          fiveHour: { utilization: 42, resetsAt: null },
          sevenDay: { utilization: 21, resetsAt: null },
          modelWeekly: [{ label: "Fable", utilization: 68, resetsAt: null }],
        }}
        suggestion={live ? null : "정지 회원 안내 문구를 Alert 로 바꿔 줄까요?"}
        onDismissSuggestion={() => undefined}
        activity={live ? { status: "requesting" } : undefined}
        turnStartedAt={live ? startedAt : null}
        tasks={live ? [{ taskId: "task_2", type: "shell", description: "pnpm -s build" }] : []}
        onStopTask={() => undefined}
        running={live}
        sendKey="enter"
        selector={{
          provider,
          model: "opus",
          effort: "high",
          permissionMode: "bypassPermissions",
          fastMode: false,
          fastModeBlocked: null,
          models: [
            {
              value: "opus",
              displayName: "Opus 5",
              description: "",
              resolvedModel: "claude-opus-5",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high", "max"],
              supportsFastMode: true,
            },
            {
              value: "sonnet",
              displayName: "Sonnet 5",
              description: "",
              resolvedModel: "claude-sonnet-5",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high", "max"],
              supportsFastMode: false,
            },
          ],
        }}
        providers={[
          {
            id: "claude",
            label: "Claude",
            available: true,
            modes: [],
            defaultModeId: "default",
            capabilities: {},
          },
          {
            id: "codex",
            label: "Codex",
            available: true,
            modes: [],
            defaultModeId: "default",
            capabilities: {},
          },
          {
            id: "opencode",
            label: "OpenCode",
            available: false,
            reason: "OpenCode CLI 를 찾지 못했습니다 — 설치한 뒤 다시 확인해 주세요.",
            modes: [],
            defaultModeId: "build",
            capabilities: {},
          },
          {
            id: "omp",
            label: "omp",
            available: true,
            modes: [],
            defaultModeId: "default",
            capabilities: {},
          },
        ]}
        onPickProvider={setProvider}
        onToggleFastMode={() => undefined}
        commands={[]}
        onSetModel={() => undefined}
        onSetEffort={() => undefined}
        onSetPermissionMode={() => undefined}
        onSend={() => undefined}
        onInterrupt={() => undefined}
        onFindFiles={async () => ["src/screens/MemberList.screen.tsx", "src/screens/"]}
      />
    </main>
  );
}

function Preview() {
  const [theme, setTheme] = useState("dark");
  const [live, setLive] = useState(false);
  const [surface, setSurface] = useState("chat");
  /** 설정의 `생각 과정 보기` 자리 — 접힌 생각 블록의 모양을 여기서도 본다. */
  const [showThinking, setShowThinking] = useState(false);
  /** 설정의 `작업 과정 보기` 자리 — 활동 카드의 모양을 여기서도 본다. */
  const [showTools, setShowTools] = useState(false);
  /** 첫 초 surface 의 진행 시계 — 입력창 위 한 줄에서 방금 보낸 요청이 센다. */
  const [sentAt] = useState(() => Date.now());
  document.documentElement.dataset.theme = theme;
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
                <option value="dark">dark</option>
                <option value="light">light</option>
                <option value="catppuccin">catppuccin</option>
                <option value="nord">nord</option>
              </select>
              <select value={surface} onChange={(e) => setSurface(e.target.value)}>
                <option value="chat">대화</option>
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
            {surface === "turnlive" && (
              <main className="planner__chat">
                <div className="chatstack">
                  <section className="scroll">
                    <div className="transcript">
                      <div className="bubble bubble--user">회원 목록에 검색창 추가해줘</div>
                    </div>
                    <div className="turnlive">
                      <span className="spinner" />
                      작업 중…
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
                  plan={null}
                  running={true}
                  turnStartedAt={sentAt}
                  sendKey="enter"
                  selector={{
                    model: null,
                    effort: null,
                    permissionMode: "acceptEdits",
                    fastMode: true,
                    fastModeBlocked: null,
                    models: [],
                  }}
                  commands={[]}
                  onSetModel={() => undefined}
                  onSetEffort={() => undefined}
                  onSetPermissionMode={() => undefined}
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
