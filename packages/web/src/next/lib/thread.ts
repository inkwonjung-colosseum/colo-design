import type { EffortLevel, LostSend } from "@colo-design/protocol";
import { koreanNoticeWords, LIMIT_WORDS } from "../../lib/error-words.ts";
import type { L } from "../labels";

/**
 * 대화 칸의 작은 판정들 — 순수 함수만 산다. 시험이 src 에서 곧장 읽으므로
 * 형제 모듈을 부르지 않고(확장자 없는 import 를 node 가 풀지 못한다), 문장이
 * 필요하면 부르는 쪽이 넘긴다.
 */

/** 생각 시간의 다섯 칸 — CLI 의 노력 단계에 하나씩 얹는다. */
export type EffortWord = "short" | "normal" | "long" | "longer" | "max";

export const EFFORT_OF: Record<EffortWord, EffortLevel> = {
  short: "low",
  normal: "medium",
  long: "high",
  longer: "xhigh",
  max: "max",
};

/** 지금 노력이 다섯 칸 중 어디인가. 고른 적이 없으면(null) CLI 의 기본 — 보통이다. */
export function effortWord(effort: EffortLevel | null): EffortWord {
  if (effort === "low") return "short";
  if (effort === "high") return "long";
  if (effort === "xhigh") return "longer";
  if (effort === "max") return "max";
  return "normal";
}

/**
 * 모델 칩의 문양(W6) — `모델 · 생각 시간`. 앞말은 부르는 쪽이 고른다: 모델 줄의
 * 이름이 먼저고, 목록이 아직 오지 않았을 때만 프로바이더가 그 자리를 대신한다.
 */
export function chipLabel(leadLabel: string, effort: string | null): string {
  return effort === null ? leadLabel : `${leadLabel} · ${effort}`;
}

/**
 * ⚡ 토글을 누른 뒤의 말 — 부탁이 받아들여지면 켬·끔의 인사를, 받아들여지지
 * 못했으면 데몬이 대신 말하는 이유(요금제 · 쿨다운)를 그대로 옮긴다. 이유마저
 * 없으면 못 했다는 말로 대신한다 — 칩이 조용히 제자리에 머무는 것은 고장과
 * 같은 얼굴이므로, 어느 길로 끝나든 말이 남아야 한다.
 */
export function fastToast(
  want: boolean,
  on: boolean,
  blocked: string | null,
  say: { on: string; off: string; fail: string },
): string {
  if (on === want) return want ? say.on : say.off;
  return blocked ?? say.fail;
}

/** 한도 문장을 알아보는 단서 — SDK 가 답의 마지막 줄에 스스로 남기는 영어 문장. */
export const LIMIT_RESULT = /usage limit|rate limit|limit reached|weekly limit|capacity/i;

/** 원문 한 줄을 화면의 문장으로 갈라 놓은 것(W3) — 접힌 `자세히` 아래 실릴 원문까지. */
export interface RawErrorLine {
  title: string;
  /** title 이 원문이면 접히지 않는다 — raw 는 null. */
  raw: string | null;
}

/**
 * 밖에서 온 오류 원문 한 줄의 한국어(W3) — 한국어 고지(고칠 것을 말하는 안내)는
 * 그대로 지나가고, 한도 문장은 그 문장으로, 그 밖의 날 원문(영어 · 스택)은 받은
 * 문장으로 덮은 뒤 원문을 접힌 자리에 내려 준다.
 */
export function rawErrorLine(raw: string, words: Pick<typeof L, "vocab">): RawErrorLine {
  if (koreanNoticeWords(raw)) return { title: raw, raw: null };
  if (LIMIT_RESULT.test(raw)) return { title: LIMIT_WORDS, raw };
  return { title: words.vocab.aiFailed, raw };
}

/** 잃은 말의 실패 카드 한 장(W8) — 사람의 말과 첨부의 수. */
export interface FailureCardRow {
  id: string;
  text: string;
  images: number;
  files: number;
}

/** 실패 판정이 읽는 블록의 모양 — 대화록(Block)에서 필요한 칸만. */
export interface FailureTapeBlock {
  type: string;
  id: string;
  text?: string;
  isError?: boolean;
  subtype?: string;
}

