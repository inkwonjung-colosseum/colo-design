import assert from "node:assert/strict";
import { test } from "node:test";
// `../dist` 임포트인 이유: escalation 의 src 는 `.js` 지정자(`./credentials.js`)
// 로 형제를 부른다 — src 직접 로드는 그 지정을 못 고친다(shelf-recover 와 같은 길).
import { MemoryCredentialStore } from "../dist/credentials.js";
import { Escalation } from "../dist/escalation.js";
import type { DaemonLogger } from "../dist/log.js";

/** 시험이 듣는 로그 — 에스컬레이션은 조용함이 계약이므로 출력도 없다. */
const quiet: DaemonLogger = { info() {}, warn() {}, error() {} };

/**
 * 가짜 전송 — 호출 순서대로 정해진 답을 내놓는다. 무엇이 몇 번 나갔는가가
 * 이 시험의 전부라 url 과 본문을 기록한다.
 */
function recorder(results: Response[]) {
  const seen: string[] = [];
  const impl: typeof fetch = async (url, init) => {
    seen.push(`${String(url)} ${String(init?.body ?? "")}`);
    const next = results[seen.length - 1];
    if (next === undefined) throw new Error("예상 밖의 전송");
    return next;
  };
  return { seen, impl };
}

const WEBHOOK = { kind: "webhook", url: "https://hooks.example/test" } as const;

test("실패한 전송 뒤 같은 문장은 곧바로 다시 보내진다", async () => {
  const { seen, impl } = recorder([new Response(null, { status: 500 }), new Response("ok")]);
  const escalation = new Escalation(new MemoryCredentialStore(), quiet, impl);
  await escalation.set(WEBHOOK);
  const text = "[Colo Design] 푸시가 실패했습니다";
  assert.equal(await escalation.notify(text), false);
  assert.equal(await escalation.notify(text), true);
  assert.equal(seen.length, 2);
});

test("성공한 전송 뒤 10분 안의 같은 문장은 보내지 않고 true 를 돌려준다", async () => {
  const { seen, impl } = recorder([new Response("ok")]);
  const escalation = new Escalation(new MemoryCredentialStore(), quiet, impl);
  await escalation.set(WEBHOOK);
  const text = "[Colo Design] 푸시가 실패했습니다";
  const first = 1_000_000;
  assert.equal(await escalation.notify(text, first), true);
  // 10분 창 안의 재울림 — 개발자 쪽 채널이 같은 고장으로 도배하지 않는다.
  assert.equal(await escalation.notify(text, first + 5 * 60_000), true);
  assert.equal(seen.length, 1);
});

test("설정이 없으면 false — 나갈 곳이 없다는 뜻이지 성공이 아니다", async () => {
  const { seen, impl } = recorder([]);
  const escalation = new Escalation(new MemoryCredentialStore(), quiet, impl);
  assert.equal(await escalation.notify("무엇이 막혔습니다"), false);
  assert.equal(seen.length, 0);
});
