/**
 * 주소창의 판정 (PLAN D66) — 순수 함수. The address bar takes a path, not a
 * url: the preview origin is never shown (the 새 창 button hides it for the
 * same reason), and a bar that can name another server is a browser this
 * tool refuses to be. What may be typed:
 *
 * - `/member/MemberList` — a declared screen's route, `?state=` welcome.
 *   A declared route rides the bridge (client routing, no reload); anything
 *   else inside the origin rides `open` (`loadURL`).
 * - `member/MemberList` — the leading slash is typed for you.
 * - `?state=empty` — the state alone, on the current path.
 * - a full url — accepted only when its origin is the preview server's,
 *   reduced to its path.
 *
 * Everything else — `//host`, `javascript:`, another origin — is refused with
 * one sentence. The main process enforces the same line (D66); this check is
 * the answer, not the gate.
 */

export type AddressTarget =
  | { kind: "screen"; route: string; state: string | null }
  | { kind: "path"; path: string }
  | { kind: "error"; message: string };

const ONLY_PREVIEW = "미리보기 서버 안의 주소만 열 수 있습니다";

/** `/a/b?state=x` → route + state, the shape the picker and chips speak. */
export function splitPath(path: string): {
  route: string;
  state: string | null;
} {
  const query = path.split("?")[1] ?? "";
  const route = path.slice(0, path.length - (query ? query.length + 1 : 0));
  const state = new URLSearchParams(query).get("state");
  return { route, state: state && state !== "" ? state : null };
}

export function parseAddress(
  raw: string,
  opts: { origin: string; currentPath: string; routes: string[] },
): AddressTarget {
  const input = raw.trim();
  if (input === "") return { kind: "error", message: "주소를 입력해 주세요" };

  // 프로토콜 상대(`//host`)와 모든 스킴(`javascript:`, `https://…`)은 한 곳에서
  // 갈린다: 절대 URL 이면 origin 이 같을 때만 경로로 환원한다.
  if (input.startsWith("//") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) {
    try {
      const url = new URL(input);
      if (url.origin !== opts.origin) return { kind: "error", message: ONLY_PREVIEW };
      return pathTarget(`${url.pathname}${url.search}`, opts.routes);
    } catch {
      return { kind: "error", message: ONLY_PREVIEW };
    }
  }

  const path = input.startsWith("?")
    ? `${splitPath(opts.currentPath).route}${input}`
    : input.startsWith("/")
      ? input
      : `/${input}`;
  return pathTarget(path, opts.routes);
}

function pathTarget(path: string, routes: string[]): AddressTarget {
  const { route, state } = splitPath(path);
  if (routes.includes(route)) return { kind: "screen", route, state };
  return { kind: "path", path };
}
