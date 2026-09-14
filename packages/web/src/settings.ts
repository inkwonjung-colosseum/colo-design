import type { EffortLevel, PermissionMode, SessionModelInfo } from "@colo-design/protocol";
import { useCallback, useEffect, useState } from "react";
import { DEFAULT_PERMISSION_MODE, SETTINGS_MODES } from "./chat-options";

/**
 * Client-side preferences. Everything here belongs to the browser, not the
 * daemon: a preference is either about how this UI looks or about how it
 * behaves when the planner types. Session state stays where it already lives —
 * the daemon owns it.
 */

/** A paintable palette. dark/light/contrast are the native set "system"
    chooses between — contrast when the OS asks for more contrast; the rest
    are full palettes in their own right. */
export type ThemeId =
  | "dark"
  | "light"
  | "sepia"
  | "midnight"
  | "contrast"
  | "dracula"
  | "solarized"
  | "catppuccin"
  | "nord"
  | "gruvbox"
  | "tokyonight"
  | "rosepine"
  | "everforest"
  | "onedark"
  | "github"
  | "monokai"
  | "latte";
/** What the picker stores: a palette, or "follow the OS". */
export type ThemeChoice = "system" | ThemeId;
/** Which keypress sends a message. The other one inserts a newline. */
export type SendKey = "enter" | "modEnter";
/**
 * 실행 중 보내기 (PLAN D86 의 스위치). A send while a turn runs either waits
 * for that turn to end (queue — the DAEMON holds it; the SDK would not, it
 * hands a mid-turn send straight to the CLI, which folds it into the running
 * turn) or cuts the running one and starts over with the new words
 * (interrupt — the ⌥Enter "끊고 보내기" path, promoted to the plain send).
 */
export type MidTurnSend = "queue" | "interrupt";
/** 완료 알림의 시점(설정 문서 P0#3): 끔 / 오래 걸린 턴만(기본) / 모든 턴. */
export type NoticeTiming = "off" | "long" | "all";

const NOTICE_TIMINGS: NoticeTiming[] = ["off", "long", "all"];

/** "오래 걸린 턴"의 기준 — 데스크톱 메인의 알림과 같은 값이다. */
export const LONG_TURN_MS = 60_000;

/** The three-step type scale (설정 벤치마크 P1 #13). 보통 is the stylesheet's
    own sizes; 작게/크게 multiply one knob — UI chrome, conversation content,
    or machine text — by 0.9/1.1. */
export type Scale = "small" | "normal" | "large";

export const SCALE_LEVELS: Scale[] = ["small", "normal", "large"];

/**
 * 알림 정책. 확인 요청·중단·게이트 실패는 시점과 무관하게 언제나 오므로,
 * 여기의 3상태는 "완료" 알림에만 적용된다.
 */
export interface NotificationSettings {
  done: NoticeTiming;
  sound: boolean;
}

/**
 * The column width the planner may drag in the workspace — the preview's —
 * in px. `null` means "never touched": the preview keeps its fluid share, so
 * an untouched window still re-fractions with the window size the way the
 * old fixed grid did.
 */
export interface LayoutSettings {
  previewWidth: number | null;
  /** The project list's width; null = never dragged (CSS default wins). */
  sidebarWidth: number | null;
  /** Folded to a 44px rail — narrow windows, or a planner who wants the room. */
  sidebarCollapsed: boolean;
}

/**
 * Hard bounds for that drag (px). PageWorkspace clamps the pointer to these
 * (and to the chat column's own minimum); loadLayout clamps whatever an
 * older or hand-edited blob stored, so a stored 5000px preview can never
 * come back and eat the window.
 */
export const PREVIEW_WIDTH_BOUNDS = { min: 340, max: 1100 } as const;

/** The sidebar's drag bounds (PLAN D19). */
export const SIDEBAR_WIDTH_BOUNDS = { min: 200, max: 360 } as const;

/**
 * How Claude answers in this planner's conversations (PLAN D10[설정 이동]).
 *
 * These used to be three chips in the composer, stored per workspace. They are
 * one shared preference now: 설정 is a single dialog, and a planner asked to
 * choose "어떤 Claude를 쓸지" twice — once for 기획, once for 화면 — is being
 * asked a question they have no way to answer differently.
 */
