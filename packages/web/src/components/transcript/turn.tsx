import { alignThumbs, readTurn, type TurnMarker } from "@colo-design/protocol";
import { useState } from "react";
import type { Block } from "../../lib/daemon-client";
import { LIMIT_WORDS } from "../../lib/error-words";
import { waitedFor } from "../../lib/format";
import { composing } from "../../lib/ime";
import { CopyButton } from "../CopyButton";
import { BranchIcon, ChevronRightIcon } from "../icons";
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
  onDevReply,
}: {
  marker: TurnMarker;
  body: string;
  /** The pin crops, when the live echo carried them. */
  thumbs?: string[];
  /** 행 클릭 → 그 핀이 찍힌 화면으로. 항목의 screen
      (경로)이 없는 옛 마커는 클릭이 없다 — 짐작으로 보내지 않는다. */
  onOpenItem?: (screen: string) => void;
  /** 리뷰 카드의 답하기 — 대화를 떠나지 않는 한 줄. 보내는 길
      (`api.replyToReview`)은 호출부(ChatColumn)가 잇는다; 없으면 카드는
      읽는 자리로 그친다. */
  onDevReply?: (reviewId: number, text: string) => Promise<void>;
}) {
  // 자세히의 접힘 — 카드마다 제 것이다.
  const [open, setOpen] = useState(false);

  let title: string;
  let lead: string | null = null;
  let rows: Array<{ key: string; label: string; text: string; screen?: string }> = [];
  // 리뷰 카드의 답하기가 보낼 코멘트의 id — 마커가 싣고 있을 때만 칸이 뜬다.
  let devReplyId: number | undefined;
  // The crops are fewer than the rows when the view could not
  // photograph a pin, so each image has to be put back on its own row.
  const aligned = marker.kind === "comments" ? alignThumbs(marker.items, thumbs) : null;

  switch (marker.kind) {
    case "comments": {
      // 마커는 뜻(질문/수정)을 싣지 않는다(C1) — 없는 뜻을 건수로 짐작하는
      // 대신 제목은 그냥 몇 건인지로 말한다.
      title = `수정 요청 ${marker.items.length}건`;
      lead = marker.screen;
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
      lead = marker.route;
      break;
    case "review":
      // The planner pressed 고치기 on a developer comment — the card
      // names the conversation, the author sits beside it, the developer's
      // own file path waits behind 자세히.
      title = "개발자 코멘트에 답하기";
      lead = [marker.author, marker.path].filter(Boolean).join(" · ");
      // 답하기가 겨눌 코멘트의 id — 프로토콜 타입은 부모 소관이라 아직 몰라도
      // optional 로 먼저 읽는다. 필드가 없는 마커에서는 칸이 뜨지 않는다.
      devReplyId = readReviewId(marker);
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
      {/* 답하기(E3) — 개발자에게 가는 한 줄이 카드를 떠나지 않는다. */}
      {marker.kind === "review" && onDevReply && devReplyId !== undefined && (
        <ReviewReply reviewId={devReplyId} onSend={onDevReply} />
      )}
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

/** ReviewMarker 의 `reviewId` — 프로토콜 타입이 아직 몰라도 런타임 가드로
 * 먼저 읽는다(부모 배치가 마커에 필드를 싣는 대로 카드의 답하기가 산다). */
function readReviewId(marker: Extract<TurnMarker, { kind: "review" }>): number | undefined {
  return "reviewId" in marker && typeof marker.reviewId === "number" ? marker.reviewId : undefined;
}

/**
 * 리뷰 카드의 답하기 — 한 줄 입력과 보내기. 성공하면 칸을 비우고, 실패는
 * 카드 안의 한 문장으로 말한다: 방금 쓴 말이 눈앞에 있어야 다시 보낼 마음이
 * 든다. Enter 도 보내지만 조합 중인 Enter 는 한글 마침일 뿐이다.
 */
function ReviewReply({
  reviewId,
  onSend,
}: {
  reviewId: number;
  onSend: (reviewId: number, text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const send = async () => {
    const text = draft.trim();
    if (text === "" || sending) return;
    setSending(true);
    setFailed(false);
    try {
      await onSend(reviewId, text);
      setDraft("");
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };
  return (
    // 한 줄이 카드의 남은 폭을 쓰도록만 인라인으로 — 스타일 파일은 이 배치의
    // 손 밖이다(dev__reply 는 상태 확인이 쓰던 같은 치수다).
    <div className="dev__reply" style={{ flex: "1 1 100%" }}>
      <input
        type="text"
        aria-label="답변"
        placeholder="개발자에게 남길 말을 한 줄 적어 주세요"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (composing(event)) return;
          if (event.key === "Enter") {
            event.preventDefault();
            void send();
          }
        }}
      />
      <button
        type="button"
        className="primary"
        disabled={sending || draft.trim() === ""}
        onClick={() => void send()}
      >
        보내기
      </button>
      {failed && (
        <span className="hint" role="status">
          전송에 실패했어요 — 잠시 후 다시
        </span>
      )}
    </div>
  );
}

const TURN_SUBTYPE_WORDS: Record<string, string> = {
  error_max_turns: "정한 답변 걸음을 채웠습니다 — 다시 보내면 이어서 계속합니다",
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
  live,
}: {
  subtype: string;
  resultText: string | null;
  retryText: string | null;
  onRetry?: (text: string) => void;
  /** 중지 카드의 회수 — 같은 말의 수정 재전송. */
  onResendEdit?: (text: string) => void;
  live?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const limit = resultText !== null && LIMIT_RESULT.test(resultText);
  const interrupted = subtype === "interrupted";
  // 행동이 있을 때만 행동을 묻는 문장이 선다 — 버튼이 잘린 옛 실패 카드가
  // "다시 보내 주세요"를 말해 놓고 손을 내밀지 않는 꼴을 막는다.
  const actionable = !interrupted && retryText !== null;
  const reason = limit
    ? "구독 사용량을 채웠습니다 — 잠시 뒤 같은 말로 이어할 수 있어요"
    : actionable || interrupted || subtype === "error_max_turns"
      ? (TURN_SUBTYPE_WORDS[subtype] ?? "잠시 문제가 있었습니다 — 다시 보내 주세요")
      : "잠시 문제가 있었습니다";
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
              고쳐서 다시 요청
            </button>
          </Tip>
        )}
        {!interrupted && onRetry && retryText && (
          <Tip
            label={
              live
                ? "지금은 스스로 다시 시도하는 중입니다 — 턴이 끝나면 누를 수 있습니다"
                : limit
                  ? "사용량이 다시 채워진 뒤 같은 말을 보냅니다"
                  : "마지막으로 보낸 말을 그대로 다시 보냅니다"
            }
          >
            <button
              type="button"
              className="primary"
              disabled={live}
              onClick={() => onRetry(retryText)}
            >
              다시 보내기
            </button>
          </Tip>
        )}
        {!interrupted && retryText && onResendEdit && (
          <Tip label="입력창으로 돌아와요 — 고쳐서 새 요청으로 보내요">
            <button type="button" className="ghost" onClick={() => onResendEdit(retryText)}>
              고쳐서 다시 요청
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

/** P2-2: `여기서 새 대화` 가 실제로 하는 일 한 줄 — 메뉴의 안내 문장이 읽는
 * 문자열이다(두 자리가 각자 문장을 가지면 하나만 고쳐진다). */
const BRANCH_MEANS = "대화만 이 답까지로 이어받아요. 화면은 지금 모습 그대로입니다.";

/**
 * 정산된 턴의 한 줄 — ChatGPT 의 마침표 행과 같은 형태다: 복사 아이콘과
 * 「N 걸렸습니다」만 줄에 남고, 나머지 손(여기서 새 대화)은 같은 줄의
 * `···` 메뉴 안에 접혀 있다(B4) — 매 턴마다 행동이 줄에 늘어서던 무게를
 * 덜어낸다. 복사는 이 아이콘 하나다: 턴이 낸 답을 이어 붙여 한 번에
 * 건넨다. 시간을 못 남긴 턴이라도 답이 있으면 복사는 선다. 셋이 모두
 * 없으면 아무것도 남기지 않는다(부르는 쪽 Transcript 이 이미 걸러내지만,
 * 줄 자체도 안다).
 */
function TurnDone({
  durationMs,
  whole,
  branch,
}: {
  durationMs: number | null;
  whole?: string;
  /** 여기서 새 대화 — `···` 메뉴가 접고 있는 손. 없으면(분기 불가
      프로바이더) 메뉴 항목은커녕 `···` 자리도 없다. */
  branch?: { live: boolean; onBranch: () => void; onOpenHistory?: () => void };
}) {
  /** 열린 메뉴의 자리 — fixed 좌표(.scroll 이 absolute 메뉴를 잘라 먹으므로
      사이드바의 노드 팝오버와 같은 규칙). 닫힘은 null 이다. */
  const [menuAt, setMenuAt] = useState<{ top?: number; bottom?: number; left: number } | null>(
    null,
  );
  if (durationMs == null && whole == null && branch == null) return null;
  return (
    <div className="turndone">
      <div className="turndone__meta">
        {whole && <CopyButton value={whole} label="전체 복사" className="turndone__act" />}
        {durationMs != null && (
          <span className="turndone__took">{waitedFor(durationMs)} 걸렸습니다</span>
        )}
        {branch && (
          <>
            <button
              type="button"
              className="turndone__act"
              aria-label="더 보기"
              aria-haspopup="menu"
              aria-expanded={menuAt !== null}
              onClick={(event) => {
                if (menuAt) {
                  setMenuAt(null);
                  return;
                }
                const rect = event.currentTarget.getBoundingClientRect();
                // 정산 줄은 대화의 아래쪽에 자주 있으니 위가 더 넓은 쪽으로
                // 연다.
                const up = rect.top > window.innerHeight - rect.bottom;
                setMenuAt(
                  up
                    ? { bottom: window.innerHeight - rect.top + 6, left: rect.left }
                    : { top: rect.bottom + 6, left: rect.left },
                );
              }}
            >
              ···
            </button>
            {menuAt && (
              <>
                <button
                  type="button"
                  className="selector__backdrop"
                  aria-label="메뉴 닫기"
                  onClick={() => setMenuAt(null)}
                />
                <span
                  className="selector__menu node__pop--fixed"
                  role="menu"
                  style={{ position: "fixed", ...menuAt }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="selector__row"
                    disabled={branch.live}
                    onClick={() => {
                      setMenuAt(null);
                      branch.onBranch();
                    }}
                  >
                    <span className="ic">
                      <BranchIcon />
                    </span>
                    <span className="selector__label">여기서 새 대화</span>
                    {branch.live && (
                      <span className="selector__hint">답변이 끝나면 누를 수 있습니다</span>
                    )}
                  </button>
                  {/* 뜻을 마우스 뒤에 숨기지 않는다(P2-2) — 누르기 **전에**
                      읽혀야 하는 문장과, 화면까지 되돌리려는 사람의 길이
                      같은 메뉴 안에 있다. */}
                  {!branch.live && (
                    <span className="selector__moreempty">
                      {BRANCH_MEANS}
                      {branch.onOpenHistory && (
                        <button
                          type="button"
                          className="turndone__restore"
                          onClick={() => {
                            setMenuAt(null);
                            void branch.onOpenHistory?.();
                          }}
                        >
                          작업 기록에서 되돌리기
                        </button>
                      )}
                    </span>
                  )}
                </span>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export { FailedTurn, isLastFailedTurn, lastUserText, MachineTurn, TurnDone };
