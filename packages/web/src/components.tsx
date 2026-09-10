import { useState } from "react";
import type { AskQuestion, TurnMarker } from "@cds-design/protocol";
import { readTurn } from "@cds-design/protocol";
import type { Block, PendingPermission, PendingQuestion } from "./daemon-client";
import { Markdown } from "./Markdown";
import { CheckIcon, CloseIcon, CopyIcon, ShieldIcon, SparkIcon, ChevronRightIcon } from "./icons";

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
        <span className="tool__name">{block.name}</span>
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
  // gained; the words below describe the work (PLAN D9).
  const parts: string[] = [];
  if (file) parts.push(`화면 파일 ${file}개 작업`);
  if (command) parts.push(`검사 ${command}회 실행`);
  if (read) parts.push(`${read}곳 확인`);
  if (other) parts.push(`그 밖에 ${other}가지`);
  return parts.join(" · ");
}

/**
 * Claude's private reasoning, folded by default. While the turn is running it
 * reads as live ("생각 중…"); once the turn ends the same fold reads as a
 * record ("생각 과정") — a finished transcript must not look like it is still
 * thinking.
 */
function ThinkingBlock({ block }: { block: Extract<Block, { type: "thinking" }> }) {
  return (
    <details className="thinking">
      <summary>{block.streaming ? "생각 중…" : "생각 과정"}</summary>
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
    <div className={failed ? "activity activity--error" : "activity"}>
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

type Row =
  | { kind: "block"; block: Block }
  | { kind: "activity"; id: string; steps: ActivityStep[] };

/**
 * A run ends where the planner's attention ends: a user bubble, assistant
 * text, a turn end, or a notice. Thinking alone never starts a run of one.
 */
function groupActivity(blocks: Block[]): Row[] {
  const rows: Row[] = [];
  let run: ActivityStep[] | null = null;
  const flush = () => {
    if (!run) return;
    if (run.every((step) => step.type === "thinking")) {
      for (const step of run) rows.push({ kind: "block", block: step });
    } else {
      rows.push({ kind: "activity", id: `activity-${run[0]!.id}`, steps: run });
    }
    run = null;
  };
  for (const block of blocks) {
    if (block.type === "tool" || block.type === "thinking") {
      run = run ?? [];
      run.push(block);
      continue;
    }
    flush();
    rows.push({ kind: "block", block });
  }
  flush();
  return rows;
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
function MachineTurn({ marker, body }: { marker: TurnMarker; body: string }) {
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
      title = "이 기획서로 화면 만들기";
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
  }

  return (
    <div className={`machine machine--${marker.kind}`}>
      <div className="machine__head">
        <span className="machine__title">{title}</span>
        {lead && <span className="machine__lead">{lead}</span>}
      </div>
      {rows.length > 0 && (
        <ul className="machine__rows">
          {rows.map((row) => (
            <li key={row.key}>
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

export function Transcript({ blocks, live = true }: { blocks: Block[]; live?: boolean }) {
  if (blocks.length === 0) {
    return <p className="empty">메시지를 보내면 대화가 여기에 이어집니다.</p>;
  }
  // A reloaded history replays its events without a guarantee that the last
  // turn's end marker is in the tape, so a finished session's trailing fold
  // would keep claiming to think. Not live → nothing is thinking.
  const rows = groupActivity(
    live
      ? blocks
      : blocks.map((block) =>
          block.type === "thinking" && block.streaming ? { ...block, streaming: false } : block,
        ),
  );
  return (
    <div className="transcript">
      {rows.map((row) => {
        if (row.kind === "activity") return <ActivitySummary key={row.id} steps={row.steps} />;
        const block = row.block;
        switch (block.type) {
          case "user": {
            // Only the planner's own side carries markers: this app writes
            // them, Claude does not. Reading them off assistant text would let
            // a quoted marker in an answer render as a second card.
            const { marker, body } = readTurn(block.text);
            if (marker) return <MachineTurn key={block.id} marker={marker} body={body} />;
            return (
              <div key={block.id} className="bubble bubble--user">
                {block.text}
                {block.images > 0 && <span className="tag">이미지 {block.images}장</span>}
                {block.files.map((file) => (
                  <span key={file} className="bubble__file">
                    {file.split("/").pop()}
                  </span>
                ))}
              </div>
            );
          }
          case "text":
            return <AssistantBubble key={block.id} block={block} />;
          case "thinking":
            return <ThinkingBlock key={block.id} block={block} />;
          case "tool":
            return <ToolBlock key={block.id} block={block} />;
          // Cost and duration are a developer's accounting, not a planner's.
          case "turn":
            return null;
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
}: {
  request: PendingPermission;
  onRespond: (decision: "allow" | "allowAlways" | "deny", message?: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [showReason, setShowReason] = useState(false);
  const headline = toolHeadline(request.toolName, request.input);
  const suggestion = request.suggestions[0];

  return (
    <div className="card card--permission">
      <div className="card__title">
        <span className="card__badge">
          <ShieldIcon />
        </span>
        <span>
          <strong>{request.toolName}</strong> 실행을 허용할까요?
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
