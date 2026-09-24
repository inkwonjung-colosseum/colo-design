import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatEvent } from "@colo-design/protocol";
// `../dist` 임포트인 이유: session 은 형제(.js 지정자)를 부른다 — src 직접
// 로드는 그 지정을 못 고친다(revive-budget 와 같은 길). 가짜 전송(agent)을
// 붙여 세션의 자기치유 상태 기계만을 몬다 — CLI 는 없다.
import { QueueStore } from "../dist/queue-store.js";
import { Session } from "../dist/session.js";

/** 세션이 방송한 사건 중 시험 한 켤레가 보는 것들. */
type Seen = {
  notices: string[];
  turnEnds: Array<{ isError: boolean; escalated: boolean; subtype: string }>;
  authStalls: number;
  turnFailures: Array<string | null>;
};

function harness(opts: { canCompact?: boolean; retryDelays?: number[] } = {}) {
  const seen: Seen = { notices: [], turnEnds: [], authStalls: 0, turnFailures: [] };
  const sends: string[] = [];
  const session = new Session(
    {
      cwd: tmpdir(),
      provider: "claude",
      ...(opts.canCompact !== undefined ? { canCompact: opts.canCompact } : {}),
      retryDelays: opts.retryDelays ?? [1, 1, 1, 1, 1],
    },
    {
      onEvent: (_id, event) => {
        if (event.kind === "notice") seen.notices.push(event.text);
        if (event.kind === "turn.end") {
          seen.turnEnds.push({
            isError: event.isError,
            escalated: event.escalated === true,
            subtype: event.subtype,
          });
        }
      },
      onState: () => undefined,
      onPermissionRequest: () => undefined,
      onQuestionRequest: () => undefined,
      onAuthStall: () => {
        seen.authStalls += 1;
      },
      onTurnFailed: (_id, resultText) => {
        seen.turnFailures.push(resultText);
      },
    },
  );
  // 가짜 전송 — 세션이 CLI 에 내려놓은 말의 순서만 기록한다.
  session.attach({
    send: (turn: { text: string }) => {
      sends.push(turn.text);
      return Promise.resolve();
    },
  } as never);
  const fail = (resultText: string) =>
    session.driverHooks.onEvent({
      kind: "turn.end",
      subtype: "error",
      isError: true,
      costUsd: null,
      numTurns: null,
      durationMs: 1,
      resultText,
    } satisfies ChatEvent & { kind: "turn.end" });
  const succeed = () =>
    session.driverHooks.onEvent({
      kind: "turn.end",
      subtype: "success",
      isError: false,
      costUsd: null,
      numTurns: null,
      durationMs: 1,
      resultText: null,
    } satisfies ChatEvent & { kind: "turn.end" });
  let blockSeq = 0;
  const answer = (text: string) =>
    session.driverHooks.onEvent({
      kind: "text.done",
      blockId: `b${blockSeq++}`,
      text,
      agentId: null,
    } satisfies ChatEvent & { kind: "text.done" });
  // 재시도 타이머(1ms)는 세션이 만든 진짜 시계다 — 스케줄러가 한 바퀴 도는
  // 것만 기다린다(가짜 시계로 돌릴 수 없는 생 타이머 통합 시험).
  const tick = () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
  };
  return { session, seen, sends, fail, succeed, answer, tick };
}

test("로그인 만료로 멈춘 말은 로그인이 돌아오면 한 번 다시 나간다 (PLAN L12)", () => {
  const { session, seen, sends, fail } = harness();
  session.send("회원 목록 화면을 만들어 줘");
  fail("authentication_error: Invalid API key");
  assert.equal(seen.authStalls, 1, "로그인 만료는 onAuthStall 로 알린다");
  assert.equal(sends.length, 1, "재시도 사다리를 타지 않는다");
  session.resumeAfterLogin();
  assert.deepEqual(sends, ["회원 목록 화면을 만들어 줘", "회원 목록 화면을 만들어 줘"]);
  assert.ok(seen.notices.some((text) => text.includes("로그인이 돌아왔습니다")));
});

test("두 번째 로그인 만료는 다시 보내지 않는다 — 사람의 손이 정답이다", () => {
  const { session, seen, sends, fail } = harness();
  session.send("첫 요청");
  fail("Please run /login to authenticate");
  session.resumeAfterLogin();
  assert.equal(sends.length, 2);
  fail("You are not logged in");
  assert.equal(seen.authStalls, 2, "두 번째 실패도 알린다");
  session.resumeAfterLogin();
  assert.equal(sends.length, 2, "같은 말을 두 번 다시 보내지 않는다");
});

