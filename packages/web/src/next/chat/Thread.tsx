import { alignThumbs, type QueuedSend, type RepoStatus, readTurn } from "@colo-design/protocol";
import { Fragment, type ReactNode } from "react";
import { Markdown } from "../../components/Markdown";
import { ActivitySummary, groupActivity } from "../../components/transcript/activity";
import { ThinkingBlock, ToolBlock } from "../../components/transcript/blocks";
import { TodoCard } from "../../components/transcript/todo";
import type { Block } from "../../lib/daemon-client";
import { previewPathOf } from "../../lib/screen-link";
import { blockOnTape, mergeThinking } from "../../lib/tape-visibility";
import { turnAnswerText, turnBlockNumbers } from "../../lib/turn-numbering";
import { lastTurnScreens, type TurnScreen } from "../../lib/turn-screens";
import { L } from "../labels";
import { noticeKind, promptNumbers, retryCount } from "../lib/thread";
import { BriefCard, FailCard, GateCard, ReceiptCard, ReviewCard, reviewParts } from "./cards";
import { CheckIcon, ClockIcon, EditIcon, SparkIcon } from "./icons";
import { SettleLine, ShotCard } from "./SettleLine";

/** CLI 가 사람의 말이나 답인 척 내려놓는 살림 줄 — 사람의 말이 아니다. */
const INTERRUPTED = "[Request interrupted by user]";
const NO_RESPONSE = "No response requested.";
/** 사용량 한도로 거절된 답 — SDK 의 마지막 줄이 스스로 그렇게 말한다(옛 실패 카드와 같은 판정). */
const LIMIT_RESULT = /usage limit|rate limit|limit reached|weekly limit|capacity/i;

type TurnBlock = Extract<Block, { type: "turn" }>;
type Row = ReturnType<typeof groupActivity>[number];

function failed(block: TurnBlock): boolean {
  return block.isError || (block.subtype !== "" && block.subtype !== "success");
}

/** 사람의 마지막 말(기계 턴 말고) — `다시 시도` 가 다시 보내는 글. */
function lastOwnWords(blocks: readonly Block[]): string | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.type === "user" && readTurn(block.text).marker === null) return block.text;
  }
  return null;
}

function Note({ children, tone }: { children: ReactNode; tone?: "red" }) {
  return (
    <div className={`nx-m-note${tone === "red" ? " nx-tone--red" : ""}`}>
      <ClockIcon />
      <span>{children}</span>
    </div>
  );
}

export interface ThreadProps {
  blocks: Block[];
  /** 이 대화의 답이 도는 중인가. */
  live: boolean;
  showThinking: boolean;
  showTools: boolean;
  /** 미리보기 서버의 주소 — 답의 링크가 이 미리보기의 화면인지 가른다. */
  previewUrl: string | null;
  handoff: RepoStatus["handoff"];
  /** 이 프로젝트에서 AI 가 도는가 — 코멘트 카드의 `AI가 반영하는 중`. */
  projectWorking: boolean;
  /** 갈래를 낼 수 있는 AI 인가 — 여기서 새 대화 · 고쳐서 다시 보내기(2번째 말부터). */
  canBranch: boolean;
  queue: QueuedSend[];
  /** 준비 중에 보낸 말인가 — 대기 줄의 한 줄이 달라진다(U8). */
  preparing: boolean;
  onFork: (turn: number) => void;
  onEditResend: (prompt: number, text: string) => void;
  onRetry: (text: string) => void;
  onOpenScreen: (screen: TurnScreen) => void;
  onOpenHistory: () => void;
  onReply: (id: number, text: string) => Promise<void>;
  onToast: (text: string) => void;
  onQueueEdit: (itemId: string) => void;
  onQueueNow: (itemId: string) => void;
  onBackgroundTask: (toolUseId: string) => void;
  onStopTask: (taskId: string) => void;
}

