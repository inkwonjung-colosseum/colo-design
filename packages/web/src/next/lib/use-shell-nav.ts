import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { SettingsCategory } from "../../components/dialogs/SettingsDialog";
import type { Sessions } from "../../hooks/useSessions";
import type { Daemon } from "../../lib/daemon-client";
import type { LayoutSettings } from "../../lib/settings";
import { L } from "../labels";
import type { ShellNav } from "../slots";
import { initialNav, type NavState, navReducer } from "./nav";
import { isPreparing } from "./project-note";

/** 좁은 창의 문턱(U16) — 목업의 `@container win (max-width:900px)`. */
const NARROW_QUERY = "(max-width: 900px)";

/** 창이 900px 아래인가 — 목업은 창 폭의 컨테이너 질의, 앱은 창 자체다. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(NARROW_QUERY).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(NARROW_QUERY);
    if (!media) return;
    const onChange = () => setNarrow(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

/**
 * 셸의 이동 — 상태(`nav.ts` 의 줄임 함수)와 칸들에 건넬 손(`ShellNav`). 옛
 * PageWorkspace 의 흐름을 그대로 옮겼다: 활성 프로젝트가 바뀌면 홈부터, 다른
 * 프로젝트의 대화를 여는 클릭은 전환을 먼저 하고 등록부가 옮겨 앉으면 그
 * 대화를 연다(jump), 대화를 여는 길은 목록 → 살아 있는 세션 → 되살리기 순.
 */
export function useShellNav({
  daemon,
  sessions,
  collapsed,
  onLayoutChange,
  onOpenSettings,
}: {
  daemon: Daemon;
  sessions: Sessions;
  /** 설정에 남은 사이드바 접힘 — 처음 값의 씨앗. */
  collapsed: boolean;
  onLayoutChange: (patch: Partial<LayoutSettings>) => void;
  onOpenSettings: (category?: SettingsCategory) => void;
}): {
  state: NavState;
  nav: ShellNav;
  toast: string | null;
  setCollapsed: (v: boolean) => void;
  setDrawer: (v: boolean) => void;
} {
  const [state, dispatch] = useReducer(navReducer, collapsed, initialNav);

  const [toastText, setToastText] = useState<string | null>(null);
  useEffect(() => {
    if (!toastText) return;
    const timer = setTimeout(() => setToastText(null), 2600);
    return () => clearTimeout(timer);
  }, [toastText]);

  // 이 두 효과의 순서가 뜻이다: 프로젝트가 바뀌면 먼저 홈으로 돌리고, 같은
  // 커밋에서 뒤따르는 점프가 대화를 열면 그 "thread" 가 이긴다.
  const firstSlug = useRef(true);
  useEffect(() => {
    if (firstSlug.current) {
      firstSlug.current = false;
      return;
    }
    dispatch({ type: "project-changed" });
  }, [daemon.activeSlug]);

  const jump = useRef<{ slug: string; threadId?: string; fresh?: boolean } | null>(null);

  /**
   * 이 프로젝트의 대화를 id 로 연다 — 목록이 빠른 길, 목록이 아직 모르는 살아
   * 있는 대화는 그 상태로, 그 밖은 저장된 대화를 되살린다(`session.create { resume }`).
   */
  const openHere = async (threadId: string) => {
    dispatch({ type: "thread" });
    const listed = sessions.list.find((session) => session.sessionId === threadId);
    if (listed) {
      await sessions.open(listed);
      return;
    }
    const view = daemon.sessions[threadId];
    if (view?.live) {
      const known = daemon.projects
        .flatMap((project) => project.threads ?? [])
        .find((thread) => thread.id === threadId);
      await sessions.open({
        sessionId: threadId,
        title: known?.title ?? threadId,
        lastModified: known ? Date.parse(known.updatedAt) : 0,
        live: true,
        state: view.state,
        turnStartedAt: view.turnStartedAt,
      });
      return;
    }
    await sessions.resume(threadId);
  };

  const freshHere = () => {
    dispatch({ type: "thread" });
    sessions.fresh();
  };

  const openRef = useRef({ openHere, freshHere });
  openRef.current = { openHere, freshHere };
  useEffect(() => {
    const pending = jump.current;
    if (!pending) return;
    jump.current = null;
    // 등록부가 다른 슬러그에 정착했다 — 낡은 점프는 거둔다.
    if (daemon.activeSlug !== pending.slug) return;
    if (pending.threadId) void openRef.current.openHere(pending.threadId);
    else if (pending.fresh) openRef.current.freshHere();
  }, [daemon.activeSlug]);

  const toastSwitched = (slug: string) => {
    const project = daemon.projects.find((entry) => entry.slug === slug);
    if (!project) return;
    setToastText(
      isPreparing(project) || project.phase === "missing"
        ? L.toast.switchedPreparing(project.name)
        : L.toast.switched(project.name),
    );
  };

  const activate = (slug: string, then?: { threadId?: string; fresh?: boolean }) => {
    // 기다리던 점프가 있어도 갈아끼운다 — 새 클릭이 사용자의 최신 뜻이다.
    jump.current = then ? { slug, ...then } : null;
    void daemon.api
      .projectActivate(slug)
      .then(() => toastSwitched(slug))
      .catch(() => {
        jump.current = null;
      });
  };

  const nav: ShellNav = {
    openThread: (slug, threadId) => {
      if (slug === daemon.activeSlug) void openHere(threadId);
      else activate(slug, { threadId });
    },
    newThread: (slug) => {
      if (!slug || slug === daemon.activeSlug) freshHere();
      else activate(slug, { fresh: true });
    },
    goHome: () => dispatch({ type: "home" }),
    showThread: () => dispatch({ type: "thread" }),
    switchProject: (slug) => {
      dispatch({ type: "drawer", open: false });
      if (slug !== daemon.activeSlug) activate(slug);
    },
    showTab: (tab) => dispatch({ type: "tab", tab }),
    openSettings: (category) => onOpenSettings(category),
    toast: setToastText,
    setDiscardableInvitePath: (path) => dispatch({ type: "invite-path", path }),
  };

  // OS 알림을 누르면 데스크톱이 세션 id 를 건넨다 — 주인 프로젝트를 먼저 찾고
  // (다른 프로젝트에서 되살리면 그곳에 갈래가 생긴다) 같은 길로 연다.
  const navRef = useRef(nav);
  navRef.current = nav;
  useEffect(() => {
    const bridge = window.coloDesignDesktop;
    if (!bridge?.onOpenSession) return;
    return bridge.onOpenSession((sessionId) => {
      void daemon.api
        .locateSession(sessionId)
        .then((located) =>
          navRef.current.openThread(located.slug ?? daemon.activeSlug ?? "", sessionId),
        )
        .catch(() => undefined);
    });
    // daemon.api 는 연결마다 같은 값이다 — 한 번만 구독한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setCollapsed = useCallback(
    (value: boolean) => {
      dispatch({ type: "collapse", collapsed: value });
      onLayoutChange({ sidebarCollapsed: value });
    },
    [onLayoutChange],
  );
  const setDrawer = useCallback((open: boolean) => dispatch({ type: "drawer", open }), []);

  return { state, nav, toast: toastText, setCollapsed, setDrawer };
}
