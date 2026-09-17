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
 * 실행 중 보내기. A send while a turn runs either waits
 * for that turn to end (queue — the DAEMON holds it; the SDK would not, it
 * hands a mid-turn send straight to the CLI, which folds it into the running
 * turn) or cuts the running one and starts over with the new words
 * (interrupt — the ⌥Enter "끊고 보내기" path, promoted to the plain send).
 */
export type MidTurnSend = "queue" | "interrupt";
/** 완료 알림의 시점: 끔 / 오래 걸린 턴만(기본) / 모든 턴. */
export type NoticeTiming = "off" | "long" | "all";

const NOTICE_TIMINGS: NoticeTiming[] = ["off", "long", "all"];

/** "오래 걸린 턴"의 기준 — 데스크톱 메인의 알림과 같은 값이다. */
export const LONG_TURN_MS = 60_000;

/** The three-step type scale. 보통 is the stylesheet's
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

/** The sidebar's drag bounds. */
export const SIDEBAR_WIDTH_BOUNDS = { min: 200, max: 360 } as const;

/**
 * How the agent answers in this planner's conversations.
 *
 * These used to be three chips in the composer, stored per workspace. They are
 * one shared preference now: 설정 is a single dialog, and a planner asked to
 * choose "어떤 모델을 쓸지" twice — once for 기획, once for 화면 — is being
 * asked a question they have no way to answer differently.
 */
export interface ChatSettings {
  /** Which agent provider new sessions run on; "claude" is the default. */
  provider: string;
  /**
   * The pinned model for `provider` — a Claude alias or that provider's own
   * model id. Other providers' pins wait in `byProvider`; the vocabularies
   * differ, so one slot cannot hold them all.
   */
  model: string | null;
  /** The pinned effort for `provider`; other providers' pins ride `byProvider`. */
  effort: EffortLevel | null;
  /**
   * Model/effort pins for providers other than `provider`. Switching the
   * 에이전트 picker swaps the top-level fields with this map's entry, so a
   * Codex id never reaches a Claude session or vice versa.
   */
  byProvider?: Record<string, { model: string | null; effort: EffortLevel | null }>;
  /**
   * 새 대화의 에이전트 목록에서 숨긴 프로바이더. 설치 여부(`available`)와
   * 별개의 사용자 선택이다 — 끈 에이전트는 컴포저의 칩에도 나오지 않고,
   * 설정의 목록에서만 다시 켠다. 기본 에이전트를 끄면 목록의 다른 켜진
   * 에이전트로 옮겨 심는다.
   */
  disabledProviders: string[];
  permissionMode: PermissionMode;
  /**
   * 작업 과정(도구 호출 묶음)을 대화에 남길지. 기본은 끔 — 생각 과정과 같은
   * 이유다. 접힌 활동 카드라 해도 답과 답 사이마다 한 줄씩 끼면 테이프가
   * 기계의 작업 기록처럼 읽힌다. 켜면 접힌 활동 카드로 돌아온다. 계획
   * 카드(TodoWrite)와 캡처 카드는 이 스위치와 무관하게 언제나 자리를
   * 지킨다 — 그 둘은 작업의 기록이 아니라 읽을 내용이다.
   */
  showTools: boolean;
  /**
   * 생각 과정을 대화에 남길지. 기본은 끔 — 사용자가 읽는 것은 답이지 답을
   * 만드는 동안의 속말이 아니다. 접혀 있어도 답과 답 사이마다 한 줄씩 끼면
   * 테이프가 기계의 기록처럼 읽힌다. 켜면 예전처럼 접힌 채로 돌아온다.
   */
  showThinking: boolean;
}

/**
 * The settings patch that writes a model/effort pin for `provider` — the
 * top-level fields when it is the selected provider, its `byProvider` entry
 * otherwise. An all-null entry is dropped so the map does not fill with
 * empty rows.
 */
export function withChatPick(
  chat: ChatSettings,
  provider: string,
  pick: { model?: string | null; effort?: EffortLevel | null },
): Partial<ChatSettings> {
  if (provider === chat.provider) {
    return {
      ...(pick.model !== undefined ? { model: pick.model } : {}),
      ...(pick.effort !== undefined ? { effort: pick.effort } : {}),
    };
  }
  const current = chat.byProvider?.[provider] ?? { model: null, effort: null };
  const next = {
    model: pick.model !== undefined ? pick.model : current.model,
    effort: pick.effort !== undefined ? pick.effort : current.effort,
  };
  const byProvider = { ...(chat.byProvider ?? {}) };
  if (next.model || next.effort) byProvider[provider] = next;
  else delete byProvider[provider];
  return { byProvider };
}

