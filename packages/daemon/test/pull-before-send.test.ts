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
