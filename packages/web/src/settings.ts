import { useCallback, useEffect, useState } from "react";
import type {
  EffortLevel,
  PermissionMode,
  SessionModelInfo,
  Workspace,
} from "@drafthouse/protocol";
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
 * How Claude answers in this planner's conversations (PLAN D10).
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
}

export interface Settings {
  theme: ThemeChoice;
  sendKey: SendKey;
  confirmBeforeDelete: boolean;
  chat: ChatSettings;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  model: null,
  effort: null,
  permissionMode: DEFAULT_PERMISSION_MODE,
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
};

export const THEMES: ThemeChoice[] = ["system", "dark", "light"];

const KEY = "drafthouse.settings";

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
  };
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
  };
}

/**
 * What an earlier build stored per workspace. Read once, so a planner who had
 * pinned a model does not silently lose it the day the two collapse into one;
 * 기획's copy wins because that is where a thread usually starts.
 */
function legacyComposerDefaults(): Partial<ChatSettings> {
  for (const workspace of ["planning", "design"] as Workspace[]) {
    let raw: unknown;
    try {
      raw = JSON.parse(localStorage.getItem(`drafthouse.composer.${workspace}`) ?? "null");
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
      const next = { ...prev, ...patch };
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

const MODELS_KEY = "drafthouse.models";

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
