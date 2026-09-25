import type { ProjectSummary, RepoStatus } from "@colo-design/protocol";
import type { RefObject } from "react";
import { openLink } from "../../lib/open-link";
import { L } from "../labels";
import type { Journey } from "../lib/journey";
import { ledgerLine } from "../lib/submit-copy";
import { commentRows, cycleStart, outgoingScreens } from "../lib/work-ledger";
import { Popover } from "../ui/Popover";
import {
  ClockIcon,
  dayText,
  ExtIcon,
  FixingIcon,
  MailIcon,
  ScreenRow,
  SentIcon,
  whenText,
} from "./parts";
import type { WorkLedger } from "./use-work-ledger";

/** Stage 3 의 작업 기록 서랍이 듣는 신호 — 서랍은 미리보기 칸의 것이다. */
export const HISTORY_OPEN_EVENT = "nx:history:open";

/**
 * `이번 작업`(PLAN-UI U2) — 여정을 누르면 뜬다. 옛 셸의 상태 칩 팝오버 ·
 * 변경 목록 · 영수증 카드 · 개발자 코멘트 창이 여기 한 장으로 모인다:
 * 바뀐 화면(제목 · 그 말 · 시각) · 제출(시각 · 작성자 · 받은 개발자 · 제출한
 * 내용 · 제출 기록 세 줄) · 개발자 코멘트(사람 · 글 · 반영 상태) · `작업 기록 열기`.
 */
export function WorkPopover({
  anchor,
  journey,
  project,
  repo,
  ledger,
  author,
  since,
  onClose,
}: {
  anchor: RefObject<HTMLElement | null>;
  journey: Journey;
  project: ProjectSummary | null;
  repo: RepoStatus | null;
  ledger: WorkLedger;
  /** 요청에 적히는 작성자 이름(`DaemonStatus.authorName`). */
  author: string | null;
  /** 마지막 제출의 시각(`submitCopy.lastAt`). */
  since: string | null;
  onClose: () => void;
}) {
  const { cycle } = journey;
  const where =
    cycle === "draft" ? L.work.subDraft : cycle === "review" ? L.work.subReview : L.work.subMerged;
  const start = dayText(cycleStart(repo?.cycleScreens, ledger.history));
  const name = project?.name ?? "";

  const screens = outgoingScreens(repo?.cycleScreens, null);
  const newSince =
    cycle === "review" && since ? outgoingScreens(repo?.cycleScreens, since).length : 0;

  // 이번 사이클의 요청 — 반영 뒤 새로 쌓인 작업(draft)은 아직 보내지 않은 것이다.
  const handoff = cycle !== "draft" ? (repo?.handoff ?? null) : null;
  const reviewers =
    handoff?.reviewers && handoff.reviewers.length > 0
      ? handoff.reviewers
      : (project?.reviewers ?? []);
  const log = [...(repo?.submit?.log ?? [])]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 3);
  // 제출 칸의 지금 한 줄(W1) — 도는 제출의 상태 문장 · 막힘의 이유. 쉬면 null.
  const submitLine = ledgerLine(repo?.submit, L);
  const submitBlocked = repo?.submit?.phase === "blocked";
  const comments =
    cycle === "draft"
      ? []
      : commentRows(ledger.reviews, ledger.history, {
          merged: cycle === "merged",
          reflectionPrefix: L.work.reflectionPrefix,
        });

  return (
    <Popover anchor={anchor} onClose={onClose} align="end" className="nx-work-pop">
      <div className="nx-wp-h">
        <b>{L.work.title}</b>
        <div>{L.work.headerSub(name, start, where)}</div>
      </div>
      <div className={`nx-wp-journey nx-cycle--${cycle}`}>
        {journey.points.map((point) => (
          <div key={point.label} className={`nx-wp-step nx-wp-step--${point.state}`}>
            {point.label}
          </div>
        ))}
      </div>

      <div className="nx-wp-sec">
        <h5>
          {screens.length > 0 ? L.work.changedCount(screens.length) : L.work.changed}
          {newSince > 0 && <span className="nx-wp-hr">{L.work.changedSince(newSince)}</span>}
        </h5>
        {screens.length > 0 ? (
          screens.map((screen) => <ScreenRow key={screen.route} screen={screen} />)
        ) : (
          <div className="nx-wp-empty">
            {cycle === "merged" ? L.work.changedEmptyMerged : L.work.changedEmpty}
          </div>
        )}
      </div>

      <div className="nx-wp-sec">
        <h5>{L.work.submitHeading}</h5>
        {handoff ? (
          <>
            <div className="nx-wp-receipt">
              <span>
                <SentIcon />
                {L.work.submittedBy(whenText(ledger.handedAt ?? since), author)}
              </span>
              <button
                type="button"
                className="nx-btn nx-btn--sm"
                onClick={() => openLink(handoff.url)}
              >
                {L.vocab.openSubmitted}
                <ExtIcon />
              </button>
            </div>
            {reviewers.length > 0 && (
              <div className="nx-wp-empty nx-wp-gap">
                {L.work.receivedBy(reviewers.join(" · "))}
              </div>
            )}
          </>
        ) : submitLine ? (
          <div className={`nx-wp-empty${submitBlocked ? " nx-wp-icon" : ""}`}>
            {submitBlocked && <MailIcon />}
            {submitLine}
          </div>
        ) : (
          <div className="nx-wp-empty">{L.work.notSubmitted}</div>
        )}
        {log.length > 0 && (
          <div className="nx-slog">
            {log.map((line) => (
              <div key={`${line.at}${line.text}`}>
                <small>{whenText(line.at)}</small>
                <span>{line.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="nx-wp-sec">
        <h5>
          {comments.length > 0 ? L.work.commentsCount(comments.length) : L.work.comments}
          {comments.length > 0 && <span className="nx-wp-hr">{L.work.commentsAuto}</span>}
        </h5>
        {comments.length > 0 ? (
          comments.map((comment) => (
            <div key={comment.id} className="nx-wp-row" title={whenText(comment.at)}>
              <span className="nx-avt" aria-hidden="true">
                {comment.author.trim().slice(0, 1) || "?"}
              </span>
              <span className="nx-wp-t nx-wp-c">
                <b>{comment.author.trim() || L.work.commentAuthor}</b>
                {comment.text}
              </span>
              <span className={`nx-wp-r nx-wp-state nx-wp-state--${comment.state}`}>
                {comment.state === "done" ? <SentIcon /> : <FixingIcon />}
                {comment.state === "done" ? L.work.commentDone : L.work.commentFixing}
              </span>
            </div>
          ))
        ) : (
          <div className="nx-wp-empty">
            {cycle === "draft" ? L.work.commentsEmptyDraft : L.work.commentsEmpty}
          </div>
        )}
      </div>

      <div className="nx-wp-foot">
        <button
          type="button"
          className="nx-btn nx-btn--sm"
          onClick={() => {
            onClose();
            window.dispatchEvent(new CustomEvent(HISTORY_OPEN_EVENT));
          }}
        >
          <ClockIcon />
          {L.work.openHistory}
        </button>
      </div>
    </Popover>
  );
}
