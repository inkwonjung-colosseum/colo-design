import type { RepoStatus, SessionState } from "@colo-design/protocol";
import { useEffect, useRef, useState } from "react";
import type { PreviewError, PreviewLocation } from "../../components/preview/types";
import type { Daemon } from "../../lib/daemon-client";
import { errorToTurn } from "../../lib/preview-turns";
import type { StageError } from "./PreviewHost";

/** 한 오류 키가 사람 손 없이 쓸 수 있는 기계 고침 발사 수. */
const MAX_AUTO_FIXES = 2;
/** 보류 목록의 상한 — 판정 창 하나가 몇 초씩이므로 정산이 무한히 늘지 않게. */
const MAX_PENDING_ERRORS = 6;
/** 성공 턴 뒤의 조용한 창 — 이 동안 새 보고도 새 턴도 없으면 확인 불능의 보고를 거둔다. */
const CONVERGE_WINDOW_MS = 10_000;

const LIVE = new Set<SessionState>([
  "starting",
  "running",
  "waiting_permission",
  "waiting_question",
]);

/** 기계의 턴을 대화에 싣는 손 — 거절이면 false(다시 시도할 수 있다). */
export type MachineTurn = (
  turn: string,
  name?: string,
  attachments?: Array<{ name: string; mediaType: string; data: string }>,
  pins?: Array<{ screen: string }>,
) => Promise<boolean>;

/**
 * 미리보기 오류의 판정(옛 ScreenPanel 의 파이프를 그대로 옮겼다) — 연결 레포의
 * 오류는 사람에게 올리지 않는다. 턴이 도는 동안의 보고는 들어 두었다가 턴의
 * 끝에 데몬의 검증 창(`preview.screenCheck`)으로 다시 열어 보고, 깨끗하면 거두고
 * 살아 있으면 AI 의 고침 턴을 스스로 내려놓는다. 예산은 키별 둘이고, 깨끗한
 * 판정과 새 서버(에포크)가 예산을 새로 산다.
 *
 * 돌려주는 `fixingStalled` 는 멈춘 화면(30초)의 고침 턴이 도는 중이라는 표식 —
 * 칸이 `AI가 막힌 곳을 고치고 있어요` 덮개를 세운다.
 */
