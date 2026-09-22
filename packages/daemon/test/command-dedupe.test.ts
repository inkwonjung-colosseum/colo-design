import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandDedupe } from "../src/command-dedupe.ts";

test("같은 id 의 순차 재호출은 한 번 실행하고 같은 답을 돌려준다", async () => {
  const dedupe = new CommandDedupe();
  let runs = 0;
  const first = await dedupe.run("a", async () => {
    runs += 1;
    return "answer";
  });
  const second = await dedupe.run("a", async () => {
    runs += 1;
    return "answer";
  });
  assert.equal(runs, 1);
  assert.equal(first, "answer");
  assert.equal(second, "answer");
});

test("도는 중인 같은 id 는 같은 약속을 기다린다 — task 는 한 번만 부른다", async () => {
  const dedupe = new CommandDedupe();
  const gate = Promise.withResolvers<string>();
  let runs = 0;
  const task = (): Promise<string> => {
    runs += 1;
    return gate.promise;
  };
  const a = dedupe.run("busy", task);
  const b = dedupe.run("busy", task);
  gate.resolve("done");
  assert.equal(await a, "done");
  assert.equal(await b, "done");
  assert.equal(runs, 1);
});

test("다른 id 는 각자 실행한다", async () => {
  const dedupe = new CommandDedupe();
  const [a, b] = await Promise.all([
    dedupe.run("x", async () => "x"),
    dedupe.run("y", async () => "y"),
  ]);
  assert.equal(a, "x");
  assert.equal(b, "y");
});

test("실패도 정산이다 — 재호출은 재실행 없이 같은 거절을 다시 본다", async () => {
  const dedupe = new CommandDedupe();
  let runs = 0;
  const task = async (): Promise<string> => {
    runs += 1;
    throw new Error("boom");
  };
  await assert.rejects(dedupe.run("f", task), /boom/);
  await assert.rejects(dedupe.run("f", task), /boom/);
  assert.equal(runs, 1);
});

test("접촉한 정산 답은 상한 안에서 살아남는다 — 잊히는 것은 맨 앞부터다", async () => {
  const dedupe = new CommandDedupe({ capacity: 2 });
  let runs = 0;
  const task = async (): Promise<number> => {
    runs += 1;
    return runs;
  };
  await dedupe.run("a", task);
  await dedupe.run("b", task);
  await dedupe.run("a", task); // 접촉 — a 가 가장 새로워진다
  await dedupe.run("c", task); // 넘침 — 맨 앞의 b 만 잊긴다
  const aAgain = await dedupe.run("a", task); // 접촉이 지켜준 기억 — 재실행 없다
  assert.equal(aAgain, 1);
  assert.equal(runs, 3);
});

test("잊힌 id 는 다시 실행한다 — 정산 답의 기억은 유한하다", async () => {
  const dedupe = new CommandDedupe({ capacity: 2 });
  let runs = 0;
  const task = async (): Promise<number> => {
    runs += 1;
    return runs;
  };
  await dedupe.run("a", task);
  await dedupe.run("b", task);
  await dedupe.run("c", task); // 넘침 — a 가 잊긴다
  const cAgain = await dedupe.run("c", task); // 기억 속 답 — 재실행 없다
  const aAgain = await dedupe.run("a", task); // 잊힌 자리 — 재실행
  assert.equal(cAgain, 3);
  assert.equal(aAgain, 4);
  assert.equal(runs, 4);
});

test("수명이 지난 정산 답은 잊힌 것으로, 새 실행이 된다", async () => {
  let now = 0;
  const dedupe = new CommandDedupe({ ttlMs: 100, now: () => now });
  let runs = 0;
  const task = async (): Promise<number> => {
    runs += 1;
    return runs;
  };
  await dedupe.run("t", task);
  now = 200;
  const again = await dedupe.run("t", task);
  assert.equal(again, 2);
  assert.equal(runs, 2);
});
