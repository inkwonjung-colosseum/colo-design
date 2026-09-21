/**
 * 방에서 돌아온 말은 자기가 가리키던 화면도 데리고 온다 (감사 2026-09-19 C4).
 *
 * 결함: 데몬은 `pins` 를 실어 보냈고 프로토콜의 `QueuedSendPayload` 에도
 * 자리가 있었는데, 웹의 `takeDropped` 가 `{ text, attachments }` 만 추려
 * 돌려주어 핀이 조용히 떨어졌다. 되살린 말을 다시 보내면 `onPinned` 가
 * 불리지 않아 `pinnedThisTurn` 이 비고 → `gatePossible` 이 false → 사람이
 * 가리킨 화면이 끝내 재검증되지 않는다. 게이트가 막기로 되어 있던
 * "콘솔에서 죽은 화면을 비개발자가 발견하는" 상황 그대로다.
 *
 * 이 시험은 데몬 쪽 절반(저장소가 핀을 왕복시키는가)을 못으로 박는다 —
 * 웹 절반은 타입(QueuedRestore)이 강제한다.
 *
 * Run: node --test packages/daemon/test/queue-pins.test.mjs
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const DIR = mkdtempSync(join(tmpdir(), "colo-queue-pins-"));
process.env.COLO_DESIGN_RUN_DIR = join(DIR, "run");
after(() => rmSync(DIR, { recursive: true, force: true }));

const { QueueStore } = await import("../dist/queue-store.js");

/**
 * 저장소의 손을 거치지 않고 방 파일을 쓴다 — 상한 검사의 재료(나이 순서, 수명이
 * 지난 lost)를 파일 시계의 분해능과 무관하게 고정하기 위해.
 */
function writeRoom(run, id, file, ageMs) {
  const path = join(run, `queue-${id}.json`);
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  const age = (Date.now() - ageMs) / 1000;
  utimesSync(path, age, age);
}

const PINS = [{ screen: "/member/MemberList" }, { screen: "/pay/PayFailed" }];

test("lost room 에서 되살린 말은 핀을 그대로 돌려준다", () => {
  const store = new QueueStore(join(DIR, "run"));
  const held = [{ id: "send-1", text: "이 두 화면을 고쳐 주세요", attachments: [], pins: PINS }];
  store.saveHeld("s1", held);
  store.moveHeldToLost("s1", held);

  const payload = store.takeLost("s1", "send-1");
  assert.equal(payload.text, "이 두 화면을 고쳐 주세요");
  assert.deepEqual(payload.pins, PINS, "핀이 함께 돌아와야 게이트가 다시 열어 본다");
});

test("핀 없이 보낸 말은 핀 없이 돌아온다 — 빈 배열을 지어내지 않는다", () => {
  const store = new QueueStore(join(DIR, "run"));
  const held = [{ id: "send-2", text: "핀 없는 말", attachments: [], pins: [] }];
  store.saveHeld("s2", held);
  store.moveHeldToLost("s2", held);

  const payload = store.takeLost("s2", "send-2");
  assert.equal(payload.text, "핀 없는 말");
  assert.equal(payload.pins, undefined);
});

/**
 * 첨부가 상한을 넘어 바이트가 버려지는 길(`truncated`)에서도 핀은 말의
 * 일부이지 첨부가 아니다 — 글자와 함께 살아남아야 한다.
 */
test("첨부가 잘린 말도 핀은 잃지 않는다", () => {
  const store = new QueueStore(join(DIR, "run"));
  const huge = "A".repeat(12 * 1024 * 1024);
  const held = [
    {
      id: "send-3",
      text: "큰 그림과 함께",
      attachments: [{ name: "big.png", mediaType: "image/png", data: huge }],
      pins: PINS,
    },
  ];
  store.saveHeld("s3", held);
  store.moveHeldToLost("s3", held);

  const payload = store.takeLost("s3", "send-3");
  assert.equal(payload.text, "큰 그림과 함께");
  assert.deepEqual(payload.attachments, [], "상한을 넘은 바이트는 버려진다");
  assert.deepEqual(payload.pins, PINS, "핀은 말의 일부다 — 첨부와 함께 버려지지 않는다");
});

