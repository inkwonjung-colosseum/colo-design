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
 */
export function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  return (
    <span className="nx-since" role="timer">
      {elapsedText(now - startedAt)}
    </span>
  );
}
