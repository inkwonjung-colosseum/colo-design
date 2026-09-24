import assert from "node:assert/strict";
import { test } from "node:test";
// `../dist` 임포트인 이유: revive-budget · dispatch 의 src 는 `.js` 지정자로
// 형제를 부른다 — src 직접 로드는 그 지정을 못 고친다(shelf-recover 와 같은 길).
import { RequestRouter, type RouterDeps } from "../dist/dispatch.js";
import { ReviveBudget } from "../dist/revive-budget.js";
import { MAX_AUTO_REVIVES } from "../dist/turn-retry.js";

test("상한에 도달하면 거절한다", () => {
  const budget = new ReviveBudget();
  let now = 0;
  for (let i = 0; i < MAX_AUTO_REVIVES; i += 1) {
    now += 1_000;
    assert.equal(budget.allow("s", now), true);
  }
  now += 1_000;
  assert.equal(budget.allow("s", now), false);
});
test("성공한 턴이 셈을 지운다 — 다음 고장은 새로운 사건이다", () => {
  const budget = new ReviveBudget();
  budget.allow("s", 0);
  budget.allow("s", 1_000);
  assert.equal(budget.allow("s", 2_000), false);
  budget.settled("s");
  assert.equal(budget.allow("s", 3_000), true);
});

test("10분 창 밖의 되살리기는 세지 않는다", () => {
  const budget = new ReviveBudget();
  const t0 = 1_000_000;
  assert.equal(budget.allow("s", t0), true);
  assert.equal(budget.allow("s", t0 + 60_000), true);
  assert.equal(budget.allow("s", t0 + 120_000), false);
  // 첫 셈은 창 밖으로 밀려났다 — 남은 셈만 센다.
  assert.equal(budget.allow("s", t0 + 11 * 60_000), true);
});

/**
 * 되살리기 자신의 교체 close 가 예산을 지우는가 — 순수 클래스를 라우터에
 * 얹은 배선까지 보는 시험. 실제 데몬에서 manager.close 의 onState("closed") 는
 * 서버(server.ts)의 closed 경로를 타고 forgetReviveBudget 을 되부른다. 이
 * 시험은 그 배선을 그대로 흉내 낸다: 가짜 manager.close 가 닫힘 콜백을 태우고,
 * 콜백이 라우터의 forgetReviveBudget 을 부른다. 고장난 CLI 의 세계 — 세션이
 * 되살아나자마자 또 죽어(onState → error) 되살리기가 다시 일어난다.
 */
function brokenCliWorld() {
  const revived: string[] = [];
  const dead = {
    id: "s",
    state: "error" as const,
    revivePayload: { text: "화면을 고쳐 줘", attachments: [], pins: [] },
    provider: "claude",
    cwd: "/tmp/repo",
    title: "대화",
    chosen: {},
  };
  let onClosed: ((id: string) => void) | null = null;
  const router = new RequestRouter({
    manager: {
      get: () => dead,
      close: async (id: string) => onClosed?.(id),
      create: () => {
        revived.push(dead.id);
        return {
          id: dead.id,
          cwd: dead.cwd,
          providerLabel: "Claude Code",
          send: () => undefined,
        };
      },
      invalidateThreads: () => undefined,
    },
    agentDrivers: {
      get: () => ({ isAvailable: async () => ({ ok: true, executable: "/bin/claude" }) }),
    },
    fleet: {
      refreshThreads: () => undefined,
      projectInstructions: () => "",
      projectSummaries: () => [],
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    broadcast: () => undefined,
  } as unknown as RouterDeps);
  onClosed = (id) => router.forgetReviveBudget(id);
  return { router, revived };
}

test("되살리기 자신의 close 는 셈을 지우지 않는다 — 상한이 지켜진다", async () => {
  const { router, revived } = brokenCliWorld();
  for (let i = 0; i < MAX_AUTO_REVIVES; i += 1) await router.revive("s");
  assert.equal(revived.length, MAX_AUTO_REVIVES);
  // 상한을 넘은 되살리기는 크래시 카드가 있는 세계에 사람의 손만 남는다.
  await router.revive("s");
  assert.equal(revived.length, MAX_AUTO_REVIVES);
});
