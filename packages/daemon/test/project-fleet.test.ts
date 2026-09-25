import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatEvent } from "@colo-design/protocol";
import { ProjectFleet } from "../dist/project-fleet.js";

/**
 * 사이클 사건의 발송(emitCycleEvent) — 귀속 대화를 찾는 대체 경로가 클론의
 * 대화 목록 캐시를 한 줄로 덮어 썼다(원래 있던 결함): `list(cwd, 1)` 의 스캔이
 * SessionManager 의 디스크 캐시를 덮써, 다음 무효화 전까지 사이드바 목록이
 * 잘려 보였다. 조회는 사이드바의 새로 고침과 같은 기본 한도(50)로 읽어야 한다.
 */
test("사이클 사건의 대체 목록 조회는 기본 한도로 읽는다 — 캐시를 한 줄로 덮지 않는다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-fleet-"));
  try {
    const listLimits: Array<number | undefined> = [];
    const broadcasts: Array<{ type: string; sessionId: string }> = [];
    const fleet = new ProjectFleet({
      registry: { list: () => [] },
      manager: {
        get: () => undefined,
        all: () => [],
        list: async (_cwd: string, limit?: number) => {
          listLimits.push(limit);
          return [
            {
              sessionId: "stored-1",
              title: "첫 대화",
              lastModified: 2,
              live: false,
              state: "closed",
            },
            {
              sessionId: "stored-2",
              title: "둘째 대화",
              lastModified: 1,
              live: false,
              state: "closed",
            },
          ];
        },
        promptCount: async () => 0,
      },
      broadcast: (message: { type: string; sessionId: string }) => broadcasts.push(message),
    } as never);

    // private 길을 그대로 부른다 — 시험이 private 멤버에 닿는 유일한 길이라
    // 캐스트를 이름 있는 자리에 둔다(pull-before-send.test.ts 와 같은 모양).
    const emitCycleEvent: (
      workspaces: { slug: string; paths: { root: string; repoRoot: string } },
      event: ChatEvent,
    ) => void = (
      fleet as never as Record<
        string,
        (
          workspaces: { slug: string; paths: { root: string; repoRoot: string } },
          event: ChatEvent,
        ) => void
      >
    )["emitCycleEvent"].bind(fleet);

    emitCycleEvent(
      { slug: "p1", paths: { root: dir, repoRoot: join(dir, "repo") } },
      { kind: "cycle.merged", at: new Date().toISOString(), pr: 7 },
    );

    // cycleTail 은 비동기로 흐른다 — 그 약속 자체를 기다린다(방송까지 끝나야
    // 풀린다).
    await (fleet as never as Record<string, Promise<void>>)["cycleTail"];
    assert.equal(broadcasts.length, 1, "사건이 대화로 방송돼야 한다");
    assert.equal(broadcasts[0]?.sessionId, "stored-1", "가장 최근 저장 대화에 귀속");
    assert.deepEqual(
      listLimits,
      [undefined],
      "기본 한도(사이드바와 같은 50)로 읽는다 — 1 을 주면 캐시가 한 줄로 덮인다",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
