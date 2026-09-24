import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoStatus } from "@colo-design/protocol";
import { type BringUpEpisode, nextBringUpBrief } from "../src/bring-up-briefs.ts";

type Status = Pick<RepoStatus, "phase" | "errorKind" | "detail">;

const failed = (errorKind: RepoStatus["errorKind"], detail = "출력"): Status => ({
  phase: "error",
  errorKind,
  detail,
});
const installing: Status = { phase: "installing", detail: "Progress: resolved 1" };
const ready: Status = { phase: "ready", detail: null };

/** 상태들을 차례로 먹이고 결정만 모은다 — fleet 이 장부를 들고 도는 것과 같다. */
function run(statuses: Status[]): { decisions: string[]; episode: BringUpEpisode | undefined } {
  let episode: BringUpEpisode | undefined;
  const decisions: string[] = [];
  for (const status of statuses) {
    const next = nextBringUpBrief(episode, status);
    episode = next.episode;
    const d = next.decision;
    decisions.push(d.action === "brief" ? (d.repeat ? "brief:repeat" : "brief") : d.action);
  }
  return { decisions, episode };
}

test("첫 실패는 AI 에게 넘긴다", () => {
  assert.deepEqual(run([failed("install")]).decisions, ["brief"]);
});

test("같은 실패의 재방송은 다시 넘기지 않는다 — 문장이 바뀌어도 준비가 다시 돌기 전까지는", () => {
  const { decisions } = run([
    failed("install", "12:00:01 실패"),
    failed("install", "12:00:02 실패"),
  ]);
  assert.deepEqual(decisions, ["brief", "none"]);
});

test("고친 뒤 준비가 다시 돌고 같은 단계에서 또 멈추면 되풀이라고 한 번 더 넘긴다", () => {
  const { decisions } = run([failed("install"), installing, failed("install")]);
  assert.deepEqual(decisions, ["brief", "none", "brief:repeat"]);
});

test("같은 단계 세 번째는 AI 를 멈추고 개발자에게 한 번만 알린다", () => {
  const { decisions } = run([
    failed("install"),
    installing,
    failed("install"),
    installing,
    failed("install"),
    installing,
    failed("install"),
  ]);
  assert.deepEqual(decisions, [
    "brief",
    "none",
    "brief:repeat",
    "none",
    "escalate",
    "none",
    "none",
  ]);
});

test("준비가 서면 장부가 비고, 다음 실패는 새 실패다", () => {
  const { decisions, episode } = run([
    failed("install"),
    installing,
    failed("install"),
    ready,
    failed("install"),
  ]);
  assert.deepEqual(decisions, ["brief", "none", "brief:repeat", "none", "brief"]);
  assert.equal(episode?.same, 1);
});

test("첫 실행의 동의(commands)와 C5 재기동 중 문장은 넘기지 않는다", () => {
  const { decisions } = run([
    failed("commands"),
    failed("preview", "화면을 다시 켜는 중 — 미리보기 서버가 종료되었습니다 (exit 1)"),
  ]);
  assert.deepEqual(decisions, ["none", "none"]);
});

test("단계가 번갈아 넘어져도 한 바퀴의 상한에서 멈춘다", () => {
  const { decisions } = run([
    failed("install"),
    installing,
    failed("preview"),
    installing,
    failed("install"),
    installing,
    failed("preview"),
    installing,
    failed("install"),
  ]);
  assert.deepEqual(
    decisions.filter((d) => d !== "none"),
    ["brief", "brief", "brief", "brief", "escalate"],
  );
});
