import type { AskQuestion, DeveloperReview, RepoStatus, TurnMarker } from "@colo-design/protocol";
import { useState } from "react";
import type { Block, PendingPermission, PendingQuestion } from "../../lib/daemon-client";
import { composing } from "../../lib/ime";
import { bashHeadline, toolLabel } from "../../lib/labels";
import { linkClick } from "../../lib/open-link";
import { L } from "../labels";
import { noteAllowed } from "../lib/thread";
import { AlertIcon, CheckIcon, ExtIcon, EyeIcon, SparkIcon } from "./icons";

/** `오후 3:12` 가 아니라 `15:12` — 목업의 시각 표기. */
export function clockOf(at: string | number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** 카드 머리의 상태 알약 — `AI가 고치는 중` · `AI가 고쳤어요` 같은 것. */
function Stat({ done, doneText, runText }: { done: boolean; doneText: string; runText: string }) {
  return done ? (
    <span className="nx-stat nx-stat--ok">
      <CheckIcon />
      {doneText}
    </span>
  ) : (
    <span className="nx-stat nx-stat--run">
      <i className="nx-spin" aria-hidden="true" />
      {runText}
    </span>
  );
}

/** AI 가 실제로 받은 글 — 한 겹 접혀 있다(개발자 말이라 몰라도 된다). */
function Received({ body }: { body: string }) {
  if (body.trim() === "") return null;
  return (
    <details className="nx-card-fold">
      <summary>{L.cards.gateBody}</summary>
      <pre>{body}</pre>
    </details>
  );
}

/**
 * 화면 확인 카드 — 게이트(`gate`)와 미리보기 오류를 맡긴 턴(`error`)이 같은 모양이다:
 * 무엇을 찾았는지 한 문장, 하실 일은 없다는 한 문장, 받은 글은 접혀 있다.
 */
export function GateCard({
  marker,
  body,
  fixing,
}: {
  marker: Extract<TurnMarker, { kind: "gate" | "error" }>;
  body: string;
  /** 이 턴이 아직 도는 중인가 — 알약이 `AI가 고치는 중` 이 된다. */
  fixing: boolean;
}) {
  const title =
    marker.kind === "error" && marker.errorKind === "look" ? L.chat.lookTitle : L.cards.screenCheck;
  const summary =
    marker.kind === "gate"
      ? L.chat.gateSummary(marker.step)
      : marker.errorKind === "look"
        ? L.chat.lookSummary
        : L.chat.errorSummary;
  return (
    <div className="nx-card nx-card--gate">
      <div className="nx-ch">
        <EyeIcon />
        <b>{title}</b>
        <Stat done={!fixing} doneText={L.cards.gateFixed} runText={L.cards.gateFixing} />
      </div>
      <div className="nx-cs">
        {summary} {fixing ? L.cards.nothingToDoYet : L.cards.nothingToDo}
      </div>
      <Received body={body} />
    </div>
  );
}

/** 도구가 연 대화의 첫 브리프(연결 준비 · 받아오기 · 화면 만들기) — 한 줄과 접힌 글. */
export function BriefCard({
  marker,
  body,
}: {
  marker: Extract<TurnMarker, { kind: "brief" }>;
  body: string;
}) {
  const title =
    marker.purpose === "bootstrap"
      ? L.chat.briefBootstrap
      : marker.purpose === "refresh"
        ? L.chat.briefRefresh
        : marker.purpose === "conventions"
          ? L.chat.briefConventions
          : L.chat.briefScreen(marker.title);
  return (
    <div className="nx-card nx-card--gate">
      <div className="nx-ch">
        <SparkIcon />
        <b>{title}</b>
      </div>
      <Received body={body} />
    </div>
  );
}

/** 답하기 한 줄 — 카드를 떠나지 않고 개발자에게 간다(`comments.reply` · `repo.note`). */
export function ReplyBox({
  placeholder,
  onSend,
  onSent,
}: {
  /** 입력칸의 지시문 — 답하기는 `…님에게 답하기`, 한마디 더는 그 자리의 말. */
  placeholder: string;
  onSend: (text: string) => Promise<void>;
  onSent: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await onSend(text);
      setDraft("");
      onSent(text);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="nx-reply">
        <input
          // biome-ignore lint/a11y/noAutofocus: 답하기를 누른 손이 곧 쓸 자리다.
          autoFocus
          value={draft}
          placeholder={placeholder}
          aria-label={placeholder}
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
          className="nx-btn nx-btn--sm nx-btn--pri"
          disabled={busy || draft.trim() === ""}
          onClick={() => void send()}
        >
          {L.cards.replySend}
        </button>
      </div>
      {failed && <div className="nx-reply-sent nx-tone--red">{L.chat.sendFailed}</div>}
    </>
  );
}

/**
 * 개발자 코멘트 카드(U14) — 사람 · 글 · 상태(`AI가 반영하는 중` → `반영해 같은
 * 요청에 다시 제출했어요`) · `답하기`. 코멘트는 AI 가 바로 반영한다(L9) — 카드는
 * 할 일을 만들지 않고 알린다. 화면 이름은 선로가 아직 싣지 않아 비운다.
 */
export function ReviewCard({
  author,
  at,
  texts,
  replyId,
  fixing,
  body = "",
  onReply,
  onToast,
}: {
  author: string;
  at: string | null;
  texts: Array<{ key: string; text: string }>;
  /** 답하기가 갈 스레드 — 없으면 답하기 없이 읽는 자리. */
  replyId: number | null;
  fixing: boolean;
  /** AI 가 받은 글(반영 턴) — 있으면 한 겹 접혀 선다. */
  body?: string;
  onReply: (id: number, text: string) => Promise<void>;
  onToast: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [replies, setReplies] = useState<Array<{ key: number; text: string }>>([]);
  const name = author.trim() || L.chat.reviewAuthor;
  return (
    <div className="nx-card nx-card--review">
      <div className="nx-ch">
        <span className="nx-avt">{name.slice(0, 1)}</span>
        <b>{name}</b>
        <span className="nx-muted">{L.cards.developer}</span>
        {at && <span className="nx-time">{clockOf(at)}</span>}
      </div>
      {texts.map((row) => (
        <div key={row.key} className="nx-ctext">
          {row.text}
        </div>
      ))}
      <div className="nx-cfoot">
        <Stat done={!fixing} doneText={L.cards.reviewDone} runText={L.cards.reviewFixing} />
        <span className="nx-grow" />
        {replyId !== null && (
          <button type="button" className="nx-btn nx-btn--sm" onClick={() => setOpen((v) => !v)}>
            {L.cards.reply}
          </button>
        )}
      </div>
      {replies.map((row) => (
        <div key={row.key} className="nx-reply-sent">
          <CheckIcon />
          <span>{L.cards.replyMine(row.text)}</span>
        </div>
      ))}
      <Received body={body} />
      {open && replyId !== null && (
        <ReplyBox
          placeholder={L.cards.replyTo(name)}
          onSend={(text) => onReply(replyId, text)}
          onSent={(text) => {
            setReplies((prev) => [...prev, { key: prev.length, text }]);
            setOpen(false);
            onToast(L.cards.replyToast(name));
          }}
        />
      )}
    </div>
  );
}

/** 코멘트 도착 블록(`review.arrived`)을 카드의 재료로. */
export function reviewParts(reviews: DeveloperReview[]): {
  author: string;
  at: string | null;
  texts: Array<{ key: string; text: string }>;
  replyId: number | null;
} {
  const first = reviews[0];
  // 리뷰 본문이 먼저, 줄마다 단 코멘트가 뒤 — 옛 대화록과 같은 차례.
  const ordered = [
    ...reviews.filter((review) => review.kind === "review"),
    ...reviews.filter((review) => review.kind === "inline"),
  ].filter((review) => review.body.trim() !== "");
  return {
    author: first?.author ?? "",
    at: first?.at ?? null,
    texts:
      ordered.length > 0
        ? ordered.map((review) => ({ key: String(review.id), text: review.body }))
        : [{ key: "empty", text: L.chat.reviewText }],
    replyId: first?.id ?? null,
  };
}

/**
 * 제출 영수증(U3 · E5) — `개발자에게 제출했어요`(같은 요청에 더했으면 그 말) ·
 * 받을 개발자 · 내 한마디 · `제출한 내용 열기`. 요청이 아직 열려 있으면
 * `한마디 더` 상자가 같은 발 밑에 선다(U20): 잘못 보냈거나 덧붙일 말을
 * 대화를 떠나지 않고 개발자에게 남긴다.
 */
export function ReceiptCard({
  block,
  more,
  handoff,
  onNote,
  onToast,
}: {
  block: Extract<Block, { type: "milestone" }>;
  more: boolean;
  handoff: RepoStatus["handoff"];
  onNote: (text: string) => Promise<void>;
  onToast: (text: string) => void;
}) {
  const same = handoff && handoff.number === block.pr ? handoff : null;
  const reviewers = same?.reviewers?.length
    ? same.reviewers
    : block.reviewer
      ? [block.reviewer]
      : [];
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteSentAt, setNoteSentAt] = useState<string | null>(null);
  const noteOk = noteAllowed(block, handoff);
  return (
    <div className="nx-card nx-card--receipt">
      <div className="nx-ch">
        <span className="nx-okc">
          <CheckIcon />
        </span>
        <b>{more ? L.cards.receiptMore : L.cards.receiptFirst}</b>
        <span className="nx-time">{clockOf(block.at)}</span>
      </div>
      {(reviewers.length > 0 || block.note) && (
        <div className="nx-cs">
          {reviewers.length > 0 && (
            <div>
              {L.cards.receiptReviewers(reviewers.length)} · {reviewers.join(" · ")}
            </div>
          )}
          {block.note && <div>{L.cards.receiptNote(block.note)}</div>}
        </div>
      )}
      {(same?.url || noteOk) && (
        <div className="nx-cfoot">
          {same?.url && (
            <a
              className="nx-btn nx-btn--sm"
              href={same.url}
              target="_blank"
              rel="noreferrer"
              onClick={linkClick}
            >
              {L.vocab.openSubmitted}
              <ExtIcon />
            </a>
          )}
          {noteOk && (
            <button
              type="button"
              className="nx-btn nx-btn--sm"
              onClick={() => setNoteOpen((open) => !open)}
            >
              {L.cards.noteMore}
            </button>
          )}
        </div>
      )}
      {noteOpen && noteOk && (
        <ReplyBox
          placeholder={L.cards.notePlaceholder}
          onSend={onNote}
          onSent={() => {
            const time = clockOf(Date.now());
            setNoteSentAt(time);
            setNoteOpen(false);
            onToast(L.cards.noteSent(time));
          }}
        />
      )}
      {noteSentAt && (
        <div className="nx-reply-sent">
          <CheckIcon />
          <span>{L.cards.noteSent(noteSentAt)}</span>
        </div>
      )}
    </div>
  );
}

type RepoCommands = NonNullable<RepoStatus["commands"]>;

/**
 * 확인 카드 — AI 가 물어보거나(질문) 무엇을 해도 되는지 묻는다(허용). 질문이 하나
 * · 고르기 하나면 누르는 순간 답이 간다(목업 `card.ask`); 여럿이면 다 고른 뒤
 * 보낸다. 어느 질문이든 `직접 답하기` 로 자기 말을 쓸 수 있다.
 */
export function AskCard({
  request,
  commands,
  onQuestion,
  onPermission,
}: {
  request: PendingQuestion | PendingPermission;
  commands?: RepoCommands;
  onQuestion: (answers: Record<string, string | string[]>) => void;
  onPermission: (decision: "allow" | "deny") => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [free, setFree] = useState<Record<string, string>>({});
  const [freeOpen, setFreeOpen] = useState<Record<string, boolean>>({});
  const [sent, setSent] = useState(false);

  if (request.kind === "permission") {
    // 레포가 정한 명령은 이름으로(`레포 검사`) — 날 명령줄은 보이지 않는다(홈 인박스와 같은 판정).
    const raw = (() => {
      if (request.toolName === "Bash") {
        const input = request.input as { command?: unknown } | null;
        const line = typeof input?.command === "string" ? input.command.trim() : "";
        const named = bashHeadline(line, commands);
        if (line && named !== line) return named;
      }
      return toolLabel(request.toolName);
    })();
    return (
      <div className="nx-card nx-card--ask" role="alert">
        <div className="nx-ch">
          <SparkIcon />
          <b>{L.cards.askTitle}</b>
        </div>
        <div className="nx-ctext">{L.inbox.askPermission(raw)}</div>
        <div className="nx-opts">
          <button
            type="button"
            className="nx-btn nx-btn--pri"
            disabled={sent}
            onClick={() => {
              setSent(true);
              onPermission("allow");
            }}
          >
            {L.inbox.allow}
          </button>
          <button
            type="button"
            className="nx-btn"
            disabled={sent}
            onClick={() => {
              setSent(true);
              onPermission("deny");
            }}
          >
            {L.inbox.deny}
          </button>
        </div>
      </div>
    );
  }

  const questions = request.questions;
  const single = questions.length === 1 && !questions[0]?.multiSelect;
  const picked = (q: AskQuestion, label: string) => {
    const value = answers[q.question];
    return Array.isArray(value) ? value.includes(label) : value === label;
  };
  const merged = (): Record<string, string | string[]> => {
    const out = { ...answers };
    for (const [question, text] of Object.entries(free))
      if (text.trim()) out[question] = text.trim();
    return out;
  };
  const complete = questions.every((q) => {
    const value = merged()[q.question];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });
  const send = (out: Record<string, string | string[]>) => {
    if (sent) return;
    setSent(true);
    onQuestion(out);
  };
  const pick = (q: AskQuestion, label: string) => {
    if (single) {
      send({ [q.question]: label });
      return;
    }
    setAnswers((prev) => {
      if (!q.multiSelect) return { ...prev, [q.question]: label };
      const current = prev[q.question];
      const list = Array.isArray(current) ? current : current ? [current] : [];
      return {
        ...prev,
        [q.question]: list.includes(label) ? list.filter((l) => l !== label) : [...list, label],
      };
    });
  };

  return (
    <div className="nx-card nx-card--ask" role="alert">
      <div className="nx-ch">
        <SparkIcon />
        <b>{L.cards.askTitle}</b>
      </div>
      {questions.map((q) => (
        <div key={q.question} className="nx-ask-q">
          <div className="nx-ctext">{q.question}</div>
          <div className="nx-opts">
            {q.options.map((option) => (
              <button
                key={option.label}
                type="button"
                className={`nx-btn${picked(q, option.label) ? " nx-btn--picked" : ""}`}
                title={option.description || undefined}
                disabled={sent}
                onClick={() => pick(q, option.label)}
              >
                {option.label}
              </button>
            ))}
            <button
              type="button"
              className="nx-btn nx-btn--ghost"
              disabled={sent}
              onClick={() => setFreeOpen((prev) => ({ ...prev, [q.question]: true }))}
            >
              {L.cards.askFree}
            </button>
          </div>
          {freeOpen[q.question] && (
            <div className="nx-reply">
              <input
                // biome-ignore lint/a11y/noAutofocus: 직접 답하기를 누른 손이 곧 쓸 자리다.
                autoFocus
                value={free[q.question] ?? ""}
                placeholder={L.cards.askFree}
                aria-label={L.cards.askFree}
                onChange={(event) =>
                  setFree((prev) => ({ ...prev, [q.question]: event.target.value }))
                }
                onKeyDown={(event) => {
                  if (composing(event)) return;
                  if (event.key === "Enter" && single) {
                    event.preventDefault();
                    const text = (free[q.question] ?? "").trim();
                    if (text) send({ [q.question]: text });
                  }
                }}
              />
              {single && (
                <button
                  type="button"
                  className="nx-btn nx-btn--sm nx-btn--pri"
                  disabled={sent || !(free[q.question] ?? "").trim()}
                  onClick={() => send({ [q.question]: (free[q.question] ?? "").trim() })}
                >
                  {L.inbox.send}
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      {!single && (
        <div className="nx-cfoot">
          <button
            type="button"
            className="nx-btn nx-btn--sm nx-btn--pri"
            disabled={!complete || sent}
            onClick={() => send(merged())}
          >
            {L.inbox.send}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * AI 답 실패 카드 — `AI가 답을 못 했어요` · 이유 한 문장 · `다시 시도`(마지막
 * 실패만, 같은 말을 다시 보낸다). 스스로 다시 묻기를 다 쓴 실패(escalated)는
 * 앞에 `조금씩 기다리며 다섯 번 다시 물었어요` 줄이 선다(부르는 쪽).
 */
export function FailCard({
  why,
  notified,
  retry,
  live,
}: {
  why: string;
  notified: boolean;
  retry: (() => void) | null;
  live: boolean;
}) {
  return (
    <div className="nx-card nx-card--fail">
      <div className="nx-ch">
        <AlertIcon />
        <b>{L.cards.failTitle}</b>
      </div>
      <div className="nx-cs">
        {why}
        {notified && ` ${L.chat.failNotified}`}
      </div>
      {retry && (
        <div className="nx-cfoot">
          <button
            type="button"
            className="nx-btn nx-btn--sm nx-btn--pri"
            disabled={live}
            title={live ? L.chat.retryLive : undefined}
            onClick={retry}
          >
            {L.vocab.retry}
          </button>
        </div>
      )}
    </div>
  );
}
