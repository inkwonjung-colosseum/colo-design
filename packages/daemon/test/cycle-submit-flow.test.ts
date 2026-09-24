// PLAN 단계 6 시험 — 감독자의 제출 네 단계 (L6). S9 입양 · 두 번 누르기 ·
// 네트워크 끊김 · 끝난 PR · 본문 보존 · 단계 예산 · 채팅 의도.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readLedger } from "../dist/cycle-ledger.js";
import { makeSupervisedScene, type SupervisedScene } from "./helpers/cycle-harness.ts";

const BRANCH = "colo-design/20260924-1";
const DEAD_REMOTE = "http://127.0.0.1:1/nope.git";

/** 클론에 커밋 — 도구의 자동 보관이 지나간 모양. */
async function commit(scene: SupervisedScene, files: Record<string, string>, message: string) {
  for (const [name, body] of Object.entries(files)) {
    const path = join(scene.clone.path, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  await scene.git(["add", "-A"]);
  await scene.git(["commit", "-m", message]);
}

/** 사이클 브랜치를 만들어 커밋하고 레지스트리에 싣는 표준 시작. */
async function cycleWith(scene: SupervisedScene, message = "회원 목록 화면") {
  await scene.git(["checkout", "-b", BRANCH]);
  await commit(scene, { "screen.tsx": "export default () => null;\n" }, message);
  scene.core.setCycle(BRANCH, null);
}

/** 원장 파일 읽기 — 감독자의 메모리가 아니라 기록을 본다. */
function ledgerOf(scene: SupervisedScene) {
  assert.ok(existsSync(scene.ledgerPath), "원장 파일이 있어야 한다");
  return readLedger(scene.ledgerPath);
}

test("제출 — 네 단계가 한 번에 서고 의도가 지워진다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await cycleWith(scene);
    scene.supervisor.submit("button");
    await scene.supervisor.settled();

    const ledger = ledgerOf(scene);
    assert.equal(ledger.submit, null, "네 단계가 모두 서면 의도가 지워진다");
    const handoff = scene.core.openHandoff;
    assert.ok(handoff, "레지스트리에 넘긴 요청이 적혀야 한다");
    assert.equal(handoff.state, "open");
    // 제목은 생성할 때만 — 초안(없음) → 프로젝트 이름 · 첫 커밋 제목.
    assert.equal(scene.github.pull(handoff.number)?.title, `하네스 프로젝트 · 회원 목록 화면`);
    const body = scene.github.pull(handoff.number)?.body ?? "";
    assert.ok(body.includes("colo-design:start"), "본문에 도구 구간이 있어야 한다");
    assert.ok(body.includes("바뀐 파일"), "본문에 바뀐 파일 절이 있어야 한다");
    assert.ok(
      scene.chatEvents.some((event) => event.kind === "cycle.handed"),
      "cycle.handed 사건이 나가야 한다",
    );
  } finally {
    await scene.dispose();
  }
});

test("S9 레지스트리가 PR 을 잃음 — head 로 입양, 새 PR 을 만들지 않는다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await cycleWith(scene);
    await scene.git(["push", "-u", "origin", BRANCH]);
    // 개발자 쪽에서 이미 열린 요청 — 레지스트리는 모른다(handoff null).
    const number = await scene.github.openPull({ head: BRANCH, title: "옛 제목" });

    scene.supervisor.submit("button");
    await scene.supervisor.settled();

    assert.equal(scene.core.openHandoff?.number, number, "같은 요청을 입양해야 한다");
    assert.equal(scene.github.pull(number)?.state, "open");
    assert.equal(scene.github.pull(number + 1), undefined, "새 PR 을 만들지 않는다");
    // 입양한 요청의 제목은 개발자(연 사람)의 것이다.
    assert.equal(scene.github.pull(number)?.title, "옛 제목");
    assert.equal(ledgerOf(scene).submit, null);
  } finally {
    await scene.dispose();
  }
});

