import type { RepoHistoryEntry, RepoStatus } from "@colo-design/protocol";
import { type RefObject, useState } from "react";
import { composing } from "../../lib/ime";
import { L } from "../labels";
import type { Journey } from "../lib/journey";
import { outgoingScreens, outsideChanges } from "../lib/work-ledger";
import { Popover } from "../ui/Popover";
import { ScreenRow } from "./parts";

/**
 * 제출은 확인 한 장(PLAN-UI U3) — 열린 제출 버튼을 누르면 뜬다. 무엇이 가는지
 * (화면마다 한 줄, 가장 최근의 말) · 화면 밖 변경의 수 · `개발자에게 한마디` ·
 * 받을 개발자. 열린 요청이 있으면 제목이 `같은 요청에 더해 제출할까요?` 이고
 * 목록은 마지막 제출 뒤의 것이다. Enter 로 보낸다(한글 조합 중에는 아니다).
 */
export function SubmitPopover({
  anchor,
  journey,
  repo,
  history,
  since,
  reviewers,
  onClose,
  onConfirm,
}: {
  anchor: RefObject<HTMLElement | null>;
  journey: Journey;
  repo: RepoStatus | null;
  history: RepoHistoryEntry[] | null;
  /** 마지막 제출의 시각 — 열린 요청에 더할 때만 목록을 자른다. */
  since: string | null;
  reviewers: string[];
  onClose: () => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const more = journey.submit.more;
  const cut = more ? since : null;
  const screens = outgoingScreens(repo?.cycleScreens, cut);
  const outside = outsideChanges(history, repo?.cycleScreens, cut);
  const confirm = () => onConfirm(note.trim());

  return (
    <Popover anchor={anchor} onClose={onClose} align="end" className="nx-work-pop nx-submit-pop">
      <div className="nx-wp-h">
        <b>{more ? L.submitConfirm.titleMore : L.submitConfirm.title}</b>
        <div>{more ? L.submitConfirm.subMore : L.submitConfirm.sub}</div>
      </div>
      <div className="nx-wp-sec">
        <h5>
          {more && screens.length > 0
            ? L.submitConfirm.screensMore(screens.length)
            : L.submitConfirm.screens(screens.length)}
        </h5>
        {screens.map((screen) => (
          <ScreenRow key={screen.route} screen={screen} />
        ))}
        {outside > 0 && (
          <div className="nx-wp-outside">{L.submitConfirm.outsideScreens(outside)}</div>
        )}
        {screens.length === 0 && outside === 0 && (
          <div className="nx-wp-empty">{journey.submit.reason}</div>
        )}
      </div>
      <div className="nx-wp-sec nx-wp-sec--last">
        <h5>
          {L.submitConfirm.note}
          <span className="nx-wp-hr">{L.submitConfirm.optional}</span>
        </h5>
        <input
          className="nx-note-input"
          // biome-ignore lint/a11y/noAutofocus: 확인 한 장은 한마디 칸에서 시작한다 — Enter 가 곧 제출이다.
          autoFocus
          value={note}
          maxLength={500}
          placeholder={L.submitConfirm.notePlaceholder}
          aria-label={L.submitConfirm.note}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || composing(event)) return;
            event.preventDefault();
            confirm();
          }}
        />
      </div>
      <div className="nx-wp-foot">
        {reviewers.length > 0 && (
          <span className="nx-snote">{L.submitConfirm.reviewers(reviewers.join(" · "))}</span>
        )}
        <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={onClose}>
          {L.submitConfirm.cancel}
        </button>
        <button type="button" className="nx-btn nx-btn--pri nx-btn--sm" onClick={confirm}>
          {L.submitConfirm.confirm}
        </button>
      </div>
    </Popover>
  );
}
