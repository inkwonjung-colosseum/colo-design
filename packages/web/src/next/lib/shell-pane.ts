/**
 * 셸 갈림길(NextShell)의 판정 — 창이 셋 중 무엇을 쓸지 한 곳에서 정한다.
 * `boot` 은 첫 상태(hello)가 오기 전의 조용한 표지, `first-run` 은 체크리스트
 * 한 장(FirstRun), `workspace` 는 작업 틀이다.
 *
 * 표지가 필요한 까닭: 다시 열기의 첫 순간에는 데몬의 상태가 아직 없다. 이를
 * `첫 실행` 으로 읽으면 프로젝트가 있는 기계에서 체크리스트가 번쩍였다 곧장
 * 작업 틀로 넘어가는 깜빡임이 생긴다(초대장으로 이미 시작한 창의 다시 열기).
 * 상태가 오기 전에는 아무 판정도 하지 않는다 — 모르는 것을 모른다고 두는 쪽이다.
 */
export type ShellPane = "boot" | "first-run" | "workspace";

export interface ShellPaneInput {
  /** 데몬의 첫 상태가 도착했는가 — `daemon.status !== null`. */
  statusLoaded: boolean;
  /** 등록부의 프로젝트 수 — 0 이면 진짜 첫 실행이다. */
  projectCount: number;
  /** 첫 실행의 초대 적용이 도는 중 — 첫 프로젝트가 생겨도 첫 화면을 지킨다. */
  applyingFirst: boolean;
  /** 온보딩 게이트가 막혔는가(검사 답이 없는 것도 막는다). */
  gatesHold: boolean;
}

export function decideShellPane(input: ShellPaneInput): ShellPane {
  if (!input.statusLoaded) return "boot";
  if (input.projectCount === 0 || input.applyingFirst || input.gatesHold) return "first-run";
  return "workspace";
}
