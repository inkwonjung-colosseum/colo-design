/**
 * 사람 메시지: 개발자의 검토 결과가 대화 안의
 * 메시지로 도착한다. 본문 버블 아래 코멘트 인용 행(`.cmt`)이 번호로 늘어선다 —
 * 반려조차 새 화면이 아니라 이 메시지 하나(+ 진행 한 줄)로 표현된다. 고치기
 * 턴은 데몬이 스스로 내려놓는다(슬라이스 2): 이 카드는 읽는 자리다.
 * 코멘트 ↔ 핀 매핑은 아직 없다: 인용 행은 핀 없이, 라벨은 화면 제목이
 * 있을 때만(없으면 라벨 없이) 렌더한다 — 파일 경로(path:line)는 개발자의
 * 어휘라 뺐다(PLAN 단계 10).
 */
export interface HumanMessageQuote {
  id: number;
  /** 화면 제목 — 매핑이 없는 코멘트는 빈 문자열(라벨 없이 렌더). */
  label: string;
  body: string;
}

export interface HumanMessageProps {
  /** 아바타 이니셜 — 이름의 첫 글자. */
  authorInitial: string;
  author: string;
  org: string;
  /** 미리 포맷된 시각 문자열("어제 오후 6:40" · "방금") — 날짜 구분은 호출부(day 구분선)의 몫. */
  time: string;
  body: string;
  quotes?: HumanMessageQuote[];
  /**
   * 답하기: 컴포저를 답장 모드로
   * 연다 — 보내는 길은 호출부(ChatColumn)가 `replyToReview` 로 잇는다.
   * 없으면 그리지 않는다(과거 재생 테이프 등).
   */
  onReply?: () => void;
  /**
   * 인용 행이 둘 이상일 때만 호출부가 내린다 — 코멘트 전부를 한 턴으로
   * 묶어 보내는 `모두 고치기`. 하나짜리 메시지에선 행 자체가 없다.
   */
  onFixAll?: () => void;
  /** 방금 도착 — live dot 을 곁들인다. */
  live?: boolean;
  /** 반려 등, 본문이 나쁜 소식을 전할 때. */
  danger?: boolean;
  flash?: boolean;
}

export function HumanMessage({
  authorInitial,
  author,
  org,
  time,
  body,
  quotes = [],
  onReply,
  live,
  danger,
  flash,
}: HumanMessageProps) {
  return (
    <div className={`devmsg${flash ? " flash" : ""}`}>
      <span className="devmsg__ava">{authorInitial}</span>
      <div className="devmsg__body">
        <div className="devmsg__who">
          <b>{author}</b> · {org} · {time}
          {live && <span className="dot dot--live" />}
        </div>
        <div className={`devmsg__text${danger ? " devmsg__text--danger" : ""}`}>{body}</div>
        {/* 행은 읽는 자리 — 고치기 턴은 데몬이 스스로 낸다(슬라이스 2).
            라벨은 화면 제목이 있을 때만(단계 10): 없으면 말몸통이 곧 행이다. */}
        {quotes.map((quote, index) => (
          <div key={quote.id} className="cmt">
            <span className="cmt__n">{index + 1}</span>
            <span className="cmt__tx">
              {quote.label ? (
                <>
                  <b>{quote.label}</b> — {quote.body}
                </>
              ) : (
                quote.body
              )}
            </span>
          </div>
        ))}
        {onReply && (
          <div className="devmsg__acts">
            <button type="button" className="devmsg__reply" onClick={onReply}>
              {author}님에게 답하기
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
