import type { Daemon } from "../../lib/daemon-client";
import type { SettingsCategory } from "../dialogs/SettingsDialog";
import { GitHubTokenForm } from "./GitHubTokenForm";
import { RepoPicker } from "./RepoPicker";

/**
 * 첫 화면의 2단 흐름 (onboarding.html, states.md §2.2): ①토큰 붙여넣기 →
 * ②레포 선택, 같은 자리에서 단계만 바뀐다 — 화면 전환 없음. 기계 게이트
 * (AI · git · 런타임)는 여기서 조용하다: 통과는 말이 없고, 실패는
 * Shell 이 마법사로 막는다. 이 흐름은 github 게이트의 warn(토큰 없음)이
 * 홀로 남은 첫 실행의 얼굴이다.
 *
 * 두 단계는 기존 컴포넌트의 재사용이다 — 설정과 마법사가 쓰는
 * GitHubTokenForm, 프로젝트 추가 대화상자와 같은 RepoPicker. 목록이 읽히지
 * 못하는 게이트의 빈 목록(오늘 규칙)도 RepoPicker 의 몫이다.
 */
export function StartFlow({
  daemon,
  onOpenSettings,
}: {
  daemon: Daemon;
  /** RepoPicker 의 토큰 없음 안내가 설정으로 건너는 다리. */
  onOpenSettings: (category?: SettingsCategory) => void;
}) {
  const hasToken =
    daemon.onboarding?.some((step) => step.id === "github" && step.status === "pass") ?? false;

  if (hasToken) {
    return (
      <section className="planner__body planner__empty" aria-label="레포 선택">
        <h2 className="planner__emptyTitle">화면을 만들 레포를 골라 주세요</h2>
        <p className="startflow__sub">
          토큰이 볼 수 있는 레포를 찾았어요. 어느 레포인지 모르겠으면 개발자에게 레포 이름을
          물어보세요.
        </p>
        <RepoPicker daemon={daemon} onOpenSettings={onOpenSettings} />
      </section>
    );
  }

  return (
    <section className="planner__body planner__empty" aria-label="토큰 연결">
      <h2 className="planner__emptyTitle">토큰 하나면 시작해요</h2>
      <p className="startflow__sub">
        개발자에게 받은 GitHub 토큰을 붙여넣으면, 그 토큰이 볼 수 있는 레포 목록이 열려요. 토큰이
        없으면 개발자에게 &ldquo;콜로 연결 토큰 하나 만들어줘&rdquo;라고 부탁하면 됩니다.
      </p>
      <GitHubTokenForm daemon={daemon} />
      <p className="hint">
        토큰은 이 컴퓨터의 자격 증명 저장소에만 저장돼요 — 앱 화면을 여는 연결 토큰(페어링)과는
        별개예요.
      </p>
    </section>
  );
}
