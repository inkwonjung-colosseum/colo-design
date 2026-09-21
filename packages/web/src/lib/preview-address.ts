/**
 * 주소창의 판정 — 순수 함수. The bar DISPLAYS the path only — origin·port 는
 * 개발자 도구의 어휘라 PreviewHost 가 붙이지 않는다 — but what may be typed
 * stays inside the preview server: a bar that can name another server is a
 * browser this tool refuses to be. What may be typed:
 *
 * - `/member/MemberList` — a path inside the origin.
 * - `member/MemberList` — the leading slash is typed for you.
 * - `?after=…` — a query alone, riding the current path (2026-09-21 상태
 *   축 철거 — 특별한 취급을 받던 상태 쿼리는 이제 그냥 쿼리다).
 * - a full url — accepted only when its origin is the preview server's,
 *   reduced to its path.
 *
 * Everything else — `//host`, `javascript:`, another origin — is refused with
 * one sentence (`ONLY_PREVIEW`). The main process enforces the same line;
 * this check is the answer, not the gate.
 */

export type AddressTarget = { kind: "path"; path: string } | { kind: "error"; message: string };

const ONLY_PREVIEW = "미리보기 안의 화면 주소만 열 수 있어요";

export function parseAddress(
  raw: string,
  opts: { origin: string; currentPath: string },
): AddressTarget {
  const input = raw.trim();
  if (input === "") return { kind: "error", message: "주소를 입력해 주세요" };

  // 프로토콜 상대(`//host`)와 모든 스킴(`javascript:`, `https://…`)은 한 곳에서
  // 갈린다: 절대 URL 이면 origin 이 같을 때만 경로로 환원한다.
  if (input.startsWith("//") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) {
    try {
      const url = new URL(input);
      if (url.origin !== opts.origin) return { kind: "error", message: ONLY_PREVIEW };
      return { kind: "path", path: `${url.pathname}${url.search}` };
    } catch {
      return { kind: "error", message: ONLY_PREVIEW };
    }
  }

  const path = input.startsWith("?")
    ? `${opts.currentPath.split("?")[0]}${input}`
    : input.startsWith("/")
      ? input
      : `/${input}`;
  return { kind: "path", path };
}
