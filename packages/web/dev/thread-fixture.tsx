/**
 * 대화록 견본 — 데몬 없이 `Thread` 를 눈으로 보는 페이지(PLAN-THREAD 단계 1).
 * 앱과 같은 CSS(테마 · styles.css · next.css→chat.css)와 같은 칸 모양
 * (.nx → .nx-chat → .nx-transcript)으로 올린다. `vite build` 의 입력은
 * index.html 뿐이라 제품에 실리지 않고, tsconfig 가 dev/ 를 보지 않는다.
 *
 *   pnpm exec vite --port 29181 --strictPort
 *   → http://127.0.0.1:29181/dev/thread-fixture.html
 */
import { markTurn } from "@colo-design/protocol";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Block } from "../src/lib/daemon-client";
import { applyStoredTheme, applyStoredTypeScale } from "../src/lib/settings";
import { Thread } from "../src/next/chat/Thread";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "../src/styles.css";
import "../src/next/next.css";

applyStoredTheme();
applyStoredTypeScale();

const PREVIEW_URL = "http://127.0.0.1:5274";

const user = (id: string, text: string): Block => ({
  type: "user",
  id,
  text,
  images: 0,
});
const step = (id: string, text: string): Block => ({
  type: "text",
  id,
  text,
  agentId: null,
  streaming: false,
});
const answer = step; // 답도 같은 text 블록 — 묶음의 마지막 말이 답이 된다.
const turn = (id: string, durationMs: number): Block => ({
  type: "turn",
  id,
  subtype: "success",
  isError: false,
  costUsd: null,
  durationMs,
  resultText: null,
});

/** 프로토콜의 표식으로 만든 핀 묶음 — 저장된 옛 이름표 `div` 재현. */
const pinsTurn = markTurn(
  {
    kind: "comments",
    screen: "김기획 회원 상세",
    note: "찍은 곳을 눈에 잘 들게 고쳐 줘.",
    items: [{ id: "pin-1", label: "div", comment: "이 부분이 눈에 잘 안 들어와요" }],
  },
  [
    "찍은 곳을 눈에 잘 들게 고쳐 줘.",
    "",
    "아래는 사용자가 가리킨 자리입니다 — 사용자의 말대로 해 주세요.",
    "",
    '1. div — "이 부분이 눈에 잘 안 들어와요"',
    "   위치: body > div > main > div:nth-of-type(2)",
  ].join("\n"),
);

const blocks: Block[] = [
  // ① 첫 턴 — 맨 위 사람 말은 위 여백이 없고, 단추는 말풍선 옆자리에 매달린다.
  user("u1", "회원을 누르면 상세 화면이 나오게 해 줘. 연락처와 가입일이 보였으면 좋겠어."),
  step("t1a", "회원 목록 화면을 찾았어요"),
  step("t1b", "행을 누르면 상세로 가는 동작을 붙였어요"),
  answer(
    "t1c",
    [
      "**회원 목록** 화면의 행을 누르면 상세 화면으로 넘어가도록 바꿨어요.",
      "",
      "- 상세 화면에는 연락처와 가입일이 함께 보여요",
      "- 목록으로 돌아가는 길도 위에 있어요",
      "",
      `[회원 목록](${PREVIEW_URL}/member/list)`,
    ].join("\n"),
  ),
  turn("e1", 38000),

  // ② 둘째 턴 — 턴과 턴 사이가 가장 넓다.
  user("u2", "상세 화면 위쪽에 회원을 한 줄로 소개하는 문장을 넣어 줘."),
  step("t2a", "상세 화면의 머리를 살펴봤어요"),
  step("t2b", "회원 이름과 한 줄 소개 자리를 마련했어요"),
  step("t2c", "목 데이터에 소개 문장을 담았어요"),
  step("t2d", "글자 크기와 자간을 주변과 맞췄어요"),
  step("t2e", "화면을 다시 열어 확인했어요"),
  answer(
    "t2f",
    [
      "상세 화면 위쪽에 회원을 한 줄로 소개하는 문장을 넣었어요.",
      "이름 오른쪽에 역할이 작게 따라붙고, 아래 한 줄이 소개예요.",
      "",
      `[김기획 회원 상세](${PREVIEW_URL}/member/1)`,
    ].join("\n"),
  ),
  turn("e2", 41000),

  // ③ 핀 묶음 — 단추가 서지 않는 말도 같은 턴 간격이어야 한다.
  user("u3", pinsTurn),
  step("t3a", "찍은 자리의 주변을 살펴봤어요"),
  step("t3b", "배경과 글자의 대비를 높였어요"),
  step("t3c", "화면을 다시 열어 확인했어요"),
  answer(
    "t3d",
    [
      "찍어 주신 자리의 대비를 높여 문장이 눈에 잘 들어오게 했어요.",
      "",
      `[김기획 회원 상세](${PREVIEW_URL}/member/1)`,
    ].join("\n"),
  ),
  turn("e3", 33000),

  // ④ 짧은 말 — 단추가 말풍선 오른쪽 아래에서 왼쪽으로만 자라는지 본다.
  user("u4", "좋아요, 이대로 두자."),
  answer("t4a", "알겠어요. 지금 모습 그대로 둘게요."),
  turn("e4", 4000),
];

function Fixture() {
  return (
    /* .nx 는 견본에서 토큰 범위만 빌린다 — 셸의 그리드(사이드바 + 미리보기)와
       고정 높이는 풀어 평범한 문서가 되게 하고, 대화 칸은 margin auto 로 가운데. */
    <div
      className="nx"
      style={{ display: "block", height: "auto", minHeight: "100vh", overflow: "visible" }}
    >
      <section className="nx-chat" style={{ width: 420, margin: "0 auto" }}>
        <div className="nx-transcript">
          <Thread
            blocks={blocks}
            live={false}
            showThinking={false}
            showTools={false}
            previewUrl={PREVIEW_URL}
            handoff={null}
            projectWorking={false}
            canBranch={true}
            queue={[]}
            preparing={false}
            dropped={[]}
            onFork={() => {}}
            onEditResend={() => {}}
            onRetry={() => {}}
            onRetryDropped={() => {}}
            onOpenScreen={() => {}}
            onOpenHistory={() => {}}
            onReply={async () => {}}
            onNote={async () => {}}
            onToast={() => {}}
            onQueueEdit={() => {}}
            onQueueNow={() => {}}
            onBackgroundTask={() => {}}
            onStopTask={() => {}}
          />
        </div>
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
