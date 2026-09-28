import { useEffect, useRef, useState } from "react";
import { L } from "../labels";
import {
  FIRST_TURN_HINT_MS,
  heldPhase,
  MAKING_CHECK_MS,
  MAKING_HOLD_MS,
  type MakingPhase,
} from "../lib/making";
import type { SubmitCopy } from "../lib/submit-copy";
import {
  SUBMIT_SHAKE_MS,
  SUBMIT_STORY_BAR_MS,
  SUBMIT_STORY_POINT_MS,
  submitStoryPhase,
} from "../lib/submit-story";
import type { StatusLineProps } from "../slots";
import { MenuIcon, PanelIcon, Spin } from "../ui/icons";
import { Elapsed } from "./Elapsed";
import { DrawnCheck, FailIcon, SentIcon } from "./parts";
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
 * 여정 세 점과 `제출`. AI 가 도는 동안 여정 앞에 단계 말이 붙는다(단계 10) —
 * 지금 도는 도구의 묶음이 `화면을 살펴보는 중` · `화면 파일을 고치는 중` ·
 * `검사를 돌리는 중` 을 고르고, 첫 보내기가 60초를 넘으면 시계 뒤에
 * `처음은 몇 분 걸려요` 가 붙는다. 좁은 창은 단계 말만.
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
  makingPhase,
  firstTurn,
  narrow,
  nav,
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
  // 여정 단추의 접근 이름 — 보이는 몸(세 점 · 시계)은 매초 바뀌므로, 이름은
  // `이번 작업 보기` 와 지금 점의 글자만 갖고 몸은 낭독에서 빼 둔다.
  const workName = journey.points[journey.current]?.label
    ? L.journey.openWorkNow(journey.points[journey.current].label)
    : L.journey.openWork;
  const submitRef = useRef<HTMLButtonElement>(null);
  const [why, setWhy] = useState<string | null>(null);
  useEffect(() => {
    if (!why) return;
    const timer = setTimeout(() => setWhy(null), 3200);
    return () => clearTimeout(timer);
  }, [why]);
  const { submit } = journey;
  // 답이 끝나면 조각을 곧장 떼지 않는다 — 600ms 체크를 보인 뒤 접는다.
  // 타이머는 동작을 줄이는 탭에서도 돈다(움직임만 줄어든다).
  const [makingState, setMakingState] = useState<"off" | "on" | "check">("off");
  useEffect(() => {
    if (journey.making) {
      setMakingState("on");
      setWord(null);
      return;
    }
    setMakingState((prev) => (prev === "on" ? "check" : "off"));
  }, [journey.making]);
  useEffect(() => {
    if (makingState !== "check") return;
    const timer = window.setTimeout(() => setMakingState("off"), MAKING_CHECK_MS);
    return () => window.clearTimeout(timer);
  }, [makingState]);

  // 단계 말은 최소 1.5초 산다(making.ts 의 heldPhase) — 몇 초 사이에 묶음이
  // 바뀌어도 알약이 흔들리지 않게. 시간이 차면 지금의 단계로 곧장 갈아입는다.
  const [word, setWord] = useState<{ phase: MakingPhase; at: number } | null>(null);
  useEffect(() => {
    if (makingState !== "on") return;
    setWord((prev) => heldPhase(prev, makingPhase, Date.now()));
  }, [makingPhase, makingState]);
  useEffect(() => {
    if (makingState !== "on" || word === null || word.phase === makingPhase) return;
    const wait = Math.max(0, MAKING_HOLD_MS - (Date.now() - word.at));
    const timer = window.setTimeout(
      () => setWord((prev) => heldPhase(prev, makingPhase, Date.now())),
      wait,
    );
    return () => window.clearTimeout(timer);
  }, [word, makingPhase, makingState]);
  // 보이는 말 — 갈아입는 사이에는 입던 말을 계속 입는다.
  const wordPhase = word?.phase ?? makingPhase;
  const makingText =
    wordPhase === "read"
      ? L.journey.makingRead
      : wordPhase === "file"
        ? L.journey.makingFile
        : wordPhase === "command"
          ? L.journey.makingCheck
          : L.journey.making;

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

  // 제출의 성공 이야기 — 순서는 submit-story.ts 의 판정이 정한다: 그려지는
  // 체크 → 첫 막대 → 둘째 점. 타이머만 돌리고 모양은 클래스가 입는다.
  const [story, setStory] = useState<"draw" | "bar" | "point" | null>(null);
  useEffect(() => {
    if (flash !== "done") {
      setStory(null);
      return;
    }
    setStory(submitStoryPhase(0));
    const atBar = window.setTimeout(
      () => setStory(submitStoryPhase(SUBMIT_STORY_BAR_MS)),
      SUBMIT_STORY_BAR_MS,
    );
    const atPoint = window.setTimeout(
      () => setStory(submitStoryPhase(SUBMIT_STORY_POINT_MS)),
      SUBMIT_STORY_POINT_MS,
    );
    return () => {
      window.clearTimeout(atBar);
      window.clearTimeout(atPoint);
    };
  }, [flash]);

  // 실패는 붉어지기 전에 잠깐 흔들린다 — 동작을 줄이는 탭에서는 곧장 붉어진다.
  const [redOn, setRedOn] = useState(false);
  useEffect(() => {
    if (flash !== "failed") {
      setRedOn(false);
      return;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setRedOn(true);
      return;
    }
    const timer = window.setTimeout(() => setRedOn(true), SUBMIT_SHAKE_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);

  // 지금 점이 앞으로 오르면 새 점이 한 번 맥동한다 — 점은 국면이 바뀌어도
  // 버려지지 않으므로(key 를 번호로) 전환으로 이어진다.
  const seenCurrent = useRef(journey.current);
  const [pulseAt, setPulseAt] = useState<number | null>(null);
  useEffect(() => {
    const rose = journey.current > seenCurrent.current;
    seenCurrent.current = journey.current;
    if (!rose) return;
    setPulseAt(journey.current);
    const timer = window.setTimeout(() => setPulseAt(null), 700);
    return () => window.clearTimeout(timer);
  }, [journey.current]);

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
          aria-label={workName}
          onClick={() => {
            if (!workOpen) ledger.refresh();
            setConfirmOpen(false);
            setWorkOpen((open) => !open);
          }}
        >
          <span
            className={`nx-making${makingState === "off" ? " nx-making--off" : ""}`}
            aria-hidden="true"
          >
            <span className="nx-making-in">
              {makingState === "check" ? (
                <span className="nx-making-check">
                  <SentIcon />
                </span>
              ) : makingState === "on" ? (
                <Spin />
              ) : null}
              <RollingWord text={makingText} />
              {makingState === "on" && turnStartedAt !== null && !narrow && (
                <Elapsed
                  startedAt={turnStartedAt}
                  hintAfterMs={firstTurn ? FIRST_TURN_HINT_MS : undefined}
                  hint={firstTurn ? L.journey.firstTurnHint : undefined}
                />
              )}
            </span>
          </span>
          {journey.points.map((point, index) => {
            // 성공 이야기의 둘째 점 — 지금 점이 되기 전에 잠깐 켜진다.
            const storyLit = story === "point" && index === 1;
            const pulsing = index === (pulseAt ?? -1) || storyLit;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: 점의 자리가 곧 정체다 — 글자를 key 로 쓰면 국면이 바뀔 때 점이 버려져 전환이 끊긴다.
              <span key={index} className="nx-jwrap" aria-hidden="true">
                {index > 0 && (
                  <span
                    className={`nx-jbar${
                      journey.points[index - 1]?.state === "done" || (story !== null && index === 1)
                        ? " nx-jbar--full"
                        : ""
                    }`}
                  />
                )}
                <span
                  className={`nx-jstep nx-jstep--${point.state}${storyLit ? " nx-jstep--lit" : ""}${pulsing ? " nx-jstep--pulse" : ""}`}
                >
                  <i aria-hidden="true" />
                  {(!narrow || index === journey.current) && (
                    <span className="nx-jl" key={point.label}>
                      {point.label}
                    </span>
                  )}
                </span>
              </span>
            );
          })}
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
            onNote={async (text) => {
              await daemon.api.noteToDeveloper(text);
            }}
            onToast={nav.toast}
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
                ? redOn
                  ? " nx-submit--failed"
                  : " nx-submit--shaking"
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
          {/* 다섯 얼굴을 한 자리에 겹쳐 둔다 — 단추 폭이 가장 넓은 얼굴에 맞아
              고정되고, 얼굴은 150ms 교차 페이드로 갈아입는다(왼쪽 여정이 밀리지
              않게). 잠긴 얼굴은 쉬는 얼굴과 같은 글자다. */}
          <span className="nx-submit-face" aria-hidden={busy !== null || flash !== null}>
            {L.submit.idle}
          </span>
          <span className="nx-submit-face" aria-hidden={busy !== "running"}>
            <Spin />
            {L.submit.running}
          </span>
          <span className="nx-submit-face" aria-hidden={busy !== "retrying"}>
            <Spin />
            {L.submit.retrying}
          </span>
          <span className="nx-submit-face" aria-hidden={flash !== "done"}>
            <DrawnCheck />
            {L.submit.done}
          </span>
          <span className="nx-submit-face" aria-hidden={flash !== "failed"}>
            <FailIcon />
            {submitCopy.label}
          </span>
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

/**
 * 세로로 굴러가는 단어 한 개 — 갈아입는 순간에 나가는 말은 위로, 들어오는
 * 말은 아래에서 온다(status.css 의 `nx-roll`). 잠깐 둘 다 그려지는 동안 폭은
 * 넓은 쪽을 지킨다.
 */
function RollingWord({ text }: { text: string }) {
  const [pair, setPair] = useState<{ cur: string; prev: string | null }>({ cur: text, prev: null });
  useEffect(() => {
    setPair((prev) => (prev.cur === text ? prev : { cur: text, prev: prev.cur }));
  }, [text]);
  useEffect(() => {
    if (pair.prev === null) return;
    const timer = window.setTimeout(() => setPair((prev) => ({ ...prev, prev: null })), 240);
    return () => window.clearTimeout(timer);
  }, [pair]);
  return (
    <span className="nx-roll">
      {pair.prev !== null && (
        <span key={pair.prev} className="nx-roll-word nx-roll-out">
          {pair.prev}
        </span>
      )}
      <span key={pair.cur} className="nx-roll-word nx-roll-in">
        {pair.cur}
      </span>
    </span>
  );
}