/**
 * The settings patch for switching the 에이전트 picker: the outgoing
 * provider's top-level pins are stashed under its id, and the incoming
 * provider's stashed pins become the top-level fields. What the dialog shows
 * after the switch is exactly what the next session of that provider gets.
 */
export function switchProviderPatch(chat: ChatSettings, next: string): Partial<ChatSettings> {
  const byProvider = { ...(chat.byProvider ?? {}) };
  if (chat.model || chat.effort)
    byProvider[chat.provider] = { model: chat.model, effort: chat.effort };
  else delete byProvider[chat.provider];
  const incoming = byProvider[next] ?? { model: null, effort: null };
  delete byProvider[next];
  return {
    provider: next,
    model: incoming.model,
    effort: incoming.effort,
    byProvider,
  };
}

export interface Settings {
  theme: ThemeChoice;
  sendKey: SendKey;
  midTurnSend: MidTurnSend;
  /**
   * 앱에서 링크 열기: 데스크톱에서 누른 http(s) 링크가 OS 브라우저 대신
   * 미리보기 칸에서 열린다. 기본은 꺼짐 — 칸은 원래 미리보기 서버만의
   * 자리다. 데스크톱이 아니면(plain 브라우저) 읽혀도 아무 일도 안 한다.
   */
  openLinksInApp: boolean;
  /** Three-step type scales. Each rides a data
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
   * Which project's tree is folded, by slug. Written by the
   * sidebar outside this hook's state, so `update` carries the stored copy
   * over and nothing can silently unfold a project the planner folded.
   */
  treeFolded?: Record<string, boolean>;
}

const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  provider: "claude",
  model: null,
  effort: null,
  disabledProviders: [],
  permissionMode: DEFAULT_PERMISSION_MODE,
  showTools: false,
  showThinking: false,
};

const DEFAULT_SETTINGS: Settings = {
  /**
   * Light, not dark. This tool used to look like a session log and
   * defaulted to the palette that suited one. What a planner does here is read
   * and write a document beside a rendered screen — both of which they will
   * see on paper and in a browser, on white. A planner who prefers dark still
   * has it one choice away; the default is now the one that matches the work.
   */
  theme: "light",
  sendKey: "enter",
  midTurnSend: "queue",
  openLinksInApp: false,
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
    openLinksInApp: stored.openLinksInApp === true,
    uiScale: oneOf(SCALE_LEVELS, stored.uiScale, DEFAULT_SETTINGS.uiScale),
    contentScale: oneOf(SCALE_LEVELS, stored.contentScale, DEFAULT_SETTINGS.contentScale),
    codeScale: oneOf(SCALE_LEVELS, stored.codeScale, DEFAULT_SETTINGS.codeScale),
    notifications: normalizeNotificationSettings(stored.notifications),
    chat: loadChat(stored.chat),
    layout: loadLayout(stored.layout),
    sessionTitles: loadSessionTitles(stored.sessionTitles),
    treeFolded: loadTreeFolded(stored.treeFolded),
  };
}

/**
 * 저장 블롭이든 데스크톱 메인이 건넨 값이든 — 못 쓰는 값은 기본으로 돌린다.
 * 데스크톱의 부팅 동기화(App.tsx)도 이 규칙을 쓴다.
 */
export function normalizeNotificationSettings(raw: unknown): NotificationSettings {
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
  return normalizeNotificationSettings(raw);
}

/** Project slug → whether its tree is folded. Slugs and booleans
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
  // acceptEdits 가 메뉴로 돌아왔으므로(chat-options) 이사도 함께 물러났다:
  // 저장된 값은 고른 그대로 돌아온다.
  const mode = oneOf(SETTINGS_MODES, stored.permissionMode, DEFAULT_PERMISSION_MODE);
  const provider =
    typeof stored.provider === "string" && stored.provider ? stored.provider : "claude";
  const byProvider = loadByProvider(stored.byProvider);
  // The stored model must belong to the stored provider's vocabulary — a
  // Codex id pinned while Codex was selected must not greet the next Claude
  // session. When that provider's catalog is known, a value it does not list
  // is a leftover from another provider and is dropped.
  const storedModel =
    typeof stored.model === "string" && stored.model ? stored.model : (legacy.model ?? null);
  const knownModels = loadModelCatalog(provider);
  const model =
    storedModel && knownModels.length > 0 && !knownModels.some((m) => m.value === storedModel)
      ? null
      : storedModel;
  return {
    provider,
    model,
    effort: EFFORT_LEVELS.includes(stored.effort as EffortLevel)
      ? (stored.effort as EffortLevel)
      : (legacy.effort ?? null),
    ...(byProvider ? { byProvider } : {}),
    // 손으로 고친 기록의 쓰레기 값(문자열 아닌 항목, 중복)은 목록에 들어오지
    // 못한다 — 이 필드는 '숨김'이므로 오염된 값은 에이전트를 조용히 지운다.
    disabledProviders: Array.isArray(stored.disabledProviders)
      ? [...new Set(stored.disabledProviders.filter((v): v is string => typeof v === "string"))]
      : [],
    permissionMode: mode,
    // 기본 끔: 위의 셋과 반대로 없는 값은 꺼짐이다 — 생각 과정과 작업 과정은
    // 켜 달라고 말한 사용자에게만 보인다.
    showTools: stored.showTools === true,
    showThinking: stored.showThinking === true,
  };
}

/**
 * The per-provider pin map, restored field by field — a hand-edited blob's
 * garbage entry must not poison a provider's next session.
 */
