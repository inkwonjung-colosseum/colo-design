import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DriverRegistry } from "../dist/agent/registry.js";
import { SessionManager } from "../dist/session-manager.js";

/**
 * 무효화 뒤의 재스캔 — 한 번 끝난 스캔 엔트리를 `diskStale` 무효화가 다시
 * 기다리면 옛 결과만 돌아와 새 대화가 목록에 절대 뜨지 않는다(실사: 데몬이
 * 도는 동안 터미널·다른 창이 남긴 대화록이 사이드바에 영원히 나타나지 않았다).
 * 끝난 스캔은 공유가 아니다 — 무효화마다 새 스캔이 서야 한다.
 */

function managerWithStore(rows: Array<{ id: string; title: string; lastModified: number }>) {
  const calls: number[] = [];
  const registry = new DriverRegistry();
  registry.register({
    id: "claude",
    name: "Claude",
    isAvailable: async () => ({ ok: true }),
    oneShot: async () => null,
    loginCommand: () => null,
    createSession: () => {
      throw new Error("unused");
    },
    store: {
      list: async () => {
        calls.push(Date.now());
        return rows.map((row) => ({ ...row, provider: "claude" }));
      },
    },
  } as never);
  const events = { onEvent: () => {}, onState: () => {} };
  return { manager: new SessionManager(events, registry), calls };
}

test("무효화는 끝난 스캔을 재사용하지 않는다 — 클론에 새 대화록이 생기면 다음 목록이 그것을 본다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-rescan-"));
  try {
    // 스토어는 이 배열을 공유한다 — 밀어 넣으면 다음 스캔이 그것을 본다.
    const rows = [{ id: "first", title: "처음 대화", lastModified: 1 }];
    const { manager, calls } = managerWithStore(rows);
    const cwd = dir;

    // 첫 스캔 — 한 줄. 끝난 스캔의 엔트리가 scanning 에 남는다.
    const first = await manager.list(cwd);
    assert.deepEqual(
      first.map((row) => row.sessionId),
      ["first"],
    );
    assert.equal(calls.length, 1);

    // 다른 길(터미널 · 다른 창)이 대화록을 남긴 뒤 세션 사건이 무효화한다 —
    // 스토어는 이제 둘을 본다.
    rows.push({ id: "later", title: "나중에 생긴 대화", lastModified: 2 });
    manager.invalidateThreads(cwd);

    const second = await manager.list(cwd);
    assert.deepEqual(
      second.map((row) => row.sessionId).sort(),
      ["first", "later"],
      "무효화 뒤 목록은 저장소를 다시 읽어야 한다 — 끝난 스캔을 기다리면 빈둥거린다",
    );
    assert.equal(calls.length, 2, "무효화마다 새 스캔 — 결론 난 스캔은 재사용되지 않는다");

    // 무효화 없이 다시 부르면 캐시 — 또 훑지 않는다.
    const third = await manager.list(cwd);
    assert.equal(calls.length, 2);
    assert.equal(third.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("살아 있는 스캔 하나는 동시 독자가 나눈다 — 팬아웃이 한 번만 돈다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-rescan-"));
  try {
    const { manager, calls } = managerWithStore([{ id: "one", title: "대화", lastModified: 1 }]);
    const cwd = dir;
    const [a, b] = await Promise.all([manager.list(cwd), manager.list(cwd)]);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(calls.length, 1, "in-flight 스캔은 하나 — 두 번째 독자는 기다린다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