export function usePreviewErrors({
  api,
  repo,
  turnState,
  location,
  onMachineTurn,
}: {
  api: Daemon["api"];
  repo: RepoStatus | null;
  turnState: SessionState;
  location: PreviewLocation | null;
  onMachineTurn: MachineTurn;
}): { report: (error: StageError) => void; fixingStalled: boolean } {
  const turnLive = LIVE.has(turnState);
  const pending = useRef<PreviewError[]>([]);
  const fires = useRef(new Map<string, number>());
  const unverifiable = useRef(new Set<string>());
  const converge = useRef<number | null>(null);
  const verdicts = useRef<Promise<void>>(Promise.resolve());
  const turnLiveNow = useRef(turnLive);
  turnLiveNow.current = turnLive;
  const fixOut = useRef(false);
  const repoNow = useRef(repo);
  repoNow.current = repo;
  const machine = useRef(onMachineTurn);
  machine.current = onMachineTurn;
  const [fixingStalled, setFixingStalled] = useState(false);

  const keyOf = (error: PreviewError) => `${error.route}|${error.kind}|${error.message}`;
  const hold = (error: PreviewError) => {
    pending.current = [...pending.current.filter((e) => keyOf(e) !== keyOf(error)), error].slice(
      -MAX_PENDING_ERRORS,
    );
  };
  const retire = (key: string) => {
    pending.current = pending.current.filter((e) => keyOf(e) !== key);
    unverifiable.current.delete(key);
  };

  const adjudicateAll = (reports: PreviewError[]) => {
    verdicts.current = verdicts.current.then(async () => {
      // 한 정산의 발사는 하나다 — 기계 둘이 서로 답하며 구독을 태우지 않게.
      let fired = false;
      for (const error of reports) {
        const key = keyOf(error);
        if (!pending.current.some((e) => keyOf(e) === key)) continue;
        // 웹뷰는 루트를 빈 경로로 보고하지만 선로는 빈 route 를 거절한다.
        const verdict = await api.screenCheck(error.route || "/").catch(() => null);
        if (verdict === null) {
          // 확인 불능 — 멈춤만은 그 자체가 확인이다(서버가 서 있을 때만).
          unverifiable.current.add(key);
          if (!error.stalled || repoNow.current?.phase !== "ready") continue;
        } else if (verdict.settled && verdict.errors.length === 0) {
          retire(key);
          for (const budget of [...fires.current.keys()]) {
            if (budget.startsWith(`${error.route}|`)) fires.current.delete(budget);
          }
          continue;
        } else {
          unverifiable.current.delete(key);
        }
        const spent = fires.current.get(key) ?? 0;
        if (fired || fixOut.current || turnLiveNow.current || spent >= MAX_AUTO_FIXES) continue;
        const delivered = await machine.current(errorToTurn(error, spent + 1));
        if (delivered) {
          fires.current.set(key, spent + 1);
          fixOut.current = true;
          fired = true;
          if (error.stalled) setFixingStalled(true);
        }
      }
    });
  };

  const disarm = () => {
    if (converge.current !== null) {
      window.clearTimeout(converge.current);
      converge.current = null;
    }
  };
  const arm = () => {
    disarm();
    if (pending.current.length === 0) return;
    converge.current = window.setTimeout(() => {
      converge.current = null;
      for (const error of pending.current) {
        if (unverifiable.current.has(keyOf(error))) retire(keyOf(error));
      }
    }, CONVERGE_WINDOW_MS);
  };

  const report = (payload: StageError) => {
    const error: PreviewError = {
      ...payload,
      kind: payload.kind === "build" ? "build" : "runtime",
    };
    disarm();
    hold(error);
    if (turnLiveNow.current) return;
    if ((fires.current.get(keyOf(error)) ?? 0) >= MAX_AUTO_FIXES) return;
    adjudicateAll([error]);
  };

  // 턴의 끝이 판정의 자리 — 들어 둔 보고 전부를 같은 파이프로.
  // biome-ignore lint/correctness/useExhaustiveDependencies: 상태 전이만 본다.
  useEffect(() => {
    if (turnLive) {
      disarm();
      return;
    }
    fixOut.current = false;
    setFixingStalled(false);
    const queue = [...pending.current];
    if (queue.length > 0) adjudicateAll(queue);
    if (turnState === "idle") arm();
  }, [turnState]);

  // 떠날 때 수렴 시계를 거둔다 — 시계는 ref 에 있으므로 마지막 렌더의 손이 필요 없다.
  useEffect(
    () => () => {
      if (converge.current !== null) window.clearTimeout(converge.current);
    },
    [],
  );

  // 새 서버 — 지난 시절의 보고는 전부 낡은 말이고, 예산도 새로 산다.
  // biome-ignore lint/correctness/useExhaustiveDependencies: 서버의 신원만 본다.
  useEffect(() => {
    disarm();
    pending.current = [];
    unverifiable.current.clear();
    fires.current.clear();
    setFixingStalled(false);
  }, [repo?.previewUrl, repo?.previewEpoch]);

  // 새 이동은 새 증거 — 보류된 마지막 보고를 다시 본다.
  // biome-ignore lint/correctness/useExhaustiveDependencies: 위치만이 새 증거다.
  useEffect(() => {
    if (turnLiveNow.current) return;
    const newest = pending.current[pending.current.length - 1];
    if (!newest || (fires.current.get(keyOf(newest)) ?? 0) >= MAX_AUTO_FIXES) return;
    adjudicateAll([newest]);
  }, [location]);

  return { report, fixingStalled };
}
