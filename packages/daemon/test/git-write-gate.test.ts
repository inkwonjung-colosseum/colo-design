import assert from "node:assert/strict";
import { test } from "node:test";
// `../dist` 임포트인 이유: 형제를 `.js` 지정자로 부르는 모듈은 src 직접 로드가
// 그 지정을 못 고친다(cycle-observe.test.ts 와 같은 길).
import { guidanceFor } from "@colo-design/protocol";
import { GIT_WRITE_REFUSAL, gitWriteDenied } from "../dist/session.js";

// PLAN L5 · 단계 3: 세션의 git 쓰기는 예외 없이 거절된다 — 옛 MERGE_HEAD 문은
// 닫혔다. 판정은 순수 함수라 MERGE_HEAD 의 유무가 결과를 바꾸지 않는다(그
// 파일을 읽는 길 자체가 없다).

test("git 쓰기 동사는 전부 거절 — commit · push · merge · reset · checkout", () => {
  for (const cmd of [
    "git commit -m x",
    "git commit --no-edit",
    "git push origin main",
    "git merge --abort",
    "git merge --no-edit origin/main",
    "git reset --hard HEAD",
    "git checkout -b foo",
    "git cherry-pick --continue",
    "git rebase --abort",
    "git stash pop",
    "git stash drop",
    "git stash",
    "git add src/a.ts && git commit -m x",
  ]) {
    assert.equal(gitWriteDenied(cmd), true, `${cmd} 는 거절돼야 한다`);
  }
});

test("git 읽기는 열어 둔다 — status · log · diff · fetch · stash list", () => {
  for (const cmd of [
    "git status --porcelain",
    "git log --oneline -5",
    "git diff --name-only",
    "git fetch origin main",
    "git stash list",
    "git stash show",
    "git config --get user.name",
    "git rev-parse HEAD",
  ]) {
    assert.equal(gitWriteDenied(cmd), false, `${cmd} 는 읽기라 열려야 한다`);
  }
});

test("MERGE_HEAD 가 있어도 commit 은 거절 — 판정이 그 파일을 읽지 않는다", () => {
  // 옛 문은 MERGE_HEAD 가 있으면 commit · add 를 열어 줬다. 지금의 판정은
  // 명령의 모양만 본다 — 충돌 정리 중의 커밋도 같은 거절이다.
  assert.equal(gitWriteDenied("git commit --no-edit"), true);
  assert.equal(gitWriteDenied("git add -- src/a.ts"), true);
});

test("거절 문장은 git 명령을 시키지 않는다", () => {
  assert.ok(!/git (add|commit|stash|push|merge)/.test(GIT_WRITE_REFUSAL));
  assert.ok(GIT_WRITE_REFUSAL.includes("파일만 고쳐"));
});

// 준비 실패의 안내(repo-guidance)는 AI 에게 git 쓰기를 시켜서는 안 된다 —
// 세션의 git 가드(PLAN L5)가 참조 변경을 막으니 시키는 순간 불가능한 과제가
// 된다. clone 안내가 "이 머신의 git 인증으로 직접 clone 하거나" 라고 했던 것이
// 이 결함이다.
test("준비 실패 안내의 브리프에는 git 쓰기 동사가 없다 — clone 직접 시도는 못 한다", () => {
  for (const kind of [
    "auth",
    "pnpm",
    "conflict",
    "install",
    "no-preview-command",
    "port-undetected",
    "preview",
    "clone",
    "unknown",
  ] as const) {
    const guidance = guidanceFor(kind, "fatal: unable to access 'https://github.com/o/r.git/'");
    assert.ok(guidance.agent, `${kind} 안내는 AI 브리프가 있다`);
    assert.equal(
      gitWriteDenied(guidance.agent?.brief ?? ""),
      false,
      `${kind} 브리프에 git 쓰기가 있으면 안 된다`,
    );
  }
  // clone 안내는 다시 받는 주체가 도구임을 말한다.
  const clone = guidanceFor("clone", null);
  assert.ok(clone.agent?.brief.includes("git 명령 없이"));
  assert.ok(clone.agent?.brief.includes("스스로 다시 받습니다"));
});
