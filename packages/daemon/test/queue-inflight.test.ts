import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { QueueStore } from "../dist/queue-store.js";
// 이 시험은 빌드 뒤에 돈다(루트 pnpm test = build → node --test). queue-store 은
// environment.js 를 데리고 있어 src 직접 로드가 안 되고, 형제 시험들의 순수
// 모듈 전통과 달리 여기는 dist 를 본다. Session 도 마찬가지다(.js 형제 지정).
import { Session } from "../dist/session.js";

function store(): { queue: QueueStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "queue-inflight-"));
  return { queue: new QueueStore(dir), dir };
}

function send(id: string, text: string) {
  return { id, text, attachments: [] };
}

test("진행 중인 말은 디스크에 남고, 턴이 끝나면 지워진다", () => {
  const { queue, dir } = store();
  try {
    queue.saveInflight("s1", send("a", "회원 목록 화면을 개선해 줘"));
    assert.equal(queue.lostItems("s1").length, 0, "진행 중은 lost 가 아니다");
    queue.clearInflight("s1");
    queue.clearInflight("s1"); // 없는 지우기는 조용하다
    assert.equal(queue.lostItems("s1").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("대기 줄 저장이 진행 중인 말을 덮어쓰지 않는다", () => {
  const { queue, dir } = store();
  try {
    queue.saveInflight("s2", send("a", "도는 턴의 말"));
    queue.saveHeld("s2", [send("b", "다음 턴의 말")]);
    queue.clearInflight("s2");
    const lost = queue.lostItems("s2");
    assert.equal(lost.length, 0, "held 는 lost 가 아니다");
    // 되살리기로 진행 중이던 말이 그대로 돌아오는지는 기동 청소가 증명한다
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("기동 청소는 데몬이 죽은 채 남은 진행 중인 말을 lost 로 옮겨 회복 패널에 준다", () => {
  const { queue, dir } = store();
  try {
    queue.saveInflight("s3", send("a", "회원 목록 화면을 개선해 줘"));
    queue.saveHeld("s3", [send("b", "대기 중이던 말")]);
    const swept = queue.sweepOrphans();
    assert.equal(swept, 1);
    const lost = queue.lostItems("s3");
    assert.equal(lost.length, 2, "진행 중이던 말과 대기 말이 모두 회복된다");
    const texts = lost.map((item) => item.text);
    assert.ok(texts.includes("회원 목록 화면을 개선해 줘"));
    assert.ok(texts.includes("대기 중이던 말"));
    // 회복된 방은 더 이상 고아가 아니다
    assert.equal(queue.sweepOrphans(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("진행 중인 말만 남은 방도 파일 수 상한 정리에서 회복성을 잃지 않는다", () => {
  const { queue, dir } = store();
  try {
    queue.saveInflight("s4", send("a", "혼자 남은 진행 중인 말"));
    // 상한 정리는 비공개 — 기동 청소가 같은 길을 지나므로 여기선 고아 판정만 본다
    assert.equal(queue.sweepOrphans(), 1);
    assert.equal(queue.lostItems("s4").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("말마다 시각이 찍힌다 — inflight 는 since, 대기 말은 queuedAt (PLAN L12)", () => {
  const { queue, dir } = store();
  try {
    const now = Date.now();
    queue.saveInflight("t1", send("a", "도는 턴의 말"));
    queue.saveHeld("t1", [send("b", "대기 말")]);
    const recoveries = queue.takeStartupRecoveries(now + 1_000);
    assert.equal(recoveries.length, 1);
    const [recovery] = recoveries;
    // 1초 뒤에 읽었으니 둘 다 살아 있는 잣대 안이다.
    assert.ok(recovery?.inflight.id === "a");
    assert.equal(recovery?.held.length, 1);
    assert.ok(recovery?.held[0]?.id === "b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("시작 복구 — 2시간 안의 inflight 는 브리프가 이어받고, 밖은 lost 로 간다", () => {
  const { queue, dir } = store();
  try {
    const now = Date.now();
    // 2시간 안 — 회복.
    queue.saveInflight("fresh", send("a", "방금 죽은 턴의 말"));
    // 2시간 밖 — 옛 판의 방 파일처럼 시각이 없는 것도 오래된 것이다.
    queue.saveInflight("stale", send("b", "오래된 턴의 말"));
    const stalePath = join(dir, "queue-stale.json");
    const staleFile = JSON.parse(readFileSync(stalePath, "utf8"));
    delete staleFile.inflight.since;
    writeFileSync(stalePath, JSON.stringify(staleFile));

    const recoveries = queue.takeStartupRecoveries(now);
    assert.deepEqual(
      recoveries.map((recovery) => recovery.sessionId),
      ["fresh"],
    );
    // 회복으로 꺼낸 방은 더 이상 고아가 아니다. 남은 방은 청소가 lost 로.
    assert.equal(queue.sweepOrphans(), 1);
    assert.equal(queue.lostItems("stale").length, 1);
    assert.equal(queue.lostItems("fresh").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("시작 복구 — 대기 말은 30분 안의 것만 함께 돌아간다", () => {
  const { queue, dir } = store();
  try {
    const now = Date.now();
    queue.saveInflight("s9", send("a", "도는 턴의 말"));
    queue.saveHeld("s9", [send("b", "방금 기다린 말")]);
    // 대기 말을 오래된 것으로 만든다 — queuedAt 을 1시간 전으로.
    const path = join(dir, "queue-s9.json");
    const file = JSON.parse(readFileSync(path, "utf8"));
    for (const item of file.held) {
      if (item.id === "b") item.queuedAt = now - 60 * 60_000;
    }
    writeFileSync(path, JSON.stringify(file));

    const [recovery] = queue.takeStartupRecoveries(now);
    assert.equal(recovery?.held.length, 0, "오래된 대기 말은 회복하지 않는다");
    // 오래된 대기 말은 방에 남아 청소가 lost 로 거둔다.
    queue.sweepOrphans();
    assert.equal(queue.lostItems("s9").length, 1);
    assert.ok(queue.lostItems("s9")[0]?.text.includes("기다린 말"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("잃은 말의 자동 복귀 — 30분 안의 것만 꺼낸다 (PLAN L12)", () => {
  const { queue, dir } = store();
  try {
    const now = Date.now();
    // lostAt 이 제각각인 방을 직접 쓴다 — moveHeldToLost 는 지금 시각만 찍는다.
    writeFileSync(
      join(dir, "queue-s10.json"),
      JSON.stringify({
        held: [],
        lost: [
          { id: "fresh", text: "방금 잃은 말", attachments: [], lostAt: now - 60_000 },
          { id: "stale", text: "오래 잃은 말", attachments: [], lostAt: now - 3 * 60 * 60_000 },
        ],
        inflight: null,
      }),
    );
    const fresh = queue.takeFreshLost("s10", 30 * 60_000, now);
    assert.deepEqual(
      fresh.map((item) => item.id),
      ["fresh"],
    );
    const left = queue.lostItems("s10");
    assert.deepEqual(
      left.map((item) => item.id),
      ["stale"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("정상 종료(shutdown) 는 inflight 를 지우지 않고, user 닫힘은 지운다 (PLAN L12)", async () => {
  const { queue, dir } = store();
  try {
    const shutdown = new Session(
      {
        cwd: tmpdir(),
        sessionId: "shutdownkept",
        queueDiskFor: (id) => queue.for(id),
      },
      minimalEvents(),
    );
    shutdown.send("앱이 꺼질 때 돌던 말");
    await shutdown.close("shutdown");
    const [recovery] = new QueueStore(dir).takeStartupRecoveries();
    assert.equal(recovery?.inflight.text, "앱이 꺼질 때 돌던 말");

    const user = new Session(
      {
        cwd: tmpdir(),
        sessionId: "usergone",
        queueDiskFor: (id) => queue.for(id),
      },
      minimalEvents(),
    );
    user.send("사용자가 닫은 대화의 말");
    await user.close("user");
    assert.equal(new QueueStore(dir).takeStartupRecoveries().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 세션 단위 시험이 건네는 최소 이벤트 — 아무 일도 하지 않는 받침. */
function minimalEvents() {
  return {
    onEvent: () => undefined,
    onState: () => undefined,
    onPermissionRequest: () => undefined,
    onQuestionRequest: () => undefined,
  };
}
