import { type DeveloperReview, readTurn } from "@colo-design/protocol";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import type { Block } from "../../lib/daemon-client";
import { blockOnTape, mergeThinking } from "../../lib/tape-visibility";
import { lastAnswerPerTurn, turnAnswerText, turnBlockNumbers } from "../../lib/turn-numbering";
import { CopyButton } from "../CopyButton";
import { Markdown } from "../Markdown";
import { Tip } from "../shell/Tip";
import { ActivitySummary, groupActivity } from "./activity";
import { ThinkingBlock, ToolBlock } from "./blocks";
import { HumanMessage, type HumanMessageQuote } from "./HumanMessage";
import { MilestoneRow } from "./MilestoneRow";
import { clockTime, dayKey, dayLabel } from "./shared";
import { TodoCard } from "./todo";
import { FailedTurn, isLastFailedTurn, lastUserText, MachineTurn, TurnDone } from "./turn";

/**
 * The CLI's own housekeeping lines. They arrive dressed as ordinary user or
 * assistant blocks, but they are the tape talking, not a person — a stopped
 * request, a turn that needed no answer. They render as quiet system lines
 * in the app's one voice instead of posing as somebody's words.
 */

const TAPE_LINES: Record<string, string> = {
  "[Request interrupted by user]": "요청을 중단했습니다",
  "No response requested.": "응답이 필요 없는 차례였습니다",
};

/** 붙여넣기가 길어지면 기둥을 통째로 먹는다 — 코드 블록의 접힘(420px)과 같은
    계약을 사람의 말에도: 잘림 판정은 CSS max-height와 같은 숫자로 하고,
    펼친 뒤에도 scrollHeight로 재어 토글이 살아 있게 한다. */
const BUBBLE_FOLD_PX = 240;

function UserBubbleText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [tall, setTall] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setTall(el.scrollHeight > BUBBLE_FOLD_PX);
  }, [text]);
  return (
    <>
      <div ref={ref} className={open ? "bubble__text" : "bubble__text bubble__text--folded"}>
        {text}
      </div>
      {tall && (
        <button
          type="button"
          className="bubble__act bubble__fold"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "접기" : "전체 보기"}
        </button>
      )}
    </>
  );
}

/**
 * 데몬이 테이프에 내려놓는 알림 한 줄. 데몬은 한국어 한 줄을 앞에 세우고,
 * 빈 줄 뒤에 원문(영어 오류 · 전송 상세)을 붙여 보낸다 — 실패 카드와 같은
 * 판정으로, 원문은 한 번 접힌 `자세히` 뒤에 산다. 사람이 읽을 것은 앞의
 * 한 줄이고, 원문은 막힌 턴을 들여다볼 때의 재료다.
 */
function NoticeLine({ block }: { block: Extract<Block, { type: "notice" }> }) {
  const [open, setOpen] = useState(false);
  const cut = block.text.search(/\n[ \t]*\n/);
  const lead = cut === -1 ? block.text : block.text.slice(0, cut).trim();
  const detail = cut === -1 ? "" : block.text.slice(cut).trim();
  return (
    <div
      className={`notice notice--${block.level}${block.subtype === "compact" ? " notice--compact" : ""}`}
    >
      <span className="notice__text">{lead}</span>
      {detail !== "" && (
        <button
          type="button"
          className="machine__more notice__more"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "접기" : "자세히"}
        </button>
      )}
      {open && detail !== "" && <pre className="machine__body notice__detail">{detail}</pre>}
    </div>
  );
}

