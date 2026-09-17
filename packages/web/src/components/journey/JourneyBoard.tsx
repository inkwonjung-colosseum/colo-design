import type { ThreadSummary } from "@colo-design/protocol";
import { Fragment, type ReactNode } from "react";
import type { Block, Daemon } from "../../lib/daemon-client";
import { timeAgo } from "../../lib/format";
import { buildJourneyBoard, type JourneyRow } from "../../lib/journey-board";
import { visibleThreads } from "../../lib/thread-visibility";
import { SaveIcon } from "../icons";
import { Tip } from "../shell/Tip";
import { MilestoneRow } from "../transcript/MilestoneRow";
import { clockTime } from "../transcript/shared";

const STOPS = ["만들기", "저장", "넘기기", "반영"] as const;

const GROUPS = [
  { key: "waiting", label: "나를 기다리는 일" },
  { key: "working", label: "지금 진행 중" },
  { key: "done", label: "방금 있던 일" },
] as const;

/** 행 머리의 상태 점 — 사이드바 잎과 같은 어휘(도는 중·확인 대기·답 도착). */
function StateDot({ thread }: { thread: ThreadSummary }) {
  if (thread.state === "running") return <span className="leaf__dot leaf__dot--live" />;
  if (thread.state === "awaiting")
    return (
      <Tip label="확인 대기" side="right">
        <span className="leaf__dot leaf__dot--ask" />
      </Tip>
    );
  if (thread.state === "finished")
    return (
      <Tip label="답이 왔습니다" side="right">
        <span className="leaf__dot leaf__dot--done" />
      </Tip>
    );
  return <span className="leaf__dot" />;
}

/** 한 줄 스테퍼 — 점과 라벨이 같은 축에 선다(mockups/journey 02-stepper). */
function Steps({ trail }: { trail: JourneyRow["trail"] }) {
  const label = trail
    ? STOPS.map((name, index) => {
        const stop = trail[index];
        if (stop === "done") return `${name} 완료`;
        if (stop === "now") return `${name} — 지금`;
        if (stop === "warn") return `${name} — 코멘트 도착`;
        return name;
      }).join(", ")
    : "아직 여정 없음";
  return (
    <span className="jb__steps" role="img" aria-label={label}>
      {STOPS.map((name, index) => {
        const stop = trail ? trail[index] : "empty";
        const stepCls = [
          "jb__step",
          stop === "done" ? "jb__step--done" : "",
          stop === "now" ? "jb__step--now" : "",
          stop === "warn" ? "jb__step--warn" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const segDone = trail ? trail[index - 1] === "done" : false;
        return (
          <Fragment key={name}>
            {index > 0 && (
              <span className={segDone ? "jb__seg jb__seg--done" : "jb__seg"} aria-hidden="true" />
            )}
            <span className={stepCls}>
              <span className="jb__stepdot" aria-hidden="true">
                {stop === "done" ? "✓" : ""}
              </span>
              <span className="jb__stepnm">{name}</span>
            </span>
          </Fragment>
        );
      })}
    </span>
  );
}

/**
 * 펼친 행의 연대기 — 이 대화의 이번 사이클(마지막 반영 뒤의 사건만)을
 * 진행 한 줄로 쌓는다. 대화의 전부가 아니라 여정의 근거 네 줄: 저장 · 넘김 ·
 * 반영 · 코멘트 도착.
 */
function cycleEvents(blocks: Block[]): ReactNode[] {
  let from = 0;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block?.type === "milestone" && block.subtype === "merged") {
      from = i;
      break;
    }
  }
  const rows: ReactNode[] = [];
  for (let i = from; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (!block) continue;
    if (block.type === "save") {
      rows.push(
        <MilestoneRow
          key={block.id}
          icon={<SaveIcon />}
          text={block.message || "저장했어요"}
          time={clockTime(block.at)}
        />,
      );
    } else if (block.type === "milestone") {
      rows.push(
        block.subtype === "merged" ? (
          <MilestoneRow
            key={block.id}
            tone="ok"
            text="이번 작업이 제품에 반영됐어요"
            time={clockTime(block.at)}
          />
        ) : (
          <MilestoneRow
            key={block.id}
            tone="send"
            text={
              block.reviewer ? `${block.reviewer}님께 넘겼어요 — 확인 요청` : "넘겼어요 — 확인 요청"
            }
            time={clockTime(block.at)}
          />
        ),
      );
    } else if (block.type === "human") {
      const header = block.reviews[0];
      if (!header) continue;
      const places = block.reviews
        .filter((review) => review.kind === "inline" && review.path)
        .map((review) => `${review.path}${review.line ? `:${review.line}` : ""}`);
      const where =
        places.length > 0
          ? ` — ${places.slice(0, 2).join(" · ")}${places.length > 2 ? ` · 외 ${places.length - 2}건` : ""}`
          : "";
      rows.push(
        <MilestoneRow
          key={block.id}
          tone="danger"
          icon={<span className="jb__ms-author">{header.author.trim().slice(0, 1) || "?"}</span>}
          text={`${header.author}님이 코멘트를 남겼어요${where}`}
          time={clockTime(header.at)}
        />,
      );
    }
  }
  return rows.slice(-4);
}

