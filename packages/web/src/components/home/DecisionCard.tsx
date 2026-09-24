import type { RepoStatus } from "@colo-design/protocol";
import { useState } from "react";
import { timeAgo } from "../../lib/format";
import type { AskingItem } from "../../lib/home-feed";
import { composing } from "../../lib/ime";
import { bashHeadline, objectParticle, toolLabel } from "../../lib/labels";
import { toolHeadline } from "../transcript/shared";

/** The commands the clone resolved to, as RepoStatus carries them. */
type RepoCommands = NonNullable<RepoStatus["commands"]>;

/**
 * 나를 기다리는 일의 카드 한 장. 세 변형을 갖는다 — 질문형(인용 + 즉답 칩),
 * 권한형(헤드라인 + 허용/거절), 코멘트형(인용 + "대화에서 보기"). 클릭 가능한
 * 영역은 "칩 이외"뿐이라, 칩이 있는 카드는 그 부분을 별도 `<button>`으로
 * 두고(중첩 버튼 금지) 나머지만 열기 버튼으로 감싼다.
 *
 * 칩 게이트 규칙 하나: 레포에 무언가를 시키는 손(즉답·허용·거절·열기)은
 * 전부 repoReady 로 잠근다 — "대화 열기"도 작업대 전환(프로젝트 활성화)을
 * 부르는 손이므로 같은 몫이다. 순수 UI 상태(되돌리기·입력)만 막지 않는다.
 */
export function DecisionCard({
  item,
  repoReady,
  commands,
  onOpenThread,
  onQuickPick,
  onRespondPermission,
}: {
  item: AskingItem;
  /** 레포가 아직 준비되지 않으면 열기를 막고 배지로 알린다. */
  repoReady: boolean;
  commands?: RepoCommands;
  onOpenThread: () => void;
  /** 즉답 칩 하나를 눌렀을 때 — question 변형에서만 쓰인다. */
  onQuickPick: (label: string) => void;
  onRespondPermission: (decision: "allow" | "allowAlways" | "deny", message?: string) => void;
}) {
  if (item.kind === "question") {
    return (
      <QuestionDecisionCard
        item={item}
        repoReady={repoReady}
        onOpenThread={onOpenThread}
        onQuickPick={onQuickPick}
      />
    );
  }
  if (item.kind === "permission") {
    return (
      <PermissionDecisionCard
        item={item}
        repoReady={repoReady}
        commands={commands}
        onOpenThread={onOpenThread}
        onRespond={onRespondPermission}
      />
    );
  }
  return <ReviewDecisionCard item={item} repoReady={repoReady} onOpenThread={onOpenThread} />;
}

function ReadyBadge({ repoReady }: { repoReady: boolean }) {
  if (repoReady) return null;
  return <span className="tag tag--warn">레포 준비 중</span>;
}

function QuestionDecisionCard({
  item,
  repoReady,
  onOpenThread,
  onQuickPick,
}: {
  item: Extract<AskingItem, { kind: "question" }>;
  repoReady: boolean;
  onOpenThread: () => void;
  onQuickPick: (label: string) => void;
}) {
  const multi = item.quote === null;
  return (
    <div className="home-card home-card--ask" role="alert">
      <div className="home-row">
        <span className="dot dot--ask" />
        <div className="home-body">
          <button
            type="button"
            className="home-hit"
            disabled={!repoReady}
            onClick={onOpenThread}
            aria-label={`${item.title} 대화 열기`}
          >
            <div className="home-top">
              <span className="home-name">{item.title}</span>
              {item.requestedAt !== undefined && (
                <span className="home-time">{timeAgo(item.requestedAt)}</span>
              )}
            </div>
            <div className="home-line">
              {multi
                ? `질문 ${item.questionCount}개가 기다리고 있어요.`
                : "계속하려면 하나만 골라주시면 대화를 이어갈게요."}
            </div>
            {item.quote && <div className="home-quote">“{item.quote}”</div>}
          </button>
          <div className="home-quick">
            {item.options.map((label) => (
              <button
                key={label}
                type="button"
                className="chip"
                disabled={!repoReady}
                onClick={() => onQuickPick(label)}
              >
                {label}
              </button>
            ))}
            <button type="button" className="chip" disabled={!repoReady} onClick={onOpenThread}>
              대화에서 답하기
            </button>
          </div>
          <ReadyBadge repoReady={repoReady} />
        </div>
      </div>
    </div>
  );
}