test("답을 낸 턴 뒤의 로그인 만료는 다시 무장한다", () => {
  const { session, sends, fail, succeed } = harness();
  session.send("요청");
  fail("not logged in");
  session.resumeAfterLogin();
  succeed();
  fail("401 Unauthorized");
  session.resumeAfterLogin();
  assert.equal(sends.length, 3, "성공 뒤의 새 로그인 만료는 다시 한 번 보낸다");
});

test("길이 초과는 /compact 뒤 원래 말을 한 번 다시 보낸다 (PLAN L12)", () => {
  const { session, sends, fail, succeed } = harness({ canCompact: true });
  session.send("아주 긴 요청");
  fail("prompt is too long: 250000 tokens > 200000 maximum");
  assert.deepEqual(sends, ["아주 긴 요청", "/compact"], "요약 명령이 먼저 나간다");
  session.driverHooks.onEvent({ kind: "compact", trigger: "manual" });
  succeed();
  assert.deepEqual(
    sends,
    ["아주 긴 요청", "/compact", "아주 긴 요청"],
    "요약 턴이 끝나면 원래 말을 다시 보낸다",
  );
  // 한 턴에 한 번 — 다시 길이 초과가 나면 /compact 없이 실패 카드가 남는다.
  fail("prompt is too long: 250000 tokens > 200000 maximum");
  assert.equal(sends.length, 3, "두 번째 요약은 없다");
});

test("요약하지 못하는 공급자는 길이 초과에 그냥 멈춘다", () => {
  const { session, seen, sends, fail } = harness({ canCompact: false });
  session.send("아주 긴 요청");
  fail("prompt is too long: 250000 tokens > 200000 maximum");
  assert.equal(sends.length, 1, "/compact 를 보내지 않는다");
  assert.equal(seen.turnFailures.length, 0, "길이 초과는 개발자 알림이 아니다");
});

test("사다리를 다 쓴 실패는 escalated 로 방송되고 개발자 알림으로 간다", async () => {
  const { session, seen, fail, tick } = harness({ retryDelays: [1, 1] });
  session.send("일시 오류에 부딪히는 요청");
  fail("temporary failure");
  await tick();
  fail("temporary failure");
  await tick();
  // 두 계단을 다 썼다 — 세 번째 실패는 소진이다.
  fail("temporary failure");
  const exhausted = seen.turnEnds[seen.turnEnds.length - 1];
  assert.equal(exhausted?.isError, true);
  assert.equal(exhausted?.escalated, true, "소진 실패에 escalated 표식이 실린다");
  assert.deepEqual(seen.turnFailures, ["temporary failure"]);
});

test("크래시 알림은 더 이상 영어 원문을 싣지 않는다 (PLAN L8 · L12)", () => {
  const { session, seen } = harness();
  session.send("도는 중 죽을 요청");
  session.driverHooks.onTransportError("Query closed before response received");
  const crashNotices = seen.notices.filter((text) => text.includes("Query closed"));
  assert.deepEqual(crashNotices, [], "원문은 화면에 올라가지 않는다");
  assert.equal(session.state, "error", "상태는 여전히 내려앉는다 — 되살리기의 조건");
});

test("정상 종료 중 죽은 전송의 대기 줄도 디스크에 산다 (PLAN L12)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selfheal-queue-"));
  try {
    const queue = new QueueStore(dir);
    const session = new Session(
      { cwd: tmpdir(), sessionId: "shut1", queueDiskFor: (id) => queue.for(id) },
      {
        onEvent: () => undefined,
        onState: () => undefined,
        onPermissionRequest: () => undefined,
        onQuestionRequest: () => undefined,
      },
    );
    session.send("도는 턴의 말");
    session.send("대기 줄의 말", [], [], "queue");
    await session.close("shutdown");
    const [recovery] = queue.takeStartupRecoveries();
    assert.equal(recovery?.inflight.text, "도는 턴의 말");
    assert.equal(recovery?.held.length, 1, "대기 말도 살아 있다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("마지막 답변 문장은 세션이 모아 둔다 — 턴이 바뀌면 비워진다 (PLAN L9)", () => {
  const { session, answer, succeed } = harness();
  session.send("첫 요청");
  answer("버튼 문구를 바꿨습니다. ");
  answer("스레드에 답장할 문장은 이 아래에 남습니다.");
  assert.equal(
    session.lastAssistantText,
    "버튼 문구를 바꿨습니다. 스레드에 답장할 문장은 이 아래에 남습니다.",
  );
  succeed();

  session.send("둘째 요청");
  assert.equal(session.lastAssistantText, null, "새 턴이 시작되면 비워진다");
  answer("둘째 답변입니다.");
  assert.equal(session.lastAssistantText, "둘째 답변입니다.");
});
