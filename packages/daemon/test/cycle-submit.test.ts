// PLAN 단계 6 시험 — 캡처의 고아 브랜치(O4). 나머지 제출 장면(감독자 네 단계)은
// cycle-submit-flow.test.ts 가 감독자 하네스로 다룬다. 여기는 PublishCycle 의
// 몸통(runHandoff 의 캡처 구간)을 서버 없이 세운다.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { HandoffShot } from "@colo-design/protocol";
import { PublishCycle } from "../dist/repo-publish.js";
import { MemoryGitHub, makeClone, makeCore, makeRemote } from "./helpers/cycle-harness.ts";

const BRANCH = "colo-design/20260924-1";

/** 캡처 한 장 — PNG 마법넘버만 있어도 blob 으로는 충분하다. */
const shot = (route: string): HandoffShot => ({
  route,
  image: new TextEncoder().encode("\x89PNG\r\n\x1a\n가짜 캡처"),
  extension: ".png",
});

/** 원격의 ref 존재와 끝 sha — `git ls-remote`. */
function lsRemote(remotePath: string, ref: string): string {
  const out = execFileSync("git", ["ls-remote", remotePath, ref], { encoding: "utf8" });
  return out.trim().split("\t")[0] ?? "";
}

/** 사이클 브랜치에 커밋하고 PublishCycle 을 세운 표준 시작. */
async function setup() {
  const remote = await makeRemote();
  const clone = await makeClone(remote);
  const github = new MemoryGitHub(remote);
  const core = makeCore(clone, remote, { github });
  execFileSync("git", ["checkout", "-b", BRANCH], { cwd: clone.path });
  writeFileSync(join(clone.path, "screen.tsx"), "export default () => null;\n");
  execFileSync("git", ["add", "-A"], { cwd: clone.path });
  execFileSync("git", ["commit", "-m", "화면"], { cwd: clone.path });
  core.setCycle(BRANCH, null);
  const publish = new PublishCycle(core, { machineMemo: async () => null });
  return { remote, clone, github, core, publish };
}

test("캡처는 colo-design-assets 에 올라가고 사이클 브랜치 · 작업 트리는 깨끗하다", async () => {
  const scene = await setup();
  try {
    const status = await scene.publish.runHandoff({ shots: [shot("/member/MemberList")] });
    assert.equal(status.stage, "handed-off");

    // 원격에 자산 브랜치가 섰고 그 끝이 링크의 sha 다.
    const assetsSha = lsRemote(scene.remote.path, "refs/heads/colo-design-assets");
    assert.notEqual(assetsSha, "", "원격에 colo-design-assets 브랜치가 있어야 한다");
    const body = scene.github.pull(status.handoff?.number ?? 0)?.body ?? "";
    assert.ok(
      body.includes(`/blob/${assetsSha}/shots/${BRANCH}/-member-MemberList.png`),
      `본문 링크가 자산 커밋 sha 를 가리켜야 한다 — ${body}`,
    );
    // 사이클 브랜치에는 캡처가 없다 — 반영돼도 main 에 이미지가 쌓이지 않는다.
    const onBranch = execFileSync(
      "git",
      ["ls-tree", "--name-only", `origin/${BRANCH}`, ".colo-design/"],
      { cwd: scene.clone.path, encoding: "utf8" },
    ).trim();
    assert.equal(onBranch, "", "사이클 브랜치에 shots 가 없어야 한다");
    // 작업 트리도 건드리지 않는다.
    const status0 = execFileSync("git", ["status", "--porcelain"], {
      cwd: scene.clone.path,
      encoding: "utf8",
    });
    assert.equal(status0.trim(), "", "작업 트리가 깨끗해야 한다");

    // 두 번째 제출의 캡처는 같은 브랜치에 쌓인다(부모가 있다).
    await scene.publish.runHandoff({ shots: [shot("/order/OrderDetail")] });
    const assetsSha2 = lsRemote(scene.remote.path, "refs/heads/colo-design-assets");
    assert.notEqual(assetsSha2, "");
    assert.notEqual(assetsSha2, assetsSha, "자산 브랜치가 앞으로 간다");
  } finally {
    scene.clone.dispose();
    scene.remote.dispose();
  }
});

test("캡처 업로드가 실패해도 제출은 계속된다 — 원격을 죽인 세계", async () => {
  const scene = await setup();
  try {
    // 사이클 브랜치는 이미 올라간 뒤다 — 캡처 push 만 실패하는 세계를 만든다.
    execFileSync("git", ["push", "-u", "origin", BRANCH], { cwd: scene.clone.path });
    execFileSync("git", ["remote", "set-url", "origin", "http://127.0.0.1:1/nope.git"], {
      cwd: scene.clone.path,
    });
    // 자산 브랜치 fetch · push 는 실패하지만 PR 을 여는 GitHub 전송은 살아 있다.
    const status = await scene.publish.runHandoff({ shots: [shot("/x")] });
    assert.equal(status.stage, "handed-off");
    const body = scene.github.pull(status.handoff?.number ?? 0)?.body ?? "";
    assert.ok(!body.includes("화면 미리보기"), "캡처 절이 없어야 한다");
  } finally {
    scene.clone.dispose();
    scene.remote.dispose();
  }
});