test("고쳐서 보내기(removeHeld)도 같은 계약이다 — 대기 줄의 핀이 함께 나온다", async () => {
  const { Session } = await import("../dist/session.js");
  const pinned = [];
  const session = new Session(
    { cwd: process.cwd(), provider: "claude", providerLabel: "Claude" },
    {
      onEvent: () => undefined,
      onState: () => undefined,
      onPinned: (_id, pins) => pinned.push(...pins),
      onPermissionRequest: () => undefined,
      onQuestionRequest: () => undefined,
    },
  );
  session.attach({
    alive: true,
    send: async () => undefined,
    interrupt: async () => "answered",
    setMode: async () => undefined,
    close: async () => undefined,
  });

  // 첫 말이 턴을 열고, 둘째 말은 방에서 기다린다.
  session.send("첫 턴");
  session.send("기다리는 말", undefined, PINS);
  const [waiting] = session.heldItems();
  assert.ok(waiting, "둘째 말은 방에서 기다려야 한다");

  const payload = session.removeHeld(waiting.id);
  assert.equal(payload.text, "기다리는 말");
  assert.deepEqual(payload.pins, PINS, "꺼낸 말도 자기 화면을 데리고 나온다");

  await session.close();
});

// ---------------------------------------------------------------------------
// 결함 4 (E2E 2026-09-20 실측): 소비·폐기된 방 파일이 지워지지 않아
// `queue-*.json` 이 180건 쌓였고, 오래된 대기가 재시작 뒤 존재하지 않는
// 세션을 위한 새 스레드까지 만들었다. 방의 수명과 파일의 수명이 같아야 한다.
// ---------------------------------------------------------------------------

test("배달이 끝난 방은 파일도 남기지 않는다", () => {
  const store = new QueueStore(join(DIR, "run"));
  const file = join(DIR, "run", "queue-s-delivered.json");
  store.saveHeld("s-delivered", [{ id: "send-d", text: "배달될 말", attachments: [] }]);
  assert.equal(existsSync(file), true, "대기 중에는 방 파일이 있다");

  store.saveHeld("s-delivered", []);
  assert.equal(existsSync(file), false, "소비된 방이 빈 파일로 쌓이면 180건이 된다");
});

test("회복 패널의 마지막 말이 나가면(되살리기·버리기) 방 파일도 닫힌다", () => {
  const store = new QueueStore(join(DIR, "run"));
  const taken = [{ id: "send-t", text: "되살려질 말", attachments: [] }];
  store.saveHeld("s-take", taken);
  store.moveHeldToLost("s-take", taken);
  const takeFile = join(DIR, "run", "queue-s-take.json");
  assert.equal(existsSync(takeFile), true);
  store.takeLost("s-take", "send-t");
  assert.equal(existsSync(takeFile), false, "되살려 나간 뒤 빈 방이 남지 않는다");

  const dropped = [{ id: "send-x", text: "버려질 말", attachments: [] }];
  store.saveHeld("s-dismiss", dropped);
  store.moveHeldToLost("s-dismiss", dropped);
  const dismissFile = join(DIR, "run", "queue-s-dismiss.json");
  store.dismissLost("s-dismiss", "send-x");
  assert.equal(existsSync(dismissFile), false, "버려진 뒤 빈 방이 남지 않는다");
});

test("재시작 복원: 죽은 세션의 대기는 lost 로 간다 — 새 세션을 만들어 배달하지 않는다", () => {
  // 이 검사는 기동 청소가 방 디렉터리 전체를 훑으므로 다른 방과 갈라 놓는다.
  const run = join(DIR, "run-restart");
  const store = new QueueStore(run);
  store.saveHeld("s-dead", [{ id: "send-dead", text: "test", attachments: [] }]);

  // 데몬이 죽어 세션이 어디에도 살아 있지 않은 상태에서의 기동 청소.
  const swept = store.sweepOrphans();
  assert.equal(swept, 1, "대기가 남은 방 하나가 정리됐다");

  const file = JSON.parse(readFileSync(join(run, "queue-s-dead.json"), "utf8"));
  assert.equal(
    file.held.length,
    0,
    "죽은 세션의 대기는 어디에도 남지 않는다 — 배달을 노릴 수 없고, 새 세션에 넣을 것도 없다",
  );
  assert.deepEqual(
    store.lostItems("s-dead").map((row) => row.text),
    ["test"],
    "말은 lost 방에서 회복 패널이 읽는다 — 되살리기는 계획자의 손으로",
  );
});