/**
 * 대화록(PLAN-UI 단계 2) — 블록 그리기는 옛 대화록의 부품(활동 · 생각 · 도구 ·
 * 할 일 · 마크다운)을 그대로 빌리고, 사람의 말 · AI 답 · 카드 · 정산 줄은 목업의
 * 모양으로 새로 선다. 답마다 그 답이 말한 화면의 `고친 화면` 카드(U5)가 정산 줄
 * 위에 선다.
 */
export function Thread(props: ThreadProps) {
  const { blocks, live, showThinking, showTools } = props;
  const tape = mergeThinking(blocks.filter((block) => blockOnTape(block, showThinking, showTools)));
  const rows: Row[] = groupActivity(
    live
      ? tape
      : tape.map((block) =>
          block.type === "thinking" && block.streaming ? { ...block, streaming: false } : block,
        ),
  );

  // 끝난 턴의 할 일만 대화록에 남는다 — 도는 턴의 목차는 입력창 위의 몫이다.
  const endedTodos = new Set<string>();
  let todosSoFar: string[] = [];
  for (const block of blocks) {
    if (block.type === "tool" && block.name === "TodoWrite") todosSoFar.push(block.id);
    else if (block.type === "turn") {
      for (const id of todosSoFar) endedTodos.add(id);
      todosSoFar = [];
    }
  }

  const prompts = promptNumbers(blocks);
  const turnNumbers = turnBlockNumbers(blocks);
  const turnAnswers = turnAnswerText(blocks);
  const toPath = (href: string) => previewPathOf(href, props.previewUrl);

  // 턴 끝마다: 그 턴이 말한 화면과 마지막 답 한 조각.
  const screensByTurn = new Map<string, TurnScreen[]>();
  const lastAnswerByTurn = new Map<string, string>();
  let segmentStart = 0;
  let lastText: string | null = null;
  blocks.forEach((block, index) => {
    if (block.type === "user") {
      segmentStart = index + 1;
      lastText = null;
    } else if (block.type === "text" && block.agentId === null) {
      lastText = block.text;
    } else if (block.type === "turn") {
      if (props.previewUrl) {
        screensByTurn.set(block.id, lastTurnScreens(blocks.slice(segmentStart, index + 1), toPath));
      }
      if (lastText !== null) lastAnswerByTurn.set(block.id, lastText);
    }
  });

  let lastUserId: string | null = null;
  let lastFailedId: string | null = null;
  let lastHumanId: string | null = null;
  for (const block of blocks) {
    if (block.type === "user") lastUserId = block.id;
    if (block.type === "turn" && failed(block)) lastFailedId = block.id;
    if (block.type === "human") lastHumanId = block.id;
  }
  const ownWords = lastOwnWords(blocks);
  const handedPrs = new Set<number>();

  const isRetryRow = (row: Row | undefined): boolean =>
    row?.kind === "block" &&
    row.block.type === "notice" &&
    noticeKind(row.block.text, L.daemonNotice) === "retry";

  // 한 사람 말 뒤의 첫 AI 답에만 얼굴이 선다 — 이어지는 조각은 그 아래로 줄을 맞춘다.
  let aiOpened = false;

  const render = (row: Row, index: number): ReactNode => {
    if (row.kind === "activity") {
      return (
        <div className="nx-m-work">
          <ActivitySummary
            steps={row.steps}
            controls={{ onBackgroundTask: props.onBackgroundTask, onStopTask: props.onStopTask }}
          />
        </div>
      );
    }
    if (row.kind === "todo") {
      if (live && !endedTodos.has(row.block.id)) return null;
      return (
        <div className="nx-m-work">
          <TodoCard block={row.block} />
        </div>
      );
    }
    const block = row.block;
    switch (block.type) {
      case "user": {
        aiOpened = false;
        const { marker, body } = readTurn(block.text);
        const running = live && block.id === lastUserId;
        if (marker?.kind === "gate" || marker?.kind === "error") {
          return <GateCard marker={marker} body={body} fixing={running} />;
        }
        if (marker?.kind === "brief") return <BriefCard marker={marker} body={body} />;
        if (marker?.kind === "review") {
          return (
            <ReviewCard
              author={marker.author}
              at={null}
              texts={[{ key: "brief", text: L.chat.reviewText }]}
              replyId={marker.id ?? null}
              fixing={running}
              body={body}
              onReply={props.onReply}
              onToast={props.onToast}
            />
          );
        }
        if (block.text.trim() === INTERRUPTED) return <Note>{L.transcript.stopped}</Note>;
        if (block.text.trim() === NO_RESPONSE) return null;
        const prompt = prompts.get(block.id) ?? 1;
        const canResend =
          marker === null && block.text.trim() !== "" && (prompt === 1 || props.canBranch);
        const thumbs = marker?.kind === "comments" ? alignThumbs(marker.items, block.thumbs) : [];
        return (
          <div className="nx-m-user">
            <div className="nx-bub">
              {(block.images > 0 || (block.files?.length ?? 0) > 0) && marker === null && (
                <div className="nx-batts">
                  {block.images > 0 && (
                    <span className="nx-tag">{L.chat.images(block.images)}</span>
                  )}
                  {block.files?.map((name) => (
                    <span key={name} className="nx-tag">
                      {name}
                    </span>
                  ))}
                </div>
              )}
              {marker?.kind === "comments" && (
                <div className="nx-bpins">
                  {marker.items.map((item, at) => (
                    <div key={item.id ?? at} className="nx-bpin">
                      {thumbs[at] ? (
                        <img
                          className="nx-bpin-shot"
                          src={`data:image/jpeg;base64,${thumbs[at]}`}
                          alt=""
                        />
                      ) : (
                        <span className="nx-pnum nx-pnum--sent">{at + 1}</span>
                      )}
                      <b>{item.label || at + 1}</b>
                      {item.comment && <span>{item.comment}</span>}
                    </div>
                  ))}
                </div>
              )}
              {marker?.kind === "comments" ? (
                marker.note && <div className="nx-btxt">{marker.note}</div>
              ) : (
                <div className="nx-btxt">{block.text}</div>
              )}
            </div>
            {canResend && (
              <button
                type="button"
                className="nx-ue"
                title={L.transcript.editResendTip}
                onClick={() => props.onEditResend(prompt, block.text)}
              >
                <EditIcon />
                {L.transcript.editResend}
              </button>
            )}
          </div>
        );
      }
      case "text": {
        const trimmed = block.text.trim();
        if (trimmed === NO_RESPONSE) return null;
        if (trimmed === INTERRUPTED) return <Note>{L.transcript.stopped}</Note>;
        const first = !aiOpened;
        aiOpened = true;
        return (
          <div className={`nx-m-ai${first ? "" : " nx-m-ai--cont"}`}>
            <div className="nx-av" aria-hidden="true">
              {first && <SparkIcon />}
            </div>
            <div className="nx-m-body">
              <Markdown text={block.text} />
              {block.streaming && <span className="nx-caret" />}
            </div>
          </div>
        );
      }
      case "thinking":
        return (
          <div className="nx-m-work">
            <ThinkingBlock block={block} />
          </div>
        );
      case "tool":
        return (
          <div className="nx-m-work">
            <ToolBlock
              block={block}
              onBackgroundTask={props.onBackgroundTask}
              onStopTask={props.onStopTask}
            />
          </div>
        );
      case "turn": {
        if (failed(block)) {
          if (block.subtype === "interrupted") return <Note>{L.transcript.stopped}</Note>;
          const limit = block.resultText !== null && LIMIT_RESULT.test(block.resultText);
          const why = limit
            ? L.chat.failLimit
            : block.escalated
              ? L.cards.failWhy
              : L.chat.failWhyShort;
          const retryText = block.id === lastFailedId ? ownWords : null;
          return (
            <FailCard
              why={why}
              notified={block.escalated === true}
              live={live}
              retry={retryText ? () => props.onRetry(retryText) : null}
            />
          );
        }
        const turnNo = turnNumbers.get(block.id) ?? 1;
        const whole = turnAnswers.get(block.id) ?? block.resultText ?? null;
        const screens = screensByTurn.get(block.id) ?? [];
        return (
          <>
            {screens.length > 0 && (
              <div className="nx-shots">
                {screens.map((screen) => (
                  <ShotCard
                    key={screen.path}
                    title={screen.title ?? screen.path}
                    onOpen={() => props.onOpenScreen(screen)}
                  />
                ))}
              </div>
            )}
            <SettleLine
              durationMs={block.durationMs}
              whole={whole}
              lastAnswer={lastAnswerByTurn.get(block.id) ?? null}
              onFork={props.canBranch && whole !== null ? () => props.onFork(turnNo) : null}
              onOpenHistory={props.onOpenHistory}
              onToast={props.onToast}
            />
          </>
        );
      }
      case "notice": {
        const kind = noticeKind(block.text, L.daemonNotice);
        if (kind === "retry") {
          // 스스로 다시 묻기는 한 줄로 접는다 — 줄의 끝에서만 말한다.
          const next = rows[index + 1];
          if (isRetryRow(next)) return null;
          const count = retryCount(block.text);
          if (!next) {
            return live && count ? <Note>{L.chat.retrying(count.n, count.of)}</Note> : null;
          }
          const exhausted = count !== null && count.n >= count.of;
          const nextFailed =
            next.kind === "block" && next.block.type === "turn" && failed(next.block);
          return nextFailed && exhausted ? <Note>{L.vocab.retriedFive}</Note> : null;
        }
        if (kind === "wait") return <Note>{L.chat.waitingLimit}</Note>;
        if (kind === "revive") return <Note>{L.transcript.revived}</Note>;
        // 데몬은 한국어 한 줄을 앞에 세우고 원문을 빈 줄 뒤에 붙인다 — 앞의 한 줄만 보인다.
        const cut = block.text.search(/\n[ \t]*\n/);
        const lead = (cut === -1 ? block.text : block.text.slice(0, cut)).trim();
        return <Note tone={block.level === "error" ? "red" : undefined}>{lead}</Note>;
      }
      case "save":
        // 보관은 답마다 도구가 스스로 한다 — 대화록에 남길 일이 아니다(작업 기록이 그 자리).
        return null;
      case "saveBlocked":
        return <Note tone="red">{block.detail}</Note>;
      case "milestone": {
        if (block.subtype === "handed") {
          const more = handedPrs.has(block.pr);
          handedPrs.add(block.pr);
          return <ReceiptCard block={block} more={more} handoff={props.handoff} />;
        }
        return (
          <div className={`nx-mile${block.subtype === "closed" ? " nx-mile--red" : ""}`}>
            <span />
            <b>
              <CheckIcon />
              {block.subtype === "merged" ? L.cards.milestoneMerged : L.chat.closed}
            </b>
            <span />
          </div>
        );
      }
      case "human": {
        const parts = reviewParts(block.reviews);
        return (
          <ReviewCard
            {...parts}
            fixing={props.projectWorking && block.id === lastHumanId}
            onReply={props.onReply}
            onToast={props.onToast}
          />
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className="nx-thread">
      {rows.map((row, index) => {
        const content = render(row, index);
        if (content === null) return null;
        return <Fragment key={row.kind === "block" ? row.block.id : row.id}>{content}</Fragment>;
      })}
      {props.queue.map((item) => (
        <div key={item.id} className="nx-m-user">
          <div className="nx-bub">
            {item.text && <div className="nx-btxt">{item.text}</div>}
            <div className="nx-bq">
              <ClockIcon />
              {props.preparing ? L.transcript.queued : L.chat.queuedAfter}
            </div>
          </div>
          <div className="nx-bq-acts">
            <button
              type="button"
              className="nx-ue nx-ue--on"
              onClick={() => props.onQueueEdit(item.id)}
            >
              {L.chat.queueEdit}
            </button>
            {!props.preparing && (
              <button
                type="button"
                className="nx-ue nx-ue--on"
                onClick={() => props.onQueueNow(item.id)}
              >
                {L.chat.queueNow}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
