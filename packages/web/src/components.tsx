import type { AskQuestion, RepoStatus, TurnMarker } from "@colo-design/protocol";
import { alignThumbs, readTurn } from "@colo-design/protocol";
import { type ReactNode, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import type { Block, PendingPermission, PendingQuestion } from "./daemon-client";
import { waitedFor } from "./format";
import { CheckIcon, ChevronRightIcon, CloseIcon, CopyIcon, ShieldIcon, SparkIcon } from "./icons";
import { Markdown } from "./Markdown";
import { isToolRunning } from "./progress";
import { GENERIC_STARTERS } from "./suggestions";
import { blockOnTape, SCREEN_SHOT_TOOL } from "./tape-visibility";
import { bashHeadline, objectParticle, toolLabel } from "./tool-names";
import {
  answerTurnNumbers,
  lastAnswerPerTurn,
  promptTotal,
  turnAnswerText,
} from "./turn-numbering";

/**
 * The CLI's own housekeeping lines. They arrive dressed as ordinary user or
 * assistant blocks, but they are the tape talking, not a person — a stopped
 * request, a turn that needed no answer. They render as quiet system lines
 * in the app's one voice instead of posing as somebody's words.
 */
const TAPE_LINES: Record<string, string> = {
  "[Request interrupted by user]": "요청을 중단했습니다",
  "No response requested.": "응답이 필요 없는 차례였습니다",
};

/** The commands the clone resolved to, as RepoStatus carries them. */
type RepoCommands = NonNullable<RepoStatus["commands"]>;

// ---------------------------------------------------------------------------
// Transcript blocks
// ---------------------------------------------------------------------------

function preview(value: unknown, max = 240): string {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…` : value;
  const text = JSON.stringify(value, null, 2) ?? String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The one input field that best identifies what a tool call is about. */
function toolHeadline(input: unknown): string {
  const i = input as Record<string, unknown> | null;
  if (!i || typeof i !== "object") return "";
  for (const key of ["command", "file_path", "path", "pattern", "url", "prompt", "description"]) {
    const value = i[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/**
 * The colo-preview 도구 이름은 `mcp__colo-preview__screen_*` 로 온다(PLAN
 * D61): the server prefix is plumbing, so the recognisers key on the tool's
 * own name. The capture pattern itself lives beside the tape-visibility rule
 * — both the renderer and the filter must agree on what a capture is.
 */
const SCREEN_LOOK_TOOL = /screen_(?:read|click|open)$/;

/**
 * The image a finished screen_screenshot carries, read defensively out of
 * the tool result: an MCP image content item (`{ type: "image", data,
 * mimeType }`) inside an array, or alone. Anything else — a running call, a
 * failure, a plain string — is not a capture.
 */
function screenshotImage(result: unknown): { data: string; mimeType: string } | null {
  const items = Array.isArray(result) ? result : [result];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "image" && typeof record.data === "string" && record.data) {
      return {
        data: record.data,
        mimeType:
          typeof record.mimeType === "string" && record.mimeType ? record.mimeType : "image/jpeg",
      };
    }
  }
  return null;
}

/**
 * 캡처 카드(PLAN D56): a screen turn leaves its evidence behind. What Claude
 * saw through the D61 driver renders as the picture it is, under one tag —
 * not as a folded tool row a planner would have to open.
 */
function CaptureCard({ block }: { block: Extract<Block, { type: "tool" }> }) {
  const image = block.done && !block.isError ? screenshotImage(block.result) : null;
  if (!image) return <ToolBlock block={block} />;
  return (
    <div className="card">
      <div className="card__title">
        <span className="card__badge">
          <SparkIcon />
        </span>
        <span>
          <strong>Claude가 본 화면</strong>
        </span>
      </div>
      <img
        className="card__shot"
        src={`data:${image.mimeType};base64,${image.data}`}
        alt="Claude가 본 화면"
      />
    </div>
  );
}

type ToolStatus = "running" | "done" | "error";

/** 도구 행이 스스로 그릴 수 있는 것 밖의, 작업을 다루는 손 (PLAN D101). */
interface TaskControls {
  /** 턴을 붙잡은 작업을 뒤로 보낸다 — 인자는 그 도구 호출의 id. */
  onBackgroundTask?: (toolUseId: string) => void;
  /** 그 작업 하나만 세운다 — 인자는 작업 id. */
  onStopTask?: (taskId: string) => void;
}

function ToolBlock({
  block,
  onBackgroundTask,
  onStopTask,
}: { block: Extract<Block, { type: "tool" }> } & TaskControls) {
  const [open, setOpen] = useState(false);
  const headline = toolHeadline(block.input);
  // 뒤로 보낸 작업의 도구 결과는 자리표시자다(PLAN D97): done 하나로 판정하면
  // 아직 도는 일이 끝난 것처럼 보인다 — 판정은 progress.ts 한 곳에서.
  const running = isToolRunning(block);
  const status: ToolStatus = running ? "running" : block.isError ? "error" : "done";
  const task = block.progress?.task;
  const elapsed = block.progress?.elapsedSeconds ?? 0;
  const retry = block.progress?.retry;

  return (
    <div className={`tool tool--${status}`}>
      <div className="tool__bar">
        <button className="tool__head" onClick={() => setOpen((v) => !v)} type="button">
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
            {status === "error"
              ? "실패"
              : running
                ? // 몇 초째인지는 도는 동안에만 뜻이 있다 (PLAN D97): 끝난 행에
                  // 남으면 지금 도는 것처럼 읽힌다.
                  elapsed > 0
                  ? `${Math.round(elapsed)}초`
                  : "실행 중…"
                : ""}
          </span>
        </button>
        {/* 작업 버튼은 머리 버튼 바깥에 산다 — 버튼 안의 버튼은 클릭이 겹친다. */}
        {task && task.status === "running" && (
          <span className="tool__acts">
            {!task.backgrounded && onBackgroundTask && (
              <button
                type="button"
                className="ghost tool__act"
                title="이 작업을 뒤로 보내고 대화를 이어갑니다"
                onClick={() => onBackgroundTask(block.id)}
              >
                뒤로 보내기
              </button>
            )}
            {onStopTask && (
              <button
                type="button"
                className="ghost tool__act"
                title="이 작업만 세웁니다 — 대화는 그대로 이어집니다"
                onClick={() => onStopTask(task.id)}
              >
                이 작업만 중지
              </button>
            )}
          </span>
        )}
      </div>
      {/* 작업의 한 줄 (PLAN D97): 모델이 쓴 근황이 있으면 그것이 가장 최신이고,
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
  let screen = 0;
  let other = 0;
  for (const tool of tools) {
    // 화면 세션의 읽기·이동·클릭(PLAN D63): the driver's look-arounds fold
    // into one phrase instead of reading as file work.
    if (SCREEN_LOOK_TOOL.test(tool.name)) screen += 1;
    else {
      const bucket = ACTIVITY_BUCKET[tool.name];
      if (bucket === "file") file += 1;
      else if (bucket === "command") command += 1;
      else if (bucket === "read") read += 1;
      else other += 1;
    }
  }
  // A planner is watching someone work on their screen, not a process table.
  // "파일 3개 생성" is true of a Write call and says nothing about what was
  // gained; the words below describe the work (PLAN D9).
  const parts: string[] = [];
  if (file) parts.push(`화면 파일 ${file}개 작업`);
  if (command) parts.push(`검사 ${command}회 실행`);
  if (read) parts.push(`${read}곳 확인`);
  if (screen) parts.push(`화면 ${screen}곳 확인`);
  if (other) parts.push(`그 밖에 ${other}가지`);
  return parts.join(" · ");
}

/**
 * Claude's private reasoning — off unless 설정's `생각 과정 보기` asks for it
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

/**
 * 하위 작업의 대화 (PLAN D98): 보조 에이전트가 한 말·생각·도구 호출은 그
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
 * A run folds tools AND the thinking between them into one row: Claude thinks
 * between tool calls, so tool-only grouping rendered a finished turn as a
 * stack of near-identical bars. The head counts the tools; the body replays
 * the steps, thinking included, for the planner who needs the detail.
 *
 * D97: 도는 동안의 머리 문장은 활동 요약이 아니라 **지금 도는 작업의 근황**이다
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
  // D98: 하위 작업의 말·생각·도구는 그것을 띄운 도구 행 아래로 들어간다. 부모를
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
 * D98: 하위 작업의 **말**도 활동의 한 걸음이다. 메인 스레드의 답만 테이프의
 * 말풍선이 되고, `agentId` 가 붙은 말은 그 작업의 기록으로 접힌다 — 이 구별이
 * 없으면 보조 에이전트의 수다가 답으로 세어져 되감기의 턴 번호까지 흔든다.
 */
type ActivityStep =
  | Extract<Block, { type: "tool" }>
  | Extract<Block, { type: "thinking" }>
  | Extract<Block, { type: "text" }>;

type TodoToolBlock = Extract<Block, { type: "tool" }>;

type Row =
  | { kind: "block"; block: Block }
  | { kind: "activity"; id: string; steps: ActivityStep[] }
  | { kind: "todo"; id: string; block: TodoToolBlock };

/**
 * A run ends where the planner's attention ends: a user bubble, assistant
 * text, a turn end, or a notice. Thinking alone never starts a run of one.
 *
 * A TodoWrite is pulled OUT of the run and becomes its own card row (PLAN
 * D48), and within one run the next write refreshes that card instead of
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
    // 캡처는 활동 줄에 접지 않는다(PLAN D56): each screenshot is its own
    // card row, the way the todo card is — a picture folded into "그 밖에
    // 1가지" would be invisible where it matters.
    if (block.type === "tool" && SCREEN_SHOT_TOOL.test(block.name)) {
      flush();
      rows.push({ kind: "block", block });
      continue;
    }
    if (block.type === "tool" || block.type === "thinking") {
      run = run ?? [];
      run.push(block);
      continue;
    }
    // D98: 하위 작업이 한 말은 답이 아니다 — 런을 끊지 않고 그 안의 한 걸음이
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

interface TodoItem {
  text: string;
  status: "completed" | "in_progress" | "pending";
}

/**
 * Claude's plan, read defensively out of a TodoWrite input: `content` is the
 * CLI's current shape, `activeForm` and `subject` are shapes other senders
 * used. Something that is not a todo list at all gets no card.
 */
function todoItems(block: TodoToolBlock): TodoItem[] | null {
  const input = block.input as { todos?: unknown } | null;
  if (!input || !Array.isArray(input.todos)) return null;
  return input.todos.map((entry): TodoItem => {
    const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const text = [item.content, item.activeForm, item.subject].find(
      (value): value is string => typeof value === "string" && value.trim() !== "",
    );
    const status =
      item.status === "completed" || item.status === "in_progress" ? item.status : "pending";
    return { text: text ?? "", status };
  });
}

function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <ul className="todo__list">
      {todos.map((todo, index) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: 할 일의 정체성은 목록에서의 위치다 — 상태만 바뀔 뿐 재배치가 없다.
          key={index}
          className={
            todo.status === "in_progress" ? "todo__item todo__item--current" : "todo__item"
          }
        >
          <span className="todo__sign" aria-hidden>
            {todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "●" : "○"}
          </span>
          <span className="todo__text">{todo.text}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Claude's own plan as a card (PLAN D48): `진행 N/M`, items ✓ · ● · ○ with
 * the current one bold. Once the turn has ended it folds to a single line —
 * the plan was followed; the reading is over. A write we cannot parse falls
 * back to the plain tool row, which is the honest rendering of noise.
 */
function TodoCard({ block, ended }: { block: TodoToolBlock; ended: boolean }) {
  const [open, setOpen] = useState(false);
  const todos = todoItems(block);
  if (!todos || todos.length === 0) return <ToolBlock block={block} />;

  if (ended) {
    return (
      <div className="machine todo todo--done">
        <button
          type="button"
          className="todo__done"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          할 일 {todos.length}개 끝
        </button>
        {open && <TodoList todos={todos} />}
      </div>
    );
  }

  const done = todos.filter((todo) => todo.status === "completed").length;
  const current = todos.find((todo) => todo.status === "in_progress") ?? null;
  return (
    <div className="machine todo">
      <div className="machine__head">
        <span className="machine__title">
          진행 {done + (current ? 1 : 0)}/{todos.length}
        </span>
        {current && <span className="machine__lead">{current.text}</span>}
      </div>
      <TodoList todos={todos} />
    </div>
  );
}

/**
 * A turn this app wrote on the planner's behalf, rendered as what it means
 * instead of as what Claude reads (PLAN D9).
 *
 * The four kinds share one shape — a heading, a short list, and the original
 * text one fold away — because they interrupt the chat for the same reason:
 * something happened that the planner started but did not type. The fold is
 * not decoration; a turn Claude answered oddly is only diagnosable against the
 * text it actually received.
 */
function MachineTurn({
  marker,
  body,
  thumbs,
}: {
  marker: TurnMarker;
  body: string;
  /** D87: the pin crops, when the live echo carried them. */
  thumbs?: string[];
}) {
  const [open, setOpen] = useState(false);

  let title: string;
  let lead: string | null = null;
  let rows: Array<{ key: string; label: string; text: string }> = [];
  // D87: the crops are fewer than the rows when the view could not
  // photograph a pin, so each image has to be put back on its own row.
  const aligned = marker.kind === "comments" ? alignThumbs(marker.items, thumbs) : null;

  switch (marker.kind) {
    case "comments": {
      // 의도가 제목을 정한다 (재설계 C10): absent reads as change, so older
      // markers keep the 수정 요청 title they were written with.
      const questions = marker.items.filter((item) => item.intent === "question").length;
      const changes = marker.items.length - questions;
      title =
        questions === 0
          ? `수정 요청 ${marker.items.length}건`
          : changes === 0
            ? `질문 ${marker.items.length}건`
            : `수정 ${changes} · 질문 ${questions}`;
      lead = [marker.screen, marker.state && `${marker.state} 상태`].filter(Boolean).join(" · ");
      rows = marker.items.map((item, index) => {
        // 여러 화면을 한 턴에 찍은 배치는 머리글이 화면 N곳 요약이라 —
        // 행마다 각자의 화면을 새긴다 (재설계 C6).
        const label =
          item.screen && marker.screen.startsWith("화면 ")
            ? `${item.label || `${index + 1}번째`} · ${item.screen}`
            : item.label || `${index + 1}번째`;
        return { key: String(index), label, text: item.comment };
      });
      break;
    }
    case "brief":
      // D94: the connection-preparation brief reads as its own thing.
      title =
        marker.purpose === "bootstrap"
          ? "연결 준비"
          : marker.purpose === "refresh"
            ? "최신 변경 받아오기"
            : marker.purpose === "conventions"
              ? "관례 최신화"
              : "이 기획서로 화면 만들기";
      lead = marker.title;
      break;
    case "gate":
      title = `${marker.step}에서 멈췄습니다`;
      lead = "무엇이 잘못됐는지 Claude에게 넘겼습니다. 고치는 동안 기다려 주세요.";
      break;
    case "error":
      // D89: `look` is the 화면 보여 주기 ask (no error the console can
      // name); `count` marks a repeat so the planner sees the loop.
      title =
        marker.errorKind === "look"
          ? marker.count && marker.count > 1
            ? `화면 보여 주기 · ${marker.count}번째 요청`
            : "화면 보여 주기"
          : marker.count && marker.count > 1
            ? `아직 같은 오류 · ${marker.count}번째`
            : "화면 오류 고치기";
      lead = [marker.route, marker.state && `${marker.state} 상태`].filter(Boolean).join(" · ");
      break;
    case "review":
      // D88: the planner pressed 고치기 on a developer comment — the card
      // names the conversation, the author sits beside it, the developer's
      // own file path waits behind 자세히 (D37·D38).
      title = "개발자 코멘트에 답하기";
      lead = [marker.author, marker.path].filter(Boolean).join(" · ");
      break;
  }

  return (
    <div className={`machine machine--${marker.kind}`}>
      <div className="machine__head">
        <span className="machine__title">{title}</span>
        {lead && <span className="machine__lead">{lead}</span>}
      </div>
      {/* The planner's own sentence (재설계 C2) — the card carries it above the rows. */}
      {marker.kind === "comments" && marker.note && <p className="machine__note">{marker.note}</p>}
      {rows.length > 0 && (
        <ul className="machine__rows">
          {rows.map((row, index) => (
            <li key={row.key}>
              {marker.kind === "comments" && aligned?.[index] && (
                <img
                  className="machine__thumb"
                  src={`data:image/jpeg;base64,${aligned[index]}`}
                  // The crop is of THIS element, and a screen reader should
                  // hear which one rather than skip an unnamed picture.
                  alt={row.label}
                />
              )}
              <span className="machine__label">{row.label}</span>
              {row.text && <span className="machine__text">{row.text}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="machine__actions">
        <button
          type="button"
          className="machine__more"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "접기" : "자세히"}
        </button>
        {/* 요청 복사: the card is a reading of the turn, not the turn — the
            text Claude actually received is what travels elsewhere. */}
        {body.trim() !== "" && (
          <CopyButton value={body} label="요청 복사" icon={null} className="machine__more" />
        )}
      </div>
      {open && <pre className="machine__body">{body}</pre>}
    </div>
  );
}

const TURN_SUBTYPE_WORDS: Record<string, string> = {
  error_max_turns: "정한 대화 길이를 채웠습니다 — 새 대화에서 이어 가면 됩니다",
  error_during_execution: "잠시 문제가 있었습니다 — 다시 보내 주세요",
  interrupted: "멈추었습니다 — 이어서 말하면 됩니다",
};

/**
 * 리뷰 U2: the one copy button. Five screens had each grown their own
 * copied-state and reset dance; the words and the timing live here now.
 * `icon` swaps the idle glyph (a link, for example); `null` drops it, for the
 * rows that read as text links rather than buttons. `className` keeps a
 * caller's own placement class on the button.
 */
export function CopyButton({
  value,
  label = "복사",
  doneLabel = "복사됨",
  icon,
  className = "ghost",
  ariaLabel,
}: {
  value: string;
  label?: string;
  doneLabel?: string;
  icon?: ReactNode | null;
  className?: string;
  ariaLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked; the text is visible to retype anyway.
    }
  };
  return (
    <button
      type="button"
      className={className}
      aria-label={ariaLabel ?? (copied ? doneLabel : label)}
      onClick={() => void copy()}
    >
      {icon === null ? null : copied ? <CheckIcon size={11} /> : (icon ?? <CopyIcon size={12} />)}
      {copied ? doneLabel : label}
    </button>
  );
}

/**
 * 접힘 슬롯 — 자식을 그리드 행에 담아 닫힘 전이(1fr→0fr)를 재생하고, 끝나면
 * onCollapsed 로 내린다. 화면 아래의 내용이 끌려 올라와 빈 자리가 점프로
 * 사라지지 않게 하는 게 전부다. styles.css 의 .fold 와 한 쌍이다.
 */
export function Fold({
  closing,
  onCollapsed,
  children,
}: {
  closing: boolean;
  onCollapsed: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fold"
      data-closing={closing || undefined}
      onTransitionEnd={(event) => {
        // 슬롯 자신의 그리드 접힘(가장 긴 전이)만 센다 — 자식에서 버블된
        // 전이는 닫기와 무관하다.
        if (event.target !== event.currentTarget) return;
        if (event.propertyName !== "grid-template-rows" || !closing) return;
        onCollapsed();
      }}
    >
      {children}
    </div>
  );
}

/**
 * 닫힘 전이를 거치는 한 줄 노티스의 상태. show 는 내용을 열며 접는 중이라도
 * 다시 편다(새 소식이 진행 중인 접힘을 이어받지 않게), close 는 사용자의
 * 닫기로 접기를 시작하고, clear 는 내린다 — 접힘이 끝났거나 시스템이
 * 대체할 때(재시도, 다음 알림).
 */
export function useFoldNotice() {
  const [text, setText] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  return {
    text,
    closing,
    show: (next: string) => {
      setText(next);
      setClosing(false);
    },
    close: () => setClosing(true),
    clear: () => {
      setText(null);
      setClosing(false);
    },
  };
}

/**
 * The card a failed turn renders as (PLAN D35). A planner whose last words
 * got no answer must see WHY the silence, and have the cheapest recovery —
 * sending the very same words again — one click away.
 */
/** The subscription's refusal names itself in the SDK's closing line (리뷰
    B5): the card must NOT invite an immediate resend that fails again — the
    limit refills on the clock, not on attempts. */
const LIMIT_RESULT = /usage limit|rate limit|limit reached|weekly limit|capacity/i;

function FailedTurn({
  subtype,
  resultText,
  retryText,
  onRetry,
}: {
  subtype: string;
  resultText: string | null;
  retryText: string | null;
  onRetry?: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const limit = resultText !== null && LIMIT_RESULT.test(resultText);
  const reason = limit
    ? "구독 사용량이 채워졌습니다 — 채워지면 같은 말로 이어하면 됩니다"
    : (TURN_SUBTYPE_WORDS[subtype] ?? "잠시 문제가 있었습니다 — 다시 보내 주세요");
  return (
    <div className="machine turnfail">
      <div className="machine__head">
        <span className="machine__title">답을 마치지 못했습니다</span>
        <span className="machine__lead">{reason}</span>
      </div>
      <div className="turnfail__actions">
        {!limit && onRetry && retryText && (
          <button type="button" className="turnfail__retry" onClick={() => onRetry(retryText)}>
            다시 보내기
          </button>
        )}
        <button
          type="button"
          className="machine__more"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "접기" : "자세히"}
        </button>
      </div>
      {open && <pre className="machine__body">{resultText ?? (subtype || "turn")}</pre>}
    </div>
  );
}

/** The planner's last own words — what `다시 보내기` resends (PLAN D35). */
function lastUserText(blocks: Block[]): string | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.type === "user") {
      const { marker } = readTurn(block.text);
      if (!marker) return block.text;
    }
  }
  return null;
}

/** The one failed turn whose card still owns `다시 보내기` (커미티 F-B3,
 * 2026-09-14): only the LAST failure. An older card's button used to carry
 * lastUserText too — resending the newest words under an old card's promise. */
function isLastFailedTurn(blocks: Block[], block: Block): boolean {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const candidate = blocks[index];
    if (
      candidate?.type === "turn" &&
      (candidate.isError || (candidate.subtype !== "" && candidate.subtype !== "success"))
    ) {
      return candidate.id === block.id;
    }
  }
  return false;
}

/**
 * 정산된 턴의 한 줄 (리뷰 B4/U4) — 그리고 답이 도구 사이에서 조각으로 올 때
 * 그 요청의 output 전부를 한 번에 복사해 나르는 유일한 자리다. 위 카드들의
 * 답변 복사가 조각을 가져간다면 이 버튼은 그 턴의 답을 이어 붙여 한 번에
 * 건넨다.
 */
function TurnDone({ durationMs, whole }: { durationMs: number; whole?: string }) {
  return (
    <div className="turndone">
      {waitedFor(durationMs)} 걸렸습니다
      {whole && <CopyButton value={whole} label="전체 복사" className="turndone__copy" />}
    </div>
  );
}

export function Transcript({
  blocks,
  live = true,
  onRetry,
  onRewind,
  onResendEdit,
  onStarter,
  starters,
  checkpoints,
  onRestoreCheckpoint,
  showThinking = false,
  showTools = false,
  onBackgroundTask,
  onStopTask,
}: {
  blocks: Block[];
  live?: boolean;
  /** Offered on a failed turn's card: send the same words again (PLAN D35). */
  onRetry?: (text: string) => void;
  /**
   * 다시 요청 (PLAN D95): discard the k-th answer — files and memory — and
   * receive it again. The k is this transcript's answer order.
   */
  onRewind?: (turn: number, text: string) => void;
  /** 고쳐서 다시 보내기 (PLAN D95): the planner's words return to the composer. */
  onResendEdit?: (text: string) => void;
  /** A starter chip was pressed — its sentence becomes the composer's draft. */
  onStarter?: (text: string) => void;
  /** The chips themselves — the connected repo's declared screens, falling
      back to the generic sentences when it declares none (suggestions.ts). */
  starters?: string[];
  /** This session's turn-start snapshots (PLAN D52), oldest first. */
  checkpoints?: Array<{ id: string; turn: number }>;
  /** Puts the worktree back the way it stood before that answer (PLAN D52). */
  onRestoreCheckpoint?: (id: string) => void;
  /**
   * 생각 과정 보기 (설정의 스위치). 꺼져 있으면 생각 블록은 접힌 채로도
   * 남지 않고 테이프에서 아예 빠진다 — 사용자가 읽는 것은 답이지 답을
   * 만드는 동안의 속말이 아니다. 기본은 꺼짐이다.
   */
  showThinking?: boolean;
  /**
   * 작업 과정 보기 (설정의 스위치). 꺼져 있으면 도구 호출 묶음(활동 카드)도
   * 테이프에서 빠진다 — 생각 과정과 같은 이유다. 계획 카드와 캡처 카드는
   * 남는다(PLAN D48·D56): 그 둘은 작업의 기록이 아니라 읽을 내용이다.
   * 판정은 tape-visibility 의 한 규칙이 내리고, 첫 초 줄도 같은 규칙을 묻는다.
   */
  showTools?: boolean;
  /**
   * 작업 다루기 (PLAN D101): 뒤로 보내기 · 이 작업만 중지. 도구 행이 그 버튼을
   * 그리고, 누른 결과는 이 콜백으로 나간다 — 테이프는 상태를 만들지 않는다.
   */
  onBackgroundTask?: (toolUseId: string) => void;
  onStopTask?: (taskId: string) => void;
}) {
  // D95: 되감기 확인 — k 가 마지막 답이 아니면 뒤의 답들도 함께 사라진다는
  // 말을 한 번 묻는다. 마지막 답이면 곧장. 훅은 빈 테이프 early return 보다
  // 위에 있어야 한다 — 순서가 render 마다 같아야 하니까.
  const [rewindAsk, setRewindAsk] = useState<{
    turn: number;
    text: string;
    after: number;
  } | null>(null);
  if (blocks.length === 0) {
    return (
      <div className="empty">
        <p className="empty__lead">메시지를 보내면 대화가 여기에 이어집니다.</p>
        <p className="empty__sub">
          만들고 싶은 화면을 말해 보세요. 미리보기에 핀을 찍어 고쳐 달라고 해도 이 대화로
          들어옵니다.
        </p>
        {onStarter && (
          <div className="empty__starters">
            {(starters ?? GENERIC_STARTERS).map((starter) => (
              <button
                key={starter}
                type="button"
                className="empty__starter"
                onClick={() => onStarter(starter)}
              >
                {starter}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
  // A reloaded history replays its events without a guarantee that the last
  // turn's end marker is in the tape, so a finished session's trailing fold
  // would keep claiming to think. Not live → nothing is thinking.
  // A todo card folds the same way (PLAN D48): a turn-end block is what ends
  // its turn, so every write seen before one is over; not live folds all.
  const endedTodos = new Set<string>();
  let todosSoFar: string[] = [];
  for (const block of blocks) {
    if (block.type === "tool" && block.name === "TodoWrite") todosSoFar.push(block.id);
    else if (block.type === "turn") {
      for (const id of todosSoFar) endedTodos.add(id);
      todosSoFar = [];
    }
  }
  // 되감기 · 체크포인트의 턴 번호는 데몬의 정의를 따른다: k 번째 **프롬프트**
  // (기계 턴 포함 — 세션이 보낸 말이면 전부). 답의 턴은 그 답을 낸 프롬프트의
  // 순번이다. text 블록을 세던 옛 셈은 도구만 돈 턴을 잃고 한 턴에 답이 둘이면
  // 넘쳤다 — 누른 답과 돌아가는 스냅샷이 어긋나던 것은 그 셈의 탓이다.
  const answerTurns = answerTurnNumbers(blocks);
  const totalTurns = promptTotal(blocks);

  // 되돌리기 · 다시 요청은 턴 단위 행동이다 — 같은 턴의 답들이 가리키는
  // 체크포인트는 하나이므로 두 버튼 모두 그 턴의 마지막 답에만 둔다. 턴이 낸
  // 답의 전문은 턴 끝 줄의 전체 복사가 대신 들고 나간다.
  const lastAnswers = lastAnswerPerTurn(blocks);
  const turnAnswers = turnAnswerText(blocks);
  // 생각 · 작업 과정이 꺼져 있으면 groupActivity 보다 **먼저** 걸러낸다:
  // 묶기까지 마치고 나서 지우면 생각이나 도구만 있던 구간이 아무것도 담지
  // 않은 활동 막대로 남는다. 턴 번호의 셈(answerTurns · totalTurns)은
  // 프롬프트와 답만 세므로 이 거르기와 무관하다 — 되감기가 가리키는 답은
  // 그대로다. 판정 규칙 하나는 tape-visibility 이다.
  const tape = blocks.filter((block) => blockOnTape(block, showThinking, showTools));
  const rows = groupActivity(
    live
      ? tape
      : tape.map((block) =>
          block.type === "thinking" && block.streaming ? { ...block, streaming: false } : block,
        ),
  );
  const askRewind = (turn: number, text: string) => {
    if (!onRewind) return;
    const after = totalTurns - turn;
    if (after > 0) setRewindAsk({ turn, text, after });
    else onRewind(turn, text);
  };
  return (
    <div className="transcript">
      {rewindAsk && onRewind && (
        <ConfirmDialog
          title="답 되감기"
          body={
            <>
              이 답을 버릴까요? <strong>이 답 이후의 답 {rewindAsk.after}개</strong>도 함께
              사라집니다.
            </>
          }
          hint="파일도 이 답 이전으로 돌아갑니다."
          confirmLabel="버리고 다시 받기"
          onConfirm={() => {
            onRewind(rewindAsk.turn, rewindAsk.text);
            setRewindAsk(null);
          }}
          onClose={() => setRewindAsk(null)}
        />
      )}
      {rows.map((row) => {
        if (row.kind === "activity")
          return (
            <ActivitySummary
              key={row.id}
              steps={row.steps}
              controls={{ onBackgroundTask, onStopTask }}
            />
          );
        if (row.kind === "todo") {
          return (
            <TodoCard
              key={row.id}
              block={row.block}
              ended={!live || endedTodos.has(row.block.id)}
            />
          );
        }
        const block = row.block;
        switch (block.type) {
          case "user": {
            // Only the planner's own side carries markers: this app writes
            // them, Claude does not. Reading them off assistant text would let
            // a quoted marker in an answer render as a second card.
            const { marker, body } = readTurn(block.text);
            if (marker)
              return (
                <MachineTurn key={block.id} marker={marker} body={body} thumbs={block.thumbs} />
              );
            const halted = TAPE_LINES[block.text.trim()];
            if (halted)
              return (
                <p key={block.id} className="sysline">
                  {halted}
                </p>
              );
            return (
              <div key={block.id} className="bubble bubble--user">
                {block.text}
                {block.images > 0 && <span className="tag">이미지 {block.images}장</span>}
                {block.files.map((file) => (
                  <span key={file} className="bubble__file">
                    {file.split("/").pop()}
                  </span>
                ))}
                {block.text.trim() !== "" && (
                  <div className="bubble__actions">
                    {/* 요청 복사: the planner's own sentence is as worth
                        keeping as the answer to it — the same word, on the
                        turn that asked. */}
                    <CopyButton
                      value={block.text}
                      label="요청 복사"
                      icon={null}
                      className="bubble__act"
                    />
                    {onResendEdit && (
                      <button
                        type="button"
                        className="bubble__act"
                        title="이 문장을 고쳐서 다시 보냅니다"
                        onClick={() => onResendEdit(block.text)}
                      >
                        고쳐서 다시 보내기
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          }
          case "text": {
            const turnNo = answerTurns.get(block.id) ?? 1;
            const tape = TAPE_LINES[block.text.trim()];
            if (tape)
              return (
                <p key={block.id} className="sysline">
                  {tape}
                </p>
              );
            const checkpoint = checkpoints?.find((entry) => entry.turn === turnNo);
            const isLastAnswer = lastAnswers.get(turnNo) === block.id;
            return (
              <div key={block.id}>
                <div className="bubble bubble--assistant">
                  <Markdown text={block.text} />
                  {block.streaming && <span className="caret" />}
                </div>
                <div className="answer__actions">
                  {!block.streaming && (
                    <CopyButton value={block.text} label="답변 복사" className="answer__copy" />
                  )}
                  {isLastAnswer && checkpoint && onRestoreCheckpoint && (
                    <button
                      type="button"
                      className="revert"
                      disabled={live}
                      title="이 요청이 바꾼 화면 파일을, 이 요청이 시작하기 전 모습으로 되돌립니다"
                      onClick={() => onRestoreCheckpoint(checkpoint.id)}
                    >
                      이 요청 이전으로 되돌리기
                    </button>
                  )}
                  {isLastAnswer && onRewind && !live && (
                    <button
                      type="button"
                      className="revert"
                      title="이 답을 버리고 파일·대화를 그 전으로 돌려 같은 말로 다시 받습니다"
                      onClick={() => askRewind(turnNo, lastUserText(blocks) ?? block.text)}
                    >
                      다시 요청
                    </button>
                  )}
                </div>
              </div>
            );
          }
          case "thinking":
            return <ThinkingBlock key={block.id} block={block} />;
          case "tool":
            return SCREEN_SHOT_TOOL.test(block.name) ? (
              <CaptureCard key={block.id} block={block} />
            ) : (
              <ToolBlock
                key={block.id}
                block={block}
                onBackgroundTask={onBackgroundTask}
                onStopTask={onStopTask}
              />
            );
          // A failed turn is the one turn end a planner must SEE (PLAN D35):
          // their words would otherwise just hang there, unanswered. A settled
          // turn keeps one quiet line (리뷰 B4) — the waiting it cost is the
          // planner's own accounting, and the only scale they can judge the
          // next spinner against. 도는 동안의 시계는 입력창 위 한 줄(Composer)이
          // 들고 있다가, 턴이 끝나면 이 줄의 `걸렸습니다`로 멈춘다.
          // Cost stays invisible.
          case "turn":
            return block.isError || (block.subtype !== "" && block.subtype !== "success") ? (
              <FailedTurn
                key={block.id}
                subtype={block.subtype}
                resultText={block.resultText}
                retryText={isLastFailedTurn(blocks, block) ? lastUserText(blocks) : null}
                onRetry={onRetry}
              />
            ) : block.durationMs != null ? (
              <TurnDone
                key={block.id}
                durationMs={block.durationMs}
                whole={turnAnswers.get(block.id)}
              />
            ) : null;
          case "notice":
            return (
              <div key={block.id} className={`notice notice--${block.level}`}>
                <span className="notice__text">{block.text}</span>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Human-in-the-loop cards
// ---------------------------------------------------------------------------

/**
 * 계획의 승인 카드 (계획 모드 완결): 권한 카드의 형식을 빌리되 물는 것이
 * 다르다 — "이 수행을 허용할까요"가 아니라 "이것을 만들까요". 본문은
 * 계획 그 자체(Claude 가 ExitPlanMode 에 실어 보낸 마크다운)이고, 승인은
 * 착수이며 거절은 수정 요청이다. 본문이 없는 요청은 있는 셈 치고 그리지
 * 않고 본래의 권한 카드로 돌려 보낸다.
 */
export function PlanCard({
  request,
  onRespond,
}: {
  request: PendingPermission;
  onRespond: (decision: "allow" | "allowAlways" | "deny", message?: string) => void;
}) {
  const [changes, setChanges] = useState("");
  const [showChanges, setShowChanges] = useState(false);
  const plan = (request.input as { plan?: unknown } | null)?.plan;
  if (typeof plan !== "string" || plan.trim() === "") {
    return <PermissionCard request={request} onRespond={onRespond} />;
  }

  return (
    <div className="card card--plan" role="alert">
      <div className="card__title">
        <span className="card__badge">
          <SparkIcon size={14} />
        </span>
        <span>
          <strong>만들 것</strong>을 승인해 주세요
        </span>
      </div>
      <p className="plan__lead">
        Claude 가 화면을 만들기 전에 무엇을 만들지 보여 드립니다 — 승인하면 바로 만듭니다.
      </p>
      <div className="card__plan">
        <Markdown text={plan} />
      </div>
      {showChanges ? (
        <div className="card__reason">
          <textarea
            autoFocus
            value={changes}
            placeholder="무엇을 어떻게 바꿀지 알려 주세요"
            onChange={(e) => setChanges(e.target.value)}
          />
          <button
            type="button"
            className="danger"
            onClick={() => onRespond("deny", changes || undefined)}
          >
            바꿔 달라 보내기
          </button>
          <button type="button" className="ghost" onClick={() => setShowChanges(false)}>
            뒤로
          </button>
        </div>
      ) : (
        <div className="card__actions">
          <button type="button" className="primary" onClick={() => onRespond("allow")}>
            승인하고 만들기
          </button>
          <button type="button" className="danger" onClick={() => setShowChanges(true)}>
            바꿔 달라…
          </button>
        </div>
      )}
    </div>
  );
}

export function PermissionCard({
  request,
  onRespond,
  commands,
}: {
  request: PendingPermission;
  onRespond: (decision: "allow" | "allowAlways" | "deny", message?: string) => void;
  /** The repo's resolved commands, for naming Bash calls (PLAN D37). */
  commands?: RepoCommands;
}) {
  const [reason, setReason] = useState("");
  const [showReason, setShowReason] = useState(false);
  const raw = toolHeadline(request.input);
  const headline = request.toolName === "Bash" ? bashHeadline(raw, commands) : raw;
  const action = toolLabel(request.toolName);
  const suggestion = request.suggestions[0];

  return (
    <div className="card card--permission" role="alert">
      <div className="card__title">
        <span className="card__badge">
          <ShieldIcon />
        </span>
        <span>
          <strong>{action}</strong>
          {objectParticle(action)} 허용할까요?
        </span>
      </div>
      {headline && <pre className="card__headline">{headline}</pre>}
      <details className="card__details">
        <summary>자세히 보기</summary>
        <pre>{preview(request.input, 4000)}</pre>
      </details>

      {showReason ? (
        <div className="card__reason">
          <input
            autoFocus
            value={reason}
            placeholder="왜 안 되는지, 대신 무엇을 할지 알려 주세요"
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              // An IME owns every keydown until its composition ends — Enter
              // commits the hangul (isComposing, legacy keyCode 229). Sending
              // the refusal on it would hand Claude half a sentence.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter") onRespond("deny", reason || undefined);
            }}
          />
          <button type="button" onClick={() => onRespond("deny", reason || undefined)}>
            거절 보내기
          </button>
          <button type="button" className="ghost" onClick={() => setShowReason(false)}>
            뒤로
          </button>
        </div>
      ) : (
        <div className="card__actions">
          <button type="button" className="primary" onClick={() => onRespond("allow")}>
            이번만 허용
          </button>
          <button
            type="button"
            disabled={!suggestion}
            title={suggestion ? suggestion.label : "이 동작은 계속 물어볼 수밖에 없습니다"}
            onClick={() => onRespond("allowAlways")}
          >
            {suggestion ? suggestion.label : "항상 허용"}
          </button>
          <button type="button" className="danger" onClick={() => setShowReason(true)}>
            거절…
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 선택지의 미리보기 (PLAN D96): `previewFormat: "html"` 로 받은 시안은 글이
 * 아니라 그림이다. 스크립트도 부모 문서도 닿을 수 없는 sandbox iframe 안에서만
 * 그린다 — 카드에 들어오는 HTML 은 모델이 쓴 것이고, 이 앱의 DOM 은 그것과
 * 같은 세계에 있으면 안 된다. `srcdoc` 의 문서에 CSP 를 직접 심어 바깥으로
 * 나가는 요청(원격 폰트 · 이미지 · 추적)까지 막는다.
 */
function OptionPreview({ html, tall }: { html: string; tall: boolean }) {
  // 마크다운으로 온 옛 미리보기(또는 HTML 이 아닌 무엇)는 글자 그대로 읽힌다.
  if (!/^\s*</.test(html)) return <pre className="option__previewtext">{html}</pre>;
  const doc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"><style>body{margin:0;padding:12px;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1c1c1f;background:#fff}</style>${html}`;
  return (
    <iframe
      className={tall ? "option__preview option__preview--tall" : "option__preview"}
      title="선택지 미리보기"
      sandbox=""
      srcDoc={doc}
    />
  );
}

export function QuestionCard({
  request,
  onRespond,
}: {
  request: PendingQuestion;
  onRespond: (
    answers: Record<string, string | string[]>,
    annotations: Record<string, { preview?: string; notes?: string }>,
  ) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  /** 선택 옆의 메모 (D96): 질문 글자를 키로, 계획자가 덧붙인 말. */
  const [notes, setNotes] = useState<Record<string, string>>({});

  const pick = (q: AskQuestion, label: string) => {
    setAnswers((prev) => {
      if (!q.multiSelect) return { ...prev, [q.question]: label };
      const current = prev[q.question];
      const list = Array.isArray(current) ? current : current ? [current] : [];
      return {
        ...prev,
        [q.question]: list.includes(label) ? list.filter((l) => l !== label) : [...list, label],
      };
    });
  };

  const isPicked = (q: AskQuestion, label: string) => {
    const current = answers[q.question];
    return Array.isArray(current) ? current.includes(label) : current === label;
  };

  const merged = (): Record<string, string | string[]> => {
    const out = { ...answers };
    for (const [question, text] of Object.entries(custom)) {
      if (text.trim()) out[question] = text.trim();
    }
    return out;
  };

  /**
   * 무엇을 돌려보내는가: 메모와, 그 메모가 붙은 선택지의 시안. 고른 것이 없는
   * 질문(직접 입력으로 답한 질문)은 시안 없이 메모만 간다.
   */
  const annotations = (): Record<string, { preview?: string; notes?: string }> => {
    const out: Record<string, { preview?: string; notes?: string }> = {};
    for (const q of request.questions) {
      const note = notes[q.question]?.trim();
      if (!note) continue;
      const picked = q.options.find((option) => isPicked(q, option.label));
      out[q.question] = { notes: note, ...(picked?.preview ? { preview: picked.preview } : {}) };
    }
    return out;
  };

  const complete = request.questions.every((q) => {
    const value = merged()[q.question];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });

  return (
    <div className="card card--question">
      <div className="card__title">
        <span className="card__badge">
          <SparkIcon size={14} />
        </span>
        <span>확인이 필요합니다</span>
      </div>
      {request.questions.map((q) => {
        const previews = q.options.filter((option) => option.preview);
        // 시안이 전부 있고 셋 이하면 나란히 놓는다 — 시안은 비교하라고 있는
        // 것이고, 위아래로 쌓인 시안은 비교가 아니라 스크롤이다.
        const compare = previews.length === q.options.length && q.options.length <= 3;
        const pickedPreview = q.options.find(
          (option) => isPicked(q, option.label) && option.preview,
        )?.preview;
        return (
          <div key={q.question} className="question">
            <div className="question__header">{q.header}</div>
            <div className="question__text">{q.question}</div>
            <div
              className={
                compare ? "question__options question__options--wide" : "question__options"
              }
            >
              {q.options.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className={isPicked(q, option.label) ? "option option--picked" : "option"}
                  onClick={() => pick(q, option.label)}
                >
                  <span className="option__label">{option.label}</span>
                  <span className="option__description">{option.description}</span>
                  {compare && option.preview && (
                    <OptionPreview html={option.preview} tall={false} />
                  )}
                </button>
              ))}
            </div>
            {/* 나란히 놓지 못한 시안은 고른 것 하나만 크게 — 고르기 전에는
                아무것도 그리지 않는다(빈 액자는 카드를 밀어낼 뿐이다). */}
            {!compare && pickedPreview && <OptionPreview html={pickedPreview} tall={true} />}
            <input
              className="question__custom"
              placeholder="기타: 직접 입력"
              value={custom[q.question] ?? ""}
              onChange={(e) => setCustom((prev) => ({ ...prev, [q.question]: e.target.value }))}
            />
            <input
              className="question__notes"
              placeholder="메모: 고른 이유나 바꿀 점 (선택)"
              value={notes[q.question] ?? ""}
              onChange={(e) => setNotes((prev) => ({ ...prev, [q.question]: e.target.value }))}
            />
          </div>
        );
      })}
      <div className="card__actions">
        <button
          type="button"
          className="primary"
          disabled={!complete}
          onClick={() => onRespond(merged(), annotations())}
        >
          답변 보내기
        </button>
      </div>
    </div>
  );
}
