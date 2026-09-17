/**
 * 홈이 기억하는 마지막 방문 — "N시간 만에 돌아오셨어요"의 근거. 데몬은
 * "이 사람이 언제 자리를 비웠다 돌아왔는지"를 모른다(그럴 이유도 없다) —
 * 이건 순전히 이 기기, 이 브라우저의 클라이언트 상태다.
 */
const KEY = "colo-design.home-last-seen";

/** 지금까지 알던 마지막 방문 시각(epoch ms). 첫 방문이면 null. */
export function readLastSeen(): number | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const at = Number(raw);
    return Number.isFinite(at) ? at : null;
  } catch {
    // 사적 모드 등에서 저장이 막혀도 배너는 그냥 "돌아왔다" 문구를 생략한다.
    return null;
  }
}

/**
 * 지금을 다음 방문의 기준점으로 적어 둔다. 홈이 마운트될 때 한 번만 부른다 —
 * 렌더마다 다시 쓰면 같은 방문 안에서도 기준이 앞으로 밀려 "0분 전"이 된다.
 */
export function markSeenNow(): void {
  try {
    localStorage.setItem(KEY, String(Date.now()));
  } catch {
    // 저장 실패는 치명적이지 않다 — 다음 방문에도 다시 시도한다.
  }
}
