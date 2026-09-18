import { useState } from "react";
import type { Block } from "../../lib/daemon-client";
import { agentBriefs } from "../../lib/progress";
import { latestTodoItems } from "../../lib/todo-plan";
import { CheckIcon, ChevronRightIcon, CloseIcon } from "../icons";
import { TodoList } from "../transcript/todo";

/**
 * 하위 작업 · 할 일의 목차 스트립. 테이프가 길어질수록 "지금 몇 개가 도는지"
 * 는 스크롤 위 어딘가에 묻힌다 — 이 한 줄이 컴포저 위에 고정으로 서서
 * 그 셈을 대신 읽어 준다. 접힌 머리가 세는 숫자고, 펼쳤을 때 읽는 목록이다:
 * 에이전트는 무엇을 하러 갔는지·최근 근황 한 줄까지, 할 일은 ✓ ● ○ 목록
 * 그대로. 보일 것이 하나도 없으면 아예 서지 않는다 — 빈 막대는 소음이다.
 */
export function WorkStrip({ blocks }: { blocks: Block[] }) {
  const [open, setOpen] = useState(false);
  const agents = agentBriefs(blocks);
  const todos = latestTodoItems(blocks);
  if (agents.length === 0 && !todos) return null;
  const running = agents.filter((agent) => agent.status === "running").length;
  const todoDone = todos ? todos.filter((t) => t.status === "completed").length : 0;
  // 진행 N/M — TodoCard 의 셈을 따른다: 현재 하고 있는 일도 이루어진 셈에 넣는다.
  const current = todos?.find((t) => t.status === "in_progress") ?? null;
  const todoProgress = todos ? todoDone + (current ? 1 : 0) : 0;
  return (
    <div className="workstrip">
      <button
        type="button"
        className="workstrip__bar"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`tool__chevron${open ? " tool__chevron--open" : ""}`}>
          <ChevronRightIcon />
        </span>
        {agents.length > 0 && (
          <span className="workstrip__chip">
            {running > 0 ? <span className="spinner" /> : <CheckIcon size={11} />}
            {running > 0 ? (
              <>
                보조 작업 {running}/{agents.length}
                <span className="workstrip__live">실행 중</span>
              </>
            ) : (
              `보조 작업 ${agents.length}개 끝`
            )}
          </span>
        )}
        {todos && todos.length > 0 && (
          <span className="workstrip__chip">
            할 일 {todoProgress}/{todos.length}
            {current && <span className="workstrip__lead">{current.text}</span>}
          </span>
        )}
      </button>
      {open && (
        <div className="workstrip__body">
          {agents.length > 0 && (
            <ul className="workstrip__agents">
              {agents.map((agent) => (
                <li key={agent.id} className={`workstrip__agent workstrip__agent--${agent.status}`}>
                  <span className="workstrip__sign">
                    {agent.status === "running" ? (
                      <span className="spinner" />
                    ) : agent.status === "completed" ? (
                      <CheckIcon size={11} />
                    ) : (
                      <CloseIcon size={11} />
                    )}
                  </span>
                  <span className="workstrip__agentmain">
                    <span className="workstrip__agentlabel">
                      {agent.label || "보조 작업"}
                      {agent.type && <span className="tag">{agent.type}</span>}
                      {agent.backgrounded && <span className="tag">뒤에서 도는 중</span>}
                    </span>
                    {agent.summary && <span className="workstrip__agentsay">{agent.summary}</span>}
                  </span>
                  {agent.toolUses > 0 && (
                    <span className="workstrip__meta">도구 {agent.toolUses}회</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {todos && todos.length > 0 && <TodoList todos={todos} />}
        </div>
      )}
    </div>
  );
}
