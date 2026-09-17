import { useState } from "react";
import { ToolBlock } from "./blocks";
import type { TodoToolBlock } from "./shared";

interface TodoItem {
  text: string;
  status: "completed" | "in_progress" | "pending";
}

/**
 * the agent.s plan, read defensively out of a TodoWrite input: `content` is the
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
 * the agent.s own plan as a card: `진행 N/M`, items ✓ · ● · ○ with
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

export { TodoCard };
