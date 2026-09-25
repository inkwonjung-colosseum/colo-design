import type { DiffStatus, HandoffStatus, RepoStatus } from "@colo-design/protocol";
import type { L } from "../labels";
import type { SubmitCopy } from "./submit-copy";

/**
 * 여정 세 점(PLAN-UI U2) — `제출 전 ─ 개발자 확인 ─ 반영됨`. 옛 셸의
 * `deriveDelivery`(lib/delivery.ts) 가 칩 하나를 판정하던 것을 넓혀, 세 점의
 * 글자 · 지금 점 · 색 · 제출 버튼의 열림과 이유 한 문장을 한 번에 낸다. 상태
 * 줄 · 좁은 창의 한 점 · `이번 작업` 팝오버가 이 한 원천을 읽는다.
 *
 * 문장은 `labels.ts` 에서 오지만 이 파일은 그것을 부르지 않고 인자로 받는다 —
 * 단위 시험이 src 에서 곧장 읽는 순수 모듈은 형제를 부르지 않는다
 * (turn-screens.ts 와 같은 규칙). 부르는 쪽은 `deriveJourney(input, L)`. 같은
 * 까닭으로 제출 상태의 문장(`submitCopy`)도 부르는 쪽이 지어 `input.submitCopy` 로 건넨다.
 */
export type JourneyWords = Pick<typeof L, "journey" | "submit" | "shell">;

/** 이번 사이클의 자리 — 세 점 중 어디에 서 있나. */
export type JourneyCycle = "draft" | "review" | "merged";

export interface JourneyPoint {
  label: string;
  /** `done` 지나온 점 · `cur` 지금 점 · `todo` 아직. */
  state: "done" | "cur" | "todo";
}

export interface Journey {
  cycle: JourneyCycle;
  /** 세 점 — 늘 셋이다. */
  points: [JourneyPoint, JourneyPoint, JourneyPoint];
  /** 지금 점의 번호(0 · 1 · 2) — 좁은 창은 이 점만 글자를 갖는다(U16). */
  current: 0 | 1 | 2;
  /** 제출이 막혔다(U13) — 첫 점이 `제출하지 못했어요` 를 말하고 색이 바뀐다. */
  blocked: boolean;
  /** AI 가 도는 중 — `만드는 중 · 12초` 가 앞에 붙는다. 시계는 부르는 쪽의 것. */
  making: boolean;
  submit: {
    enabled: boolean;
    /** 버튼의 한 문장 — 잠겼으면 잠긴 이유, 열렸으면 무엇이 가는지. */
    reason: string;
    /** 제출이 도는 중이면 그 모양 — 버튼이 스스로 답한다(U3). */
    busy: "running" | "retrying" | null;
    /** 이미 열린 요청에 더해 보내는가 — 확인 창의 제목이 달라진다(U3). */
    more: boolean;
  };
}

export interface JourneyInput {
  /** 활성 프로젝트의 레포 상태 — null 이면 아직 모른다(준비 전과 같다). */
  repo: RepoStatus | null;
  /** 제출 · 보관이 도는 동안의 방송 — 없으면 null. */
  diffStatus: DiffStatus | null;
  /** 열린(또는 방금 병합된) 요청 — 없으면 `repo.handoff` 를 읽는다. */
  handoff?: HandoffStatus | null;
  /** 이 프로젝트에서 AI 가 도는 중인가. */
  running: boolean;
  /** 다시 연결이 필요한가(연결 코드 만료 · AI 로그인) — 제출보다 먼저다. */
  reconnect?: boolean;
  /** 개발자 코멘트 수 — 아는 쪽(단계 4 의 장부)이 넘긴다. 모르면 0. */
  comments?: number;
  /** 제출 상태의 문장 — `submitCopy(repo?.submit, L)`(U13). 막힘 · 도는 중을 이것이 말한다. */
  submitCopy: SubmitCopy;
}

/** 준비가 끝나 제출이 뜻을 갖는 자리 — `error` 는 미리보기만 죽었을 뿐 작업은 산다. */
function workable(repo: RepoStatus | null): boolean {
  return repo?.phase === "ready" || repo?.phase === "error";
}

/** 이번 사이클에 아직 개발자에게 가지 않은 것이 있는가 — deriveDelivery 와 같은 잣대. */
function hasWork(repo: RepoStatus | null): boolean {
  if (!repo) return false;
  return repo.branch !== null || repo.pendingChanges > 0;
}

/** 제목이 빈 화면(화면을 만지지 않은 차례)은 목록에서 뺀다(PLAN-UI 6 리스크). */
function screensOf(repo: RepoStatus | null): RepoStatus["cycleScreens"] {
  return repo?.cycleScreens?.filter((screen) => screen.title.trim().length > 0);
}

