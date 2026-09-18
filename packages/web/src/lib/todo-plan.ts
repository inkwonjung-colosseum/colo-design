import type { Block } from "./daemon-client";

/**
 * 할 일 목록의 읽기 — TodoWrite 입력의 방어적 파싱과 "최신 목록 하나" 규칙.
 * 스트립(WorkStrip)이 세는 `k/n` 도 여기서 나온다.
 *
 * 순수 함수로 여기 사는 이유는 progress.ts 와 같다: 블록 배열 in · 목록 out,
 * 판정 규칙은 테스트가 박아야 한다.
 */

export interface TodoItem {
  text: string;
  status: "completed" | "in_progress" | "pending";
}

/**
 * the agent.s plan, read defensively out of a TodoWrite input: `content` is the
 * CLI's current shape, `activeForm` and `subject` are shapes other senders
 * used. Something that is not a todo list at all gets no card.
 */
export function readTodoList(input: unknown): TodoItem[] | null {
  const todos = (input as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(todos)) return null;
  return todos.map((entry): TodoItem => {
    const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const text = [item.content, item.activeForm, item.subject].find(
      (value): value is string => typeof value === "string" && value.trim() !== "",
    );
    const status =
      item.status === "completed" || item.status === "in_progress" ? item.status : "pending";
    return { text: text ?? "", status };
  });
}

/**
 * 테이프의 **마지막** 할 일 목록. TodoWrite 는 덮어쓰는 도구다 — 과거의
 * 목록이 이기면 스트립이 끝난 일을 다음 일처럼 읽힌다. 목록을 쓴 적이
 * 없으면 null: 빈 목록 카드를 그릴 이유가 없다.
 */
export function latestTodoItems(blocks: Block[]): TodoItem[] | null {
  let todos: TodoItem[] | null = null;
  for (const block of blocks) {
    if (block.type === "tool" && block.name === "TodoWrite") todos = readTodoList(block.input);
  }
  return todos;
}