export interface ChatSettings {
  model: string | null;
  effort: EffortLevel | null;
  permissionMode: PermissionMode;
  /**
   * Claude 가 화면을 직접 볼지(PLAN D61). A session.create choice, not a
   * live-session switch: 새 세션부터 적용되고, 열려 있는 대화는 그대로다 —
   * a running thread's tool set is not renegotiated underneath it.
   */
  previewTools: boolean;
  /**
   * Claude 가 보는 화면을 PiP 로 표시할지(PLAN D63). 브라우저 경로에는
   * 프레임이 아예 없으므로 이 값은 데스크톱에서만 무언가를 가린다.
   */
  showPip: boolean;
  /**
   * 턴이 끝나면 Claude 가 본 화면으로 따라갈지(PLAN D91). 기본은 따라감 —
   * "고쳤습니다" 뒤 기획자가 화면을 찾아 헤매지 않도록. 끄면 토스트만 온다.
   */
  followClaude: boolean;
  /**
   * 작업 과정(도구 호출 묶음)을 대화에 남길지. 기본은 끔 — 생각 과정과 같은
   * 이유다. 접힌 활동 카드라 해도 답과 답 사이마다 한 줄씩 끼면 테이프가
   * 기계의 작업 기록처럼 읽힌다. 켜면 접힌 활동 카드로 돌아온다. 계획
   * 카드(TodoWrite)와 캡처 카드는 이 스위치와 무관하게 언제나 자리를
   * 지킨다(PLAN D48·D56) — 그 둘은 작업의 기록이 아니라 읽을 내용이다.
   */
  showTools: boolean;
  /**
   * 생각 과정을 대화에 남길지. 기본은 끔 — 기획자가 읽는 것은 답이지 답을
   * 만드는 동안의 속말이 아니다. 접혀 있어도 답과 답 사이마다 한 줄씩 끼면
   * 테이프가 기계의 기록처럼 읽힌다. 켜면 예전처럼 접힌 채로 돌아온다.
   */
  showThinking: boolean;
}

export interface Settings {
  theme: ThemeChoice;
  sendKey: SendKey;
  midTurnSend: MidTurnSend;
  /** Three-step type scales (설정 벤치마크 P1 #13). Each rides a data
      attribute on <html> that the stylesheet turns into a CSS variable. */
  uiScale: Scale;
  contentScale: Scale;
  codeScale: Scale;
  notifications: NotificationSettings;
  chat: ChatSettings;
  layout: LayoutSettings;
  /** The planner's own names for threads, by session id. The daemon's
      summary stays the fallback; an entry the planner emptied is dropped. */
  sessionTitles: Record<string, string>;
  /**
   * Which project's tree is folded (PLAN D59), by slug. Written by the
   * sidebar outside this hook's state, so `update` carries the stored copy
   * over and nothing can silently unfold a project the planner folded.
   */
  treeFolded?: Record<string, boolean>;
}

const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  model: null,
  effort: null,
  permissionMode: DEFAULT_PERMISSION_MODE,
  previewTools: true,
  showPip: true,
  followClaude: true,
  showTools: false,
  showThinking: false,
};

const DEFAULT_SETTINGS: Settings = {
  /**
   * Light, not dark (PLAN D13). This tool used to look like a session log and
   * defaulted to the palette that suited one. What a planner does here is read
   * and write a document beside a rendered screen — both of which they will
   * see on paper and in a browser, on white. A planner who prefers dark still
   * has it one choice away; the default is now the one that matches the work.
   */
  theme: "light",
  sendKey: "enter",
  midTurnSend: "queue",
  uiScale: "normal",
  contentScale: "normal",
  codeScale: "normal",
  /** 기본은 "오래 걸린 턴만 + 소리" — 모든 턴마다 알림이 울리는 것부터 막는다. */
  notifications: { done: "long", sound: true },
  chat: DEFAULT_CHAT_SETTINGS,
  layout: { previewWidth: null, sidebarWidth: null, sidebarCollapsed: false },
  sessionTitles: {},
  treeFolded: {},
};

export const THEMES: ThemeChoice[] = [
  "system",
  "dark",
  "light",
  "sepia",
  "midnight",
  "contrast",
  "dracula",
  "solarized",
  "catppuccin",
  "nord",
  "gruvbox",
  "tokyonight",
  "rosepine",
  "everforest",
  "onedark",
  "github",
  "monokai",
  "latte",
];