export function deriveJourney(input: JourneyInput, words: JourneyWords): Journey {
  const { repo, running } = input;
  const handoff = input.handoff !== undefined ? input.handoff : (repo?.handoff ?? null);
  const work = hasWork(repo);
  const screens = screensOf(repo);
  const copy = input.submitCopy;
  const blocked = copy.phase === "blocked";
  const comments = input.comments ?? 0;

  // 병합 뒤에 쌓인 작업은 새 사이클이다 — `반영됐어요` 가 넘길 일감을 가리지 않는다.
  const cycle: JourneyCycle =
    handoff?.state === "merged" ? (work ? "draft" : "merged") : handoff ? "review" : "draft";

  const { journey: J } = words;
  const points: Journey["points"] =
    cycle === "draft"
      ? [
          {
            label: copy.firstPoint
              ? copy.firstPoint
              : screens && screens.length > 0
                ? J.screensBefore(screens.length)
                : J.before,
            state: "cur",
          },
          { label: J.review, state: "todo" },
          { label: J.merged, state: "todo" },
        ]
      : cycle === "review"
        ? [
            { label: J.submittedDone, state: "done" },
            {
              label: comments > 0 ? J.reviewingComments(comments) : J.reviewing,
              state: "cur",
            },
            { label: J.merged, state: "todo" },
          ]
        : [
            { label: J.submittedDone, state: "done" },
            { label: J.reviewed, state: "done" },
            { label: J.mergedNow, state: "cur" },
          ];
  const current = cycle === "draft" ? 0 : cycle === "review" ? 1 : 2;

  return {
    cycle,
    points,
    current,
    blocked,
    making: running,
    submit: submitState(input, { cycle, work, screens, blocked, handoff }, words),
  };
}

/**
 * 제출 버튼의 판정 — 목업 `submitState` 의 순서 그대로: 다시 연결 > AI 가 도는
 * 중 > 준비 중 > 제출이 도는 중 > 막힘 > 반영됨 > 열린 요청에 더하기 > 첫 제출.
 */
function submitState(
  input: JourneyInput,
  facts: {
    cycle: JourneyCycle;
    work: boolean;
    screens: RepoStatus["cycleScreens"];
    blocked: boolean;
    handoff: HandoffStatus | null;
  },
  words: JourneyWords,
): Journey["submit"] {
  const { repo, diffStatus, running, submitCopy: copy } = input;
  const { submit: S, shell } = words;
  const open = facts.handoff !== null && facts.handoff.state !== "merged";
  const lock = (reason: string, busy: Journey["submit"]["busy"] = null) => ({
    enabled: false,
    reason,
    busy,
    more: open,
  });
  const ready = (reason: string) => ({ enabled: true, reason, busy: null, more: open });

  if (input.reconnect) return lock(S.whyReconnect);
  if (running) return lock(S.whyRunning);
  if (!workable(repo)) return lock(S.whyPreparing);

  // 도는 제출 — 선로의 `submit.phase`(submitCopy)가 먼저, 옛 방송(diff.status)이
  // 그 다음. `computing` · `pushing` 은 차례마다의 자동 보관도 지나는 단계라
  // 제출로 읽지 않는다 — 넘기기만의 단계는 `handing-off` 하나다.
  if (copy.busy) return lock(copy.reason ?? copy.label, copy.busy);
  if (diffStatus?.stage === "handing-off") return lock(S.running, "running");
  // 막힘의 이유는 둘이다 — 연결 코드 만료(auth)와 개발자에게 알린 막힘.
  if (facts.blocked) return lock(copy.reason ?? S.whyBlocked);
  if (facts.cycle === "merged") return lock(S.whyMerged);

  if (open) {
    // 보낸 뒤 바뀐 화면은 마지막 제출 기록 뒤의 화면이다. 둘 중 하나라도
    // 모르면 옛 판정(작업이 있으면 열림)을 따른다 — 밀린 보관을 원격까지
    // 올릴 손이 제출뿐이라 잠가 두면 안 된다(delivery.ts 의 같은 이유).
    const since = copy.lastAt;
    if (facts.screens && since !== null) {
      // 시각은 수로 견준다 — 화면 목록은 git 의 시각(+09:00), 제출 기록은 UTC(Z)라
      // 글자로 견주면 어긋난다.
      const cut = Date.parse(since);
      const more = facts.screens.filter((screen) => Date.parse(screen.at) > cut).length;
      return more > 0 ? ready(S.whyMoreReady(more)) : lock(S.whyNoMore);
    }
    return facts.work ? ready(shell.submitMoreAny) : lock(S.whyNoMore);
  }

  if (facts.screens && facts.screens.length > 0) return ready(S.whyReady(facts.screens.length));
  return facts.work ? ready(shell.submitReadyAny) : lock(S.whyNothing);
}
