import type { ThreadSummary } from "@colo-design/protocol";
import { useEffect, useRef, useState } from "react";
import { Fold } from "../../components";
import { useInviteImport } from "../../hooks/use-invite-import";
import type { Daemon } from "../../lib/daemon-client";
import {
  type ChatSettings,
  type LayoutSettings,
  loadReadRepoWarnings,
  rememberReadRepoWarning,
  type Settings,
  SIDEBAR_WIDTH_BOUNDS,
  switchProviderPatch,
} from "../../lib/settings";
import { InviteDialog } from "../dialogs/InviteDialog";
import type { SettingsCategory } from "../dialogs/SettingsDialog";
import { Onboarding } from "../onboarding/Onboarding";
import { StartFlow } from "../onboarding/StartFlow";
import { StateBanner } from "../StateBanner";
import { PageWorkspace, type WorkspaceHandle } from "./PageWorkspace";
import { Sidebar } from "./Sidebar";
import { Splitter } from "./Splitter";
import { Tip } from "./Tip";

/** The folded rail's width — an icon column, not a hidden panel. */
const SIDEBAR_COLLAPSED_WIDTH = 44;
/** The unfolded tree's width until a drag says otherwise. 240 truncated
    most Korean task names to ~9 characters; 264 buys the titles back
    without crowding a 1280px workspace (the bounds cap at 360). */
const SIDEBAR_DEFAULT_WIDTH = 264;
/** Below this the rail folds by itself: three columns cannot fit. */
const NARROW_QUERY = "(max-width: 1100px)";

/**
 * The frame: the project rail on the left, and on the right the header, the
 * daemon's warnings, and the workspace — or, with no project yet, the
 * full-window start wizard (token → repo → 준비).
 *
 * There is one workspace now. The 기획/디자인 tabs that used to
 * live here were the daemon's two cwds showing through — a planner works on
 * one project at a time, not on one half of the tool at a time.
 */
