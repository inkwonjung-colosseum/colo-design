import type { Block } from "../../lib/daemon-client";

export function preview(value: unknown, max = 240): string {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…` : value;
  const text = JSON.stringify(value, null, 2) ?? String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The one input field that best identifies what a tool call is about. */
export function toolHeadline(input: unknown): string {
  const i = input as Record<string, unknown> | null;
  if (!i || typeof i !== "object") return "";
  for (const key of ["command", "file_path", "path", "pattern", "url", "prompt", "description"]) {
    const value = i[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/**
 * 사람 메시지 · 진행 한 줄이 읽는 시각 — 개발자의 검토 결과가 대화에 남을 때
 * "언제"를 계획자의 로캘로 읽는다. 날짜 구분("어제"/"오늘")은 이 함수의
 * 몫이 아니다 — 그건 트랜스크립트의 day 구분선(P7)이 진다.
 */
export function clockTime(at: string): string {
  return new Date(at).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
}

/**
 * day 구분선(P7)의 날짜 읽기 — 같은 날인지는 자정으로 내린 키가 가리고,
 * 라벨은 HumanMessage 의 "어제 오후 6:40" 과 같은 어휘("오늘"/"어제"/
 * "N월 N일")를 쓴다. 시각을 아는 행(저장·넘김·개발자 메시지·도구 시작)만
 * 날짜를 바꾼다 — 시각 없는 행은 직전 날짜 맥락을 그대로 잇는다.
 */
export function dayKey(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dayLabel(at: number): string {
  const day = new Date(dayKey(at));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diff <= 0) return "오늘";
  if (diff === 1) return "어제";
  return day.toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
    // 해가 바뀌었으면 해까지 읽는다 — "3월 4일"만으로는 작년인지 모른다.
    ...(day.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
}

export type ToolStatus = "running" | "done" | "error";

/** 도구 행이 스스로 그릴 수 있는 것 밖의, 작업을 다루는 손. */
export interface TaskControls {
  /** 턴을 붙잡은 작업을 뒤로 보낸다 — 인자는 그 도구 호출의 id. */
  onBackgroundTask?: (toolUseId: string) => void;
  /** 그 작업 하나만 세운다 — 인자는 작업 id. */
  onStopTask?: (taskId: string) => void;
}

export type TodoToolBlock = Extract<Block, { type: "tool" }>;
