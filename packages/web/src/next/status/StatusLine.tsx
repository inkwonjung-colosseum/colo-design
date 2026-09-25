import { useEffect, useRef, useState } from "react";
import { L } from "../labels";
import type { SubmitCopy } from "../lib/submit-copy";
import type { StatusLineProps } from "../slots";
import { MenuIcon, PanelIcon, Spin } from "../ui/icons";
import { Elapsed } from "./Elapsed";
import { FailIcon, SentIcon } from "./parts";
import { SubmitPopover } from "./SubmitPopover";
import type { WorkLedger } from "./use-work-ledger";
import { WorkPopover } from "./WorkPopover";

/** `제출됐어요` · `제출하지 못했어요` 가 버튼에 머무는 시간(U3 · U13). */
const DONE_MS = 2000;
const FAILED_MS = 3000;
/** 이보다 오래된 영수증은 방금 도착한 것이 아니다 — 대화를 다시 읽은 것이다. */
const FRESH_RECEIPT_MS = 30_000;

/**
 * 상태 줄(U2) — 대화와 미리보기 위에 걸친 한 줄. 왼쪽은 대화 제목, 오른쪽은
 * 여정 세 점과 `제출`. AI 가 도는 동안 여정 앞에 `만드는 중 · 12초` 가 붙는다.
 * 좁은 창(U16)에서는 제목이 빠지고 지금 점만 글자를 갖는다.
 *
 * 제출 버튼은 언제나 그려진다. 잠겼으면 누를 때 이유 한 줄이 버튼 아래 선다
 * (목업 `showWhy`); 열렸으면 확인 한 장(U3, `SubmitPopover`). 버튼은 스스로
 * 답한다 — `제출하는 중…` → `제출됐어요`(2초), `다시 제출하는 중…`, 막히면
 * 3초 붉은 `제출하지 못했어요` 뒤 잠긴다(이유는 `submitCopy`). 막힘의 문제
 * 문장은 대화 칸(단계 2 의 ProblemLine)의 것이라 여기서 그리지 않는다.
 */
