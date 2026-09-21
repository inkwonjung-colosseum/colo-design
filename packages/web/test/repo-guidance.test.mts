/**
 * The bring-up failure table (실사 결함의 회귀 검사 포함): the kind decides
 * the card, the card's first action is the fix — never a promise about a
 * button that is not on it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoStatus } from "@colo-design/protocol";
import { errorKindOf, guidanceFor } from "../src/lib/repo-guidance.ts";

const status = (patch: Partial<RepoStatus>): RepoStatus =>
  ({
    root: "/repo",
    phase: "error",
    detail: null,
    previewUrl: null,
    previewPort: null,
    previewEpoch: null,
    url: "https://example.invalid/org/repo.git",
    branch: null,
    baseBranch: "main",
    handoff: null,
    pendingChanges: 0,
    ...patch,
  }) as RepoStatus;

test("errorKindOf: 갈라진 거부는 포트 충돌이 아니다", () => {
  const kind = errorKindOf(
    status({
      errorKind: null,
      detail:
        "기본 브랜치에 원격과 갈라진 커밋이 있어 자동 최신화를 멈췄습니다 — 대화를 열면 AI가 확인합니다.",
    }),
  );
  assert.equal(kind, "unknown");
});

test("errorKindOf: clone · install · 미리보기 명령 실패는 각자의 종류로 — 카드는 detail 을 그대로 보여 준다", () => {
  assert.equal(
    errorKindOf(status({ errorKind: "install", detail: "설치가 실패했습니다" })),
    "install",
  );
  assert.equal(
    errorKindOf(status({ errorKind: "no-preview-command", detail: "띄울 명령이 없습니다" })),
    "no-preview-command",
  );
  assert.equal(
    errorKindOf(status({ errorKind: "port-undetected", detail: "주소를 찾지 못했습니다" })),
    "port-undetected",
  );
  assert.equal(
    errorKindOf(status({ errorKind: "clone", detail: "내려받기가 실패했습니다" })),
    "clone",
  );
});

test("guidanceFor: 미리보기 명령 없음 · 주소 미감지 카드는 AI 의 준비 과제를 밝힌다", () => {
  const noCommand = guidanceFor("no-preview-command", null);
  assert.equal(noCommand.title, "미리보기 명령이 없습니다");
  assert.match(noCommand.body, /package\.json/);
  assert.equal(noCommand.agent?.step, "미리보기 띄우기");
  assert.equal(noCommand.agent?.thread, "미리보기 명령 준비");
  assert.match(noCommand.agent?.brief ?? "", /package\.json/);

  const undetected = guidanceFor("port-undetected", null);
  assert.equal(undetected.title, "미리보기 주소를 찾지 못했습니다");
  assert.equal(undetected.agent?.step, "미리보기 띄우기");
  assert.equal(undetected.agent?.thread, "미리보기 주소 감지");
  assert.match(undetected.agent?.brief ?? "", /주소를 출력/);
});

test("guidanceFor: 충돌·첫 실행 카드의 첫 동작 문구는 그대로다 (회귀)", () => {
  assert.equal(guidanceFor("conflict", null).title, "최신 변경과 충돌이 남았습니다");
  // P3-1: 승인 게이트는 실패가 아니라 첫 실행이다 — 제목이 그렇게 읽힌다.
  assert.equal(guidanceFor("commands", null).title, "이 서비스를 이 컴퓨터에서 처음 켭니다");
  assert.equal(
    guidanceFor("auth", null).command,
    "pnpm config set //npm.pkg.github.com/:_authToken <PAT>",
  );
  assert.equal(guidanceFor("pnpm", null).command, "corepack enable");
});

test("guidanceFor: commands 를 뺀 모든 실패가 AI 요청을 안다", () => {
  // commands 하나만 카드의 첫 동작이 AI 가 아니다 — 첫 실행의 동의는 사람의
  // 것이라 AI 가 대신할 수 없다. preview 는 P3-3 에서 열렸다: 미리보기 자리의
  // 멈춤 카드가 서지 않는 길(진행 판으로 떨어지는 경우)에서는 그 카드가 유일한
  // 자리였고, 거기엔 누를 것이 하나도 없었다.
  for (const kind of [
    "auth",
    "pnpm",
    "preview",
    "port-undetected",
    "no-preview-command",
    "conflict",
    "clone",
    "install",
    "unknown",
  ] as const) {
    const agent = guidanceFor(kind, "데몬의 자세한 출력").agent;
    assert.ok(agent, `${kind} 카드에 AI 요청이 없습니다`);
    assert.ok(agent.step && agent.thread, `${kind}: 카드 제목·대화 이름이 비었습니다`);
    assert.match(
      agent.brief,
      /데몬의 자세한 출력/,
      `${kind}: 브리프가 detail 을 증거로 싣지 않습니다`,
    );
  }
  assert.equal(guidanceFor("commands", null).agent, undefined);
});

test("guidanceFor: 충돌 요청의 브리프는 옛 카드가내던 문구 그대로다 (회귀)", () => {
  const agent = guidanceFor("conflict", "충돌한 파일: app.tsx").agent;
  assert.ok(agent);
  assert.equal(agent.step, "최신 변경 받아오기");
  assert.equal(agent.thread, "최신화 충돌 정리");
  assert.match(agent.brief, /준비가 최신화 충돌로 멈춰 있습니다/);
  assert.match(agent.brief, /충돌한 파일: app\.tsx/);
  // detail 없는 브리프는 리드 문장만이다 — 빈 꼬리표를 달지 않는다.
  assert.equal(guidanceFor("conflict", null).agent?.brief.endsWith("마쳐 주세요."), true);
});