const KEY = "colo-design.settings";

const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Read stored settings, field by field. Anything unrecognised falls back to its
 * default: a stored blob written by an older build, or hand-edited in devtools,
 * must not be able to leave the UI in a state it cannot render.
 */
function loadSettings(): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    return DEFAULT_SETTINGS;
  }
  // Nothing stored yet (first visit) parses to null — an empty record reads
  // the same as every-field-unrecognised, which loadSettings already handles.
  const stored = (raw ?? {}) as Record<string, unknown>;

  return {
    theme: oneOf(THEMES, stored.theme, DEFAULT_SETTINGS.theme),
    sendKey: oneOf(["enter", "modEnter"] as const, stored.sendKey, DEFAULT_SETTINGS.sendKey),
    midTurnSend: oneOf(
      ["queue", "interrupt"] as const,
      stored.midTurnSend,
      DEFAULT_SETTINGS.midTurnSend,
    ),
    uiScale: oneOf(SCALE_LEVELS, stored.uiScale, DEFAULT_SETTINGS.uiScale),
    contentScale: oneOf(SCALE_LEVELS, stored.contentScale, DEFAULT_SETTINGS.contentScale),
    codeScale: oneOf(SCALE_LEVELS, stored.codeScale, DEFAULT_SETTINGS.codeScale),
    notifications: loadNotifications(stored.notifications),
    chat: loadChat(stored.chat),
    layout: loadLayout(stored.layout),
    sessionTitles: loadSessionTitles(stored.sessionTitles),
    treeFolded: loadTreeFolded(stored.treeFolded),
  };
}

/**
 * 알림 정책 복원 — 다른 필드와 같은 규칙: 못 알아보는 값은 기본으로.
 */
function loadNotifications(raw: unknown): NotificationSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS.notifications };
  const stored = raw as Partial<NotificationSettings>;
  return {
    done: oneOf(NOTICE_TIMINGS, stored.done, DEFAULT_SETTINGS.notifications.done),
    sound: typeof stored.sound === "boolean" ? stored.sound : true,
  };
}

/** 브라우저 알림 경로가 설정 화면 없이 최신 값을 읽는 작은 창구. */
export function currentNoticePrefs(): NotificationSettings {
  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? "null").notifications;
  } catch {
    raw = null;
  }
  return loadNotifications(raw);
}

/** acceptEdits→default 이사를 겪은 사용자 표식 — 설정의 공지 한 줄이 읽는다. */
const MIGRATED_KEY = "colo-design.acceptedits-migrated";

export function readAcceptEditsMigrated(): boolean {
  try {
    return localStorage.getItem(MIGRATED_KEY) === "1";
  } catch {
    return false;
  }
}

/** 공지는 사용자가 확인 방식을 한 번이라도 고르면 사라진다. */
export function clearAcceptEditsMigrated(): void {
  try {
    localStorage.removeItem(MIGRATED_KEY);
  } catch {
    // 저장이 막혀 있으면 공지가 다음에도 뜬다 — 해로운 것은 없다.
  }
}

/** Project slug → whether its tree is folded (PLAN D59). Slugs and booleans
    only; anything else in a hand-edited blob is dropped. */
function loadTreeFolded(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, boolean> = {};
  for (const [slug, folded] of Object.entries(raw)) {
    if (!slug || typeof folded !== "boolean") continue;
    out[slug] = folded;
  }
  return out;
}

/** The stored fold of one project's tree, read fresh — the sidebar writes
    this key outside any settings dialog, so no component may hold a stale
    copy. Unfolded until this planner says otherwise. */
export function loadTreeFoldedFor(slug: string | null): boolean {
  if (!slug) return false;
  return loadSettings().treeFolded?.[slug] ?? false;
}

/**
 * Persist one project's tree fold. The stored blob is read whole and
 * rewritten, so a stale React copy can never undo another key's newer write.
 */
export function saveTreeFolded(slug: string | null, folded: boolean): void {
  if (!slug) return;
  let base: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (raw && typeof raw === "object") base = raw as Record<string, unknown>;
  } catch {
    // An unreadable blob starts a fresh one; the fold below is what matters.
  }
  const treeFolded = { ...loadSettings().treeFolded, [slug]: folded };
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...base, treeFolded }));
  } catch {
    // Private-browsing quotas can refuse the write; the fold still applies
    // to this tab's state.
  }
}

