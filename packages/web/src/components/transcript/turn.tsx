import { alignThumbs, readTurn, type TurnMarker } from "@colo-design/protocol";
import { type ReactNode, useState } from "react";
import type { Block } from "../../lib/daemon-client";
import { LIMIT_WORDS } from "../../lib/error-words";
import { waitedFor } from "../../lib/format";
import { CopyButton } from "../CopyButton";
import { ChevronRightIcon } from "../icons";
import { Tip } from "../shell/Tip";

/**
 * A turn this app wrote on the planner's behalf, rendered as what it means
 * instead of as what the agent reads.
 *
 * The four kinds share one shape — a heading, a short list, and the original
 * text one fold away — because they interrupt the chat for the same reason:
 * something happened that the planner started but did not type. The fold is
 * not decoration; a turn the agent answered oddly is only diagnosable against the
 * text it actually received.
 */
function MachineTurn({
  marker,
  body,
  thumbs,
  onOpenItem,
}: {
  marker: TurnMarker;
  body: string;
  /** The pin crops, when the live echo carried them. */
  thumbs?: string[];
  /** 행 클릭 → 그 핀이 찍힌 화면으로. 항목의 screen
      (경로)이 없는 옛 마커는 클릭이 없다 — 짐작으로 보내지 않는다. */
  onOpenItem?: (screen: string) => void;
}) {
  const [open, setOpen] = useState(false);

  let title: string;
  let lead: string | null = null;
  let rows: Array<{ key: string; label: string; text: string; screen?: string }> = [];
  // The crops are fewer than the rows when the view could not
  // photograph a pin, so each image has to be put back on its own row.
  const aligned = marker.kind === "comments" ? alignThumbs(marker.items, thumbs) : null;

  switch (marker.kind) {
    case "comments": {
      // 의도가 제목을 정한다: absent reads as change, so older
      // markers keep the 수정 요청 title they were written with.
      const questions = marker.items.filter((item) => item.intent === "question").length;
      const changes = marker.items.length - questions;
      title =
        questions === 0
          ? `수정 요청 ${marker.items.length}건`
          : changes === 0
            ? `질문 ${marker.items.length}건`
            : `수정 ${changes} · 질문 ${questions}`;
      lead = [marker.screen, marker.state && `${marker.state} 상태`].filter(Boolean).join(" · ");
      rows = marker.items.map((item, index) => {
        // 여러 화면을 한 턴에 찍은 배치는 머리글이 화면 N곳 요약이라 —
        // 행마다 각자의 화면을 새긴다. 번호 접두는 턴 본문이 "1. 2. 3."으로
        // 세는 이 목록을, 화면의 영수증도 같은 수로 센다 — 기획자가 답변과
        // 영수증을 눈으로 맞춘다.
        const inner = item.label || `${index + 1}번째`;
        const label =
          item.screen && marker.screen.startsWith("화면 ")
            ? `${index + 1}. ${inner} · ${item.screen}`
            : `${index + 1}. ${inner}`;
        return {
          key: String(index),
          label,
          text: item.comment,
          ...(item.screen ? { screen: item.screen } : {}),
        };
      });
      break;
    }
    case "brief":
      // The connection-preparation brief reads as its own thing.
      title =
        marker.purpose === "bootstrap"
          ? "연결 준비"
          : marker.purpose === "refresh"
            ? "최신 변경 받아오기"
            : marker.purpose === "conventions"
              ? "관례 최신화"
              : "화면 만들기";
      lead = marker.title;
      break;
    case "gate":
      title = `${marker.step}에서 멈췄습니다`;
      lead = "무엇이 잘못됐는지 AI에게 넘겼습니다. 고치는 동안 기다려 주세요.";
      break;
    case "error":
      // `look` is the 화면 보여 주기 ask (no error the console can
      // name); `count` marks a repeat so the planner sees the loop.
      title =
        marker.errorKind === "look"
          ? marker.count && marker.count > 1
            ? `화면 보여 주기 · ${marker.count}번째 요청`
            : "화면 보여 주기"
          : marker.count && marker.count > 1
            ? `아직 같은 오류 · ${marker.count}번째`
            : "화면 오류 고치기";
      lead = [marker.route, marker.state && `${marker.state} 상태`].filter(Boolean).join(" · ");
      break;
    case "review":
      // The planner pressed 고치기 on a developer comment — the card
      // names the conversation, the author sits beside it, the developer's
      // own file path waits behind 자세히.
      title = "개발자 코멘트에 답하기";
      lead = [marker.author, marker.path].filter(Boolean).join(" · ");
      break;
  }

  return (
    <div className={`machine machine--${marker.kind}`}>
      <div className="machine__head">
        <span className="machine__title">{title}</span>
        {lead && <span className="machine__lead">{lead}</span>}
      </div>
      {/* The planner's own sentence — the card carries it above the rows. */}
      {marker.kind === "comments" && marker.note && <p className="machine__note">{marker.note}</p>}
      {rows.length > 0 && (
        <ul className="machine__rows">
          {rows.map((row, index) => (
            <li
              key={row.key}
              className={onOpenItem && row.screen ? "machine__row--link" : undefined}
            >
              {marker.kind === "comments" && aligned?.[index] && (
                <img
                  className="machine__thumb"
                  src={`data:image/jpeg;base64,${aligned[index]}`}
                  // The crop is of THIS element, and a screen reader should
                  // hear which one rather than skip an unnamed picture.
                  alt={row.label}
                />
              )}
              {onOpenItem && row.screen ? (
                // 영수증의 행은 과거의 가리킴을 회수하는 문이다.
                <Tip label="이 핀이 찍혔던 화면으로 돌아갑니다">
                  <button
                    type="button"
                    className="machine__label machine__label--link"
                    onClick={() => {
                      if (row.screen) onOpenItem(row.screen);
                    }}
                  >
                    {row.label}
                    <ChevronRightIcon />
                  </button>
                </Tip>
              ) : (
                <span className="machine__label">{row.label}</span>
              )}
              {row.text && <span className="machine__text">{row.text}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="machine__actions">
        <button
          type="button"
          className="machine__more"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "접기" : "자세히"}
        </button>
        {/* 요청 복사: the card is a reading of the turn, not the turn — the
            text the agent actually received is what travels elsewhere. */}
        {body.trim() !== "" && (
          <CopyButton value={body} label="요청 복사" icon={null} className="machine__more" />
        )}
      </div>
      {open && <pre className="machine__body">{body}</pre>}
    </div>
  );
}

const TURN_SUBTYPE_WORDS: Record<string, string> = {
  error_max_turns: "정한 대화 길이를 채웠습니다 — 새 대화에서 이어 가면 됩니다",
  error_during_execution: "잠시 문제가 있었습니다 — 다시 보내 주세요",
  interrupted: "멈추었습니다 — 고치던 화면이 반쯤 남았을 수 있습니다. 이어서 말하거나 되돌리세요",
};

/**
 * The card a failed turn renders as. A planner whose last words
 * got no answer must see WHY the silence, and have the cheapest recovery —
 * sending the very same words again — one click away.
 */
/** The subscription's refusal names itself in the SDK's closing line. The
    limit refills on the clock, not on attempts — so the card says 잠시 뒤
    이어할 수 있다, and `다시 보내기` stays as the hand for the moment it
    has refilled. */
const LIMIT_RESULT = /usage limit|rate limit|limit reached|weekly limit|capacity/i;

function FailedTurn({
  subtype,
  resultText,
  retryText,
  onRetry,
  onResendEdit,
  checkpointId,
  onRestoreCheckpoint,
  live,
}: {
  subtype: string;
  resultText: string | null;
  retryText: string | null;
  onRetry?: (text: string) => void;
  /** 중지 카드의 회수 — 같은 말의 수정 재전송. */
  onResendEdit?: (text: string) => void;
  /** 같은 턴 시작의 스냅샷 — 텍스트 없이 도구만 돌다 멈춘 턴의 되돌림 손. */
  checkpointId?: string;
  onRestoreCheckpoint?: (id: string) => void;
  live?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const limit = resultText !== null && LIMIT_RESULT.test(resultText);
  const interrupted = subtype === "interrupted";
  const reason = limit
    ? "구독 사용량을 채웠습니다 — 잠시 뒤 같은 말로 이어할 수 있어요"
    : (TURN_SUBTYPE_WORDS[subtype] ?? "잠시 문제가 있었습니다 — 다시 보내 주세요");
  // 자세히가 여는 영어 원문 앞에 서는 한국어 한 줄 — 한도는 전용 문장,
  // 나머지 실패는 카드가 이미 말한 이유가 그대로 요약이다.
  const detail = limit ? LIMIT_WORDS : reason;
  return (
    <div className="machine turnfail">
      <div className="machine__head">
        <span className="machine__title">답을 마치지 못했습니다</span>
        <span className="machine__lead">{reason}</span>
      </div>
      <div className="turnfail__actions">
        {/* 스스로 멈춘 사람에게 "같은 말 재발사"는 이상한 첫 제안 —
            고쳐서 다시 보내기(입력창으로 돌아온다)가 그 자리를 대신한다.
            두 버튼이 나란히 설 때는 위계가 말을 한다: 같은 말 재발사가
            primary, 고쳐서 보내기는 ghost. 한도 카드도 같은 손을 가진다 —
            채워진 뒤의 재발사는 결국 성공한다. */}
        {interrupted && retryText && onResendEdit && (
          <Tip label="보낸 말이 입력창으로 돌아갑니다 — 고친 뒤 다시 보내세요">
            <button type="button" className="ghost" onClick={() => onResendEdit(retryText)}>
              고쳐서 다시 보내기
            </button>
          </Tip>
        )}
        {!interrupted && onRetry && retryText && (
          <Tip
            label={
              limit
                ? "사용량이 다시 채워진 뒤 같은 말을 보냅니다"
                : "마지막으로 보낸 말을 그대로 다시 보냅니다"
            }
          >
            <button type="button" className="primary" onClick={() => onRetry(retryText)}>
              다시 보내기
            </button>
          </Tip>
        )}
        {!interrupted && retryText && onResendEdit && (
          <Tip label="같은 말 그대로가 아니라, 입력창에서 고친 말을 보냅니다">
            <button type="button" className="ghost" onClick={() => onResendEdit(retryText)}>
              고쳐서 다시 보내기
            </button>
          </Tip>
        )}
        {/* 텍스트 없이 도구만 돌다 멈춘 턴은 되돌릴 버튼이 답변에만 있어 여기까지
            못 미쳤다 — 중지 카드가 스스로의 체크포인트로 돌리는 손을 가진다. */}
        {interrupted && checkpointId && onRestoreCheckpoint && (
          <Tip label="이 요청이 바꾼 화면 파일을, 이 요청이 시작하기 전 모습으로 되돌립니다">
            <button
              type="button"
              className="revert"
              disabled={live}
              onClick={() => onRestoreCheckpoint(checkpointId)}
            >
              이 요청 이전으로 되돌리기
            </button>
          </Tip>
        )}
        <button
          type="button"
          className="machine__more"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "접기" : "자세히"}
        </button>
      </div>
      {open && (
        <>
          <p className="hint">{detail}</p>
          <pre className="machine__body">{resultText ?? (subtype || "turn")}</pre>
        </>
      )}
    </div>
  );
}

/** The planner's last own words — what `다시 보내기` resends. */
function lastUserText(blocks: Block[]): string | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.type === "user") {
      const { marker } = readTurn(block.text);
      if (!marker) return block.text;
    }
  }
  return null;
}

/** The one failed turn whose card still owns `다시 보내기`: only the LAST
 * failure. An older card's button used to carry
 * lastUserText too — resending the newest words under an old card's promise. */
function isLastFailedTurn(blocks: Block[], block: Block): boolean {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const candidate = blocks[index];
    if (
      candidate?.type === "turn" &&
      (candidate.isError || (candidate.subtype !== "" && candidate.subtype !== "success"))
    ) {
      return candidate.id === block.id;
    }
  }
  return false;
}

/**
 * 정산된 턴의 한 줄 — 그리고 답이 도구 사이에서 조각으로 올 때
 * 그 요청의 output 전부를 한 번에 복사해 나르는 유일한 자리다. 복사는 이
 * 아이콘 하나다: 턴이 낸 답을 이어 붙여 한 번에 건넨다. 되돌리기 · 다시
 * 요청(턴 단위 행동)도 같은 줄을 탄다 — 행동 왼쪽, 시간과 복사 오른쪽,
 * 한 턴의 마침표가 행 하나로 찍힌다. 액션과 시간이 모두 없으면 아무것도
 * 남기지 않는다(부르는 쪽 Transcript 이 이미 걸러내지만, 줄 자체도 안다).
 */
function TurnDone({
  durationMs,
  whole,
  actions,
}: {
  durationMs: number | null;
  whole?: string;
  /** 되돌리기 · 다시 요청 — 답 카드 아래 행을 따로 두르지 않고 정산 줄이
      대신 실어 나른다. */
  actions?: ReactNode;
}) {
  if (durationMs == null && actions == null) return null;
  return (
    <div className={`turndone${actions != null ? " turndone--actions" : ""}`}>
      {actions != null && <div className="turndone__actions">{actions}</div>}
      {durationMs != null && (
        <div className="turndone__meta">
          {waitedFor(durationMs)} 걸렸습니다
          {whole && <CopyButton value={whole} label="전체 복사" className="turndone__copy" />}
        </div>
      )}
    </div>
  );
}

export { FailedTurn, isLastFailedTurn, lastUserText, MachineTurn, TurnDone };
