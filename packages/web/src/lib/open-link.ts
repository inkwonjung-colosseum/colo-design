/**
 * settings.ts 의 KEY 와 같은 자리 — 이 모듈은 node --test 가 그대로 읽을
 * 수 있게(import 없는 leaf) 둔다. 키를 바꾸면 함께 바꾼다.
 */
const SETTINGS_KEY = "colo-design.settings";

/**
 * 링크 클릭이 묻는 즉시의 값 — React state 는 렌더를 거쳐야 최신이 되므로
 * 클릭 핸들러는 저장소를 직접 읽는다 (settings.ts 의 currentNoticePrefs 와
 * 같은 이유).
 */
function prefersInAppLinks(): boolean {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as unknown;
    return (
      Boolean(raw) &&
      typeof raw === "object" &&
      (raw as Record<string, unknown>).openLinksInApp === true
    );
  } catch {
    return false;
  }
}

/**
 * 링크 하나의 행선지 — 설정 `앱에서 링크 열기`가 켜져 있고 데스크톱의
 * 미리보기 칸이 있으면 칸의 페이지가 그 자리에서 열고, 아니면 OS 브라우저가
 * 연다. 칸에 자리가 없을 때(미리보기가 안 떠 있을 때)는 데스크톱 쪽이
 * 스스로 OS 브라우저로 물러난다.
 */
export function openLink(url: string): void {
  const preview = window.coloDesignDesktop?.preview;
  if (prefersInAppLinks() && preview?.openExternal) {
    void preview.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}

/**
 * <a target="_blank"> 의 onClick: 앱에서 열 때만 기본 동작을 막는다 —
 * 꺼져 있거나 데스크톱이 아니면 브라우저의 평소 길(window.open → OS)을
 * 그대로 탄다. 수식 키 클릭(새 창 의도)과 http(s) 가 아닌 href 도 건드리지
 * 않는다.
 */
export function linkClick(event: React.MouseEvent<HTMLAnchorElement>): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  const href = event.currentTarget.getAttribute("href") ?? "";
  if (!/^https?:\/\//i.test(href)) return;
  if (!prefersInAppLinks()) return;
  const openExternal = window.coloDesignDesktop?.preview?.openExternal;
  if (!openExternal) return;
  event.preventDefault();
  void openExternal(href);
}
