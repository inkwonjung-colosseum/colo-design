import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// 요약 대화 기록의 자리(Claude 설정 폴더)를 임시 폴더로 — 위생의 정리가
// 사용자의 ~/.claude 를 겨누지 않게(cycle-hygiene.test.ts 와 같은 까닭).
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "colo-s12-claude-"));

import { makeSupervisedScene, type SupervisedScene } from "./helpers/cycle-harness.ts";

const DAY = 24 * 60 * 60 * 1000;

/** 한 사이클 — 보관 · 제출(한 틱: 5행이 13행보다 앞선다) → 병합 → 랜딩(하루 뒤). */
async function cycle(scene: SupervisedScene, i: number, now: number): Promise<void> {
  // AI 가 화면 파일을 고친 모양 — 제출의 틱에서 5행이 보관하고 12행이 올린 뒤 13행이 PR 을 연다.
  writeFileSync(join(scene.clone.path, `screen-${i}.tsx`), `export const n = ${i};\n`);
  scene.supervisor.submit("button");
  await scene.supervisor.settled();
  const pr = scene.core.openHandoff?.number;
  assert.ok(pr !== undefined, `${i}번째 제출이 PR 을 열어야 한다`);
  // 개발자가 GitHub 에서 합쳤다 — 병합 커밋과 스쿼시를 번갈아.
  await scene.github.merge(pr, i % 2 === 0 ? "squash" : "merge");
  // 하루 뒤 — 8행이 베이스로 돌아오고, 위생이 하루 몫(정리 · 이동 · 디스크)을 돈다.
  scene.setNow(now);
  await scene.supervisor.tick("manual");
  assert.equal(scene.core.branch, null, `${i}번째 사이클이 랜딩해야 한다`);
}

test("S12 (축소판) — 사이클 20번(보관 · 제출 · 병합 · 랜딩) 뒤 로컬 브랜치 · stash · 임시 폴더 수가 늘지 않는다", async () => {
  const scene = await makeSupervisedScene();
  try {
    const project = dirname(scene.clone.path);
    const census = async () => ({
      branches: (await scene.git(["branch", "--list"])).split("\n").filter(Boolean).length,
      stashes: (await scene.git(["stash", "list"])).split("\n").filter(Boolean).length,
      // 구해 둔 폴더(salvage) 밖의 프로젝트 폴더와, 그 안 요약 폴더 · .git 안의 도구 흔적.
      project: readdirSync(project)
        .filter((name) => name !== "salvage")
        .sort(),
      summary: readdirSync(project).includes("summary")
        ? readdirSync(join(project, "summary")).length
        : 0,
      gitTool: readdirSync(join(scene.clone.path, ".git"))
        .filter((name) => name.startsWith("colo-design"))
        .sort(),
    });
    let now = Date.parse("2026-09-01T09:00:00.000Z");
    scene.setNow(now);
    // 예열 한 바퀴 — 처음 한 번만 생기는 것(첫 제출의 요약 폴더 · 위생의 첫 기록)을
    // 기준선에 넣는다. 잣대는 사이클이 거듭될 때 늘어나는지다.
    now += DAY;
    await cycle(scene, 0, now);
    const before = await census();

    for (let i = 1; i <= 20; i += 1) {
      now += DAY;
      await cycle(scene, i, now);
    }

    assert.deepEqual(await census(), before);
    // 예열까지 21개의 요청이 베이스에 합쳐졌다(병합 커밋 10 · 스쿼시 11).
    const log = await scene.git(["log", "--format=%s", "origin/main"]);
    assert.equal(log.split("\n").filter((line) => /pull request #\d+/i.test(line)).length, 21);
  } finally {
    await scene.dispose();
  }
});
