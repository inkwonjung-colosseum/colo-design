/**
 * 넘기기 카드 (구 panels/HandoffPanel.tsx): 개발자가 읽을 것의 렌더
 * 미리보기(제목·본문 = `handoffDraft()`), 자동 첨부 명시(`### 수정 요청` ·
 * `### 화면 미리보기`), `직접 고치기` 폴드, 목적지 표기,
 * `DEFAULT_HANDOFF_BODY` 폴백. 모달이 아니라 대화 안 카드다 — 포커스 함정도
 * 백드롭도 없고, Escape 는 접기일 뿐이다.
 */
import { DEFAULT_HANDOFF_BODY, type HandoffStatus } from "@colo-design/protocol";
import { useEffect, useRef, useState } from "react";
import { CopyButton } from "../../components";
import type { Daemon } from "../../lib/daemon-client";
import { mergeHandoffBody } from "../../lib/handoff-draft";
import { linkClick } from "../../lib/open-link";
import { ExternalLinkIcon, FileIcon, HandoffIcon, LinkIcon, StepsIcon } from "../icons";
import { Markdown } from "../Markdown";
import { RUNNING, stageLine } from "../panels/DiffPanel";
import { Tip } from "../shell/Tip";

/**
 * The three words the planner is allowed to know. GitHub reports a
 * review verdict alongside the request's own state, and both arrive here as
 * `state`; `closed` is the one outcome with no word of its own.
 */
const HANDOFF_STATE_LABEL: Record<HandoffStatus["state"], string> = {
  open: "넘김",
  changes_requested: "변경 요청",
  merged: "반영됨",
  // E2: 칩과 같은 말 — 개발자가 닫았다는 것을 사용자의 말로.
  closed: "개발자가 반려함",
};

export interface HandoffCardProps {
  daemon: Daemon;
  /** 목적지: 넘긴 요청이 향할 회사 저장소의 이름(owner/repo). */
  destination?: string | null;
  /** 브라우저의 초안 제안 — 데몬 초안 전의 첫 모습(빈 형태 금지). */
  proposedTitle: string;
  proposedBody: string;
  /** The live 화면 thread; a failing gate lands in it as the agent.s next task. */
  sessionId: string | null;
  onClose: () => void;
}

