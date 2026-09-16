import type { ThreadSummary } from "@colo-design/protocol";
import { useEffect, useRef, useState } from "react";
import { Fold } from "../../components";
import { usePreviewCover } from "../../hooks/use-preview-cover";
import type { Daemon } from "../../lib/daemon-client";
import {
  type ChatSettings,
  type LayoutSettings,
  loadReadRepoWarnings,
  rememberReadRepoWarning,
  type Settings,
  SIDEBAR_WIDTH_BOUNDS,
} from "../../lib/settings";
import { AddProjectDialog } from "../dialogs/AddProjectDialog";
import { WarnIcon } from "../icons";
import { Onboarding } from "../onboarding/Onboarding";
import { RepoPicker } from "../onboarding/RepoPicker";
import { PageWorkspace, type WorkspaceHandle } from "./PageWorkspace";
import { Sidebar } from "./Sidebar";
import { Splitter } from "./Splitter";
import { Tip } from "./Tip";

/** The folded rail's width — an icon column, not a hidden panel. */
const SIDEBAR_COLLAPSED_WIDTH = 44;
/** Below this the rail folds by itself: three columns cannot fit. */
const NARROW_QUERY = "(max-width: 1100px)";

/**
 * The frame: the project rail on the left, and on the
 * right the header, the daemon's warnings, and the workspace — or, with no
 * project yet, the picker itself.
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
  /** 설정 owns how Claude answers; the workspace starts threads on it. */
  onChatChange: (patch: Partial<ChatSettings>) => void;
  /** The workspace column widths, persisted the same way — a planner who has
      dragged the columns to fit their window should find them there tomorrow. */
  onLayoutChange: (patch: Partial<LayoutSettings>) => void;
  onOpenSettings: () => void;
  /** The planner's own names for threads, kept by session id in 설정's store. */
  onRenameSession: (sessionId: string, title: string) => void;
  /** Forces the first-run wizard open (SettingsDialog's 다시 보기). */
  onboardingOpen: boolean;
  onOnboardingClose: () => void;
}) {
  const { connection, status, api } = daemon;
  /** 프로젝트 추가 — the sidebar's `+ 새 프로젝트` opens it. */
  const [addOpen, setAddOpen] = useState(false);
  // The native preview view hides behind a freeze frame whenever a
  // modal-like layer opens — one watcher for the whole frame, mounted here.
  usePreviewCover();
  /** 시작하기 was pressed this session — warns stop re-opening the wizard. */
  const [wizardDismissed, setWizardDismissed] = useState(false);

  useEffect(() => {
    if (connection !== "open") return;
    void api.onboardingCheck().catch(() => undefined);
  }, [connection, api]);

  // A failing gate blocks: the tool cannot work without a Claude CLI or git,
  // and an UNANSWERED check blocks too — the checks run real commands and
  // treating "not yet known" as "fine" flashed the whole workspace at a
  // planner who has configured nothing, then yanked it away.
  const onboardingBlocked =
    daemon.onboarding === null || daemon.onboarding.some((step) => step.status === "fail");
  // A warn does not block. On a FIRST run it still holds the stage — a
  // machine with no GitHub token should land on the token form, not on an
  // empty picker that can only offer a pasted url — and once the wizard is
  // up it stays until 시작하기. A planner who already has a project has been
  // through this; their warn lives in 설정, not across their workspace.
  const [wizardNeeded, setWizardNeeded] = useState(false);
  useEffect(() => {
    // The hold must RELEASE: onboarding.check and the registry can arrive in
    // either order, and a hold latched before the first project would keep
    // the wizard across the screen forever (found by test:comments-ui).
    if (daemon.projects.length > 0) {
      setWizardNeeded(false);
      return;
    }
    if (daemon.onboarding?.some((step) => step.status !== "pass")) setWizardNeeded(true);
  }, [daemon.onboarding, daemon.projects.length]);
  // The daemon knows why it cannot work — no CLI, not signed in, no pnpm — and
  // the planner cannot read a terminal to find out. The repo's settings.json
  // warning rides beside them but is news, not a live problem: its
  // fingerprint, once closed, stays closed on this device until the file or
  // the repo changes.
  const warnings = status?.warnings ?? [];
  const repoWarning = status?.repoSettingsWarning ?? null;
  // 로그인 만료는 헤더의 경고 중 유일하게 앱 안에서 풀리는 것이다(리뷰 문서의
  // "시한폭탄"): 구독 로그인이 끊기면 대화가 크래시 카드로 죽고, 여기가 그 소식이
  // 처음 보이는 자리다. 같은 자리에서 다시 로그인을 열고, 마친 뒤에는 다시 확인
  // 으로 지운다 — 터미널은 끝까지 사용자의 몫으로 남지 않는다.
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
  // The logged-out warning is replaced by its own actionable row below — the
  // sentence is the daemon's, the button is here. The rest the planner may
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
    !loggedOut &&
    visibleWarnings.length > 0 &&
    visibleWarnings.every((w) => closingWarnings.has(w.text));
  const [loginStarted, setLoginStarted] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginGuidance, setLoginGuidance] = useState<string | null>(null);
  const loginPress = async () => {
    if (loginStarted) {
      setLoginBusy(true);
      try {
        await api.refreshStatus();
      } finally {
        setLoginBusy(false);
      }
      return;
    }
    setLoginBusy(true);
    try {
      const outcome = (await api.onboardingFix("login-claude")) as {
        guidance: string;
      };
      setLoginStarted(true);
      setLoginGuidance(outcome.guidance);
    } catch {
      setLoginGuidance(
        "로그인 창을 열지 못했습니다 — 설정 → 처음 설정 다시 보기에서 다시 시도해 주세요.",
      );
    } finally {
      setLoginBusy(false);
    }
  };

  // The rail's width and fold, seeded from the stored layout (already
  // clamped). Narrow windows fold it no matter what the setting says.
  const [sidebarWidth, setSidebarWidth] = useState(() => settings.layout.sidebarWidth ?? 240);
  const [collapsed, setCollapsed] = useState(settings.layout.sidebarCollapsed);
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(NARROW_QUERY).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(NARROW_QUERY);
    if (!media) return;
    const onChange = () => setNarrow(media.matches);
    media.addEventListener("change", onChange);
    return () => window.removeEventListener("change", onChange);
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
  const exportThread = (slug: string, thread: ThreadSummary) =>
    workspace.current?.exportThread(slug, thread);
  const browseThreads = (slug: string) => workspace.current?.browseThreads(slug);

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

  if (onboardingBlocked || onboardingOpen || (wizardNeeded && !wizardDismissed)) {
    return (
      <div className="planner planner--onboarding">
        <Onboarding
          daemon={daemon}
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

  const activeProject = daemon.projects.find((project) => project.slug === daemon.activeSlug);

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
        onAddProject={() => setAddOpen(true)}
        onOpenSettings={onOpenSettings}
        sessionTitles={settings.sessionTitles}
        activeThreadId={activeThreadId}
        onOpenThread={openThread}
        onNewThread={newThread}
        onDeleteThread={deleteThread}
        onExportThread={exportThread}
        onRenameThread={onRenameSession}
        onBrowseThreads={browseThreads}
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
                setSidebarWidth(240);
                onLayoutChange({ sidebarWidth: null });
              }}
            />
          )
        }
      />

      <div className="planner__main">
        <header className="planner__header">
          {/* With no project the header stays empty — the brand already reads
              in the rail beside it, and the picker below is the real content. */}
          {activeProject && <span className="planner__project">{activeProject.name}</span>}
          <span className="planner__spacer" />
          {/* The header used to read "데몬: 연결됨 · https://github.com/…" — the
              name of a program the planner never starts, beside a git url they
              never type. What is left is the only part that changes
              what they should do: whether the tool can work right now. Both the
              address and the repo live in 설정 → 문제 해결. */}
          {connection !== "open" && (
            <Tip label="연결이 끊기면 대화와 저장이 잠시 멈춥니다" side="bottom">
              <span className="hint">연결하는 중…</span>
            </Tip>
          )}
          {/* 설정 used to live here as a header gear — it moved to the rail's
              foot (Sidebar) so the whole frame's controls sit in one room. */}
        </header>

        {(visibleWarnings.length > 0 || loggedOut) && (
          <div
            className={
              stripClosing ? "planner__warnings planner__warnings--closing" : "planner__warnings"
            }
          >
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
                <div className="notice notice--warn">
                  <span className="ic ic--sm ic--warn">
                    <WarnIcon />
                  </span>
                  <span className="notice__text">{warning.text}</span>
                  <Tip label="경고 닫기">
                    <button
                      type="button"
                      className="notice__close"
                      aria-label="경고 닫기"
                      disabled={closingWarnings.has(warning.text)}
                      onClick={() => setClosingWarnings((prev) => new Set(prev).add(warning.text))}
                    >
                      ×
                    </button>
                  </Tip>
                </div>
              </Fold>
            ))}
            {loggedOut && (
              <div className="notice notice--warn">
                <span className="ic ic--sm ic--warn">
                  <WarnIcon />
                </span>
                <span className="notice__text">
                  {loginGuidance ?? "Claude Code 로그인이 필요합니다 — 다시 로그인하면 이어집니다."}
                </span>
                <button
                  type="button"
                  className="ghost"
                  disabled={loginBusy}
                  onClick={() => void loginPress()}
                >
                  {loginBusy ? "확인 중…" : loginStarted ? "다시 확인" : "다시 로그인"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* With no project there is nothing to show and nothing to ask Claude
            about — the picker IS the workspace until one exists.
            `PageWorkspace` cannot stand in for it: its screen rail calls
            `repo.*`, which refuses without an active project. */}
        {daemon.projects.length === 0 ? (
          <section className="planner__body planner__empty">
            {/* The product's whole story, told once in miniature: an ask with
                a picture attached, and the screen that comes back.
                Decorative — the picker below is the actual task. */}
            <div className="emptyhero" aria-hidden="true">
              <div className="emptyhero__ask">
                <span className="emptyhero__attach">화면.png</span>
                <span className="emptyhero__prompt">❯</span>
                결제 실패 화면의 세 상태를 만들어 줘
              </div>
              <span className="emptyhero__link" />
              <div className="emptyhero__screen">
                <span className="emptyhero__dots">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="emptyhero__line" />
                <span className="emptyhero__line emptyhero__line--short" />
                <span className="emptyhero__chips">
                  <i>기본</i>
                  <i>비어 있음</i>
                  <i>오류</i>
                </span>
              </div>
              <p className="emptyhero__caption">
                말로 시켜도, 그림을 붙여도 — 회사 디자인 시스템으로 짜인 화면이 이 자리에 떠납니다
              </p>
            </div>
            <h2 className="planner__emptyTitle">프로젝트 추가</h2>
            <p className="hint">화면을 만들 레포를 고르세요.</p>
            <RepoPicker daemon={daemon} onOpenSettings={onOpenSettings} />
          </section>
        ) : (
          /* The workspace owns its own .planner__body — the three columns and
             their draggable boundaries are its business, not the frame's. */
          <PageWorkspace
            ref={workspace}
            daemon={daemon}
            settings={settings}
            onChatChange={onChatChange}
            onLayoutChange={onLayoutChange}
            onOpenSettings={onOpenSettings}
            onRenameSession={onRenameSession}
            onActiveThreadChange={setActiveThreadId}
            onAddProject={() => setAddOpen(true)}
          />
        )}
      </div>
      {addOpen && (
        <AddProjectDialog
          daemon={daemon}
          onClose={() => setAddOpen(false)}
          onOpenSettings={onOpenSettings}
        />
      )}
    </div>
  );
}
