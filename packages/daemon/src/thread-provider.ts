/**
 * 대화의 공급자를 가리는 순수 판정 — 대화의 AI 는 태어날 때 정해지고,
 * 다시 정해지지 않는다. 선로에는 공급자를 바꾸는 명령이 없고,
 * 되살리기(resurrectSession) · 시작 복구(recoverStartupTurns) · 분기
 * (session.branch) · 자동 대화(auto-thread)는 이미 세션이나 저장소의
 * 공급자를 쓴다. 남은 입구는 session.create 의 재개 머리 하나였다 — 요청이
 * provider 를 함께 실어 오면 저장된 주인을 이겨, 죽은 대화나 저장만 된
 * 대화를 다른 드라이버로 열 수 있었다. 이 판정이 그 문을 닫는다.
 *
 * 고르는 순서:
 *   1. 새 대화(resume 없음 또는 빈 문자열) — 요청된 공급자, 없으면
 *      claude (지금 동작).
 *   2. 재개하려는 id 의 주인 — 살아 있는 세션(죽은 몸 포함)이 먼저, 없으면
 *      대화록 저장소. 주인이 이미 정해져 있으니 고를 것이 없다.
 *      요청이 주인과 다른 공급자를 가리켜도 던지지 않는다 — 대화는 태어난
 *      AI 로 조용히 이어지고, 무시한 값은 ignored 로 돌려 호출자가 로그에
 *      남긴다. 화면 어디에도 잘못된 재개를 고칠 칸은 없으니, 대화 자체가
 *      흔들려서는 안 된다.
 *   3. 주인을 아무도 모르는 id — 요청된 공급자를 믿는다(저장소가 모르는
 *      id 의 지금 폴백). 요청마저 없으면 던진다: 짐작한 드라이버로 남의
 *      id 를 이어 받으면 대화가 깨진다.
 */
export function threadProvider(input: {
  /** 이어 들 대화 id — 없거나 빈 문자열이면 새 대화(선로의 min(1) 없음). */
  resume?: string;
  /** session.create 가 실어 온 provider. */
  requested?: string;
  /** 그 id 를 쥔 살아 있는 세션(죽은 몸 포함)의 provider. */
  live?: string;
  /** 대화록 저장소가 아는 그 id 의 provider. */
  stored?: string;
}): { provider: string; ignored?: string } {
  if (!input.resume) {
    return { provider: input.requested ?? "claude" };
  }
  const owner = input.live ?? input.stored;
  if (owner !== undefined) {
    return input.requested !== undefined && input.requested !== owner
      ? { provider: owner, ignored: input.requested }
      : { provider: owner };
  }
  if (input.requested !== undefined) {
    return { provider: input.requested };
  }
  throw new Error("이 대화를 저장한 에이전트를 찾지 못했습니다 — 목록에서 다시 열어 주세요.");
}
