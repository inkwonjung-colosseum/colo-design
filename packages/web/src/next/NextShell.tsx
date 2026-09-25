import { sameRepo } from "@colo-design/protocol";
import { useEffect, useRef, useState } from "react";
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

/** App 이 셸에 건네는 계약 — 연결 하나와 설정 상태의 저장 손들. */
export interface NextShellProps {
  daemon: Daemon;
  settings: Settings;
  onChatChange: (patch: Partial<ChatSettings>) => void;
  onLayoutChange: (patch: Partial<LayoutSettings>) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  /** 설정 대화상자(단계 6)가 저장하는 손 — App 의 설정 상태로 간다. */
  onSettingsChange: (patch: Partial<Settings>) => void;
}

/**
 * 셸(PLAN-UI 단계 1 · 5) — 갈림길이 하나다. 첫 실행(프로젝트 0개) · 게이트가
 * 막혔을 때는 체크리스트 한 장(FirstRun, U11)이 창을
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
  const { daemon, settings, onChatChange } = props;
  const { connection, api } = daemon;
  const invite = useInviteImport(daemon);

  // 연결 직후의 검사는 설정이 고른 프로바이더의 몫이다. 문은 연결이다 — 고른 것이
  // 바뀌는 순간의 다시 묻기는 아래 효과가 맡으므로, 여기서는 그 순간의 값만 읽는다.
  const providerNow = useRef(settings.chat.provider);
  providerNow.current = settings.chat.provider;
  useEffect(() => {
    if (connection !== "open") return;
    void api.onboardingCheck(providerNow.current).catch(() => undefined);
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
  // 프로바이더의 fail 로 작업 틀을 막지 않기 위해서다.
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
  // 넘어가면 나머지 진행과 실패가 안 보인다.
  const applyingFirst = invite.state.phase === "applying" && invite.state.firstRun;
  const firstRun = daemon.status === null || projects.length === 0 || applyingFirst || gatesHold;

  // 첫 가져오기(프로젝트 0개)의 행이 모두 `새로` 면 확인판은 되묻는 한 걸음일 뿐이다 —
  // 곧바로 적용하고, 끝나면 첫 프로젝트의 `초대 파일을 가져왔어요` 줄이 파일 지우기를
  // 맡는다(U11). 옛 초대장이라 적을 이름을 물어야 할 때만 확인판이 선다.
  const autoApplied = useRef<object | null>(null);
  const autoFirst =
    invite.state.phase === "confirm" &&
    invite.state.firstRun &&
    invite.state.rows.length > 0 &&
    invite.state.rows.every((row) => row.action === "add") &&
    Boolean(invite.state.invite.authorName || daemon.status?.authorName);
  useEffect(() => {
    if (!autoFirst || autoApplied.current === invite.state) return;
    autoApplied.current = invite.state;
    invite.apply("");
  }, [autoFirst, invite]);
  // 첫 화면이 가져오기를 그리는 동안(여는 중 · 곧바로 적용 · 적용 중)은 확인판을 띄우지
  // 않는다 — 체크리스트의 셋째 항목이 그 진행을 말한다. 실패 · 경고는 판이 말한다.
  const quietFirst =
    firstRun &&
    projects.length === 0 &&
    (invite.state.phase === "reading" || invite.state.phase === "applying" || autoFirst);

  // 첫 실행이 모두 성공하고 경고도 없으면 확인판은 소음이다 — 조용히 닫는다
  // (삭제 안내는 확인판이 이미 말했다).
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
        />
      ) : (
        <Workspace {...props} discardableInvitePath={discardableInvitePath} />
      )}
      {!quietFirst && (
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
      )}
    </>
  );
}