function PermissionDecisionCard({
  item,
  repoReady,
  commands,
  onOpenThread,
  onRespond,
}: {
  item: Extract<AskingItem, { kind: "permission" }>;
  repoReady: boolean;
  commands?: RepoCommands;
  onOpenThread: () => void;
  onRespond: (decision: "allow" | "allowAlways" | "deny", message?: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [showReason, setShowReason] = useState(false);
  const raw = toolHeadline(item.input);
  const headline = item.toolName === "Bash" ? bashHeadline(raw, commands) : raw;
  const action = toolLabel(item.toolName);
  const suggestion = item.suggestions[0];

  return (
    <div className="home-card home-card--ask" role="alert">
      <div className="home-row">
        <span className="dot dot--ask" />
        <div className="home-body">
          <button
            type="button"
            className="home-hit"
            disabled={!repoReady}
            onClick={onOpenThread}
            aria-label={`${item.title} 대화 열기`}
          >
            <div className="home-top">
              <span className="home-name">{item.title}</span>
              {item.requestedAt !== undefined && (
                <span className="home-time">{timeAgo(item.requestedAt)}</span>
              )}
            </div>
            <div className="home-line">
              <>
                <strong>{action}</strong>
                {objectParticle(action)} 허용할까요?
              </>
            </div>
            {headline && <div className="home-quote">{headline}</div>}
          </button>
          {showReason ? (
            <div className="home-quick home-quick--reason">
              <input
                autoFocus
                className="home-reason"
                value={reason}
                placeholder="왜 안 되는지 알려 주세요"
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => {
                  if (composing(e)) return;
                  if (e.key === "Enter") onRespond("deny", reason || undefined);
                }}
              />
              <button
                type="button"
                className="chip"
                disabled={!repoReady}
                onClick={() => onRespond("deny", reason || undefined)}
              >
                거절 보내기
              </button>
              <button type="button" className="chip" onClick={() => setShowReason(false)}>
                뒤로
              </button>
            </div>
          ) : (
            <div className="home-quick">
              <button
                type="button"
                className="chip"
                disabled={!repoReady}
                onClick={() => onRespond("allow")}
              >
                이번만 허용
              </button>
              <button
                type="button"
                className="chip"
                disabled={!repoReady || !suggestion}
                onClick={() => onRespond("allowAlways")}
              >
                {suggestion ? suggestion.label : "항상 허용"}
              </button>
              <button
                type="button"
                className="chip"
                disabled={!repoReady}
                onClick={() => setShowReason(true)}
              >
                거절…
              </button>
            </div>
          )}
          <ReadyBadge repoReady={repoReady} />
        </div>
      </div>
    </div>
  );
}

function ReviewDecisionCard({
  item,
  repoReady,
  onOpenThread,
}: {
  item: Extract<AskingItem, { kind: "review" }>;
  repoReady: boolean;
  onOpenThread: () => void;
}) {
  const first = item.reviews[0];
  if (!first) return null;
  return (
    <div className="home-card home-card--ask" role="alert">
      <div className="home-row">
        <span className="dot dot--ask" />
        <div className="home-body">
          <button
            type="button"
            className="home-hit"
            disabled={!repoReady}
            onClick={onOpenThread}
            aria-label={`${item.title} 대화 열기`}
          >
            <div className="home-top">
              <span className="home-name">{item.title}</span>
              <span className="home-time">{timeAgo(Date.parse(first.at))}</span>
            </div>
            <div className="home-line">
              {item.reviews.length > 1
                ? `${first.author} 님이 코멘트 ${item.reviews.length}개를 남겼어요.`
                : `${first.author} 님이 코멘트를 남겼어요.`}
            </div>
            {first && <div className="home-quote">“{first.body}”</div>}
          </button>
          <div className="home-foot">
            <span className="tag tag--warn">코멘트 도착</span>
            <button type="button" className="chip" disabled={!repoReady} onClick={onOpenThread}>
              대화에서 보기
            </button>
          </div>
          <ReadyBadge repoReady={repoReady} />
        </div>
      </div>
    </div>
  );
}
