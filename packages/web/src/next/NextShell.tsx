import { sameRepo } from "@colo-design/protocol";
import { useEffect, useRef, useState } from "react";
import type { SettingsCategory } from "../components/dialogs/SettingsDialog";
import { useInviteImport } from "../hooks/use-invite-import";
import type { Daemon } from "../lib/daemon-client";
import {
  type ChatSettings,
  type LayoutSettings,
  type Settings,
  switchProviderPatch,
} from "../lib/settings";
import { FirstRun } from "./onboarding/FirstRun";
import { InviteConfirm } from "./onboarding/InviteConfirm";
import "./next.css";
import { Workspace } from "./Workspace";

/** App 이 두 셸에 같은 값으로 건네는 계약(PLAN-UI 4 · 병행 셸) — 옛 Shell 과 같다. */
export interface NextShellProps {
  daemon: Daemon;
  settings: Settings;
  onChatChange: (patch: Partial<ChatSettings>) => void;
  onLayoutChange: (patch: Partial<LayoutSettings>) => void;
  onOpenSettings: (category?: SettingsCategory) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  /** 설정의 `다시 보기` 가 처음 화면을 다시 연다. */
  onboardingOpen: boolean;
  onOnboardingClose: () => void;
}

/**
 * 새 셸(PLAN-UI 단계 1 · 5) — 갈림길이 하나다. 첫 실행(프로젝트 0개) · 게이트가
 * 막혔을 때 · 설정이 다시 열었을 때는 체크리스트 한 장(FirstRun, U11)이 창을
 * 쓰고, 그 밖에는 작업 틀(Workspace)이 쓴다. `시작하기` 는 없다 — 게이트가 모두
 * 지나가고 프로젝트가 생기면 저절로 넘어간다.
 *
 * 초대 파일 가져오기의 컨트롤러는 여기 앱에 하나 둔다(use-invite-import) — 창
 * 어디에 떨어뜨린 파일 · 설정의 열기 · 문제 문장의 안내가 전부 여기로 모이고,
 * 확인판(InviteConfirm)이 첫 실행 위에도 작업 틀 위에도 뜬다. 가져온 파일의
 * 위치는 데스크톱이 알려 준 것만 `discardableInvitePath` 로 셸 이동 상태에
 * 실는다 — 대화 칸(단계 2)의 `파일 지우기` 줄이 그것을 읽는다.
 */