export function Transcript({
  blocks,
  live = true,
  onRetry,
  onBranch,
  onResendEdit,
  showThinking = false,
  showTools = false,
  onBackgroundTask,
  onStopTask,
  onOpenHistory,
  onReplyReview,
  onDevReply,
  onOpenScreen,
}: {
  blocks: Block[];
  /**
   * 핀 카드의 행 → 그 핀이 찍혔던 화면으로 미리보기를 옮긴다(화면 id).
   * 없으면 행은 읽는 자리로 그친다 — 미리보기가 없는 자리(홈 인박스).
   */
  onOpenScreen?: (screen: string) => void;
  live?: boolean;
  /** Offered on a failed turn's card: send the same words again. */
  onRetry?: (text: string) => void;
  /**
   * 여기서 새 대화(분기): keep this answer and everything before it as the
   * memory of a NEW conversation. The k is this transcript's answer order.
   */
  onBranch?: (turn: number) => void;
  /** 고쳐서 다시 보내기: the planner's words return to the composer. */
  onResendEdit?: (text: string) => void;
  /**
   * 생각 과정 보기 (설정의 스위치). 꺼져 있으면 생각 블록은 접힌 채로도
   * 남지 않고 테이프에서 아예 빠진다 — 사용자가 읽는 것은 답이지 답을
   * 만드는 동안의 속말이 아니다. 기본은 꺼짐이다.
   */
  showThinking?: boolean;
  /**
   * 작업 과정 보기 (설정의 스위치). 꺼져 있으면 도구 호출 묶음(활동 카드)도
   * 테이프에서 빠진다 — 생각 과정과 같은 이유다. 계획 카드와 캡처 카드는
   * 남는다: 그 둘은 작업의 기록이 아니라 읽을 내용이다.
   * 판정은 tape-visibility 의 한 규칙이 내리고, 첫 초 줄도 같은 규칙을 묻는다.
   */
  showTools?: boolean;
  /**
   * 작업 다루기: 뒤로 보내기 · 이 작업만 중지. 도구 행이 그 버튼을
   * 그리고, 누른 결과는 이 콜백으로 나간다 — 테이프는 상태를 만들지 않는다.
   */
  onBackgroundTask?: (toolUseId: string) => void;
  onStopTask?: (taskId: string) => void;
  /**
   * 사람 메시지의 `답하기` — 컴포저를 답장 모드로 연다.
   * 보내는 길(`api.replyToReview`)은 ChatColumn 이 쥔다.
   */
  onReplyReview?: (review: DeveloperReview) => void;
  /**
   * 리뷰 카드의 답하기 — 카드 안 한 줄로 개발자에게 간다(E3). 보내는 길
   * (`api.replyToReview`)은 ChatColumn 이 쥔다.
   */
  onDevReply?: (reviewId: number, text: string) => Promise<void>;
  /**
   * 작업 기록을 여는 손 — P2-2 의 `작업 기록에서 되돌리기` 가 부른다. 없으면
   * 링크도 없다(홈 인박스처럼 드로어가 없는 자리).
   */
  onOpenHistory?: () => void;
}) {
  if (blocks.length === 0) {
    return (
      <div className="empty">
        <p className="empty__lead">메시지를 보내면 대화가 여기에 이어집니다.</p>
        <p className="empty__sub">
          만들고 싶은 화면을 말해 보세요. 미리보기에 핀을 찍어 고쳐 달라고 해도 이 대화로
          들어옵니다.
        </p>
      </div>
    );
  }
  // A reloaded history replays its events without a guarantee that the last
  // turn's end marker is in the tape, so a finished session's trailing fold
  // would keep claiming to think. Not live → nothing is thinking.
  // A todo card folds the same way: a turn-end block is what ends
  // its turn, so every write seen before one is over; not live folds all.
  const endedTodos = new Set<string>();
  let todosSoFar: string[] = [];
  for (const block of blocks) {
    if (block.type === "tool" && block.name === "TodoWrite") todosSoFar.push(block.id);
    else if (block.type === "turn") {
      for (const id of todosSoFar) endedTodos.add(id);
      todosSoFar = [];
    }
  }
  // 분기의 턴 번호는 데몬의 정의를 따른다: k 번째 **프롬프트**
  // (기계 턴 포함 — 세션이 보낸 말이면 전부). 답의 턴은 그 답을 낸 프롬프트의
  // 순번이다. text 블록을 세던 옛 셈은 도구만 돈 턴을 잃고 한 턴에 답이 둘이면
  // 넘쳤다 — 누른 답과 돌아가는 새 대화의 자리가 어긋나던 것은 그 셈의 탓이다.
  const lastAnswers = lastAnswerPerTurn(blocks);
  const turnNumbers = turnBlockNumbers(blocks);
  const turnAnswers = turnAnswerText(blocks);
  // 생각 · 작업 과정이 꺼져 있으면 groupActivity 보다 **먼저** 걸러낸다:
  // 묶기까지 마치고 나서 지우면 생각이나 도구만 있던 구간이 아무것도 담지
  // 않은 활동 막대로 남는다. 턴 번호의 셈(answerTurns · totalTurns)은
  // 프롬프트와 답만 세므로 이 거르기와 무관하다 — 되감기가 가리키는 답은
  // 그대로다. 판정 규칙 하나는 tape-visibility 이다.
  // 이웃한 생각 조각은 한 생각으로 잇는다(mergeThinking): 도구 행이 빠진 자리
  // 에서 한 턴의 생각이 접힌 줄 여럿으로 쌓이면 대화가 생각의 벽으로 열린다.
  const tape = mergeThinking(blocks.filter((block) => blockOnTape(block, showThinking, showTools)));
  const rows = groupActivity(
    live
      ? tape
      : tape.map((block) =>
          block.type === "thinking" && block.streaming ? { ...block, streaming: false } : block,
        ),
  );
  return (
    <div className="transcript">
      {(() => {
        /**
         * 그 행이 스스로 아는 시각 (ms) — 대화 블록은 시각을 싣지 않으므로
         * 저장 · 넘김 · 개발자 메시지 · 도구 시작의 시각만이 날짜 맥락을
         * 바꾼다. 시각 없는 행은 null 로 직전 날짜를 잇는다.
         */
        const stampOf = (row: (typeof rows)[number]): number | null => {
          const at = (iso: string) => {
            const ms = Date.parse(iso);
            return Number.isNaN(ms) ? null : ms;
          };
          if (row.kind === "activity") {
            for (const step of row.steps) {
              if (step.type === "tool" && step.startedAt != null) return step.startedAt;
            }
            return null;
          }
          const block = row.block;
          if (block.type === "save" || block.type === "milestone" || block.type === "saveBlocked")
            return at(block.at);
          if (block.type === "human") return at(block.reviews[0]?.at ?? "");
          if (block.type === "tool") return block.startedAt ?? null;
          return null;
        };
        // day 구분선(P7): 마지막으로 본 날짜와 다른 시각을 가진 행 앞에 선다.
        // 시각을 아는 행이 하나도 없는 테이프엔 구분선이 없다.
        let lastDay: number | null = null;
        return rows.map((row) => {
          const stamp = stampOf(row);
          const key = stamp === null ? null : dayKey(stamp);
          const divider = key !== null && key !== lastDay;
          if (key !== null) lastDay = key;
          const content = (() => {
            if (row.kind === "activity")
              return (
                <ActivitySummary
                  key={row.id}
                  steps={row.steps}
                  controls={{ onBackgroundTask, onStopTask }}
                />
              );
            if (row.kind === "todo") {
              const ended = !live || endedTodos.has(row.block.id);
              // 라이브 턴의 할 일은 WorkStrip 이 대표한다 — 같은 목차를
              // 테이프가 또 그리는 것은 소음이다. 끝난 턴의 것만 한 줄로
              // 테이프에 남는다.
              if (!ended) return null;
              return <TodoCard key={row.id} block={row.block} />;
            }
            const block = row.block;
            switch (block.type) {
              case "user": {
                // Only the planner's own side carries markers: this app writes
                // them, the agent does not. Reading them off assistant text would let
                // a quoted marker in an answer render as a second card.
                const { marker, body } = readTurn(block.text);
                if (marker)
                  return (
                    <MachineTurn
                      key={block.id}
                      marker={marker}
                      body={body}
                      thumbs={block.thumbs}
                      onOpenItem={onOpenScreen}
                      onDevReply={onDevReply}
                    />
                  );
                const halted = TAPE_LINES[block.text.trim()];
                if (halted)
                  return (
                    <p key={block.id} className="sysline">
                      {halted}
                    </p>
                  );
                return (
                  <div key={block.id} className="bubble bubble--user">
                    <UserBubbleText text={block.text} />
                    {block.images > 0 && <span className="tag">이미지 {block.images}장</span>}
                    {block.files?.map((name) => (
                      <span key={name} className="tag">
                        {name}
                      </span>
                    ))}
                    {block.text.trim() !== "" && (
                      <div className="bubble__actions">
                        {/* 요청 복사: the planner's own sentence is as worth
                            keeping as the answer to it — the same word, on the
                            turn that asked. */}
                        <CopyButton
                          value={block.text}
                          label="요청 복사"
                          icon={null}
                          className="bubble__act"
                        />
                        {onResendEdit && (
                          // 채팅 앱의 편집은 그 자리에서 대화를 갈라 옛 답을
                          // 바꾼다. 여기서는 말이 입력창으로 돌아오고, 보내면
                          // 대화 끝에 새 요청으로 이어진다 — 화면 파일은
                          // 되돌아가지 않으므로 그것이 맞다. 이름과 안내가 그
                          // 차이를 누르기 전에 말한다(갈라지기는 정산 줄의 몫).
                          <Tip label="입력창으로 돌아와요 — 보내면 이 대화에 새 요청으로 이어져요">
                            <button
                              type="button"
                              className="bubble__act"
                              onClick={() => onResendEdit(block.text)}
                            >
                              고쳐서 다시 요청
                            </button>
                          </Tip>
                        )}
                      </div>
                    )}
                  </div>
                );
              }
              case "text": {
                const tape = TAPE_LINES[block.text.trim()];
                if (tape)
                  return (
                    <p key={block.id} className="sysline">
                      {tape}
                    </p>
                  );
                return (
                  <div key={block.id}>
                    <div className="bubble bubble--assistant">
                      <Markdown text={block.text} />
                      {block.streaming && <span className="caret" />}
                    </div>
                  </div>
                );
              }
              case "thinking":
                return <ThinkingBlock key={block.id} block={block} />;
              case "tool":
                return (
                  <ToolBlock
                    key={block.id}
                    block={block}
                    onBackgroundTask={onBackgroundTask}
                    onStopTask={onStopTask}
                  />
                );
              case "turn": {
                if (block.isError || (block.subtype !== "" && block.subtype !== "success")) {
                  return (
                    <FailedTurn
                      key={block.id}
                      subtype={block.subtype}
                      resultText={block.resultText}
                      retryText={isLastFailedTurn(blocks, block) ? lastUserText(blocks) : null}
                      escalated={block.escalated}
                      onRetry={onRetry}
                      onResendEdit={onResendEdit}
                      live={live}
                    />
                  );
                }
                // 분기의 번호는 답의 셈(turnBlockNumbers)을 그대로 산다 —
                // 어긋나면 새 대화가 엉뚱한 답까지의 기억을 이어받는다.
                const turnNo = turnNumbers.get(block.id) ?? 1;
                const answered = lastAnswers.get(turnNo) !== undefined;
                // 전체 복사는 시간과 자리를 같이하지만 같은 조건이 아니다 —
                // 시간을 못 남긴 턴(오래된 대화록, usage 를 안 실는
                // 프로바이더)의 답도 복사로는 건져 간다. 답이 흐른 조각 없이
                // 결과만 온 턴의 말은 resultText 가 대신 든다.
                const whole = turnAnswers.get(block.id) ?? block.resultText ?? undefined;
                // 분기는 프롬프트 순번을 자르므로 답의 조각 유무를 묻지 않는다
                // — 결과만 온 턴도 "이 답까지"의 지점이 된다.
                const canBranch = (answered || whole != null) && onBranch != null;
                if (!canBranch && block.durationMs == null && whole == null) return null;
                return (
                  <TurnDone
                    key={block.id}
                    durationMs={block.durationMs}
                    whole={whole}
                    branch={
                      canBranch && onBranch
                        ? { live, onBranch: () => onBranch(turnNo), onOpenHistory }
                        : undefined
                    }
                  />
                );
              }
              case "notice":
                return <NoticeLine key={block.id} block={block} />;
              case "save":
                // P2-1: 저장은 사람이 누른 순간이 아니라 턴의 끝마다 도구가
                // 하는 일이 됐다 — 매 턴 카드가 뜨면 테이프가 도구의 잔일로
                // 덮인다. 남기는 것은 조용한 표식 한 글자: 무엇이 보관됐는지는
                // 마우스를 올릴 때만 말하고, 되돌리기는 작업 기록의 몫이다.
                return (
                  <div className="savemark" key={block.id}>
                    <Tip label={`${clockTime(block.at)} · 바뀐 파일 ${block.files.length}개`}>
                      <span className="savemark__dot" role="img" aria-label="여기까지 보관했습니다">
                        ✓
                      </span>
                    </Tip>
                  </div>
                );
              case "saveBlocked":
                // 제출이 저장할 것이 없어 멈춘 자리 — AI 의 과제가 아니라 사람
                // 안내의 문제라 게이트 카드가 없다. 연대기의 붉은 한 줄이
                // 흔적의 전부다(배너는 리로드와 함께 사라진다).
                return (
                  <MilestoneRow
                    key={block.id}
                    tone="danger"
                    text={block.detail}
                    time={clockTime(block.at)}
                  />
                );
              case "milestone":
                return block.subtype === "merged" ? (
                  <MilestoneRow
                    key={block.id}
                    tone="ok"
                    text="이번 작업이 제품에 합쳐졌어요"
                    time={clockTime(block.at)}
                  />
                ) : block.subtype === "closed" ? (
                  <MilestoneRow
                    key={block.id}
                    tone="danger"
                    text="개발자가 이번 요청을 닫았어요 — 작업은 새 요청으로 옮겨 두었어요"
                    time={clockTime(block.at)}
                  />
                ) : (
                  <MilestoneRow
                    key={block.id}
                    tone="send"
                    text={
                      block.reviewer
                        ? `${block.reviewer}님께 넘겼어요 — 확인 요청`
                        : "넘겼어요 — 확인 요청"
                    }
                    time={clockTime(block.at)}
                  />
                );
              case "human": {
                const [header] = block.reviews;
                if (!header) return null;
                // 리뷰 본문(kind: "review")이 devmsg__text, 인라인 코멘트가 인용
                // 행 — 핀 매핑이 없으니 라벨은 코드 위치뿐이다.
                const reviewBody = block.reviews.find((r) => r.kind === "review");
                const inline = block.reviews.filter((r) => r.kind === "inline");
                const quotes: HumanMessageQuote[] = inline.map((review) => ({
                  id: review.id,
                  label: review.path
                    ? `${review.path}${review.line ? `:${review.line}` : ""}`
                    : "코드 위치",
                  body: review.body,
                }));
                return (
                  <HumanMessage
                    key={block.id}
                    authorInitial={header.author.trim().slice(0, 1) || "?"}
                    author={header.author}
                    org="개발팀"
                    time={clockTime(header.at)}
                    body={reviewBody ? reviewBody.body : "코멘트를 남겼어요"}
                    quotes={quotes}
                    onReply={onReplyReview ? () => onReplyReview(header) : undefined}
                  />
                );
              }
              default:
                return null;
            }
          })();
          if (!divider && content === null) return null;
          return (
            <Fragment key={row.kind === "block" ? row.block.id : row.id}>
              {divider && stamp !== null && (
                <div className="day" role="separator">
                  {dayLabel(stamp)}
                </div>
              )}
              {content}
            </Fragment>
          );
        });
      })()}
    </div>
  );
}
