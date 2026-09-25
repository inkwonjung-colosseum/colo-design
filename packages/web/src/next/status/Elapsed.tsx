import { useEffect, useState } from "react";
import { L } from "../labels";

/** `12초` · `1분 5초` — 목업의 `fmtSecs`. */
export function elapsedText(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  return secs < 60
    ? L.transcript.seconds(secs)
    : L.transcript.minutesSeconds(Math.floor(secs / 60), secs % 60);
}

/**
 * 도는 시간 — `startedAt` 은 데몬의 시계다(`SessionView.turnStartedAt`): 새로
 * 고침해도, 두 번째 창에서도 같은 초를 센다(옛 `TurnClock` 과 같은 방식). 초를
 * 세는 것이 따로인 이유도 같다 — 1초마다 다시 그릴 것은 이 글자뿐이다.
 *
 * `hintAfterMs` · `hint` — 시간이 그만큼 지나면 시계 뒤에 한 마디가 붙는다
 * (첫 턴의 `처음은 몇 분 걸려요`, 단계 10). 시계를 하나 더 두지 않고 이
 * 안에서 그린다 — 다시 그릴 것이 글자 하나 늘어도 원칙은 그대로다.
 */
export function Elapsed({
  startedAt,
  hintAfterMs,
  hint,
}: {
  startedAt: number;
  /** 이 시간(데몬 시계 ms)부터 `hint` 가 붙는다. */
  hintAfterMs?: number;
  /** 시간이 넘었을 때 시계 뒤에 붙는 한 마디. */
  hint?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  return (
    <span className="nx-since" role="timer">
      {elapsedText(now - startedAt)}
      {hint !== undefined && hintAfterMs !== undefined && now - startedAt >= hintAfterMs && (
        <span className="nx-since-hint">{hint}</span>
      )}
    </span>
  );
}
