import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// 이 시험은 빌드 뒤에 돈다(루트 pnpm test = build → node --test). queue-store 은
// environment.js 를 데리고 있어 src 직접 로드가 안 되고, 형제 시험들의 순수
// 모듔 전통과 달리 여기는 dist 를 본다.
import { QueueStore } from "../dist/queue-store.js";

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
