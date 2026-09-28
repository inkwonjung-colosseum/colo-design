import assert from "node:assert/strict";
import { test } from "node:test";

// 데스크톱 메인의 순수 문 — electron 을 부르지 않는 파일이라 경로로 직접 들어온다
// (invite-discard.test.ts 가 desktop 의 순수 파일을 읽는 것과 같은 길).
const { benchEndpointBody, benchEndpointPath, benchEndpointPid } = await import(
  new URL("../../desktop/src/bench-endpoint.ts", import.meta.url).href
);

test("벤치 접속 파일 — 패키징된 앱은 env 가 있어도 절대 쓰지 않는다", () => {
  assert.equal(
    benchEndpointPath({ NOVA_DESIGN_BENCH_ENDPOINT: "/tmp/nova-bench.json" }, true),
    null,
  );
});

test("벤치 접속 파일 — env 가 없거나 빈 값이면 쓰지 않는다", () => {
  assert.equal(benchEndpointPath({}, false), null);
  assert.equal(benchEndpointPath({ NOVA_DESIGN_BENCH_ENDPOINT: "" }, false), null);
  assert.equal(benchEndpointPath({ NOVA_DESIGN_BENCH_ENDPOINT: "   " }, false), null);
  assert.equal(benchEndpointPath({ NOVA_DESIGN_BENCH_ENDPOINT: undefined }, false), null);
});

test("벤치 접속 파일 — 값이 있으면 그 경로를 그대로 준다", () => {
  assert.equal(
    benchEndpointPath({ NOVA_DESIGN_BENCH_ENDPOINT: "/tmp/nova-bench.json" }, false),
    "/tmp/nova-bench.json",
  );
});

test("벤치 접속 파일 — 본문은 JSON 한 줄이다", () => {
  const body = benchEndpointBody({
    url: "ws://127.0.0.1:54321/?token=abc",
    pid: 4242,
    now: new Date("2026-09-28T09:30:00.000Z"),
  });
  const lines = body.split("\n");
  assert.equal(lines.length, 2); // JSON 한 줄 + 끝의 개행
  assert.equal(lines[1], "");
  const data = JSON.parse(lines[0]);
  assert.equal(data.url, "ws://127.0.0.1:54321/?token=abc");
  assert.equal(data.pid, 4242);
  assert.equal(data.startedAt, "2026-09-28T09:30:00.000Z");
});

test("벤치 접속 파일 — pid 판정은 깨진 본문에 정직하다", () => {
  assert.equal(benchEndpointPid(benchEndpointBody({ url: "ws://x", pid: 7, now: new Date() })), 7);
  assert.equal(benchEndpointPid("아니"), null);
  assert.equal(benchEndpointPid("{}"), null);
  assert.equal(benchEndpointPid(JSON.stringify({ pid: "7" })), null);
});
