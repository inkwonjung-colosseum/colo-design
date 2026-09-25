import type { DeveloperReview, RepoHistoryEntry } from "@colo-design/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Daemon } from "../../lib/daemon-client";
import { focusReadDue } from "../../lib/quiet-read";

/**
 * `이번 작업` 의 장부(PLAN-UI U2 · U14) — 제출한 요청의 개발자 코멘트와 이번
 * 사이클의 작업 기록. 셸이 한 번 부르고, 여정(코멘트 수) · 제출 확인(화면 밖
 * 변경) · `이번 작업` 팝오버가 같은 값을 읽는다.
 *
 * 코멘트는 옛 셸의 조용한 읽기(ScreenPanel 의 readHandoffState)와 같은 길로
 * 읽는다 — `repo.handoffStatus` 가 GitHub 을 읽어 `reviews` 를 돌려주고,
 * 감독자의 틱을 깨운다. 그래서 타이머로 부르지 않는다: 프로젝트 · 요청이 바뀔
 * 때, 대화록에 코멘트가 도착했을 때(`review.arrived`), 창이 돌아올 때(20분에
 * 한 번), 팝오버를 열 때(1분에 한 번)만.
 */
export interface WorkLedger {
  /** 열린(또는 방금 반영된) 요청의 코멘트 — 요청이 없으면 빈 목록. */
  reviews: DeveloperReview[];
  /** 이번 사이클의 차례들(최근 것부터) — 아직 읽지 않았으면 null. */
  history: RepoHistoryEntry[] | null;
  /** 대화록에 닿은 가장 최근 제출(`cycle.handed`)의 시각 — 영수증의 시각. */
  handedAt: string | null;
  /** 팝오버가 열렸다 — 기록은 늘, 코멘트는 1분에 한 번 다시 읽는다. */
  refresh: () => void;
}

const OPEN_READ_THROTTLE_MS = 60_000;

export function useWorkLedger(daemon: Daemon): WorkLedger {
  const { api, activeSlug, repo, sessions } = daemon;
  const handoff = repo?.handoff ?? null;
  const [reviews, setReviews] = useState<DeveloperReview[]>([]);
  const [history, setHistory] = useState<RepoHistoryEntry[] | null>(null);
  const lastReviewRead = useRef(0);
  const slugRef = useRef(activeSlug);
  slugRef.current = activeSlug;

  const readReviews = useCallback(
    (hasHandoff: boolean) => {
      if (!hasHandoff) {
        setReviews([]);
        return;
      }
      const asked = slugRef.current;
      lastReviewRead.current = Date.now();
      void api
        .handoffStatus()
        .then((report) => {
          if (slugRef.current !== asked) return;
          setReviews(report?.reviews?.filter((review) => review.pr === report.number) ?? []);
        })
        .catch((error) => {
          // 원문은 기록으로 — 다음 읽기가 스스로 고친다(옛 readHandoffState 와 같다).
          console.error("[colo-design] review read", error);
        });
    },
    [api],
  );

  const readHistory = useCallback(() => {
    const asked = slugRef.current;
    void api
      .saveHistory()
      .then((answer) => {
        if (slugRef.current === asked) setHistory(answer.entries);
      })
      .catch((error) => console.error("[colo-design] history read", error));
  }, [api]);

  // 대화록에 닿은 코멘트 도착 · 제출 영수증 — 읽기의 방아쇠이자 영수증의 시각.
  const { humanCount, handedAt } = useMemo(() => {
    let count = 0;
    let latest: string | null = null;
    for (const view of Object.values(sessions)) {
      for (const block of view.blocks) {
        if (block.type === "human") count += 1;
        else if (
          block.type === "milestone" &&
          block.subtype === "handed" &&
          (latest === null || Date.parse(block.at) > Date.parse(latest))
        ) {
          latest = block.at;
        }
      }
    }
    return { humanCount: count, handedAt: latest };
  }, [sessions]);

  const hasHandoff = handoff !== null;
  const handoffKey = `${activeSlug}:${handoff?.number ?? ""}:${handoff?.state ?? ""}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: handoffKey · humanCount 는 값이 아니라 방아쇠다.
  useEffect(() => {
    readReviews(hasHandoff);
  }, [readReviews, hasHandoff, handoffKey, humanCount]);

  // 기록은 차례가 보관될 때 움직인다 — 화면 목록의 머리 · 사이클 가지가 그 신호다.
  const historyKey = `${activeSlug}:${repo?.branch ?? ""}:${repo?.cycleScreens?.[0]?.at ?? ""}:${humanCount}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: historyKey 는 방아쇠다.
  useEffect(() => {
    readHistory();
  }, [readHistory, historyKey]);

  // 다른 프로젝트의 장부를 한 순간도 보이지 않는다.
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeSlug 는 방아쇠다.
  useEffect(() => {
    setReviews([]);
    setHistory(null);
  }, [activeSlug]);

  useEffect(() => {
    const onFocus = () => {
      if (focusReadDue(lastReviewRead.current, Date.now())) readReviews(hasHandoff);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [readReviews, hasHandoff]);

  const refresh = useCallback(() => {
    readHistory();
    if (Date.now() - lastReviewRead.current >= OPEN_READ_THROTTLE_MS) readReviews(hasHandoff);
  }, [readHistory, readReviews, hasHandoff]);

  return { reviews, history, handedAt, refresh };
}
