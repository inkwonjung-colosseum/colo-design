/**
 * The bring-up failure table (실사 결함의 회귀 검사 포함): the kind decides
 * the card, the card's first action is the fix — never a promise about a
 * button that is not on it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoStatus } from "@colo-design/protocol";
import { errorKindOf, guidanceFor } from "../src/repo-guidance.ts";

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

test("errorKindOf: 포트 충돌은 kind 로 알아본다 — 메시지에 '미리보기 서버'가 없어도", () => {
  const kind = errorKindOf(
    status({
      errorKind: "port-busy",
      detail:
        "포트 3000를 다른 프로그램이 이미 쓰고 있어 미리보기를 켤 수 없습니다 — 다시 시작을 누르면 그 프로그램을 종료하고 미리보기를 다시 켭니다.",
    }),
  );
  assert.equal(kind, "port-busy");
});

test("errorKindOf: kind 없는 옛 데몬은 detail 의 다른 프로그램 문구로 포트 충돌을 읽는다", () => {
  const kind = errorKindOf(
    status({
      errorKind: null,
      detail:
        "포트 3000를 다른 프로그램이 이미 쓰고 있어 미리보기를 켤 수 없습니다 — 다시 시작을 누르면 그 프로그램을 종료하고 미리보기를 다시 켭니다.",
    }),
  );
  assert.equal(kind, "port-busy");
});

test("errorKindOf: 갈라진 거부는 포트 충돌이 아니다", () => {
  const kind = errorKindOf(
    status({
      errorKind: null,
      detail:
        "기본 브랜치에 원격과 갈라진 커밋이 있어 자동 최신화를 멈췄습니다 — 대화를 열면 Claude가 확인합니다.",
    }),
  );
  assert.equal(kind, "unknown");
});

test("errorKindOf: clone 실패는 그 종류로, install 실패는 알 수 없음으로 — 카드는 detail 을 그대로 보여 준다", () => {
  assert.equal(
    errorKindOf(status({ errorKind: "install", detail: "설치가 실패했습니다" })),
    "unknown",
  );
  assert.equal(
    errorKindOf(status({ errorKind: "clone", detail: "내려받기가 실패했습니다" })),
    "clone",
  );
});

test("guidanceFor: 포트 정리 실패 카드는 다음 과제(직접 종료·포트 변경)를 밝힌다", () => {
  const guidance = guidanceFor("port-busy", null);
  assert.equal(guidance.title, "미리보기 포트를 정리하지 못했어요");
  assert.match(guidance.body, /preview\.port/);
  // 데몬이 준 문장이 있으면 그 문장이 본문이다 — 한국어 리드가 살아 있는 한.
  const withDetail = guidanceFor("port-busy", "포트 3000를 종료하려 했지만 실패했습니다…");
  assert.equal(withDetail.body, "포트 3000를 종료하려 했지만 실패했습니다…");
});

test("guidanceFor: 충돌·승인 카드의 첫 동작 문구는 그대로다 (회귀)", () => {
  assert.equal(guidanceFor("conflict", null).title, "최신 변경과 충돌이 남았습니다");
  assert.equal(guidanceFor("commands", null).title, "명령 실행 승인이 필요합니다");
  assert.equal(
    guidanceFor("auth", null).command,
    "pnpm config set //npm.pkg.github.com/:_authToken <PAT>",
  );
  assert.equal(guidanceFor("pnpm", null).command, "corepack enable");
});

test("held-elsewhere: 산 남의 인스턴스는 그 종류로 알아보고, 카드는 다른 인스턴스를 가리킨다", () => {
  const kind = errorKindOf(
    status({
      errorKind: "held-elsewhere",
      detail:
        "포트 3000에서 다른 Colo Design 인스턴스가 이 프로젝트의 미리보기를 이미 돌리고 있습니다…",
    }),
  );
  assert.equal(kind, "held-elsewhere");
  const guidance = guidanceFor("held-elsewhere", null);
  assert.equal(guidance.title, "다른 Colo Design이 미리보기를 쓰고 있어요");
  assert.match(guidance.body, /다른 인스턴스/);
  // 데몬이 준 문장이 있으면 그 문장이 본문이다 — 포트 충돌 카드와 같은 규칙.
  const withDetail = guidanceFor("held-elsewhere", "포트 3000에서 다른 Colo Design 인스턴스가…");
  assert.equal(withDetail.body, "포트 3000에서 다른 Colo Design 인스턴스가…");
});