export function HandoffCard({
  daemon,
  destination,
  proposedTitle,
  proposedBody,
  sessionId,
  onClose,
}: HandoffCardProps) {
  const [title, setTitle] = useState(proposedTitle);
  const [body, setBody] = useState(proposedBody);
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  /** 첫 넘기기 코치 — 넘긴 뒤 무엇을 기다리면 되는지의 세 걸음. 핀 코치와
      같은 한 번 패턴(localStorage 가 진실): 닫기를 누르거나 넘기기가
      성공하면 다시 오지 않는다. 실제로 넘겨 본 사람에게는 소음이고, 검토
      중의 다음 말은 스테이지 줄과 상태 칩이 이미 하고 있기 때문이다.
      지움은 두 자리(닫기·성공)에서 같은 세 줄로 인라인 — 핀 코치의
      선례와 한 모양이다. */
  const [coachOpen, setCoachOpen] = useState(() => {
    try {
      return localStorage.getItem("colo-design.handoff-coach-seen") !== "1";
    } catch {
      return true;
    }
  });
  /** Whether the text on screen is the agent.s — said out loud on the preview. */
  const [drafted, setDrafted] = useState(false);
  /** The daemon's own appended sections — the preview's 자동 첨부. */
  const [extras, setExtras] = useState<{
    commentsSection: string | null;
    /** `### 바뀐 파일` — 실제 본문에 붙는 같은 문자열. */
    filesSection: string | null;
    shotCount: number;
  } | null>(null);
  /** Once the planner types, the draft stops landing in that field. */
  const titleTouched = useRef(false);
  const bodyTouched = useRef(false);
  const diffStatus = daemon.diffStatus;
  const running = diffStatus !== null && RUNNING.includes(diffStatus.stage);
  const handedOff = diffStatus?.stage === "handed-off";
  const failed = diffStatus?.stage === "failed";
  const handoff = handedOff ? (diffStatus?.handoff ?? null) : null;
  /**
   * 이 카드가 낼 소식만 (비개발자 넘기기): `diff.status` 는 저장과 넘기기가
   * 함께 쓰는 한 채널이라, 방금 끝난 저장의 `저장했습니다` 가 아직 실려 있다.
   * 저장 카드가 이미 보고한 문장이고 — 특히 저장 카드의 복도에서 곧장 이어 온
   * 길에서는 — 카드 위에 떠 있으면 "지금 무슨 일이 일어났나"로 읽힌다.
   * 가라앉히는 것은 그 한 단계뿐이다: 실패도, 넘기는 중도 그대로 말한다.
   */
  const stageWorthSaying = diffStatus !== null && diffStatus.stage !== "published";
  /**
   * The call rides the STABLE `api`, not the `daemon` prop: the client hands
   * out a fresh wrapper every render, and a websocket message landing while
   * this card is open would otherwise cancel an in-flight draft — a real
   * agent turn — and ask it again from scratch.
   */
  const { api } = daemon;

  // 비개발자 넘기기: the card opens on the browser's proposal — the project
  // name and the pins' screens — and asks the daemon for the sentences a
  // developer reads first plus the sections the daemon appends on its own.
  // Empty answer (no CLI, timeout, refusal) leaves the proposal exactly as it
  // was, so the card is never worse than before.
  useEffect(() => {
    let cancelled = false;
    setDrafting(true);
    api
      .handoffDraft()
      .then((draft) => {
        if (cancelled) return;
        // The extras answer even when the draft itself could not — a pin
        // history and the capture count are mechanical facts, not prose.
        if (draft.extras) setExtras(draft.extras);
        if (draft.source !== "machine") return;
        if (draft.title && !titleTouched.current) setTitle(draft.title);
        if (draft.body && !bodyTouched.current) setBody(mergeHandoffBody(draft.body));
        if (draft.title || draft.body) setDrafted(true);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setDrafting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // 카드는 모달이 아니다: Escape 는 접기일 뿐이고, 도는 넘기기의 진행
  // 줄은 카드가 닫혀도 자리를 지킨다 — 끝나야 접힌다(구 패널과 같은 규율).
  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !running) onClose();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [onClose, running]);

  const hand = async () => {
    setError(null);
    try {
      await api.handoff({
        title: title.trim() || undefined,
        body: body.trim() || undefined,
        sessionId,
      });
      // 넘겨 본 사람에게 코치는 다시 오지 않는다 — 닫기와 같은 몫.
      setCoachOpen(false);
      try {
        localStorage.setItem("colo-design.handoff-coach-seen", "1");
      } catch {
        // 저장 실패는 치명적이지 않다 — 다음 실행에 한 번 더 보일 뿐.
      }
    } catch (e) {
      // The card stays open on purpose: the reason is usually something the
      // planner can answer (a gate to fix, a token to renew) and then retry.
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // What the developer actually reads. A field left blank lets the daemon's
  // own proposal win, so the preview shows that same fallback rather than an
  // empty card.
  const previewTitle = title.trim() || proposedTitle;
  const previewBody = body.trim() || DEFAULT_HANDOFF_BODY;
  // The capture count the daemon computed is the truth; the browser's own
  // notice is only the placeholder until the draft lands.
  const shotCount = extras?.shotCount ?? null;

  return (
    <div className="handoffcard" role="group" aria-label="개발자에게 넘기기">
      <div className="handoffcard__head">
        <span className="savecard__ic">
          <HandoffIcon />
        </span>
        <div className="savecard__tt">
          <strong>개발자에게 넘기기</strong>
          <span className="savecard__sub">
            {destination
              ? `${destination} · 저장된 화면을 검토 요청으로 넘깁니다`
              : "저장된 화면을 검토 요청으로 넘깁니다"}
          </span>
        </div>
        <Tip
          label={running ? "넘기기가 진행 중입니다 — 끝나면 접을 수 있습니다" : "넘기기 카드 접기"}
        >
          <button
            type="button"
            className="ghost"
            aria-label="넘기기 카드 접기"
            aria-disabled={running}
            onClick={() => {
              if (!running) onClose();
            }}
          >
            ×
          </button>
        </Tip>
      </div>

      <div className="handoffcard__body">
        <p className="hint">
          아래가 개발자에게 갈 모습입니다. 읽어 보고 그대로 넘기면 됩니다 — 고치고 싶으면 아래 직접
          고치기를 열어 주세요.
        </p>

        {coachOpen && !handedOff && !running && (
          <div className="notice notice--info handoff__coach">
            <span className="notice__text">
              처음 넘기기예요 — 넘기면 ① 회사 저장소에 확인 요청이 열리고, ② 개발자가 검토한 뒤
              합쳐지면 상태 칩이 「반영됐어요」가 됩니다. 코멘트가 달리면 이 대화로 다시 돌아와요.
            </span>
            <button
              type="button"
              className="ghost"
              aria-label="처음 넘기기 안내 닫기"
              onClick={() => {
                setCoachOpen(false);
                try {
                  localStorage.setItem("colo-design.handoff-coach-seen", "1");
                } catch {
                  // 저장 실패는 치명적이지 않다 — 다음 실행에 한 번 더 보일 뿐.
                }
              }}
            >
              닫기
            </button>
          </div>
        )}

        {stageWorthSaying && diffStatus && (
          <div
            className={
              handedOff ? "notice notice--info" : failed ? "notice notice--error" : "diff__stage"
            }
            role={handedOff || failed ? "status" : undefined}
          >
            <span className="notice__text">{stageLine(diffStatus)}</span>
            {running && <span className="spinner" />}
          </div>
        )}
        {failed && diffStatus?.gate === "pr" && (
          <div className="notice notice--error" data-testid="pr-failure">
            <span className="notice__text">
              저장까지는 끝냈고, 개발자에게 넘기기에서 멈췄습니다 — 설정(⌘K → 설정)에서 토큰과 레포
              주소를 확인한 뒤 다시 넘길 수 있습니다.
            </span>
          </div>
        )}
        {failed && diffStatus?.gate !== "pr" && diffStatus?.detail && (
          <details className="settings__fold">
            <summary>자세히</summary>
            <pre className="diff__fail">
              <code>{diffStatus.detail}</code>
            </pre>
          </details>
        )}

        {error && (
          <div className="notice notice--error">
            <span className="notice__text">{error}</span>
          </div>
        )}

        {handedOff ? (
          handoff && (
            <div className="handoff__done">
              <a
                className="preview__link"
                href={handoff.url}
                target="_blank"
                rel="noreferrer"
                onClick={linkClick}
              >
                <ExternalLinkIcon />
                넘긴 내용 열기
              </a>
              <CopyButton value={handoff.url} label="링크 복사" icon={<LinkIcon size={12} />} />
              <span className="handoff__state">{HANDOFF_STATE_LABEL[handoff.state]}</span>
              {/* 리뷰어 보고: 고르지 않고 읽는다 — GitHub 이
                  보고한 요청 리뷰어. 비어 있으면 그 사실이 곧 안내다: 링크를
                  개발자에게 직접 들고 가라. 도구는 사람을 지정하지 않는다. */}
              {handoff.reviewers !== undefined && handoff.reviewers.length > 0 ? (
                <p className="hint" data-testid="handoff-reviewers">
                  개발자 {handoff.reviewers.length}명에게 갔습니다 · {handoff.reviewers.join(" · ")}
                </p>
              ) : (
                handoff.reviewers !== undefined && (
                  <p className="hint" data-testid="handoff-reviewers">
                    이 레포는 리뷰어를 자동 지정하지 않습니다 — 링크 복사로 개발자에게 보내 주세요.
                  </p>
                )
              )}
              <p className="hint">
                개발자가 코멘트를 남기면 상태 확인에서 읽고 이어 갈 수 있습니다. 반영되면 다음
                저장이 새 작업을 시작합니다.
              </p>
            </div>
          )
        ) : (
          <>
            {/* 개발자가 받을 모습 — the pull request as the developer reads
                it, rendered instead of left as raw markdown. */}
            <div className="handoff__preview" data-testid="handoff-preview">
              <div className="handoff__previewhead">
                <span className="handoff__previewtitle">{previewTitle}</span>
                {drafted && <span className="handoff__drafted">AI가 쓴 초안</span>}
              </div>
              {drafting ? (
                <p className="hint">개발자가 읽을 제목과 내용을 만드는 중…</p>
              ) : (
                <Markdown text={previewBody} />
              )}
              {(extras?.filesSection || extras?.commentsSection || (shotCount ?? 0) > 0) && (
                <div className="handoff__auto">
                  <span className="handoff__autolabel">함께 담기는 것</span>
                  {extras?.filesSection && <Markdown text={extras.filesSection} />}
                  {extras?.commentsSection && <Markdown text={extras.commentsSection} />}
                  {(shotCount ?? 0) > 0 && (
                    <p className="hint">화면 미리보기 — 캡처 {shotCount}장</p>
                  )}
                </div>
              )}
            </div>

            {/* 직접 고치기: the words stay the planner's to own — one fold
                away, never the first thing the card asks for. */}
            <details className="settings__fold handoff__edit">
              <summary>직접 고치기</summary>
              <label className="setting setting--wide handoff__field">
                <span className="setting__text">
                  <span className="setting__label">
                    <span className="ic ic--quiet ic--sm">
                      <FileIcon />
                    </span>{" "}
                    제목
                  </span>
                  <span className="setting__hint">개발자가 목록에서 보는 한 줄입니다</span>
                </span>
                <span className="setting__control">
                  <input
                    value={title}
                    placeholder="예: 회원 관리 화면"
                    aria-label="넘길 제목"
                    disabled={running}
                    onChange={(e) => {
                      titleTouched.current = true;
                      setTitle(e.target.value);
                    }}
                  />
                </span>
              </label>

              <label className="setting setting--wide handoff__field">
                <span className="setting__text">
                  <span className="setting__label">
                    <span className="ic ic--quiet ic--sm">
                      <StepsIcon />
                    </span>{" "}
                    내용
                  </span>
                  <span className="setting__hint">
                    무엇을 만들었고 무엇을 봐 주면 되는지. AI가 저장한 내용을 읽고 먼저 채웁니다 —
                    고쳐 주세요
                  </span>
                </span>
                <span className="setting__control">
                  <textarea
                    className="handoff__body"
                    value={body}
                    placeholder="예: 목록·빈 상태·오류 상태를 만들었습니다."
                    aria-label="넘길 내용"
                    disabled={running}
                    onChange={(e) => {
                      bodyTouched.current = true;
                      setBody(e.target.value);
                    }}
                  />
                </span>
              </label>
            </details>
          </>
        )}

        {/* 되돌리기의 시한 — 결정이 내려지는 자리에 둔다. 도입 문단에 있을
            때는 세 문장 중 하나로 흘려 읽혔다. */}
        {!handedOff && (
          <p className="hint">
            개발자가 반영하면 이 작업의 되돌리기 기록이 지워집니다 — 그 전까지는 이 앱에서 되돌릴 수
            있습니다.
          </p>
        )}

        <div className="savecard__actions">
          {handedOff ? (
            <button type="button" className="primary" onClick={onClose}>
              닫기
            </button>
          ) : (
            <>
              <button
                type="button"
                className="primary"
                disabled={running}
                onClick={() => void hand()}
              >
                <span className="ic">
                  <HandoffIcon />
                </span>
                {running ? "넘기는 중…" : "개발자에게 넘기기"}
              </button>
              <button type="button" className="ghost" disabled={running} onClick={onClose}>
                접기
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