export function NextShell(props: NextShellProps) {
  const { daemon, settings, onChatChange, onboardingOpen, onOnboardingClose } = props;
  const { connection, api } = daemon;
  const invite = useInviteImport(daemon);

  // 연결 직후의 검사는 설정이 고른 프로바이더의 몫이다(옛 Shell 과 같은 배선).
  useEffect(() => {
    if (connection !== "open") return;
    void api.onboardingCheck(settings.chat.provider).catch(() => undefined);
  }, [connection, api]);

  // 설정에 남은 프로바이더가 이 데몬에 없으면 첫 쓸 수 있는 것으로 옮긴다 — 두지
  // 않으면 첫 보내기가 `알 수 없는 에이전트입니다` 로 죽는다(개발 실행의 omp 흔적).
  useEffect(() => {
    const rows = daemon.status?.providers;
    if (!rows?.length || rows.some((entry) => entry.id === settings.chat.provider)) return;
    const fallback = rows.find((entry) => entry.available) ?? rows[0];
    if (fallback) onChatChange(switchProviderPatch(settings.chat, fallback.id));
  }, [daemon.status?.providers, settings.chat, onChatChange]);

  // 설정에서 고른 프로바이더가 마지막 검사와 다르면 한 번 다시 묻는다 — 지난
  // 프로바이더의 fail 로 작업 틀을 막지 않기 위해서다(옛 Shell 의 재검사).
  const [recheckingProvider, setRecheckingProvider] = useState(false);
  const checkedProvider = useRef<string | null>(null);
  useEffect(() => {
    if (connection !== "open") return;
    const wanted = settings.chat.provider;
    if (checkedProvider.current === wanted) {
      if (recheckingProvider) setRecheckingProvider(false);
      return;
    }
    const mismatch = daemon.onboardingProvider !== null && daemon.onboardingProvider !== wanted;
    if (!mismatch) {
      checkedProvider.current = wanted;
      if (recheckingProvider) setRecheckingProvider(false);
      return;
    }
    if (recheckingProvider) return;
    checkedProvider.current = wanted;
    setRecheckingProvider(true);
    void api
      .onboardingCheck(wanted)
      .catch(() => undefined)
      .finally(() => {
        if (checkedProvider.current === wanted) setRecheckingProvider(false);
      });
  }, [connection, api, settings.chat.provider, daemon.onboardingProvider, recheckingProvider]);

  // 게이트가 막히면 체크리스트가 창을 쓴다 — 로그인 만료(login-claude)는 프로젝트가
  // 있는 기계에서 막지 않는다: 그 소식은 작업 틀의 문제 문장이 맡는다. 답이 없는
  // 검사(onboarding === null)도 막는다 — 지나가는 작업 틀로 사용자를 흔들지 않는다.
  const projects = daemon.projects;
  const gatesHold = recheckingProvider
    ? false
    : daemon.onboarding === null ||
      daemon.onboarding.some(
        (step) =>
          step.status === "fail" && !(projects.length > 0 && step.fix?.kind === "login-claude"),
      );
  // 첫 실행의 적용이 도는 동안에도 첫 화면을 지킨다 — 첫 프로젝트가 생기는 순간
  // 넘어가면 나머지 진행과 실패가 안 보인다(옛 Shell 과 같은 이유).
  const applyingFirst = invite.state.phase === "applying" && invite.state.firstRun;
  const firstRun =
    daemon.status === null || onboardingOpen || projects.length === 0 || applyingFirst || gatesHold;
  // 설정의 `다시 보기` 로 다시 연 판은 나가는 길이 있다 — 막는 단계가 없을 때만.
  const reopenClosable = onboardingOpen && !gatesHold && projects.length > 0;

  // 첫 실행이 모두 성공하고 경고도 없으면 확인판은 소음이다 — 조용히 닫는다
  // (삭제 안내는 확인판이 이미 말했다). 옛 Shell 의 효과를 그대로.
  useEffect(() => {
    const state = invite.state;
    if (
      state.phase === "done" &&
      state.firstRun &&
      state.result.tokenError === undefined &&
      state.result.reachWarnings.length === 0 &&
      state.result.results.every((entry) => entry.ok)
    ) {
      invite.close();
    }
  }, [invite.state, invite.close]);

  // 가져온 파일의 위치 — 단계 2 의 대화 칸이 `파일 지우기` 줄로 읽는다(U11).
  // 이 판에서 이미 지웠다면 줄은 세우지 않는다.
  const [discardableInvitePath, setDiscardableInvitePath] = useState<string | null>(null);
  const inviteDiscarded = useRef(false);
  useEffect(() => {
    if (invite.state.phase === "confirm") inviteDiscarded.current = false;
  }, [invite.state.phase]);
  useEffect(() => {
    if (invite.state.phase !== "done") return;
    setDiscardableInvitePath(inviteDiscarded.current ? null : (invite.state.path ?? null));
  }, [invite.state]);

  // `지금 열기` — 적용이 끝나면 그 행의 프로젝트로. 등록부가 아직 그것을 모를
  // 수 있으므로 답을 기다렸다가 짝(sameRepo)을 찾아 활성화한다.
  const pendingOpen = useRef<string | null>(null);
  useEffect(() => {
    if (invite.state.phase !== "done") return;
    const repoUrl = pendingOpen.current;
    if (!repoUrl) return;
    const target = daemon.projects.find(
      (project) => typeof project.repoUrl === "string" && sameRepo(project.repoUrl, repoUrl),
    );
    if (!target) return;
    pendingOpen.current = null;
    void daemon.api.projectActivate(target.slug).catch(() => undefined);
  }, [invite.state, daemon.projects, daemon.api]);

  return (
    <>
      {firstRun ? (
        <FirstRun
          daemon={daemon}
          provider={settings.chat.provider}
          invite={invite}
          checking={recheckingProvider}
          onClose={reopenClosable ? onOnboardingClose : undefined}
        />
      ) : (
        <Workspace {...props} discardableInvitePath={discardableInvitePath} />
      )}
      <InviteConfirm
        daemon={daemon}
        state={invite.state}
        onApply={(authorDraft, openRepoUrl) => {
          pendingOpen.current = openRepoUrl ?? null;
          invite.apply(authorDraft);
        }}
        onRetry={invite.retry}
        onClose={invite.close}
        onOpenPicker={invite.openPicker}
        onDiscarded={() => {
          inviteDiscarded.current = true;
          setDiscardableInvitePath(null);
        }}
      />
    </>
  );
}
