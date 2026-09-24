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
 *
 * 세 프로바이더가 같은 일을 다른 이름으로 부른다 — Claude 의 `Edit`, Codex 의
 * `fileChange`, omp 의 `edit`. 이름의 원본은 데몬의 tool-names.ts 다(통계의
 * 읽기 · 편집 · 실행 묶음). 이 표는 그 묶음을 머리말 한 줄로 옮기는 사본이라,
 * 그쪽에 이름이 늘면 여기에도 는다.
 */
const ACTIVITY_BUCKET: Record<string, "file" | "command" | "read"> = {
  // Claude Code
  Write: "file",
  Edit: "file",
  MultiEdit: "file",
  NotebookEdit: "file",
  Bash: "command",
  Read: "read",
  Glob: "read",
  Grep: "read",
  LS: "read",
  // Codex — app-server 의 item 종류와 승인 요청의 이름
  fileChange: "file",
  applyPatch: "file",
  apply_patch: "file",
  edit_file: "file",
  write_file: "file",
  commandExecution: "command",
  execCommand: "command",
  exec_command: "command",
  run_command: "command",
  shell: "command",
  Shell: "command",
  view: "read",
  view_file: "read",
  read_file: "read",
  // omp
  edit: "file",
  write: "file",
  ast_edit: "file",
  notebook_edit: "file",
  bash: "command",
  eval: "command",
  read: "read",
  glob: "read",
  grep: "read",
  ast_grep: "read",
};

type ActivityCounts = { file: number; command: number; read: number; other: number };

function activityCounts(tools: Array<Extract<Block, { type: "tool" }>>): ActivityCounts {
  const counts: ActivityCounts = { file: 0, command: 0, read: 0, other: 0 };
  for (const tool of tools) counts[ACTIVITY_BUCKET[tool.name] ?? "other"] += 1;
  return counts;
}

/**
 * 접힌 머리의 한 마디(P3-4). 예전에는 여기에 숫자 줄이 섰다
 * (`화면 파일 3개 작업 · 검사 2회 실행 · 5곳 확인`) — 사실이지만 사용자의
 * 질문에 대한 답은 아니다. 비개발자가 그 줄에서 알고 싶은 것은 하나다:
 * 지금 도는가, 끝났는가. 숫자는 펼침 안으로 내려간다(거기서는 진단의
 * 재료로 쓸모가 있다).
 *
 * 끝난 머리는 한 일의 가장 무거운 쪽을 말한다 — 파일을 읽기만 한 런이
 * "화면을 고쳤어요" 라고 하면 그 말은 거짓이다.
 */
function activityStatus(running: boolean, counts: ActivityCounts): string {
  if (running) return "만드는 중…";
  if (counts.file > 0) return "화면을 고쳤어요";
  if (counts.command > 0) return "검사를 돌렸어요";
  return "확인했어요";
}

function activityLine(counts: ActivityCounts): string {
  // A planner is watching someone work on their screen, not a process table.
  // "파일 3개 생성" is true of a Write call and says nothing about what was
  // gained; the words below describe the work.
  const parts: string[] = [];
  if (counts.file) parts.push(`화면 파일 ${counts.file}개 작업`);
  if (counts.command) parts.push(`검사 ${counts.command}회 실행`);
  if (counts.read) parts.push(`${counts.read}곳 확인`);
  if (counts.other) parts.push(`그 밖에 ${counts.other}가지`);
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
      <button
        type="button"
        className="subagent__head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
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
  const counts = activityCounts(tools);
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
      <button
        type="button"
        className="activity__head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`tool__chevron${open ? " tool__chevron--open" : ""}`}>
          <ChevronRightIcon />
        </span>
        {running ? <span className="spinner" /> : <CheckIcon size={11} />}
        {/* 도구 없는 런(하위 작업의 말만 남은 구간)도 빈 막대로 두지 않는다.
            에이전트가 스스로 내놓은 근황(live summary)이 있으면 그것이 이긴다
            — 기계가 제 말로 하는 것이 도구 셈보다 언제나 낫다. */}
        <span className="activity__text">{headline ?? activityStatus(running, counts)}</span>
        {failed && <span className="activity__flag">실패 있음</span>}
      </button>
      {open && (
        <div className="activity__body">
          {/* 숫자 줄은 펼침의 첫 줄로 내려왔다(P3-4) — 무엇을 몇 번 했는지는
              막힌 턴을 들여다볼 때의 재료이지, 기다리는 동안 읽을 말이 아니다. */}
          {activityLine(counts) && <div className="activity__counts">{activityLine(counts)}</div>}
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