test("저장소 상한: 치울 죽은 방이 없으면 초과분만큼 가장 오래된 대기부터 lost 로 편입된다", () => {
  const run = join(DIR, "run-cap");
  const store = new QueueStore(run);
  mkdirSync(run, { recursive: true });
  // 저장소의 손을 거치지 않고 방 파일을 쓴다 — mtime 이 곧 방의 나이다(시계의
  // 분해능과 무관하게 낡은 순서를 새긴다).
  const ROOMS = 202;
  for (let i = 1; i <= ROOMS; i++) {
    writeRoom(
      run,
      `cap-${String(i).padStart(3, "0")}`,
      { held: [{ id: `send-${i}`, text: `방 ${i}의 말`, attachments: [] }], lost: [] },
      (ROOMS - i) * 60_000,
    );
  }

  // 상한 위에서 일어난 다음 쓰기 — 한 번의 검사가 초과분만큼 걷는다.
  store.saveHeld("cap-202", [{ id: "send-202", text: "방 202의 말", attachments: [] }]);

  const folded = JSON.parse(readFileSync(join(run, "queue-cap-001.json"), "utf8"));
  assert.equal(folded.held.length, 0, "편입된 방에는 배달을 노릴 대기가 남지 않는다");
  assert.deepEqual(
    store.lostItems("cap-001").map((row) => row.text),
    ["방 1의 말"],
    "가장 오래된 말부터 회복 패널로 — 조용한 폐기가 아니라 기록이 있는 편입이다",
  );
  assert.deepEqual(
    store.lostItems("cap-002").map((row) => row.text),
    ["방 2의 말"],
  );

  const untouched = JSON.parse(readFileSync(join(run, "queue-cap-003.json"), "utf8"));
  assert.equal(untouched.held.length, 1, "상한 안의 방은 그대로다");
  assert.equal(untouched.held[0].text, "방 3의 말");
  assert.equal(untouched.lost.length, 0);
});

test("저장소 상한: 수명이 지난 lost 만 남은 방은 파일까지 치운다", () => {
  const run = join(DIR, "run-cap-dead");
  const store = new QueueStore(run);
  mkdirSync(run, { recursive: true });
  // 가장 오래된 자리에 죽은 방 둘 — 40일 전에 잃은 말만 남은 방이다(TTL 30일).
  const LONG_AGO = 40 * 24 * 60 * 60 * 1000;
  const deadRow = (id) => ({
    id,
    text: "오래된 말",
    attachments: [],
    lostAt: Date.now() - LONG_AGO,
  });
  writeRoom(run, "dead-001", { held: [], lost: [deadRow("old-1")] }, 41 * 24 * 60 * 60 * 1000);
  writeRoom(run, "dead-002", { held: [], lost: [deadRow("old-2")] }, 40 * 24 * 60 * 60 * 1000);
  for (let i = 1; i <= 200; i++) {
    writeRoom(
      run,
      `keep-${String(i).padStart(3, "0")}`,
      { held: [{ id: `send-${i}`, text: `방 ${i}의 말`, attachments: [] }], lost: [] },
      (200 - i) * 60_000,
    );
  }

  store.saveHeld("keep-200", [{ id: "send-200", text: "방 200의 말", attachments: [] }]);

  assert.equal(existsSync(join(run, "queue-dead-001.json")), false, "죽은 방은 파일도 남지 않는다");
  assert.equal(existsSync(join(run, "queue-dead-002.json")), false);
  const kept = JSON.parse(readFileSync(join(run, "queue-keep-001.json"), "utf8"));
  assert.equal(kept.held.length, 1, "회복 가능성을 침해할 필요가 없으면 대기는 그대로다");
});