function BoardRow({
  row,
  open,
  events,
  onOpen,
}: {
  row: JourneyRow;
  open: boolean;
  events: ReactNode[];
  onOpen: () => void;
}) {
  return (
    <div className="jb__item">
      <button
        type="button"
        className={`jb__row${open ? " jb__row--open" : ""}`}
        onClick={onOpen}
        aria-expanded={open}
      >
        <StateDot thread={row.thread} />
        <span className="jb__name" title={row.title}>
          {row.title}
        </span>
        <Steps trail={row.trail} />
        {row.chip ? (
          <span className={`jb__chip jb__chip--${row.chip.tone}`}>{row.chip.label}</span>
        ) : null}
        {row.time ? <span className="jb__time">{timeAgo(Date.parse(row.time))}</span> : null}
      </button>
      {open && events.length > 0 ? <div className="jb__detail">{events}</div> : null}
    </div>
  );
}

/**
 * 여정 허브 — 활성 프로젝트의 모든 대화를 여정 한 줄로 보는 화면
 * (mockups/journey 02-stepper). 홈이 '지금 나에게 올 답'이라면 이 화면은
 * '모든 대화가 사이클의 어디에 서 있는가'를 말한다. 열려 있는 대화의 행은
 * 연대기가 펼쳐 넘겨진 근거(코멘트 위치)까지 닫아 준다.
 */
export function JourneyBoard({
  daemon,
  sessionTitles,
  activeThreadId,
  onOpenThread,
}: {
  daemon: Daemon;
  /** 설정의 대화 이름 — 사이드바 나무가 읽는 것과 같은 사전. */
  sessionTitles: Record<string, string>;
  /** 열려 있는 대화 — 이 행만 연대기가 펼쳐진다. */
  activeThreadId: string | null;
  /** 행의 유일한 열기 경로 — 사이드바·홈이 쓰는 것과 같은 통로. */
  onOpenThread: (thread: ThreadSummary) => void;
}) {
  const project = daemon.projects.find((candidate) => candidate.slug === daemon.activeSlug) ?? null;
  // 낙관 삭제의 숨김을 거둔다 — 사이드바가 안 그리는 행이 여정의 줄에 남지 않게.
  const board = buildJourneyBoard(
    visibleThreads(project?.threads, daemon.hiddenThreads, daemon.activeSlug ?? ""),
    sessionTitles,
  );
  const detail = activeThreadId ? daemon.sessions[activeThreadId] : null;
  const events = detail ? cycleEvents(detail.blocks) : [];
  const total = board.waiting.length + board.working.length + board.done.length;

  if (daemon.connection === "connecting" || daemon.connection === "idle" || !project) {
    return (
      <section className="jb__scroll" aria-label="여정">
        <div className="jb__empty">프로젝트를 연결하는 중이에요…</div>
      </section>
    );
  }

  return (
    <section className="jb__scroll" aria-label="여정">
      {total === 0 ? (
        <div className="jb__empty">
          아직 여정이 없어요 — 대화에서 첫 작업을 만들기 시작하면 이곳에 사이클이 쌓여요.
        </div>
      ) : (
        <div className="jb__list">
          <p className="jb__lede">대화 {total}개의 여정 — 만들기 · 저장 · 넘기기 · 반영</p>
          {GROUPS.map((group) => {
            const rows = board[group.key];
            if (rows.length === 0) return null;
            return (
              <div key={group.key} className="jb__group">
                <div className="jb__sect">{group.label}</div>
                {rows.map((row) => (
                  <BoardRow
                    key={row.thread.id}
                    row={row}
                    open={row.thread.id === activeThreadId}
                    events={row.thread.id === activeThreadId ? events : []}
                    onOpen={() => onOpenThread(row.thread)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
