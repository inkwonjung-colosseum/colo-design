import { useCallback, useEffect, useState } from "react";
import type { EffortLevel, PermissionMode, SessionModelInfo } from "@cds-design/protocol";
import { DEFAULT_PERMISSION_MODE, SETTINGS_MODES } from "./chat-options";

/**
 * Client-side preferences. Everything here belongs to the browser, not the
 * daemon: a preference is either about how this UI looks or about how it
 * behaves when the planner types. Session state stays where it already lives —
 * the daemon owns it.
 */

export type ThemeChoice = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";
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
}

export interface Settings {
  theme: ThemeChoice;
  sendKey: SendKey;
  /**
   * Kept, unread (PLAN D54): 대화는 보관으로 바뀌었고 삭제 확인은 없어졌다.
   * External compatibility requirement — SettingsDialog, owned outside this
   * change, still binds this field; dropping it here breaks that file. No
   * code path in this app reads it any more.
   */
  confirmBeforeDelete: boolean;
  chat: ChatSettings;
  layout: LayoutSettings;
  /** The planner's own names for threads, by session id. The daemon's
      summary stays the fallback; an entry the planner emptied is dropped. */
  sessionTitles: Record<string, string>;
  /**
   * Conversations kept out of the list (PLAN D54), by project slug. 보관 is
   * not 삭제 — the transcript survives; the list, the tabs, and the tree
   * just stop showing the thread. The 팔레트 is the way back.
   */
  archivedSessions: Record<string, string[]>;
  /**
   * Which project's tree is folded (PLAN D59), by slug. Written by the
   * sidebar outside this hook's state (the archivedSessions precedent), so
   * `update` carries the stored copy over and nothing can silently unfold a
   * project the planner folded.
   */
  treeFolded?: Record<string, boolean>;
};

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  model: null,
  effort: null,
  permissionMode: DEFAULT_PERMISSION_MODE,
  previewTools: true,
  showPip: true,
};

export const DEFAULT_SETTINGS: Settings = {
  /**
   * Light, not dark (PLAN D13). This tool used to look like a session log and
   * defaulted to the palette that suited one. What a planner does here is read
   * and write a document beside a rendered screen — both of which they will
   * see on paper and in a browser, on white. A planner who prefers dark still
   * has it one choice away; the default is now the one that matches the work.
   */
  theme: "light",
  sendKey: "enter",
  confirmBeforeDelete: true,
  chat: DEFAULT_CHAT_SETTINGS,
  layout: { previewWidth: null, sidebarWidth: null, sidebarCollapsed: false },
  sessionTitles: {},
  archivedSessions: {},
  treeFolded: {},
};

export const THEMES: ThemeChoice[] = ["system", "dark", "light"];

