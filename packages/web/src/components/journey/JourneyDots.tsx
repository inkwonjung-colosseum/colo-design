import type { ReactNode } from "react";
import type { Journey } from "../../lib/journey";
import { ArrowUpIcon, CheckIcon, CircleCheckIcon } from "../icons";
import { Tip } from "../shell/Tip";

const STOPS = ["만들기", "저장", "넘기기", "반영"] as const;

/**
 * 여정 지도의 도트 얼굴 — 라벨을 버리고 점만 남긴 변형(mockups/journey
 * 06-dots)이다. 지도는 읽기 전용: 정류장을 클릭 가능하게 보이면 안 된다
 * (지도는 '지금 어디인가'를 말할 뿐, 장면 전환은 대화 속 행동과 바깥 사건이
 * 일으킨다). 지금 정류장의 이름은 점 곁에 상시로 읽히고, 나머지 정류장의
 * 이름은 각 점의 툴팁이 대신 읽는다.
 *
 * 두 단위의 지도 (P3-1): `journey.scope === "thread"` 면 이 대화가 기여한
 * 사이클 위치 — 대화 제목 칩을 지도 앞에 달아 "이 대화의 여정"임을 말한다.
 * `project` 면 프로젝트 사이클의 진실 그대로(칩 없음).
 */
export function JourneyDots({
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
    <>
      {thread && title ? (
        <span className="jmap__thread" title={title}>
          {title}
        </span>
      ) : null}
      <ol className="dmap" aria-label={thread ? "이 대화의 여정" : "이 작업의 여정"}>
        {STOPS.map((name, index) => {
          const done = journey.reached[index];
          const now = index === journey.stop;
          const cls = [
            "dmap__stop",
            done ? "dmap__stop--done" : "",
            now && !journey.arrived && journey.warn ? "dmap__stop--warn" : "",
            now && !journey.arrived && !journey.warn ? "dmap__stop--now" : "",
            now && journey.arrived ? "dmap__stop--arrived" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const tip =
            now && journey.arrived && name === "반영"
              ? "반영됨"
              : now && journey.warn
                ? `${name} — 리뷰 코멘트 도착`
                : name;
          // 글리프가 정류장을 말한다: 지나온 정류장은 ✓, 넘기기의 경고는 ↑,
          // 반영은 언제나 자기 얼굴(빈 원)로 기다린다.
          let glyph: ReactNode;
          if (now && journey.arrived) glyph = <CircleCheckIcon />;
          else if (done) glyph = <CheckIcon />;
          else if (now && journey.warn) glyph = <ArrowUpIcon />;
          else if (index === STOPS.length - 1) glyph = <CircleCheckIcon />;
          const segDone = index > 0 && journey.reached[index - 1];
          return (
            <li className="dmap__wrap" key={name}>
              {index > 0 && (
                <div
                  className={`dmap__seg${segDone ? " dmap__seg--done" : ""}`}
                  aria-hidden="true"
                />
              )}
              <Tip label={tip} side="bottom">
                <span className={cls} aria-current={now ? "step" : undefined}>
                  {glyph}
                </span>
              </Tip>
              {/* 지금 정류장의 이름은 hover 없이도 읽힌다 — 지도의 유일한
                  글자다. 반영에 도착했으면 툴팁과 같은 말("반영됨")로 선다. */}
              {now && (
                <span className="dmap__name">
                  {journey.arrived && name === "반영" ? "반영됨" : name}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}
