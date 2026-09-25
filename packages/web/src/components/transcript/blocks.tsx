import { useEffect, useState } from "react";
import type { Block } from "../../lib/daemon-client";
import { waitedFor } from "../../lib/format";
import { toolLabel } from "../../lib/labels";
import { isToolRunning } from "../../lib/progress";
import { CheckIcon, ChevronRightIcon, CloseIcon } from "../icons";
import { Tip } from "../Tip";
import { preview, type TaskControls, type ToolStatus, toolHeadline } from "./shared";

/**
 * 도는 도구의 경과 시계 — "몇 분째인가"는 심장박동(`tool.progress`)이 오기
 * 전부터 뜻이 있으니, 행이 뜬 시각(`startedAt`)에서 창이 직접 센다. 1초
 * tick 은 이 글자만 다시 그린다(TurnClock 과 같은 이유로 컴포넌트를 나눴다).
 */
function ToolElapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  return <>{waitedFor(now - startedAt)}</>;
}

function ToolBlock({
  block,
  onBackgroundTask,
  onStopTask,
}: { block: Extract<Block, { type: "tool" }> } & TaskControls) {
  const [open, setOpen] = useState(false);
  const headline = toolHeadline(block.input);
  // 뒤로 보낸 작업의 도구 결과는 자리표시자다: done 하나로 판정하면
  // 아직 도는 일이 끝난 것처럼 보인다 — 판정은 progress.ts 한 곳에서.
  const running = isToolRunning(block);
  const status: ToolStatus = running ? "running" : block.isError ? "error" : "done";
  const task = block.progress?.task;
  const elapsed = block.progress?.elapsedSeconds ?? 0;
  const retry = block.progress?.retry;

  return (
    <div className={`tool tool--${status}`}>
      <div className="tool__bar">
        <button
          className="tool__head"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          type="button"
        >
          <span className={`tool__chevron${open ? " tool__chevron--open" : ""}`}>
            <ChevronRightIcon />
          </span>
          <span className={`tool__sign tool__sign--${status}`}>
            {status === "running" ? (
              <span className="spinner" />
            ) : status === "error" ? (
              <CloseIcon size={11} />
            ) : (
              <CheckIcon size={11} />
            )}
          </span>
          <span className="tool__name">{toolLabel(block.name)}</span>
          {headline && <span className="tool__headline">{headline}</span>}
          {block.agentId && <span className="tag">하위 작업</span>}
          <span className={`tool__status tool__status--${status}`}>
            {status === "error" ? (
              "실패"
            ) : running ? (
              // 몇 초째인지는 도는 동안에만 뜻이 있다: 끝난 행에
              // 남으면 지금 도는 것처럼 읽힌다. 시계는 행이 뜬 시각에서
              // 센다 — 심장박동이 안 오는 도구도 멈춘 것처럼 보이지 않게.
              block.startedAt !== undefined ? (
                <ToolElapsed startedAt={block.startedAt} />
              ) : elapsed > 0 ? (
                `${Math.round(elapsed)}초`
              ) : (
                "실행 중…"
              )
            ) : (
              ""
            )}
          </span>
        </button>
        {/* 작업 버튼은 머리 버튼 바깥에 산다 — 버튼 안의 버튼은 클릭이 겹친다. */}
        {task && task.status === "running" && (
          <span className="tool__acts">
            {!task.backgrounded && onBackgroundTask && (
              <Tip label="이 작업을 뒤로 보내고 대화를 이어갑니다">
                <button
                  type="button"
                  className="ghost tool__act"
                  onClick={() => onBackgroundTask(block.id)}
                >
                  뒤로 보내기
                </button>
              </Tip>
            )}
            {onStopTask && (
              <Tip label="이 작업만 세웁니다 — 대화는 그대로 이어집니다">
                <button
                  type="button"
                  className="ghost tool__act"
                  onClick={() => onStopTask(task.id)}
                >
                  이 작업만 중지
                </button>
              </Tip>
            )}
          </span>
        )}
      </div>
      {/* 작업의 한 줄: 모델이 쓴 근황이 있으면 그것이 가장 최신이고,
          없으면 무엇을 하러 떠난 작업인지가 남는다. */}
      {task && (
        <div className="tool__task">
          <span className="tool__tasktext">{task.summary || task.description}</span>
          {task.toolUses > 0 && <span className="tool__taskmeta">도구 {task.toolUses}회</span>}
          {task.lastTool && <span className="tool__taskmeta">{toolLabel(task.lastTool)}</span>}
          {task.backgrounded && task.status === "running" && (
            <span className="tag">뒤에서 도는 중</span>
          )}
        </div>
      )}
      {retry && (
        <div className="tool__task">
          <span className="tool__tasktext">
            연결이 끊겨 다시 시도합니다 ({retry.attempt}/{retry.maxRetries})
          </span>
        </div>
      )}
      {open && (
        <div className="tool__body">
          <div className="tool__label">입력</div>
          <pre>{preview(block.input, 4000)}</pre>
          {block.done && (
            <>
              <div className="tool__label">결과</div>
              <pre>{preview(block.result, 4000)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * the agent.s private reasoning — off unless 설정's `생각 과정 보기` asks for it
 * (Transcript drops the blocks before grouping). When it is on the fold is
 * still closed: while the turn is running it reads as live ("생각 중…"); once
 * the turn ends the same fold reads as a record ("생각 과정") — a finished
 * transcript must not look like it is still thinking. The closed fold carries
 * the thought's first line as a peek, so a planner scanning the tape reads the
 * shape of the reasoning without opening it.
 */
function ThinkingBlock({ block }: { block: Extract<Block, { type: "thinking" }> }) {
  const peek = block.text.trimStart().split("\n", 1)[0] ?? "";
  return (
    <details className={block.streaming ? "thinking thinking--live" : "thinking"}>
      <summary>
        <span className="thinking__label">{block.streaming ? "생각 중…" : "생각 과정"}</span>
        {!block.streaming && peek && <span className="thinking__peek">{peek}</span>}
      </summary>
      <pre>{block.text}</pre>
    </details>
  );
}

export { ThinkingBlock, ToolBlock };