function loadByProvider(
  raw: unknown,
): Record<string, { model: string | null; effort: EffortLevel | null }> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, { model: string | null; effort: EffortLevel | null }> = {};
  for (const [provider, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const model = typeof row.model === "string" && row.model ? row.model : null;
    const effort = EFFORT_LEVELS.includes(row.effort as EffortLevel)
      ? (row.effort as EffortLevel)
      : null;
    if (model || effort) out[provider] = { model, effort };
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
      // The tree fold writes its key from the sidebar, outside
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
 * The model rows the daemon last served, per provider. Only a live session
 * can be asked for them, so caching the list is what lets the 모델 chip
 * offer real choices before a workspace is connected — instead of an empty
 * menu. Each provider keeps its own rows: a Claude alias and a Codex model
 * id are different vocabularies, and one shared list would offer a model
 * the session cannot run.
 */
export function loadModelCatalog(provider?: string): SessionModelInfo[] {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(MODELS_KEY) ?? "null");
  } catch {
    return [];
  }
  // A cache written by the single-list build is one provider's rows — that
  // provider was Claude, the only one the picker knew then.
  const byProvider: Record<string, unknown> = Array.isArray(raw)
    ? { claude: raw }
    : raw && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};
  const rows = provider ? byProvider[provider] : undefined;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((entry): SessionModelInfo[] => {
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
        // 캐시는 빠르게를 모를 수 있다(이 열이 없던 시절의 블롭): 없으면
        // 받는다고 읽는다 — Composer 가 모르는 동안 토글을 보이는 자세와
        // 같다. 진짜 여부는 세션이 답하는 순간 정정된다.
        supportsFastMode: row.supportsFastMode !== false,
      },
    ];
  });
}

export function saveModelCatalog(provider: string, models: SessionModelInfo[]): void {
  try {
    let raw: unknown;
    try {
      raw = JSON.parse(localStorage.getItem(MODELS_KEY) ?? "null");
    } catch {
      raw = null;
    }
    const byProvider: Record<string, unknown> = Array.isArray(raw)
      ? { claude: raw }
      : raw && typeof raw === "object"
        ? (raw as Record<string, unknown>)
        : {};
    byProvider[provider] = models;
    localStorage.setItem(MODELS_KEY, JSON.stringify(byProvider));
  } catch {
    // A cache that cannot be written just means the next reload asks again.
  }
}

// ---------------------------------------------------------------------------
// 개발자 코멘트의 처리 표식
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
    // The map only ever grows — a planner who hands off for years would
    // carry every dead PR's keys. Keep the most recent few.
    const merged = { ...raw, [String(pr)]: [...list] };
    const keys = Object.keys(merged);
    const trimmed =
      keys.length > 20
        ? Object.fromEntries(keys.slice(-20).map((key) => [key, merged[key]!]))
        : merged;
    localStorage.setItem(HANDLED_KEY, JSON.stringify(trimmed));
  } catch {
    // 사적 모드 등에서 저장이 막혀도 표식은 메모리의 몫으로 끝난다.
  }
}

/** 첫 답하기의 확인 — 도구가 사용자 이름으로 GitHub 에 쓰는 첫 자리라 한 번. */
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
    // Append-only would grow without end — the newest few dozen
    // fingerprints are the only ones a warning can still collide with.
    const next = [...new Set([...stored, fingerprint])].slice(-50);
    localStorage.setItem(REPO_WARNINGS_KEY, JSON.stringify(next));
  } catch {
    // 사적 모드 등에서 저장이 막혀도 닫기는 이 탭의 몫으로 끝난다.
  }
}
