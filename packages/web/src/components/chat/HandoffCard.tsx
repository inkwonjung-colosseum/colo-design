/**
 * 제출의 영수증 (PLAN 단계 10): 제출이 무사히 끝난 뒤 대화 안에 한 번 서는
 * 카드다 — 누구에게 갔는지(개발자 수) · 링크 · 되돌리기 시한 안내. 모달이
 * 아니라 대화 안 카드라 포커스 함정도 백드롭도 없고, Escape 는 접기일 뿐이다.
 * 보내기 전에 제목·본문을 미리 보던 검토 자리는 제출이 `repo.submit` 한 번으로
 * 바뀌며 걷혔다 — 제목과 본문은 도구가 정한다(PLAN L6).
 */
import type { HandoffStatus } from "@colo-design/protocol";
import { useEffect } from "react";
import { CopyButton } from "../../components";
import type { Daemon } from "../../lib/daemon-client";
import { linkClick } from "../../lib/open-link";
import { ExternalLinkIcon, HandoffIcon, LinkIcon } from "../icons";
import { Tip } from "../shell/Tip";

/**
 * The three words the planner is allowed to know. GitHub reports a
 * review verdict alongside the request's own state, and both arrive here as
 * `state`; `closed` is the one outcome with no word of its own.
 */
const HANDOFF_STATE_LABEL: Record<HandoffStatus["state"], string> = {
  open: "제출했어요",
  changes_requested: "변경 요청",
  merged: "반영됨",
  // E2: 칩과 같은 말 — 개발자가 닫았다는 것을 사용자의 말로.
  closed: "개발자가 반려함",
};

export interface HandoffCardProps {
  daemon: Daemon;
  onClose: () => void;
}

export function HandoffCard({ daemon, onClose }: HandoffCardProps) {
  const diffStatus = daemon.diffStatus;
  const handoff = diffStatus?.handoff ?? null;

  // 카드는 모달이 아니다: Escape 는 접기일 뿐이다.
  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [onClose]);

  return (
    <div className="handoffcard" role="group" aria-label="제출 영수증">
      <div className="handoffcard__head">
        <span className="savecard__ic">
          <HandoffIcon />
        </span>
        <div className="savecard__tt">
          <strong>개발자에게 보냈어요</strong>
          <span className="savecard__sub">제출한 내용은 개발자가 검토하고 있어요</span>
        </div>
        <Tip label="영수증 접기" side="bottom">
          <button type="button" className="ghost" aria-label="영수증 접기" onClick={onClose}>
            ×
          </button>
        </Tip>
      </div>

      <div className="handoffcard__body">
        {handoff && (
          <div className="handoff__done">
            <a
              className="preview__link"
              href={handoff.url}
              target="_blank"
              rel="noreferrer"
              onClick={linkClick}
            >
              <ExternalLinkIcon />
              보낸 내용 열기
            </a>
            <CopyButton value={handoff.url} label="링크 복사" icon={<LinkIcon size={12} />} />
            <span className="handoff__state">{HANDOFF_STATE_LABEL[handoff.state]}</span>
            {/* 누구에게 갔는지는 수로만 말한다(PLAN 단계 10) — 리뷰어의
                로그인은 개발자의 어휘이다. 비어 있으면 그 사실이 곧 안내다:
                링크를 개발자에게 직접 들고 가라. */}
            {handoff.reviewers !== undefined && handoff.reviewers.length > 0 ? (
              <p className="hint" data-testid="handoff-reviewers">
                개발자 {handoff.reviewers.length}명에게 갔습니다
              </p>
            ) : (
              handoff.reviewers !== undefined && (
                <p className="hint" data-testid="handoff-reviewers">
                  이 레포는 리뷰어를 자동 지정하지 않습니다 — 링크 복사로 개발자에게 보내 주세요.
                </p>
              )
            )}
          </div>
        )}
        {/* 되돌리기의 시한 — 결정이 내려지는 자리에 둔다. 도입 문단에 있을
            때는 세 문장 중 하나로 흘려 읽혔다. */}
        <p className="hint">
          개발자가 반영하면 이 작업의 되돌리기 기록이 지워집니다 — 그 전까지는 이 앱에서 되돌릴 수
          있습니다.
        </p>

        <div className="savecard__actions">
          <button type="button" className="primary" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
