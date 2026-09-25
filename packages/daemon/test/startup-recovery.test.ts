import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// `../dist` 임포트인 이유: dispatch 는 형제(.js 지정자)를 부른다 — src 직접
// 로드는 그 지정을 못 고친다(revive-budget 와 같은 길). 세션 · 저장소는 가짜로.
import { RequestRouter, type RouterDeps } from "../dist/dispatch.js";
import { QueueStore } from "../dist/queue-store.js";

/** 가짜 개발자 알림 — 올라가고 거둬지는 문제만 기록한다. */
function fakeNotice() {
  const raised: Array<{ key: string; slug: string | null; detail?: string }> = [];
  const resolved: Array<{ key: string; slug: string | null }> = [];
  return {
    raised,
    resolved,
    notice: {
      raise: async (problem: { key: string; slug: string | null; detail?: string }) => {
        raised.push(problem);
        return "issue" as const;
      },
      resolve: async (key: string, slug: string | null) => {
        resolved.push({ key, slug });
      },
    },
  };
}

/** 만들어진 대화 — 브리프가 내려놓은 말과 돌려받은 대기 말을 기록한다. */
function fakeManagerWorld(
  opts: { dead?: unknown; storedProvider?: string; queueStore?: QueueStore } = {},
) {
  const created: Array<{
    resume: string | undefined;
    sent: string[];
    heldBack: number;
  }> = [];
  let onClosed: ((id: string) => void) | null = null;
  const router = new RequestRouter({
    manager: {
      get: () => (opts.dead === undefined ? undefined : opts.dead),
      close: async (id: string) => onClosed?.(id),
      create: (options: { launch?: { resume?: string } }) => {
        const record = { resume: options.launch?.resume, sent: [] as string[], heldBack: 0 };
        created.push(record);
        return {
          id: options.launch?.resume ?? "new",
          cwd: "/tmp",
          provider: "claude",
          providerLabel: "Claude Code",
          send: (text: string) => record.sent.push(text),
          restoreHeld: (items: unknown[]) => {
            record.heldBack = items.length;
          },
        };
      },
      invalidateThreads: () => undefined,
      findStoredProvider: async () => opts.storedProvider,
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
    registry: {
      activeSlug: () => null,
      list: () => (opts.storedProvider === undefined ? [] : [{ slug: "proj" }]),
      paths: () => ({ repoRoot: tmpdir() }),
    },
    ...(opts.queueStore ? { queueStore: opts.queueStore } : {}),
    queueDiskFor: () => {
      throw new Error("이 시험은 디스크 손잡이를 쓰지 않는다");
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    broadcast: () => undefined,
  } as unknown as RouterDeps);
  onClosed = (id) => router.forgetReviveBudget(id);
  return { router, created };
}

test("시작 브리프 — 2시간 안의 inflight 는 brief 표식의 턴 한 번으로 이어받는다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "startup-recovery-"));
  try {
    const queue = new QueueStore(dir);
    queue.saveInflight("thread1", {
      id: "a",
      text: "회원 목록 화면을 고쳐 줘\n둘째 줄도 있다",
      attachments: [],
    });
    queue.saveHeld("thread1", [{ id: "b", text: "이어서 할 말", attachments: [] }]);
    const recoveries = queue.takeStartupRecoveries();
    assert.equal(recoveries.length, 1);

    const { router, created } = fakeManagerWorld({ storedProvider: "claude", queueStore: queue });
    await router.recoverStartupTurns(recoveries);
    assert.equal(created.length, 1, "같은 id 의 대화를 하나 되살린다");
    assert.equal(created[0]?.resume, "thread1");
    assert.equal(created[0]?.heldBack, 1, "살아 남은 대기 말을 방에 돌려놓는다");
    const brief = created[0]?.sent[0] ?? "";
    assert.ok(brief.startsWith("<!-- colo-design:brief "), "brief 표식의 턴이다");
    assert.ok(
      brief.includes("직전 요청이 중단됐습니다: 회원 목록 화면을 고쳐 줘"),
      "원문 첫 줄이 실린다",
    );
    assert.ok(!brief.includes("둘째 줄"), "첫 줄만 실린다");
    assert.equal(created[0]?.sent.length, 1, "브리프는 한 번만 나간다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("시작 브리프 — 저장소가 잊은 대화는 lost 로 돌아가 회복의 길을 지킨다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "startup-recovery-"));
  try {
    const queue = new QueueStore(dir);
    queue.saveInflight("ghost", { id: "a", text: "어느 클론에도 없는 말", attachments: [] });
    const recoveries = queue.takeStartupRecoveries();
    const { router, created } = fakeManagerWorld({ storedProvider: undefined, queueStore: queue });
    await router.recoverStartupTurns(recoveries);
    assert.equal(created.length, 0, "세션을 만들지 않는다");
    assert.equal(queue.lostItems("ghost").length, 1, "말은 lost 방에 돌아온다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("사다리 소진은 turn:failed 를 올리고 그 프로젝트의 성공 턴이 거둔다 (PLAN L12)", async () => {
  const notice = fakeNotice();
  const router = new RequestRouter({
    fleet: {
      refreshThreads: () => undefined,
      projectInstructions: () => "",
      workspaceOfSession: () => ({ slug: "proj" }),
    },
    developerNotice: notice.notice,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    broadcast: () => undefined,
  } as unknown as RouterDeps);
  await router.noteTurnFailed("s", "temporary failure x5");
  assert.equal(notice.raised.length, 1);
  assert.equal(notice.raised[0]?.key, "turn:failed");
  assert.equal(notice.raised[0]?.slug, "proj");
  assert.ok(notice.raised[0]?.detail?.includes("temporary failure"));
  await router.settleProjectTurns("s");
  assert.deepEqual(
    notice.resolved.map((row) => row.key).sort(),
    ["revive:exhausted", "turn:failed"],
    "성공 턴이 두 알림을 모두 거둔다",
  );
});

test("이미 살아 있는 대화는 시작 브리프가 건드리지 않는다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "startup-recovery-"));
  try {
    const queue = new QueueStore(dir);
    queue.saveInflight("alive", { id: "a", text: "사람이 먼저 연 대화", attachments: [] });
    const recoveries = queue.takeStartupRecoveries();
    const { router, created } = fakeManagerWorld({
      storedProvider: "claude",
      dead: { id: "alive", state: "idle" },
    });
    await router.recoverStartupTurns(recoveries);
    assert.equal(created.length, 0, "사람이 먼저 열었다 — 브리프를 열지 않는다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
