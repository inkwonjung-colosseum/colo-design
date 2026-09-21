/**
 * 막다른 자리의 손 하나 — `개발자 부르기`(P3-3).
 *
 * 이 도구가 스스로도, AI 도 고칠 수 없는 실패가 있다: 데몬 환경의 API 키,
 * 죽은 미리보기 서버, 준비가 끝내 넘어진 자리. 그런 카드에 남는 동작이
 * `복사`뿐이면, 복사한 글을 **어디에** 붙여넣을지는 비개발자의 몫이 된다.
 * 여기서는 그 글이 곧장 개발자의 슬랙으로 간다 — 설정 → 알림의 개발자
 * 알림(escalation)이 이미 열어 둔 같은 채널이다.
 *
 * 문구는 화면이 짓는다: 어느 프로젝트의 어느 실패인지는 화면만 안다. 그리고
 * 프로젝트 이름과 시각을 반드시 싣는다 — 데몬의 10분 동일 문구 dedupe 가
 * 두 번째 누름을 조용히 삼키기 때문이다(같은 사고의 연타는 막되, 사람이
 * 다시 부른 것은 가야 한다).
 */

import { useState } from "react";
import type { Daemon } from "../lib/daemon-client";
import { SparkIcon } from "./icons";

const NOT_SET_UP = "개발자 알림이 설정되지 않았습니다 — 설정 → 알림에서 연결해 주세요";

export function CallDeveloper({
  daemon,
  what,
  detail = null,
  className = "ghost",
}: {
  daemon: Daemon;
  /** 무슨 일로 부르는지 — 한 문장. 슬랙 메시지의 본문이 된다. */
  what: string;
  /** 기계의 말(데몬 detail 등) — 있으면 본문 아래에 그대로 붙는다. */
  detail?: string | null;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const configured = daemon.status?.escalationConfigured === true;
  const projectName =
    daemon.projects.find((project) => project.slug === daemon.activeSlug)?.name ?? null;

  const press = () => {
    if (!configured || state === "sending") return;
    setState("sending");
    setError(null);
    // 프로젝트와 시각이 문구 안에 있어야 두 번째 누름이 dedupe 를 통과한다.
    const stamp = new Date().toLocaleString("ko-KR");
    const text =
      `[Colo Design] 도움이 필요합니다${projectName ? ` — ${projectName}` : ""}\n` +
      `${what}\n` +
      `${stamp}` +
      (detail ? `\n\n--- 자세히 ---\n${detail}` : "");
    void daemon.api
      .escalationNotify(text)
      .then(() => setState("sent"))
      .catch((e: Error) => {
        setState("failed");
        setError(e.message);
      });
  };

  if (state === "sent") {
    return (
      <span className="hint" role="status">
        개발자에게 알렸습니다 — 답이 올 때까지 기다려 주세요
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        className={className}
        // 진짜 disabled 는 hover 도 포커스도 막아 이유가 닿을 길이 없다 —
        // 잠긴 이유는 title 이 말한다(상단 바의 잠긴 버튼과 같은 규율).
        aria-disabled={!configured || state === "sending"}
        title={configured ? undefined : NOT_SET_UP}
        onClick={press}
      >
        <SparkIcon size={12} />
        {state === "sending" ? "부르는 중…" : "개발자 부르기"}
      </button>
      {!configured && <span className="hint">{NOT_SET_UP}</span>}
      {error && <span className="hint">{error}</span>}
    </>
  );
}
