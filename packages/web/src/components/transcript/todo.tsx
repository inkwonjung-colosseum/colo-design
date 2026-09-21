import { useState } from "react";
import { readTodoList, type TodoItem } from "../../lib/todo-plan";
import { ToolBlock } from "./blocks";
import type { TodoToolBlock } from "./shared";

export function TodoList({ todos }: { todos: TodoItem[] }) {
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
 * 끝난 턴의 할 일 한 줄 — "할 일 N개 끝". 도는 턴의 할 일은 이 카드가
 * 그리지 않는다: WorkStrip 이 컴포저 위에 같은 목차를 고정으로 세우므로,
 * 테이프가 또 그리는 것은 같은 정보의 두 번째 사본이다(라이브 카드는
 * Transcript 에서 걸러진다). 펼치면 ✓ ● ○ 목록이 남는다 — 기록은 접힌
 * 한 줄 뒤에 있다. 목록을 쓰지 않은 TodoWrite 는 카드가 아니라 도구 줄로.
 */
export function TodoCard({ block }: { block: TodoToolBlock }) {
  const [open, setOpen] = useState(false);
  const todos = readTodoList(block.input);
  if (!todos || todos.length === 0) return <ToolBlock block={block} />;

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