/** Session-id → the planner's name for it. Anything that is not a non-empty
    string is dropped, so a hand-edited blob cannot rename a tab to nothing. */
function loadSessionTitles(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [id, title] of Object.entries(raw)) {
    const name = typeof title === "string" ? title.trim() : "";
    if (id && name) out[id] = name;
  }
  return out;
}

/**
 * The conversation settings, restored like every other preference.
 *
 * 전부 맡기기 (`bypassPermissions`) used to be dropped on reload — a stored
 * blob outliving the reason it was turned on. It is the starting default now
 * (see DEFAULT_PERMISSION_MODE), so there is no quieter state to fall back to:
 * the stored mode comes back exactly as chosen, and the daemon's own write
 * policy still bounds what an edit may touch.
 */
function loadChat(raw: unknown): ChatSettings {
  const legacy = legacyComposerDefaults();
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CHAT_SETTINGS, ...legacy };
  const stored = raw as Record<string, unknown>;
  // acceptEdits 는 메뉴에서 물러났다: oneOf 의 fallback 이 bypass 를 향하므로
  // 이사를 먼저한다 — 남아 있던 값이 조용히 넓어지는 일은 없어야 한다.
  // 옮겨진 사용자에게는 설정에 한 줄 공지가 뜬다(아래 MIGRATED_KEY).
  if (stored.permissionMode === "acceptEdits") {
    try {
      localStorage.setItem(MIGRATED_KEY, "1");
    } catch {
      // 저장이 막히면 공지 없이 이사만 간다 — 값 자체는 이미 default 다.
    }
  }
  const storedMode = stored.permissionMode === "acceptEdits" ? "default" : stored.permissionMode;
  const mode = oneOf(SETTINGS_MODES, storedMode, DEFAULT_PERMISSION_MODE);
  return {
    model: typeof stored.model === "string" && stored.model ? stored.model : (legacy.model ?? null),
    effort: EFFORT_LEVELS.includes(stored.effort as EffortLevel)
      ? (stored.effort as EffortLevel)
      : (legacy.effort ?? null),
    permissionMode: mode,
    // 기본 켬(PLAN D61·D63·D91): an older blob that predates the toggles — or a
    // hand-edited one that wrote anything but a boolean — reads as on.
    previewTools: stored.previewTools === undefined ? true : stored.previewTools === true,
    showPip: stored.showPip === undefined ? true : stored.showPip === true,
    followClaude: stored.followClaude === undefined ? true : stored.followClaude === true,
    // 기본 끔: 위의 셋과 반대로 없는 값은 꺼짐이다 — 생각 과정과 작업 과정은
    // 켜 달라고 말한 기획자에게만 보인다.
    showTools: stored.showTools === true,
    showThinking: stored.showThinking === true,
  };
}

/**
 * The workspace column. Numbers are clamped into the drag bounds — a blob
 * from an older build, or a hand-edited one, must not open a window with the
 * preview filling all of it. Anything else means "never dragged".
 */
function loadLayout(raw: unknown): LayoutSettings {
  if (!raw || typeof raw !== "object") {
    return { previewWidth: null, sidebarWidth: null, sidebarCollapsed: false };
  }
  const stored = raw as Record<string, unknown>;
  return {
    previewWidth: loadWidth(stored.previewWidth, PREVIEW_WIDTH_BOUNDS),
    sidebarWidth: loadWidth(stored.sidebarWidth, SIDEBAR_WIDTH_BOUNDS),
    sidebarCollapsed: stored.sidebarCollapsed === true,
  };
}

function loadWidth(value: unknown, bounds: { min: number; max: number }): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}
/**
 * What an earlier build stored per workspace. Read once, so a planner who had
 * pinned a model does not silently lose it the day the two collapsed into one;
 * 기획's copy wins because that is where a thread usually started.
 */