export function Shell({
  daemon,
  settings,
  onChatChange,
  onLayoutChange,
  onOpenSettings,
  onRenameSession,
  onboardingOpen,
  onOnboardingClose,
}: {
  daemon: Daemon;
  settings: Settings;
  /** 설정 owns how the agent answers; the workspace starts threads on it. */
  onChatChange: (patch: Partial<ChatSettings>) => void;
  /** The workspace column widths, persisted the same way — a planner who has
      dragged the columns to fit their window should find them there tomorrow. */
  onLayoutChange: (patch: Partial<LayoutSettings>) => void;
  onOpenSettings: (category?: SettingsCategory) => void;
  /** The planner's own names for threads, kept by session id in 설정's store. */
  onRenameSession: (sessionId: string, title: string) => void;
  /** Forces the first-run wizard open (SettingsDialog's 다시 보기). */
  onboardingOpen: boolean;
  onOnboardingClose: () => void;
}) {
  const { connection, status, api } = daemon;
  // 초대 파일 가져오기 — 앱에 컨트롤러는 하나다. 드롭 · 고르기 창 · 설정의 열기
  // 버튼이 전부 여기로 모이고, 시작 화면과 작업 화면 대화상자가 이것을 그린다.
  const inviteImport = useInviteImport(daemon);

  // 첫 실행의 결과가 모두 성공이고 경고도 없으면 결과 화면은 소음이다 — 확인
  // 카드에서 삭제 안내를 이미 읽었으므로 조용히 닫는다.
  useEffect(() => {
    const state = inviteImport.state;
    if (
      state.phase === "done" &&
      state.firstRun &&
      state.result.tokenError === undefined &&
      state.result.reachWarnings.length === 0 &&
      state.result.results.every((entry) => entry.ok)
    ) {
      inviteImport.close();
    }
  }, [inviteImport.state, inviteImport.close]);
  // 개발 실행(dev) 판정 — 프로젝트 지우기(1단계 canRemoveProject)가 쓴다.
  const devMachine = status?.dev === true;
  /** 시작하기 was pressed this session — warns stop re-opening the wizard. */
  const [wizardDismissed, setWizardDismissed] = useState(false);
  useEffect(() => {
    if (connection !== "open") return;
    // 연결 직후의 검사는 설정이 고른 프로바이더의 몫이다 — 기본 claude 로
    // 검사해 놓고 불일치로 한 번 더 묻는 낭비를 줄인다. 설정이 연결된 뒤
    // 바뀌는 경우는 아래의 불일치 effect 가 걷는다.
    void api.onboardingCheck(settings.chat.provider).catch(() => undefined);
  }, [connection, api]);

  // 설정에 남은 프로바이더가 이 데몬에 없으면 — 개발 실행에서 omp 로 쓰다
  // 패키징된 앱을 켠 경우(DaemonConfig.devAgents) — 첫 쓸 수 있는 프로바이더로
  // 옮긴다. 두지 않으면 첫 보내기가 `알 수 없는 에이전트입니다` 로 죽는다.
  // 핀 옮기기는 설정창의 프로바이더 스위치와 같은 patch 다.
  useEffect(() => {
    const rows = status?.providers;
    if (!rows?.length || rows.some((p) => p.id === settings.chat.provider)) return;
    const fallback = rows.find((p) => p.available) ?? rows[0];
    if (fallback) onChatChange(switchProviderPatch(settings.chat, fallback.id));
  }, [status?.providers, settings.chat, onChatChange]);

  // 설정에서 고른 프로바이더가 마지막 검사의 프로바이더와 다르면 한 번 다시
  // 묻는다. 기다리는 동안의 판정(stale steps)으로는 작업대를 막지 않는다 —
  // 낡은 fail 이 화면을 다시 마법사로 밀어 올리는 일이 없게.
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
        // 설정이 그 사이에 또 바뀌었다면 다음 effect 가 다시 걷는다.
        if (checkedProvider.current === wanted) setRecheckingProvider(false);
      });
  }, [connection, api, settings.chat.provider, daemon.onboardingProvider, recheckingProvider]);

  // A failing gate blocks: the tool cannot work without a Claude CLI or git,
  // and an UNANSWERED check blocks too — the checks run real commands and
  // treating "not yet known" as "fine" flashed the whole workspace at a
  // planner who has configured nothing, then yanked it away.
  // 예외 둘: 프로바이더 불일치 재검사가 도는 동안에는 화면의 steps 가 지난
  // 프로바이더의 판정이라 그 fail 로는 막지 않는다 — 재검사의 답이 판정이다.
  // 그리고 프로젝트가 하나 이상 있는 기계의 로그인 만료(login-claude)도 막지
  // 않는다(3단계) — 작업 화면 상단의 "다시 로그인" 배너가 맡는 자리다. 첫
  // 실행(프로젝트 0개)은 지금처럼 마법사가 로그인까지 안내한다.
  const onboardingBlocked = recheckingProvider
    ? false
    : daemon.onboarding === null ||
      daemon.onboarding.some(
        (step) =>
          step.status === "fail" &&
          !(daemon.projects.length > 0 && step.fix?.kind === "login-claude"),
      );
  // A warn does not block. On a FIRST run it still holds the stage — the
  // machine gates are the rows a planner can still act on — and the hold is
  // live, not a latch: the moment every machine gate reads pass the wizard
  // has nothing left to ask, so it steps aside by itself (no 시작하기
  // press) into the start screen that waits for an invite file. A planner
  // who already has a project has been through this; their warn lives in
  // 설정, not across their workspace. The settings-opened wizard
  // (onboardingOpen) is exempt — a 다시 보기 stays until it is closed.
  const [wizardNeeded, setWizardNeeded] = useState(false);
  useEffect(() => {
    // The hold must RELEASE: onboarding.check and the registry can arrive in
    // either order, and a hold latched before the first project would keep
    // the wizard across the screen forever (found by test:comments-ui).
    if (daemon.projects.length > 0) {
      setWizardNeeded(false);
      return;
    }
    // github 의 warn(연결 코드 없음)은 마법사 판정에서 빠진다 — 그 수정은 초대
    // 파일이 맡는다(시작 화면 · 토큰 만료 카드 · 설정의 초대 파일 열기). 기계
    // 게이트 셋의 판정이 마법사의 운명이다: 남은 것이 없으면 스스로 물러나고,
    // 하나라도 남으면 마법사가 그 행을 안고 있는다. 재검사 중의 steps 는 지난
    // 프로바이더의 판정이라 그 답으로 닫지 않는다.
    const machineGates = (daemon.onboarding ?? []).filter((step) => step.id !== "github");
    if (machineGates.length === 0) return;
    if (!recheckingProvider && machineGates.every((step) => step.status === "pass")) {
      setWizardNeeded(false);
      return;
    }
    if (machineGates.some((step) => step.status !== "pass")) setWizardNeeded(true);
  }, [daemon.onboarding, daemon.projects.length, recheckingProvider]);
  // The daemon knows why it cannot work — no CLI, not signed in, no pnpm — and
  // the planner cannot read a terminal to find out. 단계 10부터 이 경고 띠는
  // 개발 실행에서만 선다(PLAN L8): 실사용에서는 데몬이 `env:<종류>` 로 스스로
  // 개발자에게 알리고(단계 4), 화면은 주의 한 줄(AttentionLine)이 전부다.
  // 레포 경고(repoSettingsWarning)도 같은 방 — 개발자의 말을 하는 소식이다.
  const warnings = devMachine ? (status?.warnings ?? []) : [];
  const repoWarning = devMachine ? (status?.repoSettingsWarning ?? null) : null;
  // 로그인 만료는 헤더의 경고 중 유일하게 앱 안에서 풀리는 것이다(리뷰 문서의
  // "시한폭탄"): 구독 로그인이 끊기면 대화가 크래시 카드로 죽는다. 이제 그
  // 소식은 주의 한 줄(AttentionLine 의 reconnect/agent-login)이 말한다 —
  // 같은 자리에서 다시 로그인을 열고, 로그인이 끝나면 상태 방송이 거둔다.
  const loggedOut = status != null && status.claudeExecutable != null && !status.loggedIn;
  /** 닫은 경고는 이 세션 동안만 숨긴다 — 같은 문장의 재방송은 읽은 소식이고,
      새 문장은 새 소식이니 다시 보인다. 레포 경고(뉴스)만 예외로 기기에
      눌러 담는다 — 아래 readRepoWarnings. */
  const [dismissedWarnings, setDismissedWarnings] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  /** 기기에서 닫은 레포 경고 지문 — 다른 레포, 수정된 설정은 새 지문이라
      다시 보인다. 새로고침 사이에도 묵묵히 유지되는 것이 이 경고의 요구다. */
  const [readRepoWarnings, setReadRepoWarnings] = useState<ReadonlySet<string>>(
    () => new Set(loadReadRepoWarnings()),
  );
  /** 닫기는 즉시 지우지 않는다 — closing 동안만 담겨 슬롯이 접히고,
      transitionend(그리드 접힘)에서 dismissed 로 넘어간다. 사라지는 대신
      자리를 비워 주는 게 이 닫기의 전부다. */
  const [closingWarnings, setClosingWarnings] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  // The logged-out warning never reaches the strip — its actionable row is the
  // attention line's `다시 로그인` button now. The rest the planner may
  // close: 닫기는 "문제가 없다"가 아니라 "읽었다"다. Env warnings close for
  // the session; the repo warning's close carries its fingerprint and
  // outlives the tab.
  const visibleWarnings = [
    ...warnings
      .filter((w) => !(loggedOut && w.startsWith("Claude Code 로그인이 필요합니다")))
      .map((text) => ({ text, fingerprint: null })),
    ...(repoWarning && !readRepoWarnings.has(repoWarning.fingerprint)
      ? [{ text: repoWarning.text, fingerprint: repoWarning.fingerprint }]
      : []),
  ].filter((w) => !dismissedWarnings.has(w.text));
  /** 보이는 경고가 전부 접히는 중이면 스트립도 같이 접는다 — 슬롯만 접고
      여백·경계선이 남으면 빈 테두리가 한 번에 사라지는 점프가 된다. */
  const stripClosing =
    visibleWarnings.length > 0 && visibleWarnings.every((w) => closingWarnings.has(w.text));

  // The rail's width and fold, seeded from the stored layout (already
  // clamped). Narrow windows fold it no matter what the setting says.
  const [sidebarWidth, setSidebarWidth] = useState(
    () => settings.layout.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH,
  );
  const [collapsed, setCollapsed] = useState(settings.layout.sidebarCollapsed);
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(NARROW_QUERY).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(NARROW_QUERY);
    if (!media) return;
    const onChange = () => setNarrow(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  const folded = collapsed || narrow;

  /**
   * The sidebar tree and the workspace are siblings here; the tree's clicks
   * (open · new · delete) cross this ref, and the workspace
   * reports the open thread back for the tree's active mark. No state of its
   * own beyond that one string — the session flows stay the workspace's.
   */
  const workspace = useRef<WorkspaceHandle>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const openThread = (slug: string, thread: ThreadSummary) =>
    workspace.current?.openThread(slug, thread);
  const newThread = (slug: string) => workspace.current?.newThread(slug);
  const deleteThread = (slug: string, thread: ThreadSummary) =>
    workspace.current?.deleteThread(slug, thread);
  const clearThreads = (slug: string) => workspace.current?.clearThreads(slug);
  const exportThread = (slug: string, thread: ThreadSummary) =>
    workspace.current?.exportThread(slug, thread);
  const browseThreads = (slug: string) => workspace.current?.browseThreads(slug);
  const goHome = () => workspace.current?.goHome();

  // The drag in flight, mirrored from PageWorkspace's preview boundary: the
  // pointer capture is what keeps it alive across the project list.
  const [drag, setDrag] = useState<{
    startX: number;
    startWidth: number;
  } | null>(null);
  const clampWidth = (value: number) =>
    Math.min(SIDEBAR_WIDTH_BOUNDS.max, Math.max(SIDEBAR_WIDTH_BOUNDS.min, Math.round(value)));

  // The first status snapshot carries the registry: until it lands, an empty
  // `projects` means "not yet known", and painting the picker from it showed
  // a decision screen for one round trip on every reload. The brand holds
  // the stage until the snapshot says what this machine actually has.
  if (status === null) {
    return (
      <div className="planner planner--onboarding boot" aria-busy="true">
        <img className="onboarding__mark" src="/colonova-icon.svg" alt="" width={36} height={36} />
      </div>
    );
  }

  // 마법사가 떠 있어도 초대 파일 드롭 리스너는 살아 있다(useInviteImport 가
  // 창 전체에서 받는다) — 받은 사실을 마법사 안에 한 줄로 알려 둔다. 이어짐은
  // 시작 화면이 맡는다: 마법사가 닫히면 StartFlow 가 받아 둔 상태(confirm 카드)
  // 를 그대로 그린다.
  const inviteNotice =
    inviteImport.state.phase === "reading" || inviteImport.state.phase === "confirm"
      ? { tone: "info" as const, text: "초대 파일을 받았어요 — 준비가 끝나면 바로 이어집니다." }
      : inviteImport.state.phase === "error"
        ? { tone: "error" as const, text: inviteImport.state.error }
        : null;

  if (onboardingBlocked || onboardingOpen || (wizardNeeded && !wizardDismissed)) {
    return (
      <div className="planner planner--onboarding">
        <Onboarding
          daemon={daemon}
          inviteNotice={inviteNotice}
          provider={settings.chat.provider}
          providers={daemon.status?.providers ?? []}
          checking={recheckingProvider}
          onProviderChange={(id) => onChatChange(switchProviderPatch(settings.chat, id))}
          onDone={() => {
            setWizardDismissed(true);
            onOnboardingClose();
          }}
          // 막는 단계가 없을 때만 나가는 길을 둔다 — 설정에서 다시 연
          // 마법사가 못 나가는 함정이 되지 않게.
          onClose={
            onboardingBlocked
              ? undefined
              : () => {
                  setWizardDismissed(true);
                  onOnboardingClose();
                }
          }
        />
      </div>
    );
  }

  // 프로젝트가 없으면 시작 화면이 창 전부다 — 첫 실행엔 사이드바에 보여줄 대화도
  // 프로젝트도 없으므로 껍데기는 소음이다. 첫 실행의 적용이 도는 동안에도 이
  // 화면을 지킨다 — 첫 프로젝트가 생기는 순간 작업 화면으로 바뀌면 나머지 진행과
  // 실패가 안 보이는 일을 막는다(실패한 행의 다시 시도는 이 화면의 카드에 있다).
  const firstRunApplying = inviteImport.state.phase === "applying" && inviteImport.state.firstRun;
  if (daemon.projects.length === 0 || firstRunApplying) {
    return (
      <div className="planner planner--onboarding">
        <StartFlow daemon={daemon} invite={inviteImport} />
      </div>
    );
  }

  return (
    <div
      className={`planner${folded ? " planner--rail" : ""}${drag ? " planner--resizing" : ""}`}
      style={{
        gridTemplateColumns: folded
          ? `${SIDEBAR_COLLAPSED_WIDTH}px minmax(0, 1fr)`
          : `${sidebarWidth}px minmax(0, 1fr)`,
      }}
    >
      <Sidebar
        daemon={daemon}
        commonInstructions={status?.commonInstructions ?? null}
        collapsed={collapsed}
        collapsedByViewport={narrow}
        onToggleCollapsed={() => {
          const next = !collapsed;
          setCollapsed(next);
          onLayoutChange({ sidebarCollapsed: next });
        }}
        canRemoveProject={devMachine}
        onOpenSettings={onOpenSettings}
        sessionTitles={settings.sessionTitles}
        activeThreadId={activeThreadId}
        onOpenThread={openThread}
        onNewThread={newThread}
        onDeleteThread={deleteThread}
        onClearThreads={clearThreads}
        onExportThread={exportThread}
        onRenameThread={onRenameSession}
        onBrowseThreads={browseThreads}
        onGoHome={goHome}
        boundary={
          !folded && (
            <Splitter
              side="left"
              width={sidebarWidth}
              bounds={SIDEBAR_WIDTH_BOUNDS}
              label="프로젝트 목록 너비"
              active={drag !== null}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                try {
                  event.currentTarget.setPointerCapture(event.pointerId);
                } catch {
                  /* no live pointer with that id */
                }
                setDrag({ startX: event.clientX, startWidth: sidebarWidth });
              }}
              onPointerMove={(event) => {
                if (!drag) return;
                // 버튼이 이미 떼졌는데 move 가 흘러온다 — 포인터 캡처 실패
                // 자리다. 끝으로 본다: drag 가 붙은 채 남으면 나중의 hover
                // 만으로 사이드바 폭이 흔들린다.
                if (event.buttons === 0) {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                  setDrag(null);
                  onLayoutChange({ sidebarWidth });
                  return;
                }
                setSidebarWidth(clampWidth(drag.startWidth + (event.clientX - drag.startX)));
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                setDrag(null);
                onLayoutChange({ sidebarWidth });
              }}
              onNudge={(delta) => {
                setSidebarWidth((prev) => {
                  const next = clampWidth(prev + delta);
                  onLayoutChange({ sidebarWidth: next });
                  return next;
                });
              }}
              onReset={() => {
                setDrag(null);
                setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
                onLayoutChange({ sidebarWidth: null });
              }}
            />
          )
        }
      />

      <div className="planner__main">
        {/* 프로젝트가 있으면 제목 행은 PageWorkspace 의 것이 다 — 프로젝트
            이름이 한 행을 쓴다. 이 자리의 헤더는
            프로젝트가 없을 때만 남는다: 시작 흐름 동안 연결 상태를 오른쪽에
            비추는 최소한의 행. 브랜드는 왼쪽 레일이 이미 읽는다. */}
        {daemon.projects.length === 0 && (
          <header className="planner__header">
            <span className="planner__spacer" />
            {/* The header used to read "데몬: 연결됨 · https://github.com/…" — the
                name of a program the planner never starts, beside a git url they
                never type. What is left is the only part that changes
                what they should do: whether the tool can work right now. Both the
                address and the repo live in 설정 → 문제 해결. */}
            {connection !== "open" && (
              <Tip label="연결이 끊기면 대화와 보관이 잠시 멈춥니다" side="bottom">
                <span className="hint">연결하는 중…</span>
              </Tip>
            )}
            {/* 설정 used to live here as a header gear — it moved to the rail's
                foot (Sidebar) so the whole frame's controls sit in one room. */}
          </header>
        )}

        {(visibleWarnings.length > 0 || connection === "closed") && (
          <div
            className={
              stripClosing ? "planner__warnings planner__warnings--closing" : "planner__warnings"
            }
          >
            {/* 붙었던 선이 끊긴 상태 — ConnectScreen은 첫 연결 실패 전용이라
                여기서는 스트립이 알린다. 백오프 재시도는 클라이언트가 계속
                돌리고, 버튼은 그 대기를 건너뛰는 지름길. 닫기 버튼은 없다:
                연결은 경고가 아니라 상태라, 거둬도 사라지지 않는다. */}
            {connection === "closed" && (
              <StateBanner
                tone="warn"
                role="alert"
                title="연결이 끊겼어요 — 다시 연결하는 중…"
                action={{ label: "지금 다시 시도", onClick: () => daemon.reconnect() }}
              />
            )}
            {visibleWarnings.map((warning) => (
              <Fold
                key={warning.text}
                closing={closingWarnings.has(warning.text)}
                onCollapsed={() => {
                  const { fingerprint } = warning;
                  if (fingerprint) {
                    rememberReadRepoWarning(fingerprint);
                    setReadRepoWarnings((prev) => new Set(prev).add(fingerprint));
                  }
                  setClosingWarnings((prev) => {
                    const next = new Set(prev);
                    next.delete(warning.text);
                    return next;
                  });
                  setDismissedWarnings((prev) => new Set(prev).add(warning.text));
                }}
              >
                <StateBanner
                  tone="warn"
                  role="status"
                  title={warning.text}
                  closeLabel="경고 닫기"
                  onClose={() => setClosingWarnings((prev) => new Set(prev).add(warning.text))}
                  /* 경고의 조치는 데몬이 맡는다(단계 4 · L11): `env:<종류>` 로
                     스스로 개발자에게 올리고, 화면의 문제 문장은 주의 한
                     줄(AttentionLine)이 말한다 — 이 띠는 개발 실행의 읽을거리다. */
                />
              </Fold>
            ))}
          </div>
        )}

        {/* Here only with a project — the project-less face is the start
            wizard above. `PageWorkspace` owns its own .planner__body — the
            three columns and their draggable boundaries are its business,
            not the frame's. */}
        <PageWorkspace
          ref={workspace}
          daemon={daemon}
          settings={settings}
          onChatChange={onChatChange}
          onLayoutChange={onLayoutChange}
          onOpenSettings={onOpenSettings}
          onRenameSession={onRenameSession}
          onActiveThreadChange={setActiveThreadId}
        />
      </div>
      {/* 초대 가져오기 — 작업 화면 위의 대화상자. 첫 실행이 모두 성공하고 경고도
          없으면 아래 effect 가 조용히 닫는다(삭제 안내는 확인 카드가 이미 말했다). */}
      <InviteDialog daemon={daemon} controller={inviteImport} />
    </div>
  );
}
