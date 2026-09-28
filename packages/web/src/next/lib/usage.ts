import type { PlanPeriod, PlanUsage } from "@nova-design/protocol";
import type { L } from "../labels";

/**
 * 모델 칩 팝의 사용량 칸 — 순수 판정만 산다. 시험이 src 에서 곧장 읽으므로
 * 형제 모듈을 부르지 않고, 문장은 부르는 쪽이 넘긴다(thread.ts 와 같은 모양).
 */

/** 모델 칩 옆에 사용량 한 단어가 서는 문턱(P6) — 한도의 70%. */
export const USAGE_WORD_MIN = 70;

/** 한 단어와 막대가 붉어지는 문턱 — 곧 막힌다. */
export const USAGE_HOT_MIN = 90;

/** 사용량 칸의 한 줄 — 계정의 창 하나. */
export interface UsageRow {
  /** 쓴 비율(0~100, 반올림). */
  pct: number;
  /**
   * 어느 창인가 — 요금제 자신의 5시간 · 이번 주, 또는 그 밖의 창(모델별 주간 ·
   * 모델의 제 5시간 · 이번 달). 그 밖의 창은 이름과 기간을 따로 싣고, 둘을
   * 모르는 옛 읽기는 데몬이 적어 둔 이름(`label`)을 그대로 쓴다.
   */
  window:
    | { kind: "fiveHour" }
    | { kind: "sevenDay" }
    | { kind: "extra"; name: string | null; period: PlanPeriod | null; label: string };
  resetsAt: string | null;
}

export type UsageWords = Pick<typeof L, "chat">;

const clamp = (value: number | null | undefined) =>
  Math.max(0, Math.min(100, Math.round(value ?? 0)));

/**
 * 한 계정의 창 전부 — 5시간 · 이번 주 · 그 밖의 창을 서버가 보낸 차례로.
 * 가장 찬 창 하나만 보이면 나머지 창이 곧 막혀도 모른다: 5시간이 18% 인 동안
 * 이번 주가 90% 일 수 있다. 읽을 창이 없으면 빈 목록.
 */
export function usageRows(plan: PlanUsage | null | undefined): UsageRow[] {
  if (!plan) return [];
  const rows: UsageRow[] = [];
  if (plan.fiveHour) {
    rows.push({
      pct: clamp(plan.fiveHour.utilization),
      window: { kind: "fiveHour" },
      resetsAt: plan.fiveHour.resetsAt ?? null,
    });
  }
  if (plan.sevenDay) {
    rows.push({
      pct: clamp(plan.sevenDay.utilization),
      window: { kind: "sevenDay" },
      resetsAt: plan.sevenDay.resetsAt ?? null,
    });
  }
  for (const row of plan.modelWeekly ?? []) {
    rows.push({
      pct: clamp(row.utilization),
      window: {
        kind: "extra",
        name: row.name ?? null,
        period: row.period ?? null,
        label: row.label,
      },
      resetsAt: row.resetsAt ?? null,
    });
  }
  return rows;
}

/**
 * 가장 찬 창 하나 — 칩 옆 한 단어(P6)의 몫. 같은 비율이면 앞선 창(5시간)이
 * 이긴다 — 가장 먼저 다시 차는 창이다. 읽을 창이 없으면 null.
 */
export function usageReading(plan: PlanUsage | null | undefined): UsageRow | null {
  const rows = usageRows(plan);
  if (rows.length === 0) return null;
  return rows.reduce((worst, row) => (row.pct > worst.pct ? row : worst));
}

/** 막대의 온도 — 칩 옆 한 단어와 같은 문턱(70% 주의 · 90% 위험). */
export function usageHeat(pct: number): "calm" | "warm" | "hot" {
  if (pct >= USAGE_HOT_MIN) return "hot";
  if (pct >= USAGE_WORD_MIN) return "warm";
  return "calm";
}

/**
 * 한 줄의 이름 — `이번 5시간` · `이번 주` · `Fable · 이번 주` · `이번 달`.
 * 기간을 모르는 창(옛 읽기, 세 기간 어디에도 들지 않는 창)은 데몬이 적어 둔
 * 이름을 그대로 쓴다.
 */
export function usageRowName(row: UsageRow, words: UsageWords): string {
  const { chat } = words;
  const { window } = row;
  if (window.kind === "fiveHour") return chat.usageFiveHour;
  if (window.kind === "sevenDay") return chat.usageWeek;
  if (window.period === null) return window.label;
  const period =
    window.period === "fiveHour"
      ? chat.usageFiveHour
      : window.period === "week"
        ? chat.usageWeek
        : chat.usageMonth;
  return window.name === null ? period : chat.usageScoped(window.name, period);
}

/** 두 때 사이의 달력 날 수 — 이 컴퓨터의 시간대로. 서머타임의 23·25시간 날도 하루다. */
function calendarDays(from: Date, to: Date): number {
  const day = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  return Math.round((day(to) - day(from)) / 86_400_000);
}

/**
 * 다시 차는 때 — 오늘이면 시각만(`18:00`), 내일이면 `내일 09:00`, 그 너머는
 * 날짜와 요일까지(`10월 3일(토) 03:00`). 주간 창의 시각만 말하면 오늘의 그
 * 시각으로 읽힌다. 읽을 수 없거나 이미 지난 때는 null — 다음 읽기가 창을
 * 새로 채운다.
 */
export function refillWhen(at: string, now: Date, words: UsageWords): string | null {
  const when = new Date(at);
  if (Number.isNaN(when.getTime()) || when.getTime() <= now.getTime()) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  const days = calendarDays(now, when);
  if (days === 0) return time;
  if (days === 1) return words.chat.usageTomorrow(time);
  return words.chat.usageOnDate(
    when.getMonth() + 1,
    when.getDate(),
    words.chat.usageWeekdays[when.getDay()] ?? "",
    time,
  );
}