test("두 번 눌러도 제출은 하나 — 의도가 다시 적히지 않고 PR 도 하나", async () => {
  const scene = await makeSupervisedScene();
  try {
    await cycleWith(scene);
    // 원격을 잠시 죽여 의도가 남아 있게 한다 — 두 번 누르는 찰나를 본다.
    await scene.git(["remote", "set-url", "origin", DEAD_REMOTE]);
    scene.supervisor.submit("button");
    await scene.supervisor.settled();
    const first = ledgerOf(scene).submit;
    assert.ok(first, "실패한 의도는 남아 있다");
    const firstAt = first.requestedAt;

    scene.supervisor.submit("button");
    await scene.supervisor.settled();
    assert.equal(ledgerOf(scene).submit?.requestedAt, firstAt, "의도가 다시 적히지 않는다");

    // 복구 뒤 한 번의 틱으로 끝까지 간다 — PR 하나.
    await scene.git(["remote", "set-url", "origin", scene.remote.path]);
    const push = ledgerOf(scene).push;
    assert.ok(push, "푸시 밀림이 원장에 적혀야 한다");
    scene.setNow(Date.parse(push.nextAttemptAt) + 1000);
    await scene.supervisor.tick("manual");
    assert.equal(ledgerOf(scene).submit, null, "복구 틱에 의도가 지워진다");
    assert.ok(scene.core.openHandoff, "PR 이 서야 한다");
    assert.equal(scene.github.pull(2), undefined, "PR 은 하나뿐이다");
  } finally {
    await scene.dispose();
  }
});

test("제출 중 네트워크 끊김 — ensurePushed 실패 · 의도 남음 → 복구 틱에 PR 이 선다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await cycleWith(scene);
    await scene.git(["remote", "set-url", "origin", DEAD_REMOTE]);
    scene.supervisor.submit("button");
    await scene.supervisor.settled();

    const ledger = ledgerOf(scene);
    assert.ok(ledger.submit, "의도가 남아 있어야 한다");
    assert.ok(ledger.push?.attempts === 1, "푸시 실패가 12행 원장에 남는다");
    assert.equal(scene.core.openHandoff, null, "PR 은 아직 못 연다");

    await scene.git(["remote", "set-url", "origin", scene.remote.path]);
    scene.setNow(Date.parse(ledger.push?.nextAttemptAt ?? "") + 1000);
    await scene.supervisor.tick("manual");

    assert.equal(ledgerOf(scene).submit, null, "복구 틱에 의도가 지워진다");
    assert.ok(scene.core.openHandoff, "PR 이 서야 한다");
  } finally {
    await scene.dispose();
  }
});

test("끝난 PR (merged) 이 레지스트리에 남은 채 제출 — 새 PR, 옛 PR 은 PATCH 되지 않는다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await cycleWith(scene);
    await scene.git(["push", "-u", "origin", BRANCH]);
    const number = await scene.github.openPull({ head: BRANCH, title: "옛 제목" });
    scene.github.editPull(number, { body: "옛 본문" });
    scene.core.setCycle(BRANCH, {
      number,
      url: `https://github.test/pull/${number}`,
      title: "옛 제목",
      state: "merged",
      branch: BRANCH,
    });
    await scene.github.merge(number);
    // 병합 착지(랜딩)는 아직 일어나지 않은 세계 — 감독자 틱이 land 를 돌기 전에
    // 제출이 먼저 눌렸다. 끝난 요청은 새 요청으로만 이어진다.

    scene.supervisor.submit("button");
    await scene.supervisor.settled();

    assert.equal(scene.github.pull(number)?.title, "옛 제목", "옛 PR 의 제목은 그대로");
    assert.equal(scene.github.pull(number)?.body, "옛 본문", "옛 PR 의 본문은 그대로");
    const handoff = scene.core.openHandoff;
    assert.ok(handoff && handoff.number !== number, "새 PR 이 열려야 한다");
    assert.equal(ledgerOf(scene).submit, null);
  } finally {
    await scene.dispose();
  }
});

