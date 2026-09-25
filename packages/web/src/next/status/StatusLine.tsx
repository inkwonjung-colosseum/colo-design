import { useEffect, useRef, useState } from "react";
import { L } from "../labels";
import type { StatusLineProps } from "../slots";
import { MenuIcon, PanelIcon, Spin } from "../ui/icons";
import { Elapsed } from "./Elapsed";
import { WorkPopover } from "./WorkPopover";

/**
 * 상태 줄(U2) — 대화와 미리보기 위에 걸친 한 줄. 왼쪽은 대화 제목, 오른쪽은
 * 여정 세 점과 `제출`. AI 가 도는 동안 여정 앞에 `만드는 중 · 12초` 가 붙는다.
 * 좁은 창(U16)에서는 제목이 빠지고 지금 점만 글자를 갖는다.
 *
 * 제출 버튼은 언제나 그려진다. 잠겼으면 누를 때 이유 한 줄이 버튼 아래 선다
 * (목업 `showWhy`); 열렸으면 `onSubmit` — 단계 4 가 확인 팝오버(U3)로 바꾼다.
 */
export function StatusLine({
  title,
  journey,
  turnStartedAt,
  narrow,
  onSubmit,
  sidebarHidden,
  onOpenSidebar,
}: StatusLineProps & {
  /** 사이드바가 접혀(넓은 창) 있거나 서랍 뒤(좁은 창)에 있다 — 여는 단추가 선다. */
  sidebarHidden: boolean;
  onOpenSidebar: () => void;
}) {
  const [workOpen, setWorkOpen] = useState(false);
  const journeyRef = useRef<HTMLButtonElement>(null);
  const [why, setWhy] = useState<string | null>(null);
  useEffect(() => {
    if (!why) return;
    const timer = setTimeout(() => setWhy(null), 3200);
    return () => clearTimeout(timer);
  }, [why]);
  const { submit } = journey;

  return (
    <header
      className={`nx-statusbar nx-cycle--${journey.cycle}${journey.blocked ? " nx-blocked" : ""}`}
    >
      {sidebarHidden && (
        <button
          type="button"
          className="nx-ibtn"
          title={narrow ? L.shell.menu : L.sidebar.expand}
          aria-label={narrow ? L.shell.menu : L.sidebar.expand}
          onClick={onOpenSidebar}
        >
          {narrow ? <MenuIcon /> : <PanelIcon />}
        </button>
      )}
      {!narrow && <div className="nx-conv-title">{title}</div>}
      <div className="nx-grow" />
      <div className="nx-anchor">
        <button
          ref={journeyRef}
          type="button"
          className="nx-journey"
          title={L.journey.openWork}
          aria-haspopup="dialog"
          aria-expanded={workOpen}
          onClick={() => setWorkOpen((open) => !open)}
        >
          {journey.making && (
            <span className="nx-making">
              <Spin />
              {L.journey.making}
              {turnStartedAt !== null && <Elapsed startedAt={turnStartedAt} />}
            </span>
          )}
          {journey.points.map((point, index) => (
            <span key={point.label} className="nx-jwrap">
              {index > 0 && <span className="nx-jbar" aria-hidden="true" />}
              <span className={`nx-jstep nx-jstep--${point.state}`}>
                <i aria-hidden="true" />
                {(!narrow || index === journey.current) && (
                  <span className="nx-jl">{point.label}</span>
                )}
              </span>
            </span>
          ))}
        </button>
        {workOpen && (
          <WorkPopover anchor={journeyRef} journey={journey} onClose={() => setWorkOpen(false)} />
        )}
      </div>
      <div className="nx-anchor">
        <button
          type="button"
          className={`nx-submit${submit.busy ? " nx-submit--busy" : submit.enabled ? "" : " nx-submit--locked"}`}
          title={submit.reason}
          aria-disabled={!submit.enabled}
          onClick={() => {
            if (submit.busy) return;
            if (!submit.enabled) {
              setWhy(submit.reason);
              return;
            }
            setWhy(null);
            onSubmit();
          }}
        >
          {submit.busy && <Spin />}
          {submit.busy === "running"
            ? L.submit.running
            : submit.busy === "retrying"
              ? L.submit.retrying
              : L.submit.idle}
        </button>
        {why && (
          <div className="nx-why" role="status">
            {why}
          </div>
        )}
      </div>
    </header>
  );
}