/**
 * 이 대화가 잃은 말(`sessions.dropped`)마다 실패 카드 한 장씩(W8 · N3) — 데몬의
 * 방이 기억하므로 새로 고침 뒤에도 선다. 같은 보내기가 대화록에 이미 살아 있는
 * 실패(사람의 말 뒤에 실패한 답)로 남아 있으면 하나다 — 대화록의 카드가 그 실패를
 * 이미 말한다.
 */
export function failureCards(
  dropped: LostSend[],
  blocks: ReadonlyArray<FailureTapeBlock>,
): FailureCardRow[] {
  const told = new Set<string>();
  let pending: string | null = null;
  for (const block of blocks) {
    if (block.type === "user") pending = block.text ?? null;
    else if (
      block.type === "turn" &&
      (block.isError || (block.subtype !== "" && block.subtype !== "success"))
    ) {
      if (pending !== null) told.add(pending);
      pending = null;
    }
  }
  return dropped
    .filter((item) => !told.has(item.text))
    .map((item) => ({ id: item.id, text: item.text, images: item.images, files: item.files }));
}

/** 데몬이 대화에 내려놓는 알림 한 줄의 종류 — 첫머리로 알아본다. */
export type NoticeKind = "retry" | "wait" | "revive";

export function noticeKind(text: string, prefixes: Record<NoticeKind, string>): NoticeKind | null {
  const head = text.trimStart();
  for (const kind of ["retry", "wait", "revive"] as const) {
    if (head.startsWith(prefixes[kind])) return kind;
  }
  return null;
}

/** 스스로 다시 묻기의 몇 번째인가 — 데몬 문장 끝의 `(n/N)`. 없으면 null. */
export function retryCount(text: string): { n: number; of: number } | null {
  const match = /\((\d+)\s*\/\s*(\d+)\)/.exec(text);
  if (!match) return null;
  return { n: Number(match[1]), of: Number(match[2]) };
}

/**
 * 사람(과 기계)이 보낸 말의 순번 — 블록 id → k(1부터). 데몬의 분기 셈과
 * 같다(turn-numbering.ts): `session.branch { turn }` 은 k 번째 말의 답까지를
 * 남기므로, k 번째 말 **앞까지** 이어받으려면 k-1 로 가른다.
 */
export function promptNumbers(
  blocks: ReadonlyArray<{ type: string; id: string }>,
): Map<string, number> {
  const numbers = new Map<string, number>();
  let prompts = 0;
  for (const block of blocks) {
    if (block.type !== "user") continue;
    prompts += 1;
    numbers.set(block.id, prompts);
  }
  return numbers;
}

/** 같은 화면을 두 번 싣지 않는다 — 게이트는 어차피 한 번만 열어 본다. */
export function dedupeScreens(screens: Array<{ screen: string }>): Array<{ screen: string }> {
  const seen = new Set<string>();
  return screens.filter((row) => {
    if (seen.has(row.screen)) return false;
    seen.add(row.screen);
    return true;
  });
}

/**
 * 열린 요청인가(U20) — 반영(merged) · 닫힘(closed) 이 아니면 열린 것이다.
 * `changes_requested` 는 리뷰의 판정이지 요청의 닫힘이 아니므로 열린 셈에
 * 넣는다(감독자의 관찰 · `제출한 때의 화면 보기` 와 같은 잣대).
 */
export function handoffOpen(handoff: { state: string } | null | undefined): boolean {
  return handoff?.state === "open" || handoff?.state === "changes_requested";
}

/**
 * 영수증의 `한마디 더` 단추가 살 조건(U20 · PLAN-UI §10) — 그 영수증의
 * 요청이 아직 열려 있을 때뿐. 닫히거나 반영된 요청에는 갈 곳이 없다.
 */
export function noteAllowed(
  block: { pr: number },
  handoff: { number: number; state: string } | null | undefined,
): boolean {
  return handoff != null && handoff.number === block.pr && handoffOpen(handoff);
}

/** `12초` · `1분 5초` 의 재료 — 초와 분. */
export function splitDuration(ms: number): { minutes: number; seconds: number } {
  const total = Math.max(0, Math.round(ms / 1000));
  return { minutes: Math.floor(total / 60), seconds: total % 60 };
}

/** 첨부 한 건의 크기 — 목업의 작은 글씨(`320KB` · `2.4MB`). */
export function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}
