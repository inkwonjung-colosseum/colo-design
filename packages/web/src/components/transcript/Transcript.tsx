import { type DeveloperReview, readTurn } from "@colo-design/protocol";
import { Fragment, useState } from "react";
import type { Block } from "../../lib/daemon-client";
import { GENERIC_STARTERS } from "../../lib/suggestions";
import { blockOnTape, mergeThinking } from "../../lib/tape-visibility";
import {
  lastAnswerPerTurn,
  promptTotal,
  turnAnswerText,
  turnBlockNumbers,
} from "../../lib/turn-numbering";
import { CopyButton } from "../CopyButton";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";
import { Markdown } from "../Markdown";
import { Tip } from "../shell/Tip";
import { ActivitySummary, groupActivity } from "./activity";
import { ThinkingBlock, ToolBlock } from "./blocks";
import { HumanMessage, type HumanMessageQuote } from "./HumanMessage";
import { MilestoneRow } from "./MilestoneRow";
import { SaveCard } from "./SaveCard";
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

export function Transcript({
  blocks,
  live = true,
  onRetry,
  onRewind,
  onResendEdit,
  onStarter,
  onStarterAttach,
  starters,
  checkpoints,
  onRestoreCheckpoint,
  showThinking = false,
  showTools = false,
  onBackgroundTask,
  onStopTask,
  onFixReview,
  saveCorridor,
  onReplyReview,
}: {
  blocks: Block[];
  live?: boolean;
  /** Offered on a failed turn's card: send the same words again. */
  onRetry?: (text: string) => void;
  /**
   * 다시 요청: discard the k-th answer — files and memory — and
   * receive it again. The k is this transcript's answer order.
   */
  onRewind?: (turn: number, text: string) => void;
  /** 고쳐서 다시 보내기: the planner's words return to the composer. */
  onResendEdit?: (text: string) => void;
  /** 첨부로 시작하기 — 컴포저의 파일 고르기를 연다. */
  onStarterAttach?: () => void;
  /** A starter chip was pressed — its sentence becomes the composer's draft. */
  onStarter?: (text: string) => void;
  /** 시작 칩의 문장들 — 선언 화면이 없으니 언제나 generic 문장(suggestions.ts). */
  starters?: string[];
  /** This session's turn-start snapshots, oldest first. */
  checkpoints?: Array<{ id: string; turn: number }>;
  /** Puts the worktree back the way it stood before that answer. */
  onRestoreCheckpoint?: (id: string) => void;
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
  /** 사람 메시지 인용 행의 `대화에서 고치기` — 그 코멘트들을 새 턴으로 낸다. */
  onFixReview?: (reviews: DeveloperReview[]) => void;
  /**
   * 사람 메시지의 `답하기` — 컴포저를 답장 모드로 연다.
   * 보내는 길(`api.replyToReview`)은 ChatColumn 이 쥔다.
   */
  onReplyReview?: (review: DeveloperReview) => void;
  /**
   * 게이트 사이의 복도(저장 카드의 나가는 길): 마지막 저장
   * 카드 밑에 `[개발자에게 넘기기로 이어가기]` 를 그린다. null 이면 넘길 수
   * 없는 자리(저장 전·이미 넘김·반영됨) — 판정은 호출부가 deriveDelivery 로
   * 내리고, 이 테이프는 그 결과만 믿는다.
   */
  saveCorridor?: { onHandoff: () => void } | null;
}) {
  // 되감기 확인 — k 가 마지막 답이 아니면 뒤의 답들도 함께 사라진다는
  // 말을 한 번 묻는다. 마지막 답이면 곧장. 훅은 빈 테이프 early return 보다
  // 위에 있어야 한다 — 순서가 render 마다 같아야 하니까.
  const [rewindAsk, setRewindAsk] = useState<{
    turn: number;
    text: string;
    after: number;
  } | null>(null);
  /** 접어 둔 복도 — `아직이요` 를 누른 저장 카드의 id. 창의 기억이다. */
  const [corridorDismissed, setCorridorDismissed] = useState<Set<string>>(new Set());
  // 복도는 사이클의 마지막 발자국에만 선다 — 지난 저장들의 카드는 기록이지
  // 길이가 아니다.
  const lastSaveId = blocks.filter((block) => block.type === "save").at(-1)?.id ?? null;
  if (blocks.length === 0) {
    return (
      <div className="empty">
        <p className="empty__lead">메시지를 내면 대화가 여기에 이어집니다.</p>
        <p className="empty__sub">
          만들고 싶은 화면을 말해 보세요. 미리보기에 핀을 찍어 고쳐 달라고 해도 이 대화로
          들어옵니다.
        </p>
        {onStarter && (
          <div className="empty__starters">
            {/* 첫 문장의 초대는 타이핑만이 아니라 첨부다 —
                "입력은 뭐든 된다"(README)를 빈 대화의 첫 동작으로 지킨다. 문장
                칩들보다 앞에 서되, 같은 어휘의 칩이다(메뉴가 아니라 문턱). */}
            {onStarterAttach && (
              <button
                type="button"
                className="empty__starter empty__starter--attach"
                onClick={onStarterAttach}
              >
                그림을 붙여 시작하기
              </button>
            )}
            {(starters ?? GENERIC_STARTERS).map((starter) => (
              <button
                key={starter}
                type="button"
                className="empty__starter"
                onClick={() => onStarter(starter)}
              >
                {starter}
              </button>
            ))}
          </div>
        )}
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
  // 되감기 · 체크포인트의 턴 번호는 데몬의 정의를 따른다: k 번째 **프롬프트**
  // (기계 턴 포함 — 세션이 보낸 말이면 전부). 답의 턴은 그 답을 낸 프롬프트의
  // 순번이다. text 블록을 세던 옛 셈은 도구만 돈 턴을 잃고 한 턴에 답이 둘이면
  // 넘쳤다 — 누른 답과 돌아가는 스냅샷이 어긋나던 것은 그 셈의 탓이다.
  const totalTurns = promptTotal(blocks);

  // 되돌리기 · 다시 요청은 턴 단위 행동이다 — 같은 턴의 답들이 가리키는
  // 체크포인트는 하나이므로 정산 줄(턴 끝) 하나에만 실린다. 턴이 낸 답의
  // 전문은 같은 줄의 전체 복사가 대신 들고 나간다.
  const lastAnswers = lastAnswerPerTurn(blocks);
  const turnNumbers = turnBlockNumbers(blocks);
  const turnAnswers = turnAnswerText(blocks);
  // 되감기가 되감을 턴의 원말 — 정산 줄 id → 그 턴을 연 사람의 문장.
  // lastUserText 는 테이프 끝의 가장 최근 말만 내놓으므로, 오래된 턴의
  // `다시 요청` 이 최신 말을 되감았다. 셈은 turnAnswerText 의 규칙을 그대로
  // 거꾸로 든다: 프롬프트(기계 턴 표식은 제외)가 그 턴의 답들보다 앞서므로
  // 정산 줄을 만날 때의 마지막 사람 말이 그 턴의 원말이다.
  const turnUserText = new Map<string, string>();
  {
    let current: string | null = null;
    for (const block of blocks) {
      if (block.type === "user") {
        const { marker } = readTurn(block.text);
        if (!marker) current = block.text;
      } else if (block.type === "turn" && current !== null) {
        turnUserText.set(block.id, current);
      }
    }
  }
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
  const askRewind = (turn: number, text: string) => {
    if (!onRewind) return;
    const after = totalTurns - turn;
    if (after > 0) setRewindAsk({ turn, text, after });
    else onRewind(turn, text);
  };
  return (
    <div className="transcript">
      {rewindAsk && onRewind && (
        <ConfirmDialog
          title="답 되감기"
          body={
            <>
              이 답을 버릴까요? <strong>이 답 이후의 답 {rewindAsk.after}개</strong>도 함께
              사라집니다.
            </>
          }
          hint="파일도 이 답 이전으로 돌아갑니다."
          confirmLabel="버리고 다시 받기"
          onConfirm={() => {
            onRewind(rewindAsk.turn, rewindAsk.text);
            setRewindAsk(null);
          }}
          onClose={() => setRewindAsk(null)}
        />
      )}
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
          if (block.type === "save" || block.type === "milestone") return at(block.at);
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
              return (
                <TodoCard
                  key={row.id}
                  block={row.block}
                  ended={!live || endedTodos.has(row.block.id)}
                />
              );
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
                    <MachineTurn key={block.id} marker={marker} body={body} thumbs={block.thumbs} />
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
                    {block.text}
                    {block.images > 0 && <span className="tag">이미지 {block.images}장</span>}
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
                          <Tip label="이 문장을 고쳐서 다시 보냅니다">
                            <button
                              type="button"
                              className="bubble__act"
                              onClick={() => onResendEdit(block.text)}
                            >
                              고쳐서 다시 보내기
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
                      onRetry={onRetry}
                      onResendEdit={onResendEdit}
                      checkpointId={
                        block.subtype === "interrupted" && checkpoints?.length
                          ? checkpoints[checkpoints.length - 1]?.id
                          : undefined
                      }
                      onRestoreCheckpoint={onRestoreCheckpoint}
                      live={live}
                    />
                  );
                }
                // 되돌리기 · 다시 요청은 정산 줄을 탄다 — 턴 단위 행동이 한 행에서
                // 마침표를 찍는다(행동 왼쪽, 시간과 복사 오른쪽). 답 없이 끝난 턴은
                // 행동이 없고, 시간이 안 남은 옛 턴은 행동만 남는다. 되감기 번호는
                // 답의 셈(turnBlockNumbers)을 그대로 산다 — 어긋나면 체크포인트가
                // 엉뚱한 스냅샷을 고른다.
                const turnNo = turnNumbers.get(block.id) ?? 1;
                const answered = lastAnswers.get(turnNo) !== undefined;
                const checkpoint = checkpoints?.find((entry) => entry.turn === turnNo);
                const canRestore = answered && checkpoint != null && onRestoreCheckpoint != null;
                const canRewind = answered && onRewind != null;
                if (!canRestore && !canRewind && block.durationMs == null) return null;
                return (
                  <TurnDone
                    key={block.id}
                    durationMs={block.durationMs}
                    whole={turnAnswers.get(block.id)}
                    actions={
                      canRestore || canRewind ? (
                        <>
                          {canRestore && checkpoint && onRestoreCheckpoint && (
                            <Tip label="이 요청이 바꾼 화면 파일을, 이 요청이 시작하기 전 모습으로 되돌립니다">
                              <button
                                type="button"
                                className="revert"
                                disabled={live}
                                onClick={() => onRestoreCheckpoint(checkpoint.id)}
                              >
                                이 요청 이전으로 되돌리기
                              </button>
                            </Tip>
                          )}
                          {canRewind && (
                            <Tip
                              label={
                                live
                                  ? "답변이 끝나면 누를 수 있습니다"
                                  : "이 답을 버리고 파일·대화를 그 전으로 돌려 같은 말로 다시 받습니다"
                              }
                            >
                              <button
                                type="button"
                                className="revert"
                                disabled={live}
                                onClick={() =>
                                  askRewind(
                                    turnNo,
                                    turnUserText.get(block.id) ?? lastUserText(blocks) ?? "",
                                  )
                                }
                              >
                                다시 요청
                              </button>
                            </Tip>
                          )}
                        </>
                      ) : null
                    }
                  />
                );
              }
              case "notice":
                return (
                  <div
                    key={block.id}
                    className={`notice notice--${block.level}${block.subtype === "compact" ? " notice--compact" : ""}`}
                  >
                    <span className="notice__text">{block.text}</span>
                  </div>
                );
              case "save": {
                const corridor =
                  saveCorridor && block.id === lastSaveId && !corridorDismissed.has(block.id);
                return (
                  <div key={block.id}>
                    <SaveCard
                      title="저장했어요"
                      sub={`${clockTime(block.at)} · 바뀐 파일 ${block.files.length}개`}
                      tagLabel="저장됨"
                      tagTone="ok"
                      files={block.files.map((file) => ({
                        title: file,
                        detail: "",
                        tag: "고침",
                      }))}
                    />
                    {corridor && (
                      <div className="corridor">
                        <button
                          type="button"
                          className="corridor__go"
                          onClick={saveCorridor.onHandoff}
                        >
                          개발자에게 넘기기로 이어가기
                        </button>
                        <button
                          type="button"
                          className="corridor__later"
                          onClick={() =>
                            setCorridorDismissed((prev) => new Set(prev).add(block.id))
                          }
                        >
                          아직이요
                        </button>
                      </div>
                    )}
                  </div>
                );
              }
              case "milestone":
                return block.subtype === "merged" ? (
                  <MilestoneRow
                    key={block.id}
                    tone="ok"
                    text="이번 작업이 제품에 반영됐어요"
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
                  onFix: onFixReview ? () => onFixReview([review]) : undefined,
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
                    onFixAll={
                      onFixReview && inline.length > 1 ? () => onFixReview(inline) : undefined
                    }
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
undefined;
