import type { Journey } from "../../lib/journey";

/**
 * 여정 띠 — 읽기 전용. 정류장·세그먼트 전부 클릭 없음: 정류장을 클릭
 * 가능하게 보이면 안 된다(스펙 §1-A — 지도는 '지금 어디인가'를 말할 뿐,
 * 장면 전환은 대화 속 행동과 바깥 사건이 일으킨다).
 *
 * 두 단위의 지도 (P3-1): `journey.scope === "thread"` 면 이 대화가 기여한
 * 사이클 위치 — 대화 제목(`title`) 칩을 지도 앞에 달아 "이 대화의 여정"임을
 * 말한다. `project` 면 프로젝트 사이클의 진실 그대로(칩 없음). 상태 캡션은
 * 없다 — 스펙 §1-A(2026-09): 점·색이 상태를 말한다.
 */
const STOPS = ["만들기", "저장", "넘기기", "반영"] as const;

export function JourneyBar({
  journey,
  title,
}: {
  journey: Journey | null;
  /** 대화 지도일 때만 읽힌다 — 그 대화의 이름. */
  title?: string;
}) {
  if (!journey) return null;
  const thread = journey.scope === "thread";
  return (
    <div className="jbar">
      {thread && title ? (
        <span className="jbar__thread" title={title}>
          {title}
        </span>
      ) : null}
      <ol className="jmap" aria-label={thread ? "이 대화의 여정" : "이 작업의 여정"}>
        {STOPS.map((name, index) => {
          const done = journey.reached[index];
          const now = index === journey.stop;
          const cls = [
            "jstop",
            done ? "jstop--done" : "",
            now && !journey.arrived ? "jstop--now" : "",
            now && journey.arrived ? "jstop--arrived" : "",
            now && journey.warn ? "jstop--warn" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <li className="jstopwrap" key={name}>
              {index > 0 && (
                <div className={`jseg${done ? " jseg--done" : ""}`} aria-hidden="true" />
              )}
              <div className={cls} aria-current={now ? "step" : undefined}>
                <span className="jdot" aria-hidden="true">
                  {done ? "✓" : ""}
                </span>
                <span className="jnm">{name}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
