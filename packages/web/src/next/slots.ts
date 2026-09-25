import type { ProjectSummary } from "@colo-design/protocol";
import type { Pins } from "../hooks/usePins";
import type { Sessions } from "../hooks/useSessions";
import type { Daemon } from "../lib/daemon-client";
import type { ChatSettings, Settings } from "../lib/settings";
import type { Journey } from "./lib/journey";

/**
 * 셸이 칸들에 건네는 이동의 손 — 모든 칸이 같은 길로 움직인다. 다른 프로젝트의
 * 대화를 여는 손은 전환을 먼저 하고, 등록부가 옮겨 앉으면 그 대화를 연다(한
 * 번의 클릭, 두 걸음).
 */
export interface ShellNav {
  /** 대화 하나를 연다. `slug` 가 활성 프로젝트가 아니면 옮긴 뒤에 연다. */
  openThread: (slug: string, threadId: string) => void;
  /** 새 대화의 빈 자리로(⌘T) — 세션은 첫 말이 나갈 때 태어난다. 다른 프로젝트면 옮긴 뒤. */
  newThread: (slug?: string) => void;
  /** 홈(받은 편지함)으로. */
  goHome: () => void;
  /** 대화 보기로 — 지금 열린 대화(또는 새 대화의 빈 자리) 그대로. */
  showThread: () => void;
  /** 활성 프로젝트를 옮긴다(`project.activate`). 옮겨 앉으면 셸은 홈부터 선다. */
  switchProject: (slug: string) => void;
  /** 좁은 창의 두 탭 중 하나를 앞에 세운다. 넓은 창에서는 아무 일도 없다. */
  showTab: (tab: "chat" | "preview") => void;
  /** 설정 대화상자. */
  openSettings: () => void;
  /** 셸 위에 잠깐 뜨는 한 줄. */
  toast: (text: string) => void;
  /**
   * 방금 가져온 초대 파일의 자리를 세운다(단계 5 의 가져오기) · 거둔다(null) —
   * 대화 칸의 `초대 파일을 가져왔어요` 줄이 그 값을 읽는다(U11).
   */
  setDiscardableInvitePath: (path: string | null) => void;
}

/**
 * 대화 칸과 미리보기 칸이 함께 받는 것 — 단계 2(대화)와 단계 3(미리보기)이 이
 * 계약 위에 짓는다. 훅은 셸이 한 번만 부른다: 두 칸이 같은 세션 · 같은 핀을 본다.
 */
export interface SlotProps {
  daemon: Daemon;
  settings: Settings;
  /** `useSessions` 의 결과 — 대화 목록 · 열린 대화 · 보내기 전부. */
  sessions: Sessions;
  /** `usePins` 의 결과 — 입력창 칩 · 미리보기 배지 · 말풍선이 같은 목록을 읽는다. */
  pins: Pins;
  /** 활성 프로젝트 — 등록부가 아직 없으면 null. */
  project: ProjectSummary | null;
  /** 열린 대화의 id(`sessions.activeId` 그대로) — 새 대화의 빈 자리면 null. */
  activeSessionId: string | null;
  nav: ShellNav;
  /** 900px 아래 — 두 칸이 탭으로 나뉘고, 각 칸은 혼자 창을 쓴다(U16). */
  narrow: boolean;
  onChatChange: (patch: Partial<ChatSettings>) => void;
  onRenameSession: (sessionId: string, title: string) => void;
}

/** 대화 칸(단계 2) — 입력창 · 대화록 · 카드. 문제 문장은 셸이 상태 줄 아래에 그린다. */
export type ChatColumnProps = SlotProps;

/**
 * 미리보기 칸(단계 3 이 채운다). `onScreenName` 은 지금 화면의 제목을 셸에
 * 알린다 — 좁은 창의 `화면 · <이름>` 탭이 읽는다. 찍은 핀 수는 `pins` 에서
 * 셸이 직접 센다.
 */
export interface PreviewColumnProps extends SlotProps {
  onScreenName: (name: string | null) => void;
}

/**
 * 상태 줄(단계 4 가 `이번 작업` · 제출 확인을 채운다). 여정은 셸이
 * `deriveJourney` 로 한 번 판정해 건넨다 — 상태 줄 · 좁은 창 · 팝오버가 한
 * 원천을 읽는다.
 */
export interface StatusLineProps {
  daemon: Daemon;
  sessions: Sessions;
  project: ProjectSummary | null;
  /** 왼쪽의 대화 제목 — 이름 바꾸기가 이긴다. 새 대화면 `새 대화`. */
  title: string;
  journey: Journey;
  /** AI 가 도는 턴의 시작 시각(데몬 시계, ms) — `만드는 중 · 12초`. 모르면 null. */
  turnStartedAt: number | null;
  narrow: boolean;
  nav: ShellNav;
  /** 열린 제출 버튼을 눌렀다 — 단계 4 가 확인 팝오버로 바꾼다. 지금은 자리만. */
  onSubmit: () => void;
}
