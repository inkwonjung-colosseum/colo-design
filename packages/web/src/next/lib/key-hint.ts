/**
 * 단축키 표기를 이 컴퓨터에 맞춘다. 문장(`labels.ts`)은 mac 의 글리프(⌘ ⌥ ⇧)로 적혀 있고,
 * Windows · Linux 에서는 같은 키가 Ctrl · Alt · Shift 다. 핸들러는 ⌘ 와 Ctrl 을 모두
 * 받으니(`metaKey || ctrlKey`) 표기만 바꾸면 된다. 글리프 밖의 글자는 건드리지 않는다.
 */

const NAMES: Record<string, string> = { "⌘": "Ctrl", "⌃": "Ctrl", "⌥": "Alt", "⇧": "Shift" };

/** 지금 창이 mac 위에 있는가 — 모르면 mac(문장의 원래 모양)으로 둔다. */
function detectMac(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return true;
  const desktop = (window as unknown as { novaDesignDesktop?: { platform?: string } })
    .novaDesignDesktop;
  if (desktop?.platform) return desktop.platform === "darwin";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? "";
  return !/win|linux/i.test(platform);
}

/** mac 이 아니면 `⌘⇧P` → `Ctrl+Shift+P`, `option(⌥)+클릭` → `Alt+클릭`. mac 이면 그대로. */
export function keyHint(text: string, mac: boolean = detectMac()): string {
  if (mac) return text;
  return text
    .replace(/option\(⌥\)/g, "Alt")
    .replace(/[⌘⌃⌥⇧]+/g, (run) => `${[...run].map((glyph) => NAMES[glyph]).join("+")}+`);
}
