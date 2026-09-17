/**
 * 화면 카드 (docs/plan/chat.md §1.1 #4). 답변↔선언 화면 대조와 사이클
 * 칩 판정은 호출부의 몫 — `ScreenCards`(turn.tsx)가 대조를, §3.3
 * `lib/screen-state.ts` 가 칩을 정한다. 이 컴포넌트는 정해진 것만
 * 그린다: 미니스샷(그 턴의 캡처 재사용, 없으면 도형 플레이스홀더) +
 * 제목 + 상태 칩, 그리고 미리보기가 이 카드를 보고 있을 때의 accent 링.
 */
import type { ScreenChipTone } from "../../lib/screen-state";

type ScreenCardState = { label: string; tone: ScreenChipTone };

export interface ScreenCardProps {
  title: string;
  /** "미리보기 · 어제 오후 4:31" 같은 한 줄. */
  caption: string;
  states?: ScreenCardState[];
  onOpen: () => void;
}

/** 진짜 스냅샷이 없을 때의 최소 도식 — 빈 상자가 아니라 "화면 있음"을 알린다. */
function MiniPlaceholder() {
  return (
    <div className="mini">
      <div className="mini__bar" />
      <div className="mini__row">
        <i className="d d--ok" />
        <i className="ln" />
      </div>
      <div className="mini__row">
        <i className="d d--mut" />
        <i className="ln" style={{ maxWidth: "70%" }} />
      </div>
      <div className="mini__row">
        <i className="d d--warn" />
        <i className="ln" />
      </div>
    </div>
  );
}

export function ScreenCard({ title, caption, states = [], onOpen }: ScreenCardProps) {
  return (
    <button type="button" className="scard" title="누르면 미리보기가 열립니다" onClick={onOpen}>
      <div className="scard__shot">
        <MiniPlaceholder />
      </div>
      <div className="scard__body">
        <div className="scard__title">{title}</div>
        <div className="scard__route">{caption}</div>
        {states.length > 0 && (
          <div className="scard__states">
            {states.map((state) => (
              <span key={state.label} className={chipClass(state.tone)}>
                {state.label}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}

/** 칩의 톤 → 어휘 클래스. */
function chipClass(tone: ScreenChipTone): string {
  if (tone === "default") return "state-chip";
  return `state-chip state-chip--${tone}`;
}
