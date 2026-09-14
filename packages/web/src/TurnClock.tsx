import { useEffect, useState } from "react";
import { waitedFor } from "./format";
import { ClockIcon } from "./icons";

/**
 * 진행 시계: 지금 도는 요청이 몇 분 몇 초째인지. 보낸 다음 조용해진 화면에서
 * 기획자가 실제로 묻는 것은 "멈춘 건가"이고, 그 답은 초가 움직이는 것 하나로
 * 끝난다 — 그래서 숫자는 램프·스피너와 달리 얼마나 기다렸는지까지 말한다.
 *
 * `startedAt` 은 데몬의 시각이다(창의 것이 아니다): 새로고침해도, 두 번째
 * 창에서도 같은 초를 센다. 카드 앞에 멈춘 턴도 계속 센다 — 사람이 기다린
 * 시간도 그 요청의 시간이다.
 *
 * 초를 세는 컴포넌트가 따로인 이유: 1초마다 바뀌는 상태를 입력창이 들면 답이
 * 흐르는 동안 내내 입력창 전체가 1초마다 다시 그려진다. 다시 그릴 것은 이
 * 글자뿐이다.
 */
export function TurnClock({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  // 초침 하나로 충분하다 — 턴이 바뀌어도 같은 초침이 새 시작을 뺀다. 그리는
  // 값은 매번 지금 시각에서 다시 계산하므로, 배경 탭에서 타이머가 느려져도
  // 돌아온 순간의 숫자는 맞다.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  return (
    <span className="turnclock" role="timer" title="이 요청이 진행된 시간">
      <span className="ic ic--sm ic--quiet">
        <ClockIcon />
      </span>{" "}
      {waitedFor(now - startedAt)}
    </span>
  );
}