test("개발자가 구간 밖에 쓴 글과 제목은 다시 제출해도 그대로다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await cycleWith(scene);
    scene.supervisor.submit("button");
    await scene.supervisor.settled();
    const number = scene.core.openHandoff?.number;
    assert.ok(number);

    // 개발자가 본문의 도구 구간 밖에 글을 쓰고 제목도 고친다.
    const before = scene.github.pull(number)?.body ?? "";
    scene.github.editPull(number, {
      title: "개발자가 고친 제목",
      body: `리뷰 메모 — 이 화면 승인 전에 검증해 주세요.\n\n${before}`,
    });

    // 작업이 더 쌓이고 다시 제출 — 도구 구간만 갱신된다.
    await commit(scene, { "screen2.tsx": "export default () => null;\n" }, "두 번째 화면");
    scene.supervisor.submit("button");
    await scene.supervisor.settled();

    const after = scene.github.pull(number)?.body ?? "";
    assert.equal(scene.github.pull(number)?.title, "개발자가 고친 제목", "제목은 그대로");
    assert.ok(after.startsWith("리뷰 메모"), "구간 밖의 첫 문단이 그대로");
    assert.ok(
      after.includes("두 번째 화면") || after.includes("screen2.tsx"),
      "도구 구간은 갱신된다",
    );
    assert.equal(scene.core.openHandoff?.number, number, "같은 요청에 쌓인다");
  } finally {
    await scene.dispose();
  }
});

test("단계 예산 — PR 생성이 계속 실패하면 다섯 번 뒤 submit:pr 알림 한 번", async () => {
  const scene = await makeSupervisedScene();
  try {
    await cycleWith(scene);
    await scene.git(["push", "-u", "origin", BRANCH]);
    scene.github.failPullCreates();

    scene.supervisor.submit("button");
    await scene.supervisor.settled();
    let ledger = ledgerOf(scene);
    assert.ok(ledger.submit, "의도가 남아 있다");

    // 백오프 창을 넘기며 네 번 더 실패시킨다.
    for (let i = 0; i < 4; i += 1) {
      const intent = ledgerOf(scene).submit;
      assert.ok(intent?.nextAttemptAt, "실패마다 백오프가 적힌다");
      scene.setNow(Date.parse(intent.nextAttemptAt) + 1000);
      await scene.supervisor.tick("manual");
    }
    ledger = ledgerOf(scene);
    assert.equal(ledger.budgets["submit:pr"]?.spent, 5, "예산이 5번 다했다");
    assert.equal(ledger.budgets["submit:pr"]?.escalated, true);
    assert.equal(
      scene.notices.filter((n) => n.key === "submit:pr").length,
      1,
      "알림은 한 번만 나간다",
    );

    // 여섯 번째 실패 — 알림은 늘지 않는다(시도는 백오프 간격으로 계속).
    const intent = ledgerOf(scene).submit;
    assert.ok(intent?.nextAttemptAt);
    scene.setNow(Date.parse(intent.nextAttemptAt) + 1000);
    await scene.supervisor.tick("manual");
    assert.equal(scene.notices.filter((n) => n.key === "submit:pr").length, 1);

    // 실패가 풀리면 알림이 거두어지고 제출이 끝난다 — 예산도 되감는다.
    const last = ledgerOf(scene).submit;
    assert.ok(last?.nextAttemptAt);
    scene.github.healPullCreates();
    scene.setNow(Date.parse(last.nextAttemptAt) + 1000);
    await scene.supervisor.tick("manual");
    assert.equal(ledgerOf(scene).submit, null, "복구되면 제출이 끝난다");
    assert.equal(ledgerOf(scene).budgets["submit:pr"], undefined, "예산이 되감긴다");
  } finally {
    await scene.dispose();
  }
});

test("채팅 제출 — submit(via chat) 이 원장에 chat 의도를 적는다", async () => {
  const scene = await makeSupervisedScene();
  try {
    await cycleWith(scene);
    await scene.git(["remote", "set-url", "origin", DEAD_REMOTE]);
    scene.supervisor.submit("chat");
    await scene.supervisor.settled();
    assert.equal(ledgerOf(scene).submit?.via, "chat", "의도의 출처가 chat 이어야 한다");
  } finally {
    await scene.dispose();
  }
});
