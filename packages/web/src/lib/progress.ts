import type { ChatEvent } from "@colo-design/protocol";
import type { Block } from "./daemon-client";

/**
 * 도는 동안의 진행 — 새 기록 행이 아니라 **이미 있는 도구 행에 붙는
 * 상태**다. 사용자가 보는 것은 하나의 일이지 그 일에 대한 두 개의 줄이 아니고,
 * 백그라운드로 보낸 작업은 도구 호출이 끝난 뒤에도 계속 도니까 — 그 사실을
 * 담을 곳은 그 행밖에 없다.
 *
 * 순수 함수로 여기 사는 이유: 접기(`foldEvent`)와 같은 성질(블록 배열 in ·
 * 블록 배열 out)이면서, 붙일 행을 못 찾는 경우가 규칙의 절반이라 테스트가
 * 케이스를 박아야 한다. 못 찾으면 **같은 배열을 그대로** 돌려준다 — React 가
 * 헛되이 다시 그리지 않게.
 */

type ToolBlock = Extract<Block, { type: "tool" }>;

export type ProgressEvent =
  | Extract<ChatEvent, { kind: "tool.progress" }>
  | Extract<ChatEvent, { kind: "task.start" }>
  | Extract<ChatEvent, { kind: "task.progress" }>
  | Extract<ChatEvent, { kind: "task.update" }>
  | Extract<ChatEvent, { kind: "task.end" }>;

/** 한 작업(보조 에이전트 · 백그라운드 명령)의 지금. */
interface TaskProgress {
  id: string;
  description: string;
  /** 모델이 30초마다 쓴 한 줄 근황(`agentProgressSummaries`), 없으면 null. */
  summary: string | null;
  lastTool: string | null;
  subagentType: string | null;
  tokens: number;
  toolUses: number;
  /** 턴을 붙잡지 않고 뒤에서 도는 작업 — 도구 결과는 자리표시자다. */
  backgrounded: boolean;
  status: "running" | "completed" | "failed" | "stopped";
}

export interface ToolProgress {
  elapsedSeconds?: number;
  /** 서브에이전트의 API 호출이 실패해 다시 걸고 있는 중. */
  retry?: { attempt: number; maxRetries: number; delayMs: number };
  task?: TaskProgress;
}

/**
 * 백그라운드로 보낸 작업의 `tool_result` 는 자리표시자다: 도구 호출은 끝나도
 * 일은 돈다. 그래서 "도는 중"은 도구 행의 done 하나로 판정할 수 없다.
 *
 * 포그라운드 작업은 done 을 믿는다 — task.update 가 늦거나 오지 않아도 행이
 * 영원히 도는 것처럼 보이면 안 되니까.
 */
export function isToolRunning(block: ToolBlock): boolean {
  if (!block.done) return true;
  const task = block.progress?.task;
  return Boolean(task?.backgrounded && task.status === "running");
}

/** CLI 의 작업 상태 낱말을 카드가 쓰는 넷으로 좁힌다. */
function taskStatus(patch: string | null): TaskProgress["status"] | null {
  if (patch === "completed") return "completed";
  if (patch === "failed") return "failed";
  if (patch === "killed") return "stopped";
  // pending · running · paused 는 전부 아직 도는 중이다: 멈춤(paused)에 따로
  // 낱말을 주면 카드가 끝난 것처럼 읽힌다.
  if (patch === "pending" || patch === "running" || patch === "paused") return "running";
  return null;
}

/** 이 사건이 가리키는 도구 행 — 도구 id 로, 없으면 작업 id 로 찾는다. */
function targetIndex(blocks: Block[], event: ProgressEvent): number {
  // task.update 만 도구 id 를 싣지 않는다 — 그 행을 찾는 끈은 시작 때 붙여 둔
  // 작업 id 뿐이다.
  const toolUseId = "toolUseId" in event ? event.toolUseId : null;
  if (toolUseId) {
    const byTool = blocks.findIndex((block) => block.type === "tool" && block.id === toolUseId);
    if (byTool !== -1) return byTool;
  }
  // task.update 는 도구 id 를 싣지 않는다: 시작 때 붙여 둔 작업 id 가 그 행을
  // 찾는 유일한 끈이다.
  if (event.kind === "tool.progress") return -1;
  return blocks.findIndex(
    (block) => block.type === "tool" && block.progress?.task?.id === event.taskId,
  );
}

/**
 * 진행 사건 하나를 그 도구 행에 병합한다. 붙을 행이 없으면(집안일, 되살아난
 * 백그라운드 작업, 이미 지나간 기록) 아무 일도 없었던 것처럼 원본을 돌려준다.
 */
