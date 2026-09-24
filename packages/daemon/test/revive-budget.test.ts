import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// `../dist` 임포트인 이유: revive-budget · dispatch 의 src 는 `.js` 지정자로
// 형제를 부른다 — src 직접 로드는 그 지정을 못 고친다(shelf-recover 와 같은 길).
import { RequestRouter, type RouterDeps } from "../dist/dispatch.js";
import { QueueStore } from "../dist/queue-store.js";
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
  budget.allow("s", 2_000);
  assert.equal(budget.allow("s", 3_000), false, "10분 안의 3회가 상한이다");
  budget.settled("s");
  assert.equal(budget.allow("s", 4_000), true);
});

test("10분 창 밖의 되살리기는 세지 않는다", () => {
  const budget = new ReviveBudget();
  const t0 = 1_000_000;
  assert.equal(budget.allow("s", t0), true);
  assert.equal(budget.allow("s", t0 + 60_000), true);
  assert.equal(budget.allow("s", t0 + 120_000), true);
  assert.equal(budget.allow("s", t0 + 180_000), false, "창 안의 3회가 상한이다");
  // 앞두 셈은 창 밖으로 밀려났다 — 남은 셈만 센다.
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
function brokenCliWorld(opts: { lost?: number } = {}) {
  const revived: string[] = [];
  const notices: string[] = [];
  const raised: Array<{ key: string; slug: string | null }> = [];
  const requeued: number[] = [];
  const dir = mkdtempSync(join(tmpdir(), "revive-budget-"));
  const queue = new QueueStore(dir);
  if (opts.lost !== undefined) {
    // lostAt 이 1분 전인 잃은 말 — 되살리기가 성공하면 대기 줄로 돌아간다.
    writeFileSync(
      join(dir, "queue-s.json"),
      JSON.stringify({
        held: [],
        lost: [
          ...Array.from({ length: opts.lost }, (_, i) => ({
            id: `lost${i}`,
            text: `잃은 말 ${i}`,
            attachments: [],
            lostAt: Date.now() - 60_000,
          })),
        ],
        inflight: null,
      }),
    );
  }
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
          restoreHeld: (items: unknown[]) => requeued.push(items.length),
        };
      },
      invalidateThreads: () => undefined,
    },
    agentDrivers: {
      get: () => ({ isAvailable: async () => ({ ok: true, executable: "/bin/claude" }) }),
    },
    fleet: {
      workspaces: new Map(),
      refreshThreads: () => undefined,
      projectInstructions: () => "",
      projectSummaries: () => [],
      workspaceOfSession: () => ({ slug: "proj" }),
    },
    queueStore: queue,
    developerNotice: {
      raise: async (problem: { key: string; slug: string | null }) => {
        raised.push(problem);
        return "issue" as const;
      },
      resolve: async () => undefined,
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    broadcast: (message: { event?: { text?: string } }) => {
      if (message.event?.text) notices.push(message.event.text);
    },
  } as unknown as RouterDeps);
  onClosed = (id) => router.forgetReviveBudget(id);
  return { router, revived, notices, raised, requeued, queue, dir };
}

test("되살리기 자신의 close 는 셈을 지우지 않는다 — 상한이 지켜진다", async () => {
  const { router, revived, dir } = brokenCliWorld();
  try {
    for (let i = 0; i < MAX_AUTO_REVIVES; i += 1) await router.revive("s");
    assert.equal(revived.length, MAX_AUTO_REVIVES);
    // 상한을 넘은 되살리기는 크래시 카드가 있는 세계에 사람의 손만 남는다.
    await router.revive("s");
    assert.equal(revived.length, MAX_AUTO_REVIVES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("되살리기가 성공하면 한 줄로 말하고 30분 안의 잃은 말을 대기 줄로 돌린다", async () => {
  const { router, notices, requeued, queue, dir } = brokenCliWorld({ lost: 2 });
  try {
    await router.revive("s");
    assert.ok(
      notices.some((text) => text === "AI 프로그램을 다시 켰어요 — 하던 일을 이어서 합니다"),
      "되살린 뒤의 한 줄이 나간다",
    );
    assert.deepEqual(requeued, [2], "잃은 말 두 건이 대기 줄로 돌아간다");
    assert.equal(queue.lostItems("s").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("되살리지 못하면(상한) 한 줄로 말하고 개발자 알림이 오른다 (PLAN L12)", async () => {
  const { router, revived, notices, raised, dir } = brokenCliWorld();
  try {
    for (let i = 0; i < MAX_AUTO_REVIVES; i += 1) await router.revive("s");
    await router.revive("s");
    assert.equal(revived.length, MAX_AUTO_REVIVES);
    assert.ok(
      notices.some((text) => text === "AI 프로그램이 멈췄어요 — 개발자에게 알렸어요"),
      "실패의 한 줄이 나간다",
    );
    assert.deepEqual(
      raised.map((problem) => problem.key),
      ["revive:exhausted"],
      "개발자 알림이 오른다",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