export function StatusLine({
  daemon,
  sessions,
  project,
  title,
  journey,
  turnStartedAt,
  narrow,
  onSubmit,
  ledger,
  submitCopy,
  sidebarHidden,
  onOpenSidebar,
}: StatusLineProps & {
  /** 셸이 한 번 부른 `useWorkLedger` — 코멘트 · 작업 기록 · 영수증의 시각. */
  ledger: WorkLedger;
  /** 셸이 여정에 건넨 것과 같은 제출 상태의 문장. */
  submitCopy: SubmitCopy;
  /** 사이드바가 접혀(넓은 창) 있거나 서랍 뒤(좁은 창)에 있다 — 여는 단추가 선다. */
  sidebarHidden: boolean;
  onOpenSidebar: () => void;
}) {
  const [workOpen, setWorkOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const journeyRef = useRef<HTMLButtonElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const [why, setWhy] = useState<string | null>(null);
  useEffect(() => {
    if (!why) return;
    const timer = setTimeout(() => setWhy(null), 3200);
    return () => clearTimeout(timer);
  }, [why]);
  const { submit } = journey;

  // 보낸 순간부터 데몬이 `running` 을 싣기까지의 틈 — 버튼이 먼저 답한다.
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (submitCopy.phase !== "idle") setSending(false);
  }, [submitCopy.phase]);

  // 버튼의 짧은 답 — `done` 은 영수증(cycle.handed)이, `failed` 는 막힘의 시작이 켠다.
  const [flash, setFlash] = useState<"done" | "failed" | null>(null);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), flash === "done" ? DONE_MS : FAILED_MS);
    return () => clearTimeout(timer);
  }, [flash]);
  const lastHanded = useRef(ledger.handedAt);
  useEffect(() => {
    const previous = lastHanded.current;
    lastHanded.current = ledger.handedAt;
    if (!ledger.handedAt || ledger.handedAt === previous) return;
    if (Date.now() - Date.parse(ledger.handedAt) > FRESH_RECEIPT_MS) return;
    setSending(false);
    setFlash("done");
  }, [ledger.handedAt]);
  const lastPhase = useRef(submitCopy.phase);
  useEffect(() => {
    const previous = lastPhase.current;
    lastPhase.current = submitCopy.phase;
    if (submitCopy.phase === previous) return;
    if (submitCopy.phase === "blocked") setFlash("failed");
    // 영수증이 이 창에 닿지 않는 대화로 갔어도 — 도는 제출이 끝나 요청이 섰으면 보냈다.
    else if (
      submitCopy.phase === "idle" &&
      (previous === "running" || previous === "retrying") &&
      daemon.repo?.handoff
    ) {
      setFlash("done");
    }
  }, [submitCopy.phase, daemon.repo?.handoff]);

  const busy = submit.busy ?? (sending ? "running" : null);
  const reviewers =
    submit.more && daemon.repo?.handoff?.reviewers && daemon.repo.handoff.reviewers.length > 0
      ? daemon.repo.handoff.reviewers
      : (project?.reviewers ?? []);

  const send = (note: string) => {
    setConfirmOpen(false);
    // 창이 열린 사이에 AI 가 돌기 시작했으면 — 잠긴 이유로 답한다.
    if (!journey.submit.enabled) {
      setWhy(journey.submit.reason);
      return;
    }
    setSending(true);
    onSubmit();
    daemon.api
      .submit(sessions.activeId, note || undefined)
      .catch((error) => {
        console.error("[colo-design] submit", error);
        setWhy(L.submit.sendFailed);
      })
      .finally(() => setSending(false));
  };

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
          onClick={() => {
            if (!workOpen) ledger.refresh();
            setConfirmOpen(false);
            setWorkOpen((open) => !open);
          }}
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
          <WorkPopover
            anchor={journeyRef}
            journey={journey}
            project={project}
            repo={daemon.repo}
            ledger={ledger}
            author={daemon.status?.authorName ?? null}
            since={submitCopy.lastAt}
            onClose={() => setWorkOpen(false)}
          />
        )}
      </div>
      <div className="nx-anchor">
        <button
          ref={submitRef}
          type="button"
          className={`nx-submit${
            flash === "done"
              ? " nx-submit--sent"
              : flash === "failed"
                ? " nx-submit--failed"
                : busy
                  ? " nx-submit--busy"
                  : submit.enabled
                    ? ""
                    : " nx-submit--locked"
          }`}
          title={submit.reason}
          aria-disabled={!submit.enabled || busy !== null}
          aria-haspopup="dialog"
          aria-expanded={confirmOpen}
          aria-busy={busy !== null || undefined}
          onClick={() => {
            if (busy || flash === "done") return;
            if (!submit.enabled) {
              setConfirmOpen(false);
              setWhy(submit.reason);
              return;
            }
            setWhy(null);
            setWorkOpen(false);
            if (!confirmOpen) ledger.refresh();
            setConfirmOpen((open) => !open);
          }}
        >
          {flash === "done" ? (
            <>
              <SentIcon />
              {L.submit.done}
            </>
          ) : flash === "failed" ? (
            <>
              <FailIcon />
              {submitCopy.label}
            </>
          ) : busy ? (
            <>
              <Spin />
              {busy === "retrying" ? L.submit.retrying : L.submit.running}
            </>
          ) : (
            L.submit.idle
          )}
        </button>
        {confirmOpen && (
          <SubmitPopover
            anchor={submitRef}
            journey={journey}
            repo={daemon.repo}
            history={ledger.history}
            since={submitCopy.lastAt}
            reviewers={reviewers}
            onClose={() => setConfirmOpen(false)}
            onConfirm={send}
          />
        )}
        {why && (
          <div className="nx-why" role="status">
            {why}
          </div>
        )}
      </div>
    </header>
  );
}
