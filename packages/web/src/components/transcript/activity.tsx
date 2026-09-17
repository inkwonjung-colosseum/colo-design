import { useState } from "react";
import type { Block } from "../../lib/daemon-client";
import { isToolRunning } from "../../lib/progress";
import { CheckIcon, ChevronRightIcon } from "../icons";
import { Markdown } from "../Markdown";
import { ThinkingBlock, ToolBlock } from "./blocks";
import type { TaskControls, TodoToolBlock } from "./shared";

/**
 * A planner never asked for a tool log. One assistant turn's tool calls fold
 * into a single Korean line; the developer-grade blocks are one click away so
 * a stuck turn can still be diagnosed.
 */
const ACTIVITY_BUCKET: Record<string, "file" | "command" | "read"> = {
  Write: "file",
  Edit: "file",
  MultiEdit: "file",
  NotebookEdit: "file",
  Bash: "command",
  Read: "read",
  Glob: "read",
  Grep: "read",
};

function activityLine(tools: Array<Extract<Block, { type: "tool" }>>): string {
  let file = 0;
  let command = 0;
  let read = 0;
  let other = 0;
  for (const tool of tools) {
    const bucket = ACTIVITY_BUCKET[tool.name];
    if (bucket === "file") file += 1;
    else if (bucket === "command") command += 1;
    else if (bucket === "read") read += 1;
    else other += 1;
  }
  // A planner is watching someone work on their screen, not a process table.
  // "파일 3개 생성" is true of a Write call and says nothing about what was
  // gained; the words below describe the work.
  const parts: string[] = [];
  if (file) parts.push(`화면 파일 ${file}개 작업`);
  if (command) parts.push(`검사 ${command}회 실행`);
  if (read) parts.push(`${read}곳 확인`);
  if (other) parts.push(`그 밖에 ${other}가지`);
  return parts.join(" · ");
}

/**
 * 하위 작업의 대화: 보조 에이전트가 한 말·생각·도구 호출은 그
 * 에이전트를 띄운 도구 행 **아래** 접힘 하나로 산다. 접힌 채의 머리가 지금
 * 무엇을 하는지 한 줄로 말하므로, 펼치지 않아도 진행은 읽힌다.
 *
 * `agentId` 는 그 에이전트를 띄운 도구 호출의 id 다 — 그래서 부모를 찾는 일은
 * 문자열 비교 하나로 끝난다.
 */