const KEY = "cds-design.settings";

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
export function loadSettings(): Settings {
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
    confirmBeforeDelete:
      typeof stored.confirmBeforeDelete === "boolean"
        ? stored.confirmBeforeDelete
        : DEFAULT_SETTINGS.confirmBeforeDelete,
    chat: loadChat(stored.chat),
    layout: loadLayout(stored.layout),
    sessionTitles: loadSessionTitles(stored.sessionTitles),
    archivedSessions: loadArchivedSessions(stored.archivedSessions),
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
 * Persist one project's tree fold. Same read-modify-write as the archive:
 * the stored blob is read whole and rewritten, so a stale React copy can
 * never undo another key's newer write.
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

/** Project slug → the session ids kept out of its list (PLAN D54). Slugs and
    id arrays only; anything else in a hand-edited blob is dropped. */
function loadArchivedSessions(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string[]> = {};
  for (const [slug, ids] of Object.entries(raw)) {
    if (!slug || !Array.isArray(ids)) continue;
    const clean = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
    if (clean.length > 0) out[slug] = clean;
  }
  return out;
}

/** The archived ids of one project, read fresh — the thread list writes this
    key outside any settings dialog, so no component may hold a stale copy. */
export function loadArchivedSessionIds(slug: string | null): string[] {
  if (!slug) return [];
  return loadSettings().archivedSessions[slug] ?? [];
}

/**
 * Persist one project's archived ids. Reads the stored blob first and rewrites
 * it whole: `useSettings` holds settings state that can be older than the last
 * 보관, and writing this key from that stale copy would silently un-archive
 * conversations the planner hid minutes ago.
 */
export function saveArchivedSessionIds(slug: string | null, ids: string[]): void {
  if (!slug) return;
  let base: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (raw && typeof raw === "object") base = raw as Record<string, unknown>;
  } catch {
    // An unreadable blob starts a fresh one; the validated archive map below
    // is what matters.
  }
  const archived = { ...loadSettings().archivedSessions, [slug]: ids };
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...base, archivedSessions: archived }));
  } catch {
    // Private-browsing quotas can refuse the write; the hide still applies
    // to this tab's state.
  }
  // Every archive write funnels through here — 보관, 되살리기, 영구 삭제 —
  // so this one ping is how the sidebar tree (which reads the stored ids
  // fresh, project by project) learns to redraw (PLAN D59).
  window.dispatchEvent(new Event("cds-design:archived"));
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
    model:
      typeof stored.model === "string" && stored.model ? stored.model : (legacy.model ?? null),
    effort: EFFORT_LEVELS.includes(stored.effort as EffortLevel)
      ? (stored.effort as EffortLevel)
      : (legacy.effort ?? null),
    permissionMode: mode === "bypassPermissions" ? DEFAULT_PERMISSION_MODE : mode,
    // 기본 켬(PLAN D61·D63): an older blob that predates the toggles — or a
    // hand-edited one that wrote anything but a boolean — reads as on.
    previewTools: stored.previewTools === undefined ? true : stored.previewTools === true,
    showPip: stored.showPip === undefined ? true : stored.showPip === true,
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
      raw = JSON.parse(localStorage.getItem(`cds-design.composer.${workspace}`) ?? "null");
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

function systemTheme(): ResolvedTheme {
  const media = window.matchMedia?.(DARK_QUERY);
  // No matchMedia at all (an old embedded webview): keep the native palette.
  if (!media) return "dark";
  return media.matches ? "dark" : "light";
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  return choice === "system" ? systemTheme() : choice;
}

/**
 * Paint the stored theme before React mounts. Without this a client set to
 * light renders one dark frame on every load, because the attribute would
 * otherwise land in an effect after the first paint.
 */
export function applyStoredTheme(): void {
  document.documentElement.dataset.theme = resolveTheme(loadSettings().theme);
}

/** Settings plus a patch function that persists. */
export function useSettings(): {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  theme: ResolvedTheme;
} {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [theme, setTheme] = useState<ResolvedTheme>(() => resolveTheme(settings.theme));

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      // 보관 (PLAN D54) and the tree fold (PLAN D59) write their keys from
      // the sidebar, outside this hook's state — carry the stored copies
      // over, or a settings save made later in the same sitting would
      // restore conversations the planner archived, and unfold the project
      // they folded, minutes ago.
      const stored = loadSettings();
      const next = {
        ...prev,
        ...patch,
        archivedSessions: stored.archivedSessions,
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

  // Follow the OS while the choice is "system", so switching appearance in
  // macOS or Windows moves the app without a reload.
  useEffect(() => {
    setTheme(resolveTheme(settings.theme));
    if (settings.theme !== "system") return;
    const media = window.matchMedia?.(DARK_QUERY);
    if (!media) return;
    const onChange = () => setTheme(systemTheme());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [settings.theme]);

  // The stylesheet keys its light palette off this attribute; `color-scheme`
  // comes along with it so form controls and scrollbars match.
  useEffect(() => {
    const root = document.documentElement;
    // Surfaces have a 120ms transition. Fading between two palettes leaves
    // inputs dark-text-on-dark for those frames, so a swap skips animation.
    const swapping = root.dataset.theme !== undefined && root.dataset.theme !== theme;
    if (swapping) root.classList.add("theme-swap");
    root.dataset.theme = theme;
    if (!swapping) return;
    const timer = setTimeout(() => root.classList.remove("theme-swap"), 50);
    return () => clearTimeout(timer);
  }, [theme]);

  return { settings, update, theme };
}

const MODELS_KEY = "cds-design.models";

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
