import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { ChatEvent, RepoPhase } from "@colo-design/protocol";
// Session 은 형제(.js 지정자)를 부르므로 dist 를 본다(turn-selfheal 과 같은 길).
import { ProjectFleet } from "../dist/project-fleet.js";
import { Session } from "../dist/session.js";
import { nextReadyWatch } from "../src/ready-notice.ts";

/** 상태 방송의 줄을 차례로 먹여 알림이 몇 번 나는지 센다. */
function run(phases: Array<[RepoPhase, boolean]>): number {
  let watching = false;
  let notices = 0;
  for (const [phase, active] of phases) {
    const next = nextReadyWatch(watching, phase, active);
    watching = next.watching;
    if (next.notify) notices += 1;
  }
  return notices;
}

test("첫 준비가 배경에서 끝나면 ready 알림 한 번 (PLAN-UI U8)", () => {
  assert.equal(
    run([
      ["cloning", true],
      ["installing", false],
      ["ready", false],
      // 다시 준비(최신화 · 미리보기 켜기)는 내려받기를 지나지 않는다.
      ["pulling", false],
      ["starting", false],
      ["ready", false],
    ]),
    1,
  );
});

test("보고 있는 프로젝트의 첫 준비는 알리지 않는다", () => {
  assert.equal(
    run([
      ["cloning", true],
      ["installing", true],
      ["starting", true],
      ["ready", true],
    ]),
    0,
  );
});

test("이미 준비된 프로젝트의 다시 준비는 알리지 않는다", () => {
  assert.equal(
    run([
      ["pulling", false],
      ["installing", false],
      ["ready", false],
    ]),
    0,
  );
});

test("오류를 지나도 첫 준비다 — AI 가 고친 뒤 배경에서 끝나면 알린다", () => {
  assert.equal(
    run([
      ["cloning", true],
      ["error", false],
      ["pulling", false],
      ["installing", false],
      ["ready", false],
    ]),
    1,
  );
});

function preparedSession() {
  const sends: string[] = [];
  const queued: number[] = [];
  const session = new Session(
    { cwd: tmpdir(), provider: "claude" },
    {
      onEvent: (_id: string, event: ChatEvent) => {
        if (event.kind === "queued") queued.push(event.items.length);
      },
      onState: () => undefined,
      onPermissionRequest: () => undefined,
      onQuestionRequest: () => undefined,
    },
  );
  session.attach({
    send: (turn: { text: string }) => {
      sends.push(turn.text);
      return Promise.resolve();
    },
  } as never);
  const endTurn = () =>
    session.driverHooks.onEvent({
      kind: "turn.end",
      subtype: "success",
      isError: false,
      costUsd: null,
      numTurns: null,
      durationMs: 1,
      resultText: null,
    } satisfies ChatEvent & { kind: "turn.end" });
  return { session, sends, queued, endTurn };
}

test("준비 중에 온 말은 대기 줄에 서고, 준비가 끝나면 차례로 나간다 (PLAN-UI U8)", () => {
  const { session, sends, queued, endTurn } = preparedSession();
  session.setPreparing(true);
  session.send("회원 목록 화면을 만들어 줘");
  session.send("검색창도 넣어 줘");
  assert.deepEqual(sends, [], "준비가 끝나기 전에는 아무것도 나가지 않는다");
  assert.deepEqual(
    session.heldItems().map((item) => item.text),
    ["회원 목록 화면을 만들어 줘", "검색창도 넣어 줘"],
  );
  assert.equal(queued.at(-1), 2, "대기 줄은 queued 로 화면에 보인다");

  session.setPreparing(false);
  assert.deepEqual(sends, ["회원 목록 화면을 만들어 줘"], "맨 앞 말부터 하나");
  endTurn();
  assert.deepEqual(sends, ["회원 목록 화면을 만들어 줘", "검색창도 넣어 줘"]);
  assert.equal(queued.at(-1), 0);
});

test("준비가 아닌 대화의 말은 그대로 나간다", () => {
  const { session, sends } = preparedSession();
  session.send("바로 가는 말");
  assert.deepEqual(sends, ["바로 가는 말"]);
  // 열린 문을 다시 여는 것은 아무 일도 하지 않는다.
  session.setPreparing(false);
  assert.deepEqual(sends, ["바로 가는 말"]);
});

test("fleet — 배경에서 끝난 첫 준비가 ready 알림을 내고, 기다리던 말을 놓아 준다", () => {
  let active = "a";
  const notices: unknown[] = [];
  const { session, sends } = preparedSession();
  const fleet = new ProjectFleet({
    registry: {
      list: () => [],
      activeSlug: () => active,
      get: (slug: string) => ({ slug, name: slug === "b" ? "회원 관리" : "다른 것" }),
    },
    manager: { get: () => session, all: () => [session] },
    notice: (notice: unknown) => notices.push(notice),
  } as never);
  const inner = fleet as never as {
    workspaces: Map<string, unknown>;
    watchFirstPrep: (slug: string, status: { phase: RepoPhase }) => void;
    preparing: Set<string>;
  };
  // 세션의 클론과 같은 뿌리를 가진 워크스페이스 하나 — 놓아 주기가 cwd 로 찾는다.
  inner.workspaces.set("b", { slug: "b", paths: { root: tmpdir(), repoRoot: tmpdir() } });

  active = "b";
  inner.watchFirstPrep("b", { phase: "cloning" });
  assert.ok(inner.preparing.has("b"));
  session.setPreparing(true);
  session.send("먼저 말해 둔 것");
  assert.deepEqual(sends, []);

  active = "a"; // 사용자가 다른 프로젝트로 갔다.
  inner.watchFirstPrep("b", { phase: "installing" });
  inner.watchFirstPrep("b", { phase: "ready" });
  assert.deepEqual(notices, [{ kind: "ready", slug: "b", title: "회원 관리" }]);
  assert.equal(inner.preparing.has("b"), false);
  assert.deepEqual(sends, ["먼저 말해 둔 것"], "준비가 끝나면 대기 줄이 풀린다");

  // 두 번째 ready(돌아와서 미리보기 켜기)는 다시 알리지 않는다.
  inner.watchFirstPrep("b", { phase: "starting" });
  inner.watchFirstPrep("b", { phase: "ready" });
  assert.equal(notices.length, 1);
});
