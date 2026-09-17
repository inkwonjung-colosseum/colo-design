/**
 * 화면 확인 게이트 (screen-gate.ts) — 턴이 끝난 뒤 기계가 화면을 다시 열어
 * 보는 절차의 단위 검사. 가짜 드라이버로 돈다.
 *
 * 계약: 자리를 잡고 조용한 화면은 아무 말도 만들지 않는다. 자리를 못 잡았거나
 * error·실패한 요청이 있으면 그 화면만 브리프에 오른다. 경고는 세지 않는다 —
 * 레포 개발 빌드의 기본 소음이라 게이트가 그것으로 울면 매 턴이 멈춘다.
 *
 * Run: node --test packages/daemon/test/screen-gate.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readTurn } from "../../protocol/dist/turn-marker.js";
import { PreviewDrivers } from "../dist/preview-drivers.js";
import { gateBrief, inspectScreens, MAX_GATE_SCREENS } from "../dist/screen-gate.js";

/** 화면마다 다른 답을 주는 드라이버 — 연 순서도 기록한다. */
function fakeDriver(answers, opened = []) {
  let current = null;
  return {
    driver: {
      open: async (route, state) => {
        opened.push(state ? `${route}?${state}` : route);
        current = answers[route] ?? { settled: true, lines: [] };
        if (current.refuse) return { ok: false, reason: "없는 주소입니다" };
        return { ok: true, settled: current.settled !== false };
      },
      consoleLines: async () => current?.lines ?? [],
      destroy: async () => undefined,
    },
    opened,
  };
}

test("자리를 잡고 조용한 화면은 게이트를 울리지 않는다", async () => {
  const { driver, opened } = fakeDriver({
    "/member/MemberList": { settled: true, lines: [{ level: "log", text: "mounted" }] },
  });
  const troubles = await inspectScreens(driver, [{ route: "/member/MemberList", state: "기본" }]);
  assert.deepEqual(troubles, []);
  assert.deepEqual(opened, ["/member/MemberList?기본"], "판정은 그 화면을 실제로 열고 내린다");
});

test("경고는 세지 않고 error 와 실패한 요청만 센다", async () => {
  const { driver } = fakeDriver({
    "/a": { settled: true, lines: [{ level: "warn", text: "React key 경고" }] },
    "/b": {
      settled: true,
      lines: [
        { level: "warn", text: "무시" },
        { level: "error", text: "Cannot read properties of undefined" },
        { level: "net", text: "404 /api/members" },
      ],
    },
  });
  const troubles = await inspectScreens(driver, [
    { route: "/a", state: null },
    { route: "/b", state: null },
  ]);
  assert.equal(troubles.length, 1, "경고만 있는 화면은 오르지 않는다");
  assert.equal(troubles[0].route, "/b");
  assert.deepEqual(
    troubles[0].lines.map((line) => line.level),
    ["error", "net"],
  );
});

test("자리를 잡지 못한 화면은 조용해도 오른다", async () => {
  const { driver } = fakeDriver({ "/slow": { settled: false, lines: [] } });
  const troubles = await inspectScreens(driver, [{ route: "/slow", state: "비어 있음" }]);
  assert.equal(troubles.length, 1);
  assert.equal(troubles[0].unsettled, true);
  assert.deepEqual(troubles[0].lines, []);
});

test("열리지 않은 화면은 게이트의 판정이 아니다", async () => {
  const { driver } = fakeDriver({ "/gone": { refuse: true } });
  assert.deepEqual(await inspectScreens(driver, [{ route: "/gone", state: null }]), []);
});

test("한 턴이 다시 열어 보는 화면 수에는 상한이 있다", async () => {
  const { driver, opened } = fakeDriver({});
  const many = Array.from({ length: MAX_GATE_SCREENS + 3 }, (_, index) => ({
    route: `/s${index}`,
    state: null,
  }));
  await inspectScreens(driver, many);
  assert.equal(opened.length, MAX_GATE_SCREENS);
});

test("브리프는 gate 마커를 달고 화면마다 이유를 싣는다", () => {
  const brief = gateBrief([
    { route: "/pay/PayFailed", state: "오류", unsettled: true, lines: [] },
    {
      route: "/member/MemberList",
      state: null,
      unsettled: false,
      lines: [{ level: "error", text: "members.map is not a function" }],
    },
  ]);
  const read = readTurn(brief);
  assert.equal(read.marker?.kind, "gate");
  assert.equal(read.marker?.step, "화면 확인");
  assert.match(read.body, /\/pay\/PayFailed · 오류/);
  assert.match(read.body, /자리를 잡지 못했습니다/);
  assert.match(read.body, /error: members\.map is not a function/);
  // 기계 턴의 공통 규칙: 파일 경로도 컴포넌트 이름도 쓰지 않는다.
  assert.ok(!read.body.includes(".tsx"), read.body);
});

test("핀이 없는 턴은 게이트가 아무 화면도 다시 열지 않는다", async () => {
  // 게이트 재배선: AI 가 연 화면 같은 옛 입력은 게이트를 부르지 않는다 —
  // 사람이 pin·캡처로 가리킨 화면만 입력이다.
  const { driver, opened } = fakeDriver({});
  const drivers = new PreviewDrivers({
    factory: () => ({ for: () => driver, forIsolated: () => driver }),
    activeRepo: () => null,
    session: () => undefined,
    sessions: () => [],
    notice: () => undefined,
  });
  await drivers.runGate("s1");
  assert.deepEqual(opened, []);
});

test("게이트는 핀이 가리킨 화면만 다시 열어 판정을 실어 보낸다", async () => {
  const { driver, opened } = fakeDriver({
    "/pay/PayFailed": {
      settled: true,
      lines: [{ level: "error", text: "Cannot read properties of undefined" }],
    },
  });
  const sent = [];
  const notices = [];
  const drivers = new PreviewDrivers({
    factory: () => ({ for: () => driver, forIsolated: () => driver }),
    activeRepo: () => ({
      status: async () => ({ previewUrl: "http://127.0.0.1:4173/" }),
    }),
    session: (id) => ({ title: "대화", state: "idle", send: (text) => sent.push(text) }),
    sessions: () => [],
    notice: (n) => notices.push(n),
  });
  // 같은 화면·상태를 두 번 가리켜도 한 번 본다.
  drivers.notePinned("s1", "/member/MemberList", "기본");
  drivers.notePinned("s1", "/member/MemberList", "기본");
  drivers.notePinned("s1", "/pay/PayFailed", null);
  // preview origin 밖의 주소는 재검증 대상이 아니다.
  drivers.notePinned("s1", "http://elsewhere.example/steal", null);
  await drivers.runGate("s1");
  assert.deepEqual(opened, ["/member/MemberList?기본", "/pay/PayFailed"]);
  // 문제가 난 화면이 있으면 AI 에게 게이트 턴으로 돌아온다.
  assert.equal(sent.length, 1);
  assert.equal(readTurn(sent[0]).marker?.kind, "gate");
  assert.equal(notices[0]?.kind, "gate");
});
