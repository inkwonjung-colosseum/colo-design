import { Shell } from "../components/shell/Shell";
import type { Settings } from "../lib/settings";
import "./next.css";
import { Workspace } from "./Workspace";

/** 옛 셸과 같은 계약 — App 은 두 셸에 같은 값을 건넨다(PLAN-UI 4 · 병행 셸).
 *  설정의 저장(단계 6)만 곁가지다: 옛 셸은 설정 대화상자를 App 이 직접 그리므로
 *  이 손을 건너도 쓰지 않는다. */
export type NextShellProps = Parameters<typeof Shell>[0] & {
  onSettingsChange: (patch: Partial<Settings>) => void;
};

/**
 * 새 셸(PLAN-UI 단계 1) — 프로젝트가 있는 기계의 작업 틀은 `Workspace` 가
 * 그린다. 첫 실행(프로젝트 0개)과 설정에서 다시 연 마법사는 아직 옛 셸의
 * 온보딩 · 시작 화면이 맡는다 — 단계 5 가 체크리스트 한 장(U11)으로 바꾼다.
 * 첫 상태가 오기 전에는 옛 셸이 그 기다림(브랜드 한 장)을 그린다.
 */
export function NextShell(props: NextShellProps) {
  const { daemon, onboardingOpen } = props;
  if (daemon.status === null || daemon.projects.length === 0 || onboardingOpen) {
    return <Shell {...props} />;
  }
  return <Workspace {...props} />;
}