function legacyComposerDefaults(): Partial<ChatSettings> {
  for (const workspace of ["planning", "design"]) {
    let raw: unknown;
    try {
      raw = JSON.parse(localStorage.getItem(`colo-design.composer.${workspace}`) ?? "null");
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const stored = raw as Record<string, unknown>;
    const model = typeof stored.model === "string" && stored.model ? stored.model : null;
    const effort = EFFORT_LEVELS.includes(stored.effort as EffortLevel)
      ? (stored.effort as EffortLevel)
      : null;
    if (model || effort) return { model, effort };
  }
  return {};
}

const DARK_QUERY = "(prefers-color-scheme: dark)";
const CONTRAST_QUERY = "(prefers-contrast: more)";

function systemTheme(): ThemeId {
  const media = window.matchMedia?.(DARK_QUERY);
  // No matchMedia at all (an old embedded webview): keep the native palette.
  if (!media) return "dark";
  // A request for more contrast outranks the light/dark preference — the
  // contrast palette exists precisely for that request.
  if (window.matchMedia(CONTRAST_QUERY).matches) return "contrast";
  return media.matches ? "dark" : "light";
}

function resolveTheme(choice: ThemeChoice): ThemeId {
  return choice === "system" ? systemTheme() : choice;
}

/**
 * Paint the stored theme before React mounts. Without this a client set to
 * light renders one dark frame on every load, because the attribute would
 * otherwise land in an effect after the first paint.
 */
export function applyStoredTheme(): void {
  document.documentElement.dataset.theme = resolveTheme(loadSettings().theme);
  syncThemeColor();
}

/**
 * Paint the stored type scale before React mounts — the same first-frame
 * argument as the theme: a client set to 크게 must not render one 보통 frame.
 */
export function applyStoredTypeScale(): void {
  const { uiScale, contentScale, codeScale } = loadSettings();
  document.documentElement.dataset.ui = uiScale;
  document.documentElement.dataset.content = contentScale;
  document.documentElement.dataset.code = codeScale;
}

/** The browser chrome (mobile Safari toolbar, installed-window frame) tints
    from this tag, not from CSS — keep it on the live palette's background. */
function syncThemeColor(): void {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (!bg) return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = bg;
}

/** Settings plus a patch function that persists. */
export function useSettings(): {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  theme: ThemeId;
} {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [theme, setTheme] = useState<ThemeId>(() => resolveTheme(settings.theme));

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      // The tree fold (PLAN D59) writes its key from the sidebar, outside
      // this hook's state — carry the stored copy over, or a settings save
      // made later in the same sitting would unfold the project the planner
      // folded minutes ago.
      const stored = loadSettings();
      const next = {
        ...prev,
        ...patch,
        treeFolded: stored.treeFolded,
      };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Private-browsing quotas can refuse the write. The choice still
        // applies to this tab, it just will not survive a reload.
      }
      return next;
    });
  }, []);

  // Follow the OS while the choice is "system": appearance switches move the
  // app without a reload, and a request for more contrast pulls in the
  // contrast palette ahead of the light/dark preference.
  useEffect(() => {
    setTheme(resolveTheme(settings.theme));
    if (settings.theme !== "system") return;
    const queries = [DARK_QUERY, CONTRAST_QUERY]
      .map((query) => window.matchMedia?.(query))
      .filter((media): media is MediaQueryList => Boolean(media));
    const onChange = () => setTheme(systemTheme());
    for (const media of queries) media.addEventListener("change", onChange);
    return () => {
      for (const media of queries) media.removeEventListener("change", onChange);
    };
  }, [settings.theme]);

  // The stylesheet keys each palette off this attribute; `color-scheme`
  // comes along with it so form controls and scrollbars match.
  useEffect(() => {
    const root = document.documentElement;
    // Surfaces have a 120ms transition. Fading between two palettes leaves
    // inputs dark-text-on-dark for those frames, so a swap skips animation.
    const swapping = root.dataset.theme !== undefined && root.dataset.theme !== theme;
    if (swapping) root.classList.add("theme-swap");
    root.dataset.theme = theme;
    syncThemeColor();
    if (!swapping) return;
    const timer = setTimeout(() => root.classList.remove("theme-swap"), 50);
    return () => clearTimeout(timer);
  }, [theme]);

  // The stylesheet keys each type-scale knob off these attributes; a choice
  // made in the dialog moves the page without a reload.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.ui = settings.uiScale;
    root.dataset.content = settings.contentScale;
    root.dataset.code = settings.codeScale;
  }, [settings.uiScale, settings.contentScale, settings.codeScale]);

  return { settings, update, theme };
}

const MODELS_KEY = "colo-design.models";

