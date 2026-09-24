import assert from "node:assert/strict";
import { test } from "node:test";
// `../dist` 임포트인 이유: 형제를 `.js` 지정자로 부르는 모듈은 src 직접 로드가
// 그 지정을 못 고친다(cycle-observe.test.ts 와 같은 길).
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
