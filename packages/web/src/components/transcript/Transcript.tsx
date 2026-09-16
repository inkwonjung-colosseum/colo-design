import { type ColoDesignScreen, readTurn } from "@colo-design/protocol";
import { useState } from "react";
import type { Block } from "../../lib/daemon-client";
import { GENERIC_STARTERS } from "../../lib/suggestions";
import { blockOnTape, mergeThinking, SCREEN_SHOT_TOOL } from "../../lib/tape-visibility";
import {
  answerTurnNumbers,
  lastAnswerPerTurn,
  promptTotal,
  turnAnswerText,
} from "../../lib/turn-numbering";
import { CopyButton } from "../CopyButton";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";
import { Markdown } from "../Markdown";
import { Tip } from "../shell/Tip";
import { ActivitySummary, groupActivity } from "./activity";
import { CaptureCard, ThinkingBlock, ToolBlock } from "./blocks";
import { TodoCard } from "./todo";
import {
  FailedTurn,
  isLastFailedTurn,
  lastUserText,
  MachineTurn,
  ScreenChips,
  TurnDone,
} from "./turn";

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
  screens,
  onOpenScreen,
  onOpenScreenTitle,
  checkpoints,
  onRestoreCheckpoint,
  showThinking = false,
  showTools = false,
  onBackgroundTask,
  onStopTask,
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
  /** 연결 레포가 선언한 화면 — 답변의 "만든 화면" 칩의 대조 원본. */
  screens?: ColoDesignScreen[];
  /** 칩을 누르면 미리보기가 그 화면으로 간다. */
  onOpenScreen?: (route: string, state: string | null) => void;
  /** 영수증 행 클릭 — 화면 제목으로 점프(상태는 그 턴이 본 것). */
  onOpenScreenTitle?: (title: string, state: string | null) => void;
  /** A starter chip was pressed — its sentence becomes the composer's draft. */
  onStarter?: (text: string) => void;
  /** The chips themselves — the connected repo's declared screens, falling
      back to the generic sentences when it declares none (suggestions.ts). */
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
}) {
  // 되감기 확인 — k 가 마지막 답이 아니면 뒤의 답들도 함께 사라진다는
  // 말을 한 번 묻는다. 마지막 답이면 곧장. 훅은 빈 테이프 early return 보다
  // 위에 있어야 한다 — 순서가 render 마다 같아야 하니까.
  const [rewindAsk, setRewindAsk] = useState<{
    turn: number;
    text: string;
    after: number;
  } | null>(null);
  if (blocks.length === 0) {
    return (
      <div className="empty">
        <p className="empty__lead">메시지를 보내면 대화가 여기에 이어집니다.</p>
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
  const answerTurns = answerTurnNumbers(blocks);
  const totalTurns = promptTotal(blocks);

  // 되돌리기 · 다시 요청은 턴 단위 행동이다 — 같은 턴의 답들이 가리키는
  // 체크포인트는 하나이므로 두 버튼 모두 그 턴의 마지막 답에만 둔다. 턴이 낸
  // 답의 전문은 턴 끝 줄의 전체 복사가 대신 들고 나간다.
  const lastAnswers = lastAnswerPerTurn(blocks);
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
      {rows.map((row) => {
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
            // them, Claude does not. Reading them off assistant text would let
            // a quoted marker in an answer render as a second card.
            const { marker, body } = readTurn(block.text);
            if (marker)
              return (
                <MachineTurn
                  key={block.id}
                  marker={marker}
                  body={body}
                  thumbs={block.thumbs}
                  onOpenItem={
                    onOpenScreenTitle
                      ? (screen) =>
                          onOpenScreenTitle(screen, "state" in marker ? marker.state : null)
                      : undefined
                  }
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
            const turnNo = answerTurns.get(block.id) ?? 1;
            const tape = TAPE_LINES[block.text.trim()];
            if (tape)
              return (
                <p key={block.id} className="sysline">
                  {tape}
                </p>
              );
            const checkpoint = checkpoints?.find((entry) => entry.turn === turnNo);
            const isLastAnswer = lastAnswers.get(turnNo) === block.id;
            return (
              <div key={block.id}>
                <div className="bubble bubble--assistant">
                  <Markdown text={block.text} />
                  {block.streaming && <span className="caret" />}
                </div>
                {/* 답변의 "만든 화면"을 미리보기로 여는
                    칩. 파싱이 아니라 대조다 — 선언된 화면의 주소가 답변에
                    보이는 것만 칩이 되므로, 형식을 안 지킨 답변은 지금과
                    같다. 되돌리기·다시 요청(파괴적)과는 다른 행 — 탐색은 액션과
                    섞이지 않는다. */}
                {!block.streaming && screens && onOpenScreen && (
                  <ScreenChips text={block.text} screens={screens} onOpen={onOpenScreen} />
                )}
                {isLastAnswer && ((checkpoint && onRestoreCheckpoint) || (onRewind && !live)) && (
                  <div className="answer__actions">
                    {checkpoint && onRestoreCheckpoint && (
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
                    {onRewind && !live && (
                      <Tip label="이 답을 버리고 파일·대화를 그 전으로 돌려 같은 말로 다시 받습니다">
                        <button
                          type="button"
                          className="revert"
                          onClick={() => askRewind(turnNo, lastUserText(blocks) ?? block.text)}
                        >
                          다시 요청
                        </button>
                      </Tip>
                    )}
                  </div>
                )}
              </div>
            );
          }
          case "thinking":
            return <ThinkingBlock key={block.id} block={block} />;
          case "tool":
            return SCREEN_SHOT_TOOL.test(block.name) ? (
              <CaptureCard key={block.id} block={block} />
            ) : (
              <ToolBlock
                key={block.id}
                block={block}
                onBackgroundTask={onBackgroundTask}
                onStopTask={onStopTask}
              />
            );
          case "turn":
            return block.isError || (block.subtype !== "" && block.subtype !== "success") ? (
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
            ) : block.durationMs != null ? (
              <TurnDone
                key={block.id}
                durationMs={block.durationMs}
                whole={turnAnswers.get(block.id)}
              />
            ) : null;
          case "notice":
            return (
              <div key={block.id} className={`notice notice--${block.level}`}>
                <span className="notice__text">{block.text}</span>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
undefined;