/**
 * The model rows the daemon last served. Only a live session can be asked for
 * them, so caching the list is what lets the 모델 chip offer real choices
 * before a workspace is connected — instead of an empty menu.
 */
export function loadModelCatalog(): SessionModelInfo[] {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(MODELS_KEY) ?? "null");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): SessionModelInfo[] => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.value !== "string" || typeof row.displayName !== "string") return [];
    const levels = Array.isArray(row.supportedEffortLevels)
      ? row.supportedEffortLevels.filter((level): level is EffortLevel =>
          EFFORT_LEVELS.includes(level as EffortLevel),
        )
      : null;
    return [
      {
        value: row.value,
        displayName: row.displayName,
        resolvedModel: typeof row.resolvedModel === "string" ? row.resolvedModel : null,
        description: typeof row.description === "string" ? row.description : "",
        supportsEffort: row.supportsEffort !== false,
        supportedEffortLevels: levels,
      },
    ];
  });
}

export function saveModelCatalog(models: SessionModelInfo[]): void {
  try {
    localStorage.setItem(MODELS_KEY, JSON.stringify(models));
  } catch {
    // A cache that cannot be written just means the next reload asks again.
  }
}

// ---------------------------------------------------------------------------
// 개발자 코멘트의 처리 표식 (PLAN D88)
// ---------------------------------------------------------------------------

const HANDLED_KEY = "colo-design.handled-reviews";
const REPLY_CONFIRMED_KEY = "colo-design.reply-confirmed";

/**
 * 처리한 개발자 코멘트 id, PR 번호별로. 사이클이 짧으니 기계를 바꾸면 다시
 * 보여도 받아들인다 — 이 표식은 배지를 조용히 하기 위한 것이라 반응형 저장소
 * 대신 자기 열쇠 하나로 산다.
 */
export function loadHandledReviews(pr: number): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HANDLED_KEY) ?? "{}") as Record<string, string[]>;
    return Array.isArray(raw[String(pr)]) ? (raw[String(pr)] as string[]) : [];
  } catch {
    return [];
  }
}

export function saveHandledReview(pr: number, id: number): void {
  try {
    const raw = JSON.parse(localStorage.getItem(HANDLED_KEY) ?? "{}") as Record<string, string[]>;
    const stored: string[] = Array.isArray(raw[String(pr)]) ? (raw[String(pr)] as string[]) : [];
    const list = new Set([...stored, String(id)]);
    localStorage.setItem(HANDLED_KEY, JSON.stringify({ ...raw, [String(pr)]: [...list] }));
  } catch {
    // 사적 모드 등에서 저장이 막혀도 표식은 메모리의 몫으로 끝난다.
  }
}

/** 첫 답하기의 확인 — 도구가 기획자 이름으로 GitHub 에 쓰는 첫 자리라 한 번. */
export function isReplyConfirmed(): boolean {
  try {
    return localStorage.getItem(REPLY_CONFIRMED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markReplyConfirmed(): void {
  try {
    localStorage.setItem(REPLY_CONFIRMED_KEY, "1");
  } catch {
    // 다음 답하기가 다시 물어볼 뿐이다.
  }
}
// ---------------------------------------------------------------------------
// 레포 경고의 읽음 지문 — 닫은 소식은 기기에 눌러 담긴다
// ---------------------------------------------------------------------------

const REPO_WARNINGS_KEY = "colo-design.repo-warnings-read";

/**
 * 이 기기에서 닫은 레포 경고의 지문들. 헤더의 나머지 경고는 살아 있는 문제라
 * 세션 동안만 숨겨지지만, 레포가 보낸 settings.json 경고는 뉴스다 — 한 번
 * 읽은 같은 소식이 새로고침마다 돌아오면 잡음일 뿐이다. 지문(레포 루트+파일
 * 원문)을 기억해, 설정이 바뀌거나 다른 레포가 연결될 때만 다시 보인다.
 */
export function loadReadRepoWarnings(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(REPO_WARNINGS_KEY) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export function rememberReadRepoWarning(fingerprint: string): void {
  try {
    const stored = loadReadRepoWarnings();
    localStorage.setItem(REPO_WARNINGS_KEY, JSON.stringify([...new Set([...stored, fingerprint])]));
  } catch {
    // 사적 모드 등에서 저장이 막혀도 닫기는 이 탭의 몫으로 끝난다.
  }
}
