import type { ColoDesignPinEnvelope, SessionState } from "@colo-design/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ShortcutsSheet } from "../../components/dialogs/ShortcutsSheet";
import type { PreviewLocation, PreviewTarget } from "../../components/preview/PreviewHost";
import { pinsSync } from "../../hooks/usePins";
import { parseAddress } from "../../lib/preview-address";
import { lookToTurn } from "../../lib/preview-turns";
import { previewPathOf, registerScreenOpener, screenPath } from "../../lib/screen-link";
import {
  lastTurnScreens,
  screenKey,
  type TurnScreen,
  threadScreens,
  titleOfPath,
} from "../../lib/turn-screens";
import { L } from "../labels";
import type { PreviewColumnProps } from "../slots";
import { clockOf, HISTORY_OPEN_EVENT, HistoryDrawer } from "./HistoryDrawer";
import { ArrowIcon, PinSmallIcon } from "./icons";
import { PINS_SEND_EVENT, PinBubble } from "./PinBubble";
import { PrepareCard, StageNotice } from "./PrepareCard";
import { PreviewBar, type ScreenRow } from "./PreviewBar";
import { nativePreview, type PreviewDevice, PreviewHost } from "./PreviewHost";
import { type MachineTurn, usePreviewErrors } from "./use-preview-errors";

/** `nx:pins:toggle` — 좁은 창 입력창의 `찍기`(단계 2)가 찍기를 켜고 끈다. */
export const PINS_TOGGLE_EVENT = "nx:pins:toggle";
/**
 * `nx:composer:attach` — `AI에게 이 화면 보여 주기` 가 찍은 화면을 입력창에 담는다.
 * `detail: { attachments: [{ name, mediaType, data }], screen }`, cancelable —
 * 입력창이 받으면 `preventDefault()` 로 답한다. 아무도 받지 않으면 옛 셸처럼
 * 그 화면을 곧장 AI 에게 보여 주는 기계 턴으로 물러선다.
 */
export const COMPOSER_ATTACH_EVENT = "nx:composer:attach";

const LIVE = new Set<SessionState>([
  "starting",
  "running",
  "waiting_permission",
  "waiting_question",
]);
const RECENT_MAX = 8;

/**
 * 미리보기 칸(PLAN-UI 단계 3) — 막대 · 무대 · 찍기 알약 · 말풍선 · 준비 화면과
 * 두 덮개 · 작업 기록 서랍 · 제출한 때의 화면. 셸은 이 칸을 홈에서도 마운트한
 * 채 숨긴다; 무대(`PreviewHost`)는 어떤 덮개 아래서도 언제나 그려진다 — 게스트가
 * 살아 있어야 `돌아오면 보던 자리 그대로` 가 선다.
 *
 * 이 칸이 쥐는 것: 보고 싶은 화면(`target`)과 게스트가 말한 자리(`location`),
 * 찍기 켜짐, 기기 · 배율. 핀 목록은 `usePins`(입력창과 같은 목록)가 쥐고, 이 칸은
 * 배지를 투영하고 말풍선을 띄운다. 연결 레포의 오류는 사람에게 올리지 않는다 —
 * `usePreviewErrors` 가 AI 의 고침 턴으로 넘긴다.
 */
