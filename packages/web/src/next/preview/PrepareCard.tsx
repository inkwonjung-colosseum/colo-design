import { useEffect, useState } from "react";
import { L } from "../labels";
import { elapsedParts, prepProgress, prepStep } from "../lib/preview-geometry";
import { SmallCheckIcon } from "./icons";

/** 흐른 시간 한 마디 — `12초` · `1분 5초`. */
export function elapsedText(ms: number): string {
  const { minutes, seconds } = elapsedParts(ms);
  return minutes > 0 ? L.preview.elapsedMin(minutes, seconds) : L.preview.elapsedSec(seconds);
}

/** 1초마다 다시 그리는 시계 — 데몬이 적은 `phaseSince` 부터 센다. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}

/**
 * 준비 화면(PLAN-UI U8) — 처음 켜는 서비스의 세 걸음 `내려받기 · 설치하기 ·
 * 미리보기 켜기`, 지금 걸음의 흐른 시간(`RepoStatus.phaseSince`), 진행 막대,
 * `준비되는 동안 먼저 말해 두셔도 돼요`. 이미 한 번 켠 서비스를 다시 켜는
 * 동안(앱을 다시 켰다)은 제목만 조용해진다.
 */
export function PrepareCard({
  phase,
  phaseSince,
  first,
}: {
  phase: string;
  phaseSince?: string;
  first: boolean;
}) {
  const now = useNow(true);
  // 데몬이 걸음의 시작을 싣지 않으면 이 카드가 본 순간부터 센다.
  const [seenAt, setSeenAt] = useState(() => ({ phase, at: Date.now() }));
  if (seenAt.phase !== phase) setSeenAt({ phase, at: Date.now() });
  const since = phaseSince ? Date.parse(phaseSince) : Number.NaN;
  const startedAt = Number.isFinite(since) ? since : seenAt.at;
  const elapsed = Math.max(0, now - startedAt);
  const step = prepStep(phase) ?? 0;
  const names = [L.prepare.stepDownload, L.prepare.stepInstall, L.prepare.stepPreview];
  return (
    <div className="nx-prep-card" role="status">
      <i className="nx-spin nx-spin--lg" aria-hidden="true" />
      <h3>{first ? L.prepare.title : L.preview.prepAgainTitle}</h3>
      <p>{first ? L.prepare.body : L.preview.prepAgainBody}</p>
      <ul className="nx-prep-steps">
        {names.map((name, index) => {
          const state = index < step ? "ok" : index === step ? "run" : "wait";
          return (
            <li key={name} className={`nx-prep-step nx-prep-step--${state}`}>
              {state === "ok" ? (
                <span className="nx-sic nx-sic--ok">
                  <SmallCheckIcon />
                </span>
              ) : state === "run" ? (
                <span className="nx-sic nx-sic--run">
                  <i className="nx-spin" aria-hidden="true" />
                </span>
              ) : (
                <span className="nx-sic nx-sic--wait" />
              )}
              {name}
              {state === "run" && (
                <em>
                  {index === 1
                    ? L.preview.stepEta(L.prepare.aboutTwoMinutes, elapsedText(elapsed))
                    : elapsedText(elapsed)}
                </em>
              )}
            </li>
          );
        })}
      </ul>
      <div className="nx-prep-bar">
        <i style={{ width: `${prepProgress(phase, elapsed)}%` }} />
      </div>
      <p className="nx-prep-hint">{L.prepare.hint}</p>
    </div>
  );
}

/** 화면을 다시 켜는 중(C5) · AI가 막힌 곳을 고치는 중 — 오류 문장은 없다. */
export function StageNotice({
  kind,
  restarts,
}: {
  kind: "restarting" | "fixing";
  restarts: number;
}) {
  return (
    <div className="nx-prep-card" role="status">
      <i className="nx-spin nx-spin--lg" aria-hidden="true" />
      <h3>{kind === "restarting" ? L.preview.restartingTitle : L.preview.fixingTitle}</h3>
      <p className="nx-prep-lines">
        {kind === "restarting"
          ? L.preview.restartingBody(Math.min(2, Math.max(1, restarts)))
          : L.preview.fixingBody}
      </p>
    </div>
  );
}
