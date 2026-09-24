/**
 * 답변의 화면 링크와 핀 카드의 행이 미리보기 칸을 움직이는 통로.
 *
 * 공통 규칙이 AI 에게 답변 끝에 `[제목](전체 주소)` 를 남기게 한다. 그 주소는
 * 미리보기 서버의 것이라, 새 창으로 열면 OS 브라우저가 떠서 핀도 못 찍는
 * 화면이 된다. 이 통로는 그 클릭을 미리보기의 주소창 이동으로 바꾼다 —
 * 주소창에 경로를 친 것과 같은 길(ScreenPanel 의 target)이다.
 *
 * 모양은 invite-bus 와 같다: 이동할 수 있는 쪽(ScreenPanel)이 스스로를
 * 등록하고, 누르는 쪽(마크다운 링크 · 핀 카드)은 등록된 손을 빌린다.
 * 판정은 클릭 핸들러 안에서 동기로 끝나야 기본 동작을 막을 수 있으므로
 * 이벤트가 아니라 등록된 함수 하나다.
 */

/** 루프백의 이름들 — 같은 기계의 서버를 가리키는 표기는 여럿이다. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1", "0.0.0.0"]);

function isLoopback(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase());
}

/**
 * 링크가 이 미리보기의 화면이면 그 경로(`/member/list?q=1`), 아니면 null —
 * 순수 함수.
 *
 * - origin 이 미리보기 서버와 같으면 그 화면이다.
 * - 둘 다 루프백이면 포트가 달라도 그 화면으로 읽는다. 미리보기 서버는 켤
 *   때마다 빈 포트를 고르므로, 어제 대화의 링크는 어제의 포트를 들고 있다.
 *   이 도구에서 AI 가 링크로 남기는 로컬 서버는 미리보기 하나뿐이다.
 * - 그 밖의 주소(GitHub · 외부 문서)는 null — 원래대로 브라우저가 연다.
 */
export function previewPathOf(href: string, previewUrl: string | null): string | null {
  if (!previewUrl) return null;
  let link: URL;
  let preview: URL;
  try {
    link = new URL(href);
    preview = new URL(previewUrl);
  } catch {
    return null;
  }
  if (link.protocol !== "http:" && link.protocol !== "https:") return null;
  const sameServer =
    link.origin === preview.origin ||
    (link.protocol === preview.protocol &&
      isLoopback(link.hostname) &&
      isLoopback(preview.hostname));
  if (!sameServer) return null;
  return `${link.pathname || "/"}${link.search}${link.hash}`;
}

/**
 * 링크의 모양이 미리보기 화면 같은가 — 표식(아이콘)만 이 판정을 쓴다. 칸이
 * 등록돼 있으면 그 서버와 견주고, 아직이면 루프백 http 주소를 화면으로 본다
 * (이 도구의 답변에서 루프백 주소는 미리보기뿐이다). 클릭의 진짜 판정은
 * openScreenLink 가 한다.
 */
export function looksLikeScreenLink(href: string): boolean {
  if (opener) return previewPathOf(href, opener.previewUrl) !== null;
  try {
    const link = new URL(href);
    return (link.protocol === "http:" || link.protocol === "https:") && isLoopback(link.hostname);
  } catch {
    return false;
  }
}

/**
 * 화면 id → 경로 — 순수 함수. id 는 앞 슬래시 없는 경로이고 루트는 `index`
 * 다(preview-preload 의 pageContext 와 같은 규칙). 옛 마커가 슬래시를 달고
 * 와도 같은 곳으로 간다.
 */
export function screenPath(screen: string): string {
  const id = screen.trim().replace(/^\/+/, "");
  return id === "" || id === "index" ? "/" : `/${id}`;
}

/** 등록된 미리보기 칸 — 지금 서버의 주소와 이동의 손. */
interface ScreenOpener {
  previewUrl: string;
  open: (path: string) => void;
}

let opener: ScreenOpener | null = null;

/**
 * 미리보기 칸이 이동의 손을 등록한다. 돌려받은 함수는 제 등록만 거둔다:
 * 다시 마운트된 칸이 먼저 등록한 뒤 옛 칸의 정리가 돌아도 새 등록은 남는다.
 */
export function registerScreenOpener(entry: ScreenOpener): () => void {
  opener = entry;
  return () => {
    if (opener === entry) opener = null;
  };
}

/** 미리보기 칸이 지금 이동을 받을 수 있는가 — 누를 손을 그릴지의 판정. */
export function canOpenScreen(): boolean {
  return opener !== null;
}

/** 경로 하나로 미리보기를 옮긴다. 받을 칸이 없으면 false. */
export function openScreenPath(path: string): boolean {
  if (!opener) return false;
  opener.open(path);
  return true;
}

/**
 * 답변의 링크 하나 — 이 미리보기의 화면이면 칸을 옮기고 true, 아니면 false
 * (부르는 쪽이 원래 길로 연다). 클릭 핸들러 안에서 동기로 답한다.
 */
export function openScreenLink(href: string): boolean {
  if (!opener) return false;
  const path = previewPathOf(href, opener.previewUrl);
  if (path === null) return false;
  opener.open(path);
  return true;
}
