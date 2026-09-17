/**
 * 사람 메시지 (docs/plan/chat.md §1.1 #7): 개발자의 검토 결과가 대화 안의
 * 메시지로 도착한다. 본문 버블 아래 코멘트 인용 행(`.cmt`)이 번호로 늘어서고,
 * 각 행의 `대화에서 고치기` 는 그 코멘트 하나만을 새 턴으로 내보낸다 — 반려조차
 * 새 화면이 아니라 이 메시지 하나(+ 진행 한 줄)로 표현된다(§5 엣지케이스 4).
 *
 * 코멘트 ↔ 핀 매핑은 아직 없다(§5 엣지케이스 5): 인용 행은 핀 없이,
 * 라벨은 코드 위치(path:line, 없으면 "코드 위치")로 렌더한다 — 화면 이름을
 * 지어내지 않는다.
 */
export interface HumanMessageQuote {
  id: number;
  /** 코드 위치(`path:line`) — 핀 매핑이 없는 1차 렌더의 라벨. */
  label: string;
  body: string;
  onFix?: () => void;
}

export interface HumanMessageProps {
  /** 아바타 이니셜 — 이름의 첫 글자. */
  authorInitial: string;
  author: string;
  org: string;
  /** 미리 포맷된 시각 문자열("어제 오후 6:40" · "방금") — 날짜 구분은 호출부(§1.1 day)의 몫. */
  time: string;
  body: string;
  quotes?: HumanMessageQuote[];
  /**
   * 답하기 (docs/plan/states.md §2.2 사람 메시지): 컴포저를 답장 모드로
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
  onFixAll,
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
        {/* 읽으려는 클릭이 곧 발사가 되면 안 된다 — 행은 읽는 자리,
            `대화에서 고치기` 버튼만 새 턴을 낸다. */}
        {quotes.map((quote, index) => (
          <div key={quote.id} className="cmt">
            <span className="cmt__n">{index + 1}</span>
            <span className="cmt__tx">
              <b>{quote.label}</b> — {quote.body}
            </span>
            {quote.onFix && (
              <button type="button" className="cmt__go" onClick={quote.onFix}>
                대화에서 고치기
              </button>
            )}
          </div>
        ))}
        {(onReply || onFixAll) && (
          <div className="devmsg__acts">
            {onReply && (
              <button type="button" className="devmsg__reply" onClick={onReply}>
                {author}님에게 답하기
              </button>
            )}
            {onFixAll && (
              <button type="button" className="devmsg__reply" onClick={onFixAll}>
                모두 고치기
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
