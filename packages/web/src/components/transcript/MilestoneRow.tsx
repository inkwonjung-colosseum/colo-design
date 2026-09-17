/**
 * 진행 한 줄 (docs/plan/chat.md §1.1 #6): 넘김·반영이 대화에 남기는 시스템의
 * 채팅 상태줄. 도구 확인 한 줄(`.tool`)과는 다른 어휘 — 접히지 않고, 원 아이콘
 * 하나 + 문장 + 오른쪽 시각으로 끝난다. 같은 PR 을 여러 라운드 돌면 이 줄이
 * 여러 개 쌓이는 것이 의도다(대화가 사이클의 연대기).
 */
import type { ReactNode } from "react";
import { CheckIcon } from "../icons";

export type MilestoneTone = "send" | "ok" | "danger" | "default";

export interface MilestoneRowProps {
  /** 원 아이콘 안의 글리프 — 기본은 넘김(↑)/반영(✓)에 맞는 아이콘을 호출부가 고른다. */
  icon?: ReactNode;
  text: ReactNode;
  time: string;
  tone?: MilestoneTone;
}

/** ↑ — 넘김의 기본 글리프. lucide 를 쓰지 않는 이유: 열림표는 화살표보다
 *  얇은 획 하나로 충분하고, CheckIcon 과 짝을 이루는 손그림이 낫다. */
function UpArrowGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="10"
      height="10"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

export function MilestoneRow({ icon, text, time, tone = "default" }: MilestoneRowProps) {
  return (
    <div className={`milestone milestone--${tone}`}>
      <span className="mic">{icon ?? (tone === "ok" ? <CheckIcon /> : <UpArrowGlyph />)}</span>
      {text}
      <span className="t">{time}</span>
    </div>
  );
}