function SubagentThread({ steps, controls }: { steps: ActivityStep[]; controls: TaskControls }) {
  const [open, setOpen] = useState(false);
  const last = [...steps].reverse().find((step) => step.type === "text");
  const peek = last?.type === "text" ? (last.text.trimStart().split("\n", 1)[0] ?? "") : "";
  return (
    <div className="subagent">
      <button type="button" className="subagent__head" onClick={() => setOpen((v) => !v)}>
        <span className={`tool__chevron${open ? " tool__chevron--open" : ""}`}>
          <ChevronRightIcon />
        </span>
        <span className="subagent__label">하위 작업의 대화 {steps.length}</span>
        {peek && <span className="subagent__peek">{peek}</span>}
      </button>
      {open && (
        <div className="subagent__body">
          {steps.map((step) => (
            <ActivityStepRow key={step.id} step={step} controls={controls} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 활동 본문의 한 줄 — 도구 · 생각 · (하위 작업이 한) 말. */
function ActivityStepRow({ step, controls }: { step: ActivityStep; controls: TaskControls }) {
  if (step.type === "tool") return <ToolBlock block={step} {...controls} />;
  if (step.type === "thinking") return <ThinkingBlock block={step} />;
  return (
    <div className="subagent__say">
      <Markdown text={step.text} />
    </div>
  );
}

/**
 * A run folds tools AND the thinking between them into one row: the agent thinks
 * between tool calls, so tool-only grouping rendered a finished turn as a
 * stack of near-identical bars. The head counts the tools; the body replays
 * the steps, thinking included, for the planner who needs the detail.
 *
 * 도는 동안의 머리 문장은 활동 요약이 아니라 **지금 도는 작업의 근황**이다
 * — 30초마다 갱신되는 그 한 줄이, 끝난 뒤의 "무엇을 했는가"보다 도는 동안에 훨씬
 * 쓸모 있다.
 */
function ActivitySummary({ steps, controls }: { steps: ActivityStep[]; controls: TaskControls }) {
  const [open, setOpen] = useState(false);
  const tools = steps.filter(
    (step): step is Extract<Block, { type: "tool" }> => step.type === "tool",
  );
  const running = tools.some((tool) => isToolRunning(tool));
  const failed = tools.some((tool) => tool.isError);
  const live = tools.find((tool) => isToolRunning(tool) && tool.progress?.task?.summary);
  const headline = running && live?.progress?.task?.summary ? live.progress.task.summary : null;
  // 하위 작업의 말·생각·도구는 그것을 띄운 도구 행 아래로 들어간다. 부모를
  // 이 런에서 못 찾은 고아만 본문에 그대로 남는다.
  // 값이 없으면 메인의 걸음으로 본다 — 잃는 쪽보다 보이는 쪽이 안전하다.
  const own = steps.filter((step) => !step.agentId);
  const parents = new Set(tools.map((tool) => tool.id));
  const orphans = steps.filter((step) => step.agentId && !parents.has(step.agentId));

  return (
    <div
      className={
        failed ? "activity activity--error" : running ? "activity activity--running" : "activity"
      }
    >
      <button type="button" className="activity__head" onClick={() => setOpen((v) => !v)}>
        <span className={`tool__chevron${open ? " tool__chevron--open" : ""}`}>
          <ChevronRightIcon />
        </span>
        {running ? <span className="spinner" /> : <CheckIcon size={11} />}
        {/* 도구 없는 런(하위 작업의 말만 남은 구간)도 빈 막대로 두지 않는다. */}
        <span className="activity__text">
          {headline ?? (activityLine(tools) || "하위 작업의 기록")}
        </span>
        {failed && <span className="activity__flag">실패 있음</span>}
      </button>
      {open && (
        <div className="activity__body">
          {own.map((step) => {
            const children =
              step.type === "tool"
                ? steps.filter((child) => child.agentId === step.id)
                : ([] as ActivityStep[]);
            return (
              <div key={step.id}>
                <ActivityStepRow step={step} controls={controls} />
                {children.length > 0 && <SubagentThread steps={children} controls={controls} />}
              </div>
            );
          })}
          {orphans.map((step) => (
            <ActivityStepRow key={step.id} step={step} controls={controls} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 하위 작업의 **말**도 활동의 한 걸음이다. 메인 스레드의 답만 테이프의
 * 말풍선이 되고, `agentId` 가 붙은 말은 그 작업의 기록으로 접힌다 — 이 구별이
 * 없으면 보조 에이전트의 수다가 답으로 세어져 되감기의 턴 번호까지 흔든다.
 */
type ActivityStep =
  | Extract<Block, { type: "tool" }>
  | Extract<Block, { type: "thinking" }>
  | Extract<Block, { type: "text" }>;

type Row =
  | { kind: "block"; block: Block }
  | { kind: "activity"; id: string; steps: ActivityStep[] }
  | { kind: "todo"; id: string; block: TodoToolBlock };

/**
 * A run ends where the planner's attention ends: a user bubble, assistant
 * text, a turn end, or a notice. Thinking alone never starts a run of one.
 *
 * A TodoWrite is pulled OUT of the run and becomes its own card row,
 * and within one run the next write refreshes that card instead of
 * stacking another — the plan is one thing that changes, not a log of plans.
 */
function groupActivity(blocks: Block[]): Row[] {
  const rows: Row[] = [];
  let run: ActivityStep[] | null = null;
  /** The card the current run opened; null again at every run boundary. */
  let todo: Extract<Row, { kind: "todo" }> | null = null;
  const flush = () => {
    if (!run) return;
    if (run.every((step) => step.type === "thinking")) {
      for (const step of run) rows.push({ kind: "block", block: step });
    } else {
      rows.push({ kind: "activity", id: `activity-${run[0]!.id}`, steps: run });
    }
    run = null;
  };
  const endRun = () => {
    flush();
    todo = null;
  };
  for (const block of blocks) {
    if (block.type === "tool" && block.name === "TodoWrite") {
      flush();
      if (todo) {
        todo.block = block;
      } else {
        todo = { kind: "todo", id: `todo-${block.id}`, block };
        rows.push(todo);
      }
      continue;
    }
    if (block.type === "tool" || block.type === "thinking") {
      run = run ?? [];
      run.push(block);
      continue;
    }
    // 하위 작업이 한 말은 답이 아니다 — 런을 끊지 않고 그 안의 한 걸음이
    // 된다. 메인 스레드의 말만 런을 닫고 말풍선이 된다.
    if (block.type === "text" && block.agentId) {
      run = run ?? [];
      run.push(block);
      continue;
    }
    endRun();
    rows.push({ kind: "block", block });
  }
  endRun();
  return rows;
}

export { ActivitySummary, groupActivity };
