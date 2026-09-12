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
}

export interface Settings {
  theme: ThemeChoice;
  sendKey: SendKey;
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
  if (!raw || typeof raw !== "object") return DEFAULT_SETTINGS;
  const stored = raw as Record<string, unknown>;

  return {
    theme: oneOf(THEMES, stored.theme, DEFAULT_SETTINGS.theme),
    sendKey: oneOf(["enter", "modEnter"] as const, stored.sendKey, DEFAULT_SETTINGS.sendKey),
    chat: loadChat(stored.chat),
    layout: loadLayout(stored.layout),
    sessionTitles: loadSessionTitles(stored.sessionTitles),
    treeFolded: loadTreeFolded(stored.treeFolded),
  };
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
 * The conversation settings, with one value deliberately not restored.
 *
 * 전부 맡기기 (`bypassPermissions`) lets Claude act on the repo clone without
 * asking. Turning it on is a decision about one afternoon's work; finding it
 * still on next Tuesday, because a stored blob outlived the reason, is not a
 * decision anybody made. Every other mode is safe to remember — the daemon's
 * own write policy already bounds what an edit may touch.
 */
function loadChat(raw: unknown): ChatSettings {
  const legacy = legacyComposerDefaults();
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CHAT_SETTINGS, ...legacy };
  const stored = raw as Record<string, unknown>;
  const mode = oneOf(SETTINGS_MODES, stored.permissionMode, DEFAULT_PERMISSION_MODE);
  return {
    model: typeof stored.model === "string" && stored.model ? stored.model : (legacy.model ?? null),
    effort: EFFORT_LEVELS.includes(stored.effort as EffortLevel)
      ? (stored.effort as EffortLevel)
      : (legacy.effort ?? null),
    permissionMode: mode === "bypassPermissions" ? DEFAULT_PERMISSION_MODE : mode,
    // 기본 켬(PLAN D61·D63·D91): an older blob that predates the toggles — or a
    // hand-edited one that wrote anything but a boolean — reads as on.
    previewTools: stored.previewTools === undefined ? true : stored.previewTools === true,
    showPip: stored.showPip === undefined ? true : stored.showPip === true,
    followClaude: stored.followClaude === undefined ? true : stored.followClaude === true,
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