export function attachProgress(blocks: Block[], event: ProgressEvent): Block[] {
  const index = targetIndex(blocks, event);
  if (index === -1) return blocks;
  const block = blocks[index] as ToolBlock;
  const before = block.progress ?? {};
  const task = before.task;
  let progress: ToolProgress;

  switch (event.kind) {
    case "tool.progress":
      progress = {
        ...before,
        elapsedSeconds: event.elapsedSeconds,
        ...(event.retry ? { retry: event.retry } : {}),
      };
      break;
    case "task.start":
      progress = {
        ...before,
        task: {
          id: event.taskId,
          description: event.description,
          summary: null,
          lastTool: null,
          subagentType: event.subagentType,
          tokens: 0,
          toolUses: 0,
          backgrounded: event.backgrounded,
          status: "running",
        },
      };
      break;
    case "task.progress":
      progress = {
        ...before,
        task: {
          id: event.taskId,
          description: event.description || (task?.description ?? ""),
          summary: event.summary ?? task?.summary ?? null,
          lastTool: event.lastTool ?? task?.lastTool ?? null,
          subagentType: task?.subagentType ?? null,
          tokens: event.tokens,
          toolUses: event.toolUses,
          backgrounded: task?.backgrounded ?? false,
          status: task?.status ?? "running",
        },
      };
      break;
    case "task.update": {
      if (!task) return blocks;
      const status = taskStatus(event.status);
      progress = {
        ...before,
        task: {
          ...task,
          ...(status ? { status } : {}),
          ...(event.backgrounded === null ? {} : { backgrounded: event.backgrounded }),
        },
      };
      break;
    }
    case "task.end":
      progress = {
        ...before,
        task: {
          id: event.taskId,
          description: task?.description ?? "",
          // 끝난 작업의 한 줄은 그 작업이 남긴 요약이다 — 도는 동안의 근황보다
          // 이쪽이 최신이다.
          summary: event.summary || (task?.summary ?? null),
          lastTool: task?.lastTool ?? null,
          subagentType: task?.subagentType ?? null,
          tokens: event.tokens ?? task?.tokens ?? 0,
          toolUses: event.toolUses ?? task?.toolUses ?? 0,
          backgrounded: task?.backgrounded ?? false,
          status: event.status,
        },
      };
      break;
  }

  const next = [...blocks];
  next[index] = { ...block, progress };
  return next;
}

/**
 * 하위 작업의 목차 — 테이프의 `Task` 도구 호출 하나가 에이전트 하나다. 스트립
 * (WorkStrip)이 접힌 머리에 세는 숫자와 펼쳤을 때 읽는 목록이 이 한 셈에서
 * 나온다. `progress.task` 가 아직 안 붙은 호출(시작 사건보다 도구 행이 먼저
 * 온 경우)도 설명은 입력에서 읽어 채운다 — 도는 중 판정은 위의 `isToolRunning`
 * 하나만 믿는다. 하위 대화(`agentId` 로 물린 조각)는 활동 카드의 몫이고,
 * 여기는 목차만 셈한다.
 */
export interface AgentBrief {
  /** 그 에이전트를 띄운 도구 호출의 id — 하위 대화의 `agentId` 와 같은 값. */
  id: string;
  /** 에이전트 종별("scout", "swe-2"…). 시작 사건이 아직 없으면 null. */
  type: string | null;
  /** 무엇을 하러 보냈는가 — 작업 설명. 아직 모르면 빈 문자열. */
  label: string;
  /** 모델이 30초마다 쓴 최근 근황 한 줄. */
  summary: string | null;
  status: "running" | "completed" | "failed" | "stopped";
  /** 턴을 붙잡지 않고 뒤에서 도는 작업. */
  backgrounded: boolean;
  toolUses: number;
}

export function agentBriefs(blocks: Block[]): AgentBrief[] {
  const agents: AgentBrief[] = [];
  for (const block of blocks) {
    if (block.type !== "tool" || block.name !== "Task") continue;
    const task = block.progress?.task ?? null;
    const input = (block.input ?? {}) as Record<string, unknown>;
    const description =
      task?.description ||
      (typeof input.description === "string" && input.description.trim()) ||
      "";
    const type =
      task?.subagentType ||
      (typeof input.subagent_type === "string" && input.subagent_type.trim()) ||
      null;
    const status: AgentBrief["status"] = isToolRunning(block)
      ? "running"
      : block.isError || task?.status === "failed"
        ? "failed"
        : task?.status === "stopped"
          ? "stopped"
          : "completed";
    agents.push({
      id: block.id,
      type,
      label: description,
      summary: task?.summary ?? null,
      status,
      backgrounded: task?.backgrounded ?? false,
      toolUses: task?.toolUses ?? 0,
    });
  }
  return agents;
}
