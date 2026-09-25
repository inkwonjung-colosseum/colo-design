/**
 * 설정 → 연결의 한 줄(PLAN-UI §10 U17) — 연결 코드의 만료를 미리 안다.
 * 만료를 모르면 지금 문장(`연결 정상 · 프로젝트 N개`), 15일 이상 남으면 거기에
 * 남은 날짜까지, 14일 안이면 노란 점과 개발자 부탁 문장, 지났거나 이미 만료되면
 * 다시 연결 문장. 날짜는 라벨 함수가 짓는다.
 *
 * 문장은 `labels.ts` 에서 오지만 이 파일은 그것을 부르지 않고 인자로 받는다 —
 * 단위 시험이 src 에서 곧장 읽는 순수 모듈은 형제를 부르지 않는다
 * (journey.ts 와 같은 규칙). 부르는 쪽은 `connectionCopy(input, now, L)`.
 */
import type { DaemonStatus } from "@colo-design/protocol";
import type { L } from "../labels";

/** 판정에 쓰는 칸 — `L.vocab` · `L.problem` · `L.settings` 가 구조적으로 채운다. */
export type ConnectionWords = Pick<typeof L, "vocab" | "problem" | "settings">;

export interface ConnectionInput {
  /** 이미 401 을 본 판정(`DaemonStatus.githubAuthExpired`). */
  expired: boolean;
  /** 만료 예정(ISO) — null 은 만료일이 없는 코드, 만료 전 적임. */
  expiresAt: string | null;
  /** 등록된 프로젝트 수. */
  projects: number;
  /** 개발자 알림이 갈 길 — 없으면 부탁했어요가 아니라 부탁하세요가 된다. */
  noticeRoute: DaemonStatus["noticeRoute"];
}

export interface ConnectionCopy {
  dot: "green" | "amber" | "red";
  text: string;
}

/** 하루의 밀리초 — 남은 날의 올림에 쓴다. */
const DAY_MS = 86_400_000;
/** 미리 말하는 창(날) — 데몬의 예산표(BUDGETS.tokenExpiry)와 같은 값. */
const WARN_DAYS = 14;

/** 설정 → 연결 한 줄의 판정 — 상태에서만 나온다. */
export function connectionCopy(
  input: ConnectionInput,
  now: number,
  words: ConnectionWords,
): ConnectionCopy {
  const plain = `${words.vocab.connectionOk} · ${words.vocab.projectCount(input.projects)}`;
  if (input.expired) return { dot: "red", text: words.problem.reconnectInvite };
  if (input.expiresAt === null) return { dot: "green", text: plain };
  const end = new Date(input.expiresAt).getTime();
  if (Number.isNaN(end)) return { dot: "green", text: plain };
  const daysLeft = Math.ceil((end - now) / DAY_MS);
  // 지났다 — 예고의 자리가 아니라 다시 연결의 자리다(실제 401 은 곧 온다).
  if (daysLeft <= 0) return { dot: "red", text: words.problem.reconnectInvite };
  if (daysLeft <= WARN_DAYS) {
    const tail =
      input.noticeRoute === "none" ? words.settings.connectionAsk : words.settings.connectionAsked;
    return { dot: "amber", text: `${words.settings.connectionEnding(daysLeft)} · ${tail}` };
  }
  const date = new Date(end);
  return {
    dot: "green",
    text: `${plain} · ${words.settings.connectionUntil(date.getMonth() + 1, date.getDate())}`,
  };
}