export function PreviewColumn({
  daemon,
  sessions,
  pins,
  project,
  activeSessionId,
  nav,
  narrow,
  onScreenName,
}: PreviewColumnProps) {
  const { api, repo, connection } = daemon;
  const native = nativePreview();
  const phase = repo?.phase ?? project?.phase ?? "missing";
  const previewUrl = repo?.previewUrl ?? null;
  const epoch = repo?.previewEpoch ?? null;
  const turnState: SessionState = sessions.active?.state ?? "idle";
  const turnLive = LIVE.has(turnState);
  // 셸의 손은 렌더마다 새 겉모습일 수 있다 — 구독이 매 렌더 다시 걸리지 않게 ref 로 쥔다.
  const navRef = useRef(nav);
  navRef.current = nav;
  const toast = useCallback((text: string) => navRef.current.toast(text), []);
  const showTab = useCallback((tab: "chat" | "preview") => navRef.current.showTab(tab), []);

  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  /** 홈이 떠 있는 동안(셸이 이 칸을 숨긴다)은 단축키가 이 칸의 것이 아니다. */
  const offstage = () => sectionRef.current?.closest(".nx-offstage") != null;

  // --- 레포를 깨운다 ---------------------------------------------------
  // 이 칸의 마운트가 레포를 준비시킨다(옛 ScreenPanel 의 몫) — `repoSync` 는
  // 데몬 쪽에서 멱등이다. 떠나도 아무것도 하지 않는다: 서버는 따뜻하게 남는다.
  useEffect(() => {
    if (connection !== "open") return;
    void api.repoSync().catch((cause: Error) => console.error("[colo-design] repo sync", cause));
  }, [connection, api]);

  // --- 어디를 보는가 ----------------------------------------------------
  const [target, setTarget] = useState<PreviewTarget | null>(null);
  const [location, setLocation] = useState<PreviewLocation | null>(null);
  // 프로젝트가 바뀌면 물음과 위치는 낡은 말이다 — 렌더 중에 함께 비운다(옛 칸과 같다).
  const root = repo?.root ?? null;
  const [askRoot, setAskRoot] = useState(root);
  if (askRoot !== root) {
    setAskRoot(root);
    setTarget(null);
    setLocation(null);
  }
  const go = useCallback((path: string) => setTarget({ kind: "path", path }), []);

  // 브라우저 경로의 궤적 — iframe 은 제 위치를 말하지 않으니 물음이 곧 역사다.
  const [trail, setTrail] = useState<{ list: string[]; at: number }>({ list: [], at: -1 });
  // biome-ignore lint/correctness/useExhaustiveDependencies: 서버가 바뀌면 궤적을 새로 쓴다.
  useEffect(() => setTrail({ list: [], at: -1 }), [previewUrl]);
  useEffect(() => {
    if (native || !target) return;
    setTrail((t) => {
      if (t.list[t.at] === target.path) return t;
      return { list: [...t.list.slice(0, t.at + 1), target.path], at: t.at + 1 };
    });
  }, [native, target]);
  const walk = (delta: -1 | 1) => {
    if (native) {
      void window.coloDesignDesktop?.preview?.history?.(delta);
      return;
    }
    const path = trail.list[trail.at + delta];
    if (path === undefined) return;
    setTrail((t) => ({ ...t, at: t.at + delta }));
    go(path);
  };
  const herePath = location?.path ?? target?.path ?? "/";

  // 답변의 화면 링크 · `고친 화면` 카드가 이 칸을 옮기는 손(screen-link.ts).
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  useEffect(() => {
    if (!previewUrl) return;
    return registerScreenOpener({
      previewUrl,
      open: (path) => {
        setTarget({ kind: "path", path });
        if (narrowRef.current) showTab("preview");
      },
    });
  }, [previewUrl, showTab]);

  // 지나온 화면 — 주소 목록의 `다른 화면` 이 읽는다.
  const [recent, setRecent] = useState<string[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 프로젝트가 바뀌면 새로 쌓는다.
  useEffect(() => setRecent([]), [root]);
  useEffect(() => {
    const path = location?.kind === "preview" ? location.path : native ? null : target?.path;
    if (!path) return;
    setRecent((list) =>
      [path, ...list.filter((p) => screenKey(p) !== screenKey(path))].slice(0, RECENT_MAX),
    );
  }, [location, native, target]);

  // --- 이 대화가 말한 화면 ---------------------------------------------
  const toPath = useCallback((href: string) => previewPathOf(href, previewUrl), [previewUrl]);
  const blocks = activeSessionId ? (daemon.sessions[activeSessionId]?.blocks ?? null) : null;
  const [convScreens, setConvScreens] = useState<TurnScreen[]>([]);
  const screensOf = useRef<string | null>(null);
  useEffect(() => {
    // 흐르는 답의 조각마다 대화 전체를 훑지 않는다 — 쉬는 순간에만(대화를 옮겼으면 바로).
    if (turnLive && screensOf.current === activeSessionId) return;
    screensOf.current = activeSessionId;
    setConvScreens(blocks ? threadScreens(blocks, toPath) : []);
  }, [turnLive, activeSessionId, blocks, toPath]);

  // 턴이 끝나면 그 턴이 고친 화면으로(README 「미리보기에서 확인」) — 이미 보고
  // 있으면 그대로 둔다. 외부 페이지를 보는 중이면 사람이 일부러 나간 것이다.
  const liveBefore = useRef({ live: turnLive, id: activeSessionId });
  // biome-ignore lint/correctness/useExhaustiveDependencies: 턴의 끝(상태 전이)만 본다.
  useEffect(() => {
    const before = liveBefore.current;
    liveBefore.current = { live: turnLive, id: activeSessionId };
    if (!before.live || turnLive || !activeSessionId || before.id !== activeSessionId) return;
    if (location?.kind === "web") return;
    const done = daemon.sessions[activeSessionId]?.blocks;
    if (!done) return;
    const screens = lastTurnScreens(done, toPath);
    const first = screens[0];
    if (!first) return;
    if (screens.some((screen) => screenKey(screen.path) === screenKey(herePath))) return;
    go(first.path);
  }, [turnLive, activeSessionId]);

  const cycleTitle = useCallback(
    (path: string): string | null => {
      const key = screenKey(path);
      const found = repo?.cycleScreens?.find((s) => s.title.trim() && screenKey(s.route) === key);
      return found?.title ?? null;
    },
    [repo?.cycleScreens],
  );
  const nameOf = useCallback(
    (path: string): string =>
      titleOfPath(convScreens, path) ??
      cycleTitle(path) ??
      (screenKey(path) === "/" ? L.preview.homeScreen : L.preview.untitledScreen),
    [convScreens, cycleTitle],
  );
  const screenName = nameOf(herePath);
  const hasScreen = previewUrl !== null && location?.kind !== "web";
  useEffect(() => {
    onScreenName(hasScreen ? screenName : null);
  }, [hasScreen, screenName, onScreenName]);

  const rows = useMemo(() => {
    const mine: ScreenRow[] = convScreens.map((s) => ({
      path: s.path,
      name: s.title ?? nameOf(s.path),
    }));
    const seen = new Set(mine.map((row) => screenKey(row.path)));
    const others: ScreenRow[] = [];
    const add = (path: string) => {
      const key = screenKey(path);
      if (seen.has(key)) return;
      seen.add(key);
      others.push({ path, name: nameOf(path) });
    };
    for (const screen of repo?.cycleScreens ?? []) if (screen.title.trim()) add(screen.route);
    for (const path of recent) add(path);
    return { mine, others };
  }, [convScreens, repo?.cycleScreens, recent, nameOf]);

  const onAddress = (raw: string): string | null => {
    if (!previewUrl) return L.preview.addrOnly;
    const verdict = parseAddress(raw, {
      origin: new URL(previewUrl).origin,
      currentPath: herePath,
    });
    if (verdict.kind === "error") return L.preview.addrOnly;
    go(verdict.path);
    return null;
  };

  // --- 준비 · 덮개 ------------------------------------------------------
  const preparing =
    phase === "missing" ||
    phase === "cloning" ||
    phase === "installing" ||
    phase === "starting" ||
    (phase === "pulling" && !previewUrl);
  // 처음 켜는 준비인가 — 이 준비가 내려받기부터 시작했으면 처음이다.
  const firstPrep = useRef(new Map<string, boolean>());
  const slug = daemon.activeSlug ?? "";
  if (phase === "missing" || phase === "cloning") firstPrep.current.set(slug, true);
  if (phase === "ready") firstPrep.current.delete(slug);
  const first = firstPrep.current.get(slug) === true;

  const previewStopped = phase === "error" && repo?.errorKind === "preview";
  const restarting = previewStopped && repo?.detail?.startsWith(L.preview.restartPrefix) === true;
  const [restarts, setRestarts] = useState(0);
  const wasRestarting = useRef(false);
  useEffect(() => {
    if (restarting && !wasRestarting.current) setRestarts((n) => n + 1);
    wasRestarting.current = restarting;
  }, [restarting]);
  useEffect(() => {
    if (phase === "ready") setRestarts(0);
  }, [phase]);
  // 서버가 저절로 꺼졌다 다시 섰다 — 한 줄로 알린다.
  const hadRestart = useRef(false);
  useEffect(() => {
    if (restarting) hadRestart.current = true;
    else if (phase === "ready" && hadRestart.current) {
      hadRestart.current = false;
      toast(L.preview.restarted);
    }
  }, [restarting, phase, toast]);

  // --- 기계의 턴 --------------------------------------------------------
  const machineBusy = useRef(false);
  const machineTurn: MachineTurn = useCallback(
    async (turn, name, attachments, turnPins) => {
      if (machineBusy.current) return false;
      machineBusy.current = true;
      try {
        const into = sessions.activeId ?? (await sessions.create(name));
        if (!into) return false;
        await sessions.sendTurn(turn, attachments, into, turnPins);
        return true;
      } catch {
        return false;
      } finally {
        machineBusy.current = false;
      }
    },
    [sessions],
  );
  const errors = usePreviewErrors({
    api,
    repo,
    turnState,
    location,
    onMachineTurn: machineTurn,
  });
  const bringUpBroken = phase === "error" && !previewStopped && !previewUrl;
  const fixing =
    !preparing && ((previewStopped && !restarting) || bringUpBroken || errors.fixingStalled);

  // --- 무대 ---------------------------------------------------------
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const [zoom, setZoom] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((n) => n + 1), []);
  const pickDevice = (next: PreviewDevice) => {
    setDevice(next);
    // 기기는 몸이고 배율은 눈이다 — 기기가 바뀌면 눈은 100% 로.
    setZoom(1);
    void window.coloDesignDesktop?.preview?.zoom?.("reset");
  };

  // --- 찍기 ---------------------------------------------------------
  const [commentsOn, setCommentsOn] = useState(false);
  const commentsRef = useRef(commentsOn);
  commentsRef.current = commentsOn;
  const pinLocked = preparing || !previewUrl ? L.pin.lockedPreparing : null;
  useEffect(() => {
    if (pinLocked) setCommentsOn(false);
  }, [pinLocked]);
  const [frozen, setFrozen] = useState<{
    shot: { mediaType: string; data: string };
    at: string | null;
  } | null>(null);
  const togglePins = useCallback(
    (on?: boolean) => {
      if (pinLocked) {
        toast(pinLocked);
        return;
      }
      setFrozen(null);
      const next = on ?? !commentsRef.current;
      setCommentsOn(next);
      if (next && narrowRef.current) showTab("preview");
    },
    [pinLocked, toast, showTab],
  );

  const sync = useMemo(() => pinsSync(pins.ghosts, pins.list), [pins.ghosts, pins.list]);

  // 보낸 핀은 턴 동안 회색으로 남았다가 턴이 끝나면 사라진다 — 옛 셸의
  // PageWorkspace 가 하던 해산을 이 칸이 맡는다(배지의 주인이 이 칸이다).
  // 판정은 종착 상태가 내린다: 살아 있는 턴도 대기 중인 보내기도 없으면 끝이다.
  const settledEmpty = !turnLive && (sessions.active?.queue?.length ?? 0) === 0;
  const ghostCount = pins.ghosts.length;
  const ghostArmedAt = useRef<number | null>(null);
  if (ghostCount > 0 && ghostArmedAt.current === null) ghostArmedAt.current = Date.now();
  if (ghostCount === 0) ghostArmedAt.current = null;
  const dismissGhosts = pins.dismissGhosts;
  // biome-ignore lint/correctness/useExhaustiveDependencies: dismissGhosts 는 setState 의 포장 — 상태만 본다.
  useEffect(() => {
    if (!settledEmpty || ghostCount === 0) return;
    const armed = ghostArmedAt.current ?? Date.now();
    const wait = 750 - (Date.now() - armed);
    if (wait <= 0) {
      dismissGhosts();
      return;
    }
    const timer = window.setTimeout(() => dismissGhosts(), wait);
    return () => window.clearTimeout(timer);
  }, [settledEmpty, ghostCount]);
  // 핀을 보냈으면 찍기는 끝났다 — 고스트가 느는 순간이 보냄의 신호다.
  const sentGhosts = useRef(ghostCount);
  useEffect(() => {
    if (ghostCount > sentGhosts.current) setCommentsOn(false);
    sentGhosts.current = ghostCount;
  }, [ghostCount]);

  // --- 말풍선 -------------------------------------------------------
  const [bubble, setBubble] = useState<{
    id: string;
    frame: { left: number; top: number };
    box: { width: number; height: number };
    zoom: number;
  } | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const openBubble = useCallback((id: string) => {
    const section = sectionRef.current;
    if (!section) return;
    const base = section.getBoundingClientRect();
    const guest =
      stageRef.current?.querySelector(".preview__frame--live") ??
      stageRef.current?.querySelector(".nx-pvframe") ??
      stageRef.current;
    const at = guest?.getBoundingClientRect() ?? base;
    setBubble({
      id,
      frame: { left: at.left - base.left, top: at.top - base.top },
      box: { width: section.clientWidth, height: section.clientHeight },
      zoom: zoomRef.current,
    });
  }, []);
  const onPin = useCallback(
    (pin: ColoDesignPinEnvelope["pin"]) => {
      pins.add(pin);
      openBubble(pin.id);
    },
    [pins, openBubble],
  );
  // 어긋날 수 있는 사건에는 닫는다 — 이동 · 배율 · 기기 · 창 크기(U4 · 6 리스크).
  // biome-ignore lint/correctness/useExhaustiveDependencies: 사건만 본다.
  useEffect(() => setBubble(null), [location, zoom, device, frozen, root]);
  useEffect(() => {
    const close = () => setBubble(null);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, []);
  const bubbleIndex = bubble ? pins.list.findIndex((pin) => pin.id === bubble.id) : -1;
  const bubblePin = bubbleIndex >= 0 ? pins.list[bubbleIndex] : undefined;

  // --- 제출한 때의 화면 ----------------------------------------------
  const handoff = repo?.handoff ?? null;
  const frozenReady = handoff?.state === "open" || handoff?.state === "changes_requested";
  const submits = useMemo(() => {
    if (!handoff) return [];
    const times: string[] = [];
    for (const view of Object.values(daemon.sessions)) {
      for (const block of view.blocks) {
        if (
          block.type === "milestone" &&
          block.subtype === "handed" &&
          block.pr === handoff.number
        ) {
          times.push(block.at);
        }
      }
    }
    return times.sort();
  }, [daemon.sessions, handoff]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 사이클이 움직이면 얼린 얼굴은 거짓말이다.
  useEffect(() => setFrozen(null), [root, handoff?.state, handoff?.number]);
  const openFrozen = async () => {
    const route = herePath.split("?")[0] ?? "/";
    const shot = await api.handoffShot(route).catch(() => null);
    if (!shot) {
      toast(L.preview.frozenNoShot);
      return;
    }
    setCommentsOn(false);
    setFrozen({ shot, at: submits[submits.length - 1] ?? null });
  };

  // --- AI에게 이 화면 보여 주기 ----------------------------------------
  const [lookBusy, setLookBusy] = useState(false);
  const lookSent = useRef(false);
  const lookCount = useRef<{ route: string; n: number }>({ route: "", n: 0 });
  useEffect(() => {
    if (!turnLive) lookSent.current = false;
  }, [turnLive]);
  const showAi = async () => {
    if (lookBusy) return;
    if (turnLive && lookSent.current) {
      toast(L.preview.showAiAgain);
      return;
    }
    setLookBusy(true);
    try {
      const snapshot = await window.coloDesignDesktop?.preview?.snapshot?.();
      const attachment = snapshot?.jpeg
        ? { name: L.preview.shotName(screenName), mediaType: "image/jpeg", data: snapshot.jpeg }
        : null;
      // 먼저 입력창에 담는다(목업) — 입력창이 받으면 사람이 말을 붙여 보낸다.
      const offer = new CustomEvent(COMPOSER_ATTACH_EVENT, {
        cancelable: true,
        detail: { attachments: attachment ? [attachment] : [], screen: herePath },
      });
      if (attachment && !window.dispatchEvent(offer)) {
        toast(L.preview.showAiToast);
        if (narrow) showTab("chat");
        return;
      }
      // 받는 입력창이 없다 — 옛 셸처럼 곧장 AI 에게 보여 준다.
      const count = lookCount.current.route === herePath ? lookCount.current.n + 1 : 1;
      lookCount.current = { route: herePath, n: count };
      const lines = [
        L.preview.lookAsk,
        snapshot && snapshot.console.length > 0
          ? L.preview.lookConsole(snapshot.console.join("\n"))
          : "",
      ].filter(Boolean);
      const delivered = await machineTurn(
        lookToTurn(herePath, lines.join("\n\n"), count),
        undefined,
        attachment ? [attachment] : undefined,
        [{ screen: herePath }],
      );
      lookSent.current = delivered;
      if (delivered) toast(L.preview.showAiSent);
    } catch (cause) {
      console.error("[colo-design] look", cause);
    } finally {
      setLookBusy(false);
    }
  };

  // --- 서랍 · 단축키 -----------------------------------------------
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [addrSignal, setAddrSignal] = useState(0);
  useEffect(() => {
    const onOpen = () => {
      setHistoryOpen(true);
      if (narrowRef.current) showTab("preview");
    };
    window.addEventListener(HISTORY_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(HISTORY_OPEN_EVENT, onOpen);
  }, [showTab]);

  // 입력창의 보내기(⌘↵ 포함)와 좁은 창의 `찍기` 단추가 부르는 두 이음매.
  useEffect(() => {
    const onSend = () => setCommentsOn(false);
    const onToggle = () => togglePins();
    window.addEventListener(PINS_SEND_EVENT, onSend);
    window.addEventListener(PINS_TOGGLE_EVENT, onToggle);
    return () => {
      window.removeEventListener(PINS_SEND_EVENT, onSend);
      window.removeEventListener(PINS_TOGGLE_EVENT, onToggle);
    };
  }, [togglePins]);

  // ⌘⇧P 찍기 · ⌘L 화면 목록 · Esc(얼린 얼굴 → 찍기 끄기). 게스트가 포커스를
  // 쥐고 있어도 PreviewFrame 이 조합키를 창으로 다시 쏜다.
  const keys = useRef<{ pins: () => void; addr: () => void; escape: () => boolean }>({
    pins: () => {},
    addr: () => {},
    escape: () => false,
  });
  keys.current = {
    pins: () => togglePins(),
    addr: () => {
      if (narrowRef.current) showTab("preview");
      setAddrSignal((n) => n + 1);
    },
    escape: () => {
      if (frozen) {
        setFrozen(null);
        return true;
      }
      if (commentsOn) {
        setCommentsOn(false);
        return true;
      }
      return false;
    },
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (offstage()) return;
      if (document.querySelector(".modal, .palette")) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && event.shiftKey && !event.altKey && key === "p") {
        event.preventDefault();
        keys.current.pins();
      } else if (mod && !event.shiftKey && !event.altKey && key === "l") {
        event.preventDefault();
        keys.current.addr();
      } else if (event.key === "Escape" && !event.defaultPrevented) {
        const target = event.target as HTMLElement | null;
        if (target?.closest("input, textarea, [contenteditable], .nx-pop, .nx-hist")) return;
        if (keys.current.escape()) event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // biome-ignore lint/correctness/useExhaustiveDependencies: 손은 ref 가 늘 새것으로 쥔다.
  }, []);

  const overlay = preparing ? (
    <PrepareCard phase={phase} phaseSince={repo?.phaseSince} first={first} />
  ) : restarting ? (
    <StageNotice kind="restarting" restarts={restarts} />
  ) : fixing ? (
    <StageNotice kind="fixing" restarts={restarts} />
  ) : !previewUrl && location?.kind !== "web" ? (
    <div className="nx-pv-placeholder">{L.slot.previewWaiting}</div>
  ) : null;

  const pinCount = pins.list.length;

  return (
    <section ref={sectionRef} className={`nx-preview${historyOpen ? " nx-preview--hist" : ""}`}>
      <PreviewBar
        canBack={native ? location?.canGoBack === true : trail.at > 0}
        canForward={native ? location?.canGoForward === true : trail.at < trail.list.length - 1}
        onBack={() => walk(-1)}
        onForward={() => walk(1)}
        onReload={reload}
        screenName={hasScreen ? screenName : (project?.name ?? L.preview.frameTitle)}
        mine={rows.mine}
        others={rows.others}
        onGo={go}
        onAddress={onAddress}
        device={device}
        onDevice={pickDevice}
        pinOn={commentsOn}
        pinLocked={pinLocked}
        onPin={() => togglePins()}
        historyOpen={historyOpen}
        onHistory={() => setHistoryOpen((open) => !open)}
        native={native}
        zoom={zoom}
        onZoom={(kind) => void window.coloDesignDesktop?.preview?.zoom?.(kind)}
        frozenReady={frozenReady}
        onFrozen={() => void openFrozen()}
        onShowAi={() => void showAi()}
        showAiBusy={lookBusy}
        onShortcuts={() => setSheetOpen(true)}
        addrSignal={addrSignal}
      />

      <PreviewHost
        url={previewUrl}
        epoch={epoch}
        target={target}
        reloadKey={reloadKey}
        device={device}
        commentsOn={commentsOn}
        sync={sync}
        location={location}
        onPin={onPin}
        onPinFocus={openBubble}
        onLocation={setLocation}
        onZoom={setZoom}
        onError={errors.report}
        onSelfReload={reload}
        stageRef={stageRef}
      >
        {frozen && (
          <div className="nx-frozen">
            <img
              className="nx-frozen-shot"
              alt={L.preview.frozenBar}
              src={`data:${frozen.shot.mediaType};base64,${frozen.shot.data}`}
            />
            <div className="nx-frozen-bar" role="status">
              <span>
                {frozen.at ? L.preview.frozenBarAt(clockOf(frozen.at)) : L.preview.frozenBar}
              </span>
              <button type="button" className="nx-btn nx-btn--sm" onClick={() => setFrozen(null)}>
                {L.preview.unfreeze}
              </button>
            </div>
          </div>
        )}
        {overlay && <div className="nx-over">{overlay}</div>}
        {commentsOn && !overlay && (
          <div className="nx-pinstrip" role="status">
            <PinSmallIcon />
            <b>{L.pin.stripTitle}</b>
            <span>{L.pin.stripBody}</span>
            <button
              type="button"
              className="nx-btn nx-btn--sm"
              onClick={() => setCommentsOn(false)}
            >
              {L.pin.stripOff}
            </button>
          </div>
        )}
        {narrow && pinCount > 0 && !overlay && (
          <button type="button" className="nx-pv-fab" onClick={() => showTab("chat")}>
            <span className="nx-pnum">{pinCount}</span>
            {L.narrow.sendPins}
            <ArrowIcon />
          </button>
        )}
      </PreviewHost>

      {bubble && bubblePin && (
        <PinBubble
          key={bubble.id}
          pin={bubblePin}
          n={pins.ghosts.length + bubbleIndex + 1}
          screenName={nameOf(screenPath(bubblePin.screen))}
          frame={bubble.frame}
          zoom={bubble.zoom}
          box={bubble.box}
          narrow={narrow}
          onNote={(note) => pins.setNote(bubblePin.id, note)}
          onRemove={() => pins.remove(bubblePin.id)}
          onClose={() => setBubble(null)}
          toast={toast}
        />
      )}

      <HistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        daemon={daemon}
        repo={repo}
        submits={submits}
        onRestored={reload}
        toast={toast}
      />

      {sheetOpen &&
        createPortal(<ShortcutsSheet open onClose={() => setSheetOpen(false)} />, document.body)}
    </section>
  );
}
