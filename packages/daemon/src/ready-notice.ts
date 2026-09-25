import type { RepoPhase } from "@colo-design/protocol";

/**
 * 처음 여는 프로젝트의 준비가 배경에서 끝났는가(PLAN-UI U8 · P5) — 상태가
 * 움직일 때마다 한 번 부른다. `watching` 은 이 프로젝트가 첫 준비 중인가다:
 * 내려받기(cloning)를 본 순간 켜지고, `ready` 에 닿는 순간 꺼진다. 알림은
 * 켜진 채로 `ready` 에 닿았고 그때 사용자가 그 프로젝트 앞에 있지 않을 때
 * 한 번뿐이다 — 이미 준비된 프로젝트의 다시 준비(최신화 · 재설치)는 내려받기를
 * 지나지 않으므로 부르지 않고, 보고 있는 프로젝트는 화면이 이미 말한다.
 * 오류는 지켜보기를 끄지 않는다 — AI 가 고쳐 다시 돌린 준비도 첫 준비다.
 */
export function nextReadyWatch(
  watching: boolean,
  phase: RepoPhase,
  active: boolean,
): { watching: boolean; notify: boolean } {
  if (phase === "cloning") return { watching: true, notify: false };
  if (phase === "ready") return { watching: false, notify: watching && !active };
  return { watching, notify: false };
}
