/**
 * 연결 코드(GitHub PAT)의 만료 미리보기 (PLAN-UI §10 U17) — GitHub 이 만료일이
 * 있는 코드의 모든 응답에 실어 보내는 `github-authentication-token-expiration`
 * 머리글(예: `2026-10-15 12:00:00 UTC`)을 읽는 순수 판정. 감시점은 이미 있다 —
 * 브리지(github-bridge.ts)의 전송 래퍼가 401 을 보는 그 자리에서 같이 읽으므로,
 * 2분 관찰의 첫 응답에서 추가 요청 없이 만료 시각을 안다.
 *
 * 실제 만료(401)는 지금의 `github:auth` 길 그대로다 — 이 판정은 예고일 뿐이고,
 * 문제 문장(상태 줄 아래 세 문장)은 늘리지 않는다. 사용자가 할 일이 없기 때문이다.
 */

import { BUDGETS } from "./budgets.js";

/** 머리글의 키 — 전송(github.ts)이 소문자로 내려 준다. */
const HEADER = "github-authentication-token-expiration";

/**
 * 응답 머리글에서 만료 시각 — GitHub 의 `YYYY-MM-DD HH:MM:SS UTC` 꼴과 ISO 꼴을
 * 받아 ISO 문자열을 내고, 머리글이 없거나 해석할 수 없으면 null. 시간대가 없는
 * 값은 UTC 로 본다(머리글의 값은 언제나 UTC 다). 만료일이 없는 코드는 머리글
 * 자체가 오지 않으므로 null 이 「만료 없음」의 정답이다.
 */
export function parseTokenExpiration(headers: Record<string, string> | undefined): string | null {
  const raw = headers?.[HEADER]?.trim();
  if (!raw) return null;
  // 시간대를 밝힌 값은 그대로, 밝히지 않은 값은 UTC 를 덧붙여 읽는다 — Date 는
  // 시간대 없는 `YYYY-MM-DD HH:MM:SS` 를 현지 시각으로 해석하므로 그대로 두면
  // 기계의 시간대마다 답이 달라진다.
  const zoned = /(?:Z|UTC|[+-]\d{1,2}:?\d{2})$/i.test(raw);
  const date = new Date(zoned ? raw : `${raw.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** 만료 판정 — 남은 날과 미리 알림 창 안인가. */
export interface TokenExpiryJudgement {
  /** 만료까지의 날 수(올림) — 반나절 남음은 1일. 지난 날짜는 0 아래. */
  daysLeft: number;
  /** 개발자에게 알릴 창(BUDGETS.tokenExpiry.warnBeforeMs) 안이고 아직 지나지 않았나. */
  warn: boolean;
}

/**
 * 만료 시각의 판정 — 창은 예산표의 `tokenExpiry.warnBeforeMs`(기본 14일).
 * 경계는 포함한다(꼭 14일 남음 = warn). 이미 지난 시각은 warn 이 아니다 —
 * 그때는 예고가 아니라 401 의 일이므로 `github:auth` 길이 맡는다.
 */
export function expiryJudgement(
  expiresAt: string | number | Date,
  now: number = Date.now(),
): TokenExpiryJudgement {
  const end = new Date(expiresAt).getTime();
  if (Number.isNaN(end)) return { daysLeft: 0, warn: false };
  const left = end - now;
  return {
    daysLeft: Math.ceil(left / 86_400_000),
    warn: left > 0 && left <= BUDGETS.tokenExpiry.warnBeforeMs,
  };
}

/** 만료 예고의 한 걸음 — 서버(noteTokenExpiry)는 이 판정을 부르기만 한다. */
export interface ExpiryNoticeStepInput {
  /** 지금 판정 — null 은 만료 예정이 사라졌다(새 자격의 시작을 포함). */
  judged: TokenExpiryJudgement | null;
  /** 지난번 실행이 알림을 보낸 슬러그(machine.json) — 재시작을 넘는 근거. */
  storedSlug: string | null;
  /** 알림의 대상 — 활성 프로젝트, 없으면 등록부의 첫 프로젝트. */
  activeSlug: string | null;
}

export interface ExpiryNoticeStep {
  /** 경고 창에 들어섰다 — 이 슬러그로 알린다. */
  raise?: string;
  /** 경고 창 밖으로 나갔다 — 이 슬러그로 거둔다. 저장된 슬러그가 없으면 없다. */
  resolve?: string;
}

/**
 * 예고의 한 걸음 — 알림을 보낸 슬러그는 machine.json 이 기억하므로 거둠이
 * 재시작을 넘는다: 알림은 오늘 나가고 새 초대 파일은 며칠 뒤 오는 것이 보통이라,
 * 메모리의 슬러그만으로는 이슈가 영원히 열려 있다. 경고 창 안에서의 다시 판정은
 * 다시 알릴 뿐(실제 쓰기는 알림의 창이 합친다) 거두지 않는다.
 */
export function expiryNoticeStep(input: ExpiryNoticeStepInput): ExpiryNoticeStep {
  if (input.judged?.warn === true) {
    return input.activeSlug === null ? {} : { raise: input.activeSlug };
  }
  return input.storedSlug === null ? {} : { resolve: input.storedSlug };
}
