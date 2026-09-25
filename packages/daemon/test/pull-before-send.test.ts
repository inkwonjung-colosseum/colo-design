import assert from "node:assert/strict";
import { test } from "node:test";
import { RequestRouter } from "../dist/dispatch.js";

/**
 * E1 보내기 직전 최신화의 20초 상한 — 감독자의 틱이 끝나지 않아도 말은
 * 먼저 나간다(PLAN L2 흡수표). RequestRouter 의 다른 의존성은 이 길이
 * 닿지 않으므로 fleet 하나만 흉내 낸다.
 */
test("before-send 틱이 20초를 넘으면 말이 먼저 나가고 틱은 뒤에서 이어진다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const gate = Promise.withResolvers<void>();
  let tickFinished = false;
  const hanging = {
    supervisor: {
      tick: () =>
        gate.promise.then(() => {
          tickFinished = true;
        }),
    },
  };
  const fleet = { workspaceOfSession: () => hanging };
  const router = new RequestRouter({ fleet } as never);

  // private 길을 그대로 부른다 — 상한은 이 메서드의 Promise.race 가 쥔다.
  // 시험이 private 멤버에 닿는 유일한 길이라 캐스트를 이름 있는 자리에 둔다.
  const pullBeforeSend: (id: string) => Promise<void> = (
    router as never as Record<string, (id: string) => Promise<void>>
  )["pullBeforeSend"].bind(router);

  const pull = pullBeforeSend("s1");

  // 틱이 끝나지 않아도 20초 상한이 풀어 준다.
  t.mock.timers.tick(20_000);
  await pull;
  assert.equal(tickFinished, false, "상한이 먼저 풀려야 한다");

  // 뒤에서 이어지는 틱은 그대로 끝난다 — 말을 보낸 뒤의 세계가 멈추지 않는다.
  gate.resolve();
  await gate.promise;
  assert.equal(tickFinished, true, "틱은 뒤에서 끝나야 한다");
});

test("게이트 문제 해결 대화는 fleet 의 자동 대화 길로 연다 — codex 만 쓸 수 있으면 codex 로", async () => {
  // 공급자 고르기는 fleet → autoThreads(auto-thread.ts) 가 한다: codex 만
  // 쓸 수 있는 기계에서 그 판정이 codex 세션을 돌려준다. 라우터의 몫은 그
  // 길에 다리는 것뿐이다 — claude 실행 파일을 직접 보던 옛 길이라면 아래의
  // 최소 deps(claudeExecutable 없음)에서 무너진다.
  const codexSession = {
    id: "codex-s1",
    cwd: "/tmp/colo-repo",
    state: "idle",
    title: "제출 문제 해결",
  };
  const opened: string[] = [];
  const fleet = {
    workspaceCwd: () => "/tmp/colo-repo",
    requireActive: () => ({}),
    autoFixThreadFor: async (_workspaces: unknown, title: string) => {
      opened.push(title);
      return codexSession;
    },
  };
  const manager = { get: (id: string) => (id === "codex-s1" ? codexSession : undefined) };
  const router = new RequestRouter({ fleet, manager } as never);
  const gateThreadFor: (stage: string) => Promise<unknown> = (
    router as never as Record<string, (stage: string) => Promise<unknown>>
  )["gateThreadFor"].bind(router);

  assert.equal(await gateThreadFor("handoff"), codexSession, "fleet 이 연 codex 세션");
  assert.deepEqual(opened, ["제출 문제 해결"]);

  // 살아 있는 게이트 대화는 재사용한다 — 다시 열지 않는다.
  opened.length = 0;
  assert.equal(await gateThreadFor("save"), codexSession);
  assert.deepEqual(opened, [], "기억한 대화를 다시 쓴다");
});
