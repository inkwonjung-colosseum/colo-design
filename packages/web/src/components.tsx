import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import type { AskQuestion, RepoStatus, TurnMarker } from "@cds-design/protocol";
import { readTurn } from "@cds-design/protocol";
import type { Block, PendingPermission, PendingQuestion } from "./daemon-client";
import { Markdown } from "./Markdown";
import { CheckIcon, CloseIcon, CopyIcon, ShieldIcon, SparkIcon, ChevronRightIcon } from "./icons";
import { bashHeadline, objectParticle, toolLabel } from "./tool-names";

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

/** The repo's own cds-design.json commands, as RepoStatus carries them. */
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
function toolHeadline(name: string, input: unknown): string {
  const i = input as Record<string, unknown> | null;
  if (!i || typeof i !== "object") return "";
  for (const key of ["command", "file_path", "path", "pattern", "url", "prompt", "description"]) {
    const value = i[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/**
 * The cds-preview 도구 이름은 `mcp__cds-preview__screen_*` 로 온다(PLAN
 * D61): the server prefix is plumbing, so the recognisers key on the tool's
 * own name.
 */
const SCREEN_SHOT_TOOL = /screen_screenshot$/;
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

function ToolBlock({ block }: { block: Extract<Block, { type: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const headline = toolHeadline(block.name, block.input);
  const status: ToolStatus = !block.done ? "running" : block.isError ? "error" : "done";

  return (
    <div className={`tool tool--${status}`}>
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
          {status === "running" ? "실행 중…" : status === "error" ? "실패" : ""}
        </span>
      </button>
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
 * Claude's private reasoning, folded by default. While the turn is running it
 * reads as live ("생각 중…"); once the turn ends the same fold reads as a
 * record ("생각 과정") — a finished transcript must not look like it is still
 * thinking. The closed fold carries the thought's first line as a peek, so a
 * planner scanning the tape reads the shape of the reasoning without opening
 * it.
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
 * A run folds tools AND the thinking between them into one row: Claude thinks
 * between tool calls, so tool-only grouping rendered a finished turn as a
 * stack of near-identical bars. The head counts the tools; the body replays
 * the steps, thinking included, for the planner who needs the detail.
 */
function ActivitySummary({ steps }: { steps: ActivityStep[] }) {
  const [open, setOpen] = useState(false);
  const tools = steps.filter((step): step is Extract<Block, { type: "tool" }> => step.type === "tool");
  const running = tools.some((tool) => !tool.done);
  const failed = tools.some((tool) => tool.isError);

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
        <span className="activity__text">{activityLine(tools)}</span>
        {failed && <span className="activity__flag">실패 있음</span>}
      </button>
      {open && (
        <div className="activity__body">
          {steps.map((step) =>
            step.type === "tool" ? <ToolBlock key={step.id} block={step} /> : <ThinkingBlock key={step.id} block={step} />,
          )}
        </div>
      )}
    </div>
  );
}

type ActivityStep = Extract<Block, { type: "tool" }> | Extract<Block, { type: "thinking" }>;

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
          key={index}
          className={todo.status === "in_progress" ? "todo__item todo__item--current" : "todo__item"}
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

  switch (marker.kind) {
    case "comments":
      title = `수정 요청 ${marker.items.length}건`;
      lead = [marker.screen, marker.state && `${marker.state} 상태`].filter(Boolean).join(" · ");
      rows = marker.items.map((item, index) => ({
        key: String(index),
        label: item.label || `${index + 1}번째`,
        text: item.comment,
      }));
      break;
    case "brief":
      // D94: the connection-preparation brief reads as its own thing.
      title = marker.purpose === "bootstrap" ? "연결 준비" : "이 기획서로 화면 만들기";
      lead = marker.title;
      break;
    case "precheck":
      title = "기획서와 대조하기";
      lead = marker.title;
      rows =
        marker.screens.length > 0
          ? marker.screens.map((screen, index) => ({
              key: String(index),
              label: screen,
              text: "",
            }))
          : [{ key: "none", label: "아직 이 기획서로 만든 화면이 없습니다", text: "" }];
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
      {rows.length > 0 && (
        <ul className="machine__rows">
          {rows.map((row, index) => (
            <li key={row.key}>
              {marker.kind === "comments" && thumbs?.[index] && (
                <img
                  className="machine__thumb"
                  src={`data:image/jpeg;base64,${thumbs[index]}`}
                  alt=""
                />
              )}
              <span className="machine__label">{row.label}</span>
              {row.text && <span className="machine__text">{row.text}</span>}
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="machine__more"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "접기" : "자세히"}
      </button>
      {open && <pre className="machine__body">{body}</pre>}
    </div>
  );
}

/**
 * The planner lifts Claude's wording into a 기획 doc or a chat, so the
 * answer's hover carries a one-click copy. It copies the markdown source —
 * the text Claude wrote, not the rendered reading of it.
 */
function AssistantBubble({ block }: { block: Extract<Block, { type: "text" }> }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(block.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked; the answer stays selectable text regardless.
    }
  };
  return (
    <div className="bubble bubble--assistant">
      <Markdown text={block.text} />
      {block.streaming && <span className="caret" />}
      <button
        type="button"
        className={copied ? "bubble__copy bubble__copy--done" : "bubble__copy"}
        aria-label={copied ? "복사됨" : "답변 복사"}
        title="복사"
        onClick={() => void copy()}
      >
        {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
      </button>
    </div>
  );
}

const TURN_SUBTYPE_WORDS: Record<string, string> = {
  error_max_turns: "정한 대화 길이를 채웠습니다 — 새 대화에서 이어 가면 됩니다",
  error_during_execution: "잠시 문제가 있었습니다 — 다시 보내 주세요",
  interrupted: "멈추었습니다 — 이어서 말하면 됩니다",
};

/**
 * The card a failed turn renders as (PLAN D35). A planner whose last words
 * got no answer must see WHY the silence, and have the cheapest recovery —
 * sending the very same words again — one click away.
 */
function FailedTurn({
  subtype,
  retryText,
  onRetry,
}: {
  subtype: string;
  retryText: string | null;
  onRetry?: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const reason = TURN_SUBTYPE_WORDS[subtype] ?? "잠시 문제가 있었습니다 — 다시 보내 주세요";
  return (
    <div className="machine turnfail">
      <div className="machine__head">
        <span className="machine__title">답을 마치지 못했습니다</span>
        <span className="machine__lead">{reason}</span>
      </div>
      <div className="turnfail__actions">
        {onRetry && retryText && (
          <button type="button" className="primary" onClick={() => onRetry(retryText)}>
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
      {open && <pre className="machine__body">{subtype || "turn"}</pre>}
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

export function Transcript({
  blocks,
  live = true,
  commands,
  onRetry,
  onRewind,
  onResendEdit,
  checkpoints,
  onRestoreCheckpoint,
}: {
  blocks: Block[];
  live?: boolean;
  /** The repo's cds-design.json commands, for naming Bash calls (PLAN D37). */
  commands?: RepoCommands;
  /** Offered on a failed turn's card: send the same words again (PLAN D35). */
  onRetry?: (text: string) => void;
  /**
   * 다시 요청 (PLAN D95): discard the k-th answer — files and memory — and
   * receive it again. The k is this transcript's answer order.
   */
  onRewind?: (turn: number, text: string) => void;
  /** 고쳐서 다시 보내기 (PLAN D95): the planner's words return to the composer. */
  onResendEdit?: (text: string) => void;
  /** This session's turn-start snapshots (PLAN D52), oldest first. */
  checkpoints?: Array<{ id: string; turn: number }>;
  /** Puts the worktree back the way it stood before that answer (PLAN D52). */
  onRestoreCheckpoint?: (id: string) => void;
}) {
  if (blocks.length === 0) {
    return (
      <div className="empty">
        <p className="empty__lead">메시지를 보내면 대화가 여기에 이어집니다.</p>
        <p className="empty__sub">
          만들고 싶은 화면을 말해 보세요. 미리보기에 핀을 찍어 고쳐 달라고 해도 이 대화로 들어옵니다.
        </p>
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
  // The k-th assistant answer maps to the k-th turn-start snapshot (PLAN
  // D52): every send takes one, so the counts line up even when a turn failed.
  let assistantCount = 0;
  const rows = groupActivity(
    live
      ? blocks
      : blocks.map((block) =>
          block.type === "thinking" && block.streaming ? { ...block, streaming: false } : block,
        ),
  );
  // D95: 되감기 확인 — k 가 마지막 답이 아니면 뒤의 답들도 함께 사라진다는
  // 말을 한 번 묻는다. 마지막 답이면 곧장.
  const [rewindAsk, setRewindAsk] = useState<{ turn: number; text: string; after: number } | null>(
    null,
  );
  const totalAnswers = blocks.filter((block) => block.type === "text").length;
  const askRewind = (turn: number, text: string) => {
    if (!onRewind) return;
    const after = totalAnswers - turn;
    if (after > 0) setRewindAsk({ turn, text, after });
    else onRewind(turn, text);
  };
  return (
    <div className="transcript">
      {rewindAsk && onRewind && (
        <ConfirmDialog
          title="답 되감기"
          body={<>이 답을 버릴까요? <strong>이 답 이후의 답 {rewindAsk.after}개</strong>도 함께 사라집니다.</>}
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
        if (row.kind === "activity") return <ActivitySummary key={row.id} steps={row.steps} />;
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
              return <MachineTurn key={block.id} marker={marker} body={body} thumbs={block.thumbs} />;
            const halted = TAPE_LINES[block.text.trim()];
            if (halted) return <p key={block.id} className="sysline">{halted}</p>;
            return (
              <div key={block.id} className="bubble bubble--user">
                {block.text}
                {block.images > 0 && <span className="tag">이미지 {block.images}장</span>}
                {block.files.map((file) => (
                  <span key={file} className="bubble__file">
                    {file.split("/").pop()}
                  </span>
                ))}
                {onResendEdit && block.text.trim() !== "" && (
                  <button
                    type="button"
                    className="bubble__resend"
                    title="이 문장을 고쳐서 다시 보냅니다"
                    onClick={() => onResendEdit(block.text)}
                  >
                    고쳐서 다시 보내기
                  </button>
                )}
              </div>
            );
          }
          case "text": {
            assistantCount += 1;
            // The checkpoint count stays aligned even for a block that only
            // poses as an answer; the k-th turn is the k-th turn regardless.
            const tape = TAPE_LINES[block.text.trim()];
            if (tape) return <p key={block.id} className="sysline">{tape}</p>;
            const checkpoint = checkpoints?.find((entry) => entry.turn === assistantCount);
            return (
              <div key={block.id}>
                <AssistantBubble block={block} />
                <div className="answer__actions">
                  {checkpoint && onRestoreCheckpoint && (
                    <button
                      type="button"
                      className="revert"
                      disabled={live}
                      title="이 답변이 바꾼 화면 파일을, 이 답변이 시작하기 전 모습으로 되돌립니다"
                      onClick={() => onRestoreCheckpoint(checkpoint.id)}
                    >
                      이 답변 이전으로 되돌리기
                    </button>
                  )}
                  {onRewind && !live && (
                    <button
                      type="button"
                      className="revert"
                      title="이 답을 버리고 파일·대화를 그 전으로 돌려 같은 말로 다시 받습니다"
                      onClick={() => askRewind(assistantCount, lastUserText(blocks) ?? block.text)}
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
              <ToolBlock key={block.id} block={block} />
            );
          // A failed turn is the one turn end a planner must SEE (PLAN D35):
          // their words would otherwise just hang there, unanswered. Cost and
          // duration stay invisible — that accounting is not theirs.
          case "turn":
            return block.isError || (block.subtype !== "" && block.subtype !== "success") ? (
              <FailedTurn
                key={block.id}
                subtype={block.subtype}
                retryText={lastUserText(blocks)}
                onRetry={onRetry}
              />
            ) : null;
          case "notice":
            return (
              <div key={block.id} className={`notice notice--${block.level}`}>
                <span className="notice__text">{block.text}</span>
              </div>
            );
        }
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Human-in-the-loop cards
// ---------------------------------------------------------------------------

export function PermissionCard({
  request,
  onRespond,
  commands,
}: {
  request: PendingPermission;
  onRespond: (decision: "allow" | "allowAlways" | "deny", message?: string) => void;
  /** The repo's cds-design.json commands, for naming Bash calls (PLAN D37). */
  commands?: RepoCommands;
}) {
  const [reason, setReason] = useState("");
  const [showReason, setShowReason] = useState(false);
  const raw = toolHeadline(request.toolName, request.input);
  const headline = request.toolName === "Bash" ? bashHeadline(raw, commands) : raw;
  const action = toolLabel(request.toolName);
  const suggestion = request.suggestions[0];

  return (
    <div className="card card--permission">
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
            {suggestion ? `항상 허용 · ${suggestion.label}` : "항상 허용"}
          </button>
          <button type="button" className="danger" onClick={() => setShowReason(true)}>
            거절…
          </button>
        </div>
      )}
    </div>
  );
}

export function QuestionCard({
  request,
  onRespond,
}: {
  request: PendingQuestion;
  onRespond: (answers: Record<string, string | string[]>) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});

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
      {request.questions.map((q) => (
        <div key={q.question} className="question">
          <div className="question__header">{q.header}</div>
          <div className="question__text">{q.question}</div>
          <div className="question__options">
            {q.options.map((option) => (
              <button
                key={option.label}
                type="button"
                className={isPicked(q, option.label) ? "option option--picked" : "option"}
                onClick={() => pick(q, option.label)}
              >
                <span className="option__label">{option.label}</span>
                <span className="option__description">{option.description}</span>
              </button>
            ))}
          </div>
          <input
            className="question__custom"
            placeholder="기타: 직접 입력"
            value={custom[q.question] ?? ""}
            onChange={(e) => setCustom((prev) => ({ ...prev, [q.question]: e.target.value }))}
          />
        </div>
      ))}
      <div className="card__actions">
        <button
          type="button"
          className="primary"
          disabled={!complete}
          onClick={() => onRespond(merged())}
        >
          답변 보내기
        </button>
      </div>
    </div>
  );
}
