import assert from "node:assert/strict";
import { test } from "node:test";

// reconcile 은 sessionStorage 에 쓴다 — node 에는 없으니 최소 스텁.
Object.assign(globalThis, {
  sessionStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
});

const { reconcile, markNumberFor } = await import("../src/hooks/useMarks.ts");

type Pin = Parameters<typeof reconcile>[1][number];

let seq = 0;
const pin = (intent: "change" | "question" = "change"): Pin =>
  // 테스트 픽스처 — overlay envelope 의 최소 형태.
  ({
    id: `pin-${++seq}`,
    screen: "oms/Dashboard",
    state: "default",
    element: {
      kind: "element",
      component: "div",
      path: "div",
      text: "대시보드",
      rect: { x: 0, y: 0, width: 10, height: 10 },
    },
    note: "",
    intent,
  }) as Pin;

const empty = new Set<string>();

test("보내기 전 지운 핀의 번호는 다음 핀이 물려받는다 — 3개 찍고 지우면 다시 1부터", () => {
  const slug = `t-reclaim-${seq}`;
  const first = [pin(), pin(), pin()];
  reconcile(slug, first, [], empty, []);
  assert.deepEqual(
    first.map((p) => markNumberFor(slug, p.id)),
    [1, 2, 3],
  );

  // 전부 지우고 두 개를 다시 찍는다 — 예전 동작은 4,5 였다.
  reconcile(slug, [], [], empty, []);
  const second = [pin(), pin()];
  reconcile(slug, second, [], empty, []);
  assert.deepEqual(
    second.map((p) => markNumberFor(slug, p.id)),
    [1, 2],
    "지워진 핀의 번호를 실은 말은 없으므로 자리를 물려받아야 한다",
  );
});

test("보낸 핀의 번호는 지킨다 — 고스트가 살아 있는 동안 새 핀은 그 뒤를 잇는다", () => {
  const slug = `t-sent-${seq}`;
  const sent = [pin(), pin()];
  reconcile(slug, sent, [], empty, []);
  // 턴이 실어 갔다 — 트레이는 비고 고스트가 된다.
  reconcile(slug, [], sent, empty, []);

  const next = pin();
  reconcile(slug, [next], sent, empty, []);
  assert.equal(markNumberFor(slug, next.id), 3, "회색 배지 ①② 뒤의 새 핀은 ③");

  // 턴 종료: 수정 고스트는 done 으로 남아 번호를 지키고, 다음 핀은 그 위로.
  reconcile(slug, [next], [], empty, []);
  assert.equal(markNumberFor(slug, sent[0]!.id), 1);
  assert.equal(markNumberFor(slug, sent[1]!.id), 2);
  const later = pin();
  reconcile(slug, [next, later], [], empty, []);
  assert.equal(markNumberFor(slug, later.id), 4);
});

test("질문 핀은 턴이 끝나면 마크를 남기지 않는다 — 그 자리도 물려받는다", () => {
  const slug = `t-question-${seq}`;
  const asked = pin("question");
  reconcile(slug, [asked], [], empty, []);
  reconcile(slug, [], [asked], empty, []);
  // 턴 종료 — 질문 고스트는 done 이 되지 않고 사라진다.
  reconcile(slug, [], [], empty, []);
  assert.equal(markNumberFor(slug, asked.id), null);

  const fresh = pin();
  reconcile(slug, [fresh], [], empty, []);
  assert.equal(markNumberFor(slug, fresh.id), 1);
});
