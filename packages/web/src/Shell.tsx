import { useEffect, useRef, useState } from "react";
import type { ThreadSummary } from "@cds-design/protocol";
import type { Daemon } from "./daemon-client";
import { AddProjectDialog } from "./AddProjectDialog";
import { PageWorkspace, type WorkspaceHandle } from "./PageWorkspace";
import { Sidebar } from "./Sidebar";
import { Splitter } from "./Splitter";
import { Onboarding } from "./Onboarding";
import { RepoPicker } from "./RepoPicker";
import { usePreviewCover } from "./use-preview-cover";
import {
  SIDEBAR_WIDTH_BOUNDS,
  type ChatSettings,
  type LayoutSettings,
  type Settings,
} from "./settings";

/** The folded rail's width — an icon column, not a hidden panel. */
const SIDEBAR_COLLAPSED_WIDTH = 44;
/** Below this the rail folds by itself (PLAN D19): three columns cannot fit. */
const NARROW_QUERY = "(max-width: 1100px)";

/**
 * The frame (PLAN D12/D22/D23): the project rail on the left, and on the
 * right the header, the daemon's warnings, and the workspace — or, with no
 * project yet, the picker itself.
 *
 * There is one workspace now (PLAN D1). The 기획/디자인 tabs that used to
 * live here were the daemon's two cwds showing through — a planner works on
 * one 기획서 at a time, not on one half of the tool at a time.
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
  /** 설정 owns how Claude answers (PLAN D10); the workspace starts threads on it. */
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
  /** 프로젝트 추가 (PLAN D25) — the sidebar's `+ 새 프로젝트` opens it. */
  const [addOpen, setAddOpen] = useState(false);
  // D65: the native preview view hides behind a freeze frame whenever a
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
  // the planner cannot read a terminal to find out.
  const warnings = status?.warnings ?? [];

  // The rail's width and fold, seeded from the stored layout (already
  // clamped). Narrow windows fold it no matter what the setting says.
  const [sidebarWidth, setSidebarWidth] = useState(
    () => settings.layout.sidebarWidth ?? 240,
  );
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
   * (open · new · delete, PLAN D59) cross this ref, and the workspace
   * reports the open thread back for the tree's active mark. No state of its
   * own beyond that one string — the session flows stay the workspace's.
   */
  const workspace = useRef<WorkspaceHandle>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const openThread = (slug: string, thread: ThreadSummary) => workspace.current?.openThread(slug, thread);
  const newThread = (slug: string) => workspace.current?.newThread(slug);
  const deleteThread = (slug: string, thread: ThreadSummary) => workspace.current?.deleteThread(slug, thread);

  // The drag in flight, mirrored from PageWorkspace's preview boundary: the
  // pointer capture is what keeps it alive across the project list.
  const [drag, setDrag] = useState<{ startX: number; startWidth: number } | null>(null);
  const clampWidth = (value: number) =>
    Math.min(SIDEBAR_WIDTH_BOUNDS.max, Math.max(SIDEBAR_WIDTH_BOUNDS.min, Math.round(value)));

  if (onboardingBlocked || onboardingOpen || (wizardNeeded && !wizardDismissed)) {
    return (
      <div className="planner planner--onboarding">
        <Onboarding
          daemon={daemon}
          onDone={() => {
            setWizardDismissed(true);
            onOnboardingClose();
          }}
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
        onRenameThread={onRenameSession}
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
          <span className="planner__project">
            {activeProject?.name ?? "CDS Design"}
          </span>
          <span className="planner__spacer" />
          {/* The header used to read "데몬: 연결됨 · https://github.com/…" — the
              name of a program the planner never starts, beside a git url they
              never type (PLAN D13). What is left is the only part that changes
              what they should do: whether the tool can work right now. Both the
              address and the repo live in 설정 → 문제 해결. */}
          {connection !== "open" && (
            <span className="hint" title="연결이 끊기면 대화와 저장이 잠시 멈춥니다">
              연결하는 중…
            </span>
          )}
          {/* 설정 used to live here as a header gear — it moved to the rail's
              foot (Sidebar) so the whole frame's controls sit in one room. */}
        </header>

        {warnings.length > 0 && (
          <div className="planner__warnings">
            {warnings.map((warning) => (
              <div key={warning} className="notice notice--warn">
                <span className="notice__text">{warning}</span>
              </div>
            ))}
          </div>
        )}

        {/* With no project there is nothing to show and nothing to ask Claude
            about — the picker IS the workspace until one exists (PLAN D23).
            `PageWorkspace` cannot stand in for it: its screen rail calls
            `repo.*`, which refuses without an active project. */}
        {daemon.projects.length === 0 ? (
          <section className="planner__body planner__empty">
            {/* The product's whole story, told once in miniature: an ask with
                a 기획서 attached, and the screen that comes back.
                Decorative — the picker below is the actual task. */}
            <div className="emptyhero" aria-hidden="true">
              <div className="emptyhero__ask">
                <span className="emptyhero__attach">기획서.pdf</span>
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
                기획서를 첨부하면, 회사 디자인 시스템으로 짜인 화면이 이 자리에 뜹니다
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
