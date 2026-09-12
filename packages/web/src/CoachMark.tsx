import { useState } from "react";

/**
 * 코치 마크 (PLAN D92) — 레일이 가르치던 것을 대신 가르치는 한 문장 셋.
 * 셋 · 한 번 · `알겠어요` 하나: 읽힌 마크는 이 브라우저의 설정에서 영원히
 * 조용해지고, 설정의 `안내 다시 보기` 가 되살린다. 순회형 튜토리얼은 만들지
 * 않는다 — 이것이 전부다.
 */
const KEY = "colo-design.coach";

export type CoachId = "pin" | "save" | "review";

function seen(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[];
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

export function resetCoachMarks(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 되살리기가 막힌 환경이라면 다음 마크도 그냥 안 보일 뿐이다.
  }
}

export function CoachMark({ id, text }: { id: CoachId; text: string }) {
  const [dismissed, setDismissed] = useState(() => seen().has(id));
  if (dismissed) return null;
  return (
    <span className="coach" data-testid={`coach-${id}`} role="note">
      {text}
      <button
        type="button"
        className="coach__ok"
        onClick={() => {
          try {
            const marks = seen();
            marks.add(id);
            localStorage.setItem(KEY, JSON.stringify([...marks]));
          } catch {
            // 저장이 막혀도 이 화면에서는 조용해진다.
          }
          setDismissed(true);
        }}
      >
        알겠어요
      </button>
    </span>
  );
}
