import type { EffortLevel, LostSend } from "@nova-design/protocol";
import { koreanNoticeWords, LIMIT_WORDS } from "../../lib/error-words.ts";
import { screenPath } from "../../lib/screen-link.ts";
import { screenKey } from "../../lib/turn-screens.ts";
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
 * 같은 얼굴이므로, 어느 길로 끝나든 말이 남아야 한다. 이유의 번역 묶음(`blocked`)을
 * 넘기면 그 이유가 한국어로 갈아입는다(§5.3) — 선택 칸이라 넘기지 않는
 * 부르는 쪽은 지금 그대로다.
 */
export function fastToast(
  want: boolean,
  on: boolean,
  blocked: string | null,
  say: { on: string; off: string; fail: string; blocked?: FastBlockedWords },
): string {
  if (on === want) return want ? say.on : say.off;
  // 빈 이유는 이유가 아니다 — 빈 토스트는 뜨지 않아 칩이 말없이 제자리에 선다.
  if (!blocked) return say.fail;
  return say.blocked ? fastBlockedWords(blocked, say.blocked) : blocked;
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

/**
 * 빠르게가 막힌 이유의 문장 묶음 — 데몬은 CLI 의 영어 원문(`fast_mode_disabled_reason`)
 * 을 그대로 나르므로, 이 묶음이 각 단서의 한국어를 채운다.
 */
export interface FastBlockedWords {
  creditsGone: string;
  credits: string;
  org: string;
  orgModels: string;
  network: string;
  evaluation: string;
  cooldown: string;
}

/**
 * 빠르게 툴팁 카드의 문장 묶음 — 이 파일은 labels 를 부르지 않으므로(시험이 src 를
 * 곧장 읽는다) 부르는 쪽이 `L.fast` 로 이 모양을 채워 넘긴다.
 */
export interface FastWords {
  offTitle: string;
  nextTitle: string;
  onTitle: string;
  costClaude: string;
  costMidway: string;
  costOmp: string;
  costOther: string;
  blocked: FastBlockedWords;
}

/**
 * ⚡ 토글을 보이는 규칙(§5.1) — 켜져 있으면 능력을 몰라도 보인다: 끌 길은
 * 남겨야 하므로(omp 의 `-fast` 변종으로 도는 대화가 이 경우). 꺼져 있을 때는
 * 프로바이더 능력을 요구하고, 모델 행을 모르면(선택자가 오기 전 잠깐) 능력만으로
 * 낙관한다 — 행이 오면 정정된다.
 */
export function fastChip(input: {
  capability: boolean;
  row: { supportsFastMode: boolean } | undefined;
  on: boolean;
}): boolean {
  return input.on || (input.capability && (input.row ? input.row.supportsFastMode : true));
}

/**
 * 빠르게가 막힌 이유의 한국어(§5.3) — 원문을 소문자로 눌러 단서를 본다. 단서의
 * 순서가 곧 우선순위다: "allowed models" 원문은 organization 을 품는 문장이라
 * orgModels 가 org 보다 먼저 오고, exhausted 는 credits 의 더 뚜렷한 꼬리라 먼저
 * 본다. 모르는 원문은 번역을 지어내지 않고 그대로 돌려준다 — 빈 문자열도 그대로
 * 돌아가 호출자가 판단한다.
 */
export function fastBlockedWords(reason: string, words: FastBlockedWords): string {
  const clue = reason.toLowerCase();
  if (clue.includes("usage credit") && clue.includes("exhaust")) return words.creditsGone;
  if (clue.includes("usage credit")) return words.credits;
  if (clue.includes("allowed models")) return words.orgModels;
  if (clue.includes("organization")) return words.org;
  if (clue.includes("network") || clue.includes("connectivity")) return words.network;
  if (clue.includes("evaluation")) return words.evaluation;
  if (clue.includes("cooldown") || clue.includes("rate limit")) return words.cooldown;
  return reason;
}

/**
 * 프로바이더별 빠르게의 비용 문장(§5.2) — 툴팁 카드와 켜는 순간의 토스트가
 * 같은 문장을 쓴다. 문장의 주인은 이 파일이 아니라 `L.fast` 다.
 */
export function fastCost(
  provider: string,
  words: Pick<FastWords, "costClaude" | "costOmp" | "costOther">,
): string {
  if (provider === "claude") return words.costClaude;
  if (provider === "omp") return words.costOmp;
  return words.costOther;
}

/**
 * 빠르게 툴팁 카드의 문장(§5.2) — 제목 하나와 비고 줄들(한 줄에 하나, 없으면 빈
 * 배열). 막힌 이유는 몸이 있는 session 만 보인다 — next 는 아직 켜 주지 않으므로
 * blocked 가 와도 무시한다. 대화 중간에 켜면 그때까지의 대화가 한 번 더 계산되는
 * 것(Claude 만)은 꺼져 있고 열린 대화의 카드에만 덧선다.
 */
export function fastTipWords(
  state: { subject: "next" | "session"; on: boolean; blocked: string | null; provider: string },
  words: FastWords,
): { title: string; notes: string[] } {
  const cost = fastCost(state.provider, words);
  if (state.blocked != null && state.subject === "session") {
    return { title: fastBlockedWords(state.blocked, words.blocked), notes: [] };
  }
  if (state.on) return { title: words.onTitle, notes: [cost] };
  if (state.subject === "next") return { title: words.nextTitle, notes: [cost] };
  return {
    title: words.offTitle,
    notes: state.provider === "claude" ? [cost, words.costMidway] : [cost],
  };
}

/** 고친 화면 카드의 제목 문장 — 부르는 쪽이 L 에서 채운다. */
export interface ScreenTitleWords {
  homeScreen: string;
  unknownScreen: string;
}

/**
 * 고친 화면 카드의 제목 — 답이 링크에 붙인 제목이 먼저고, 없으면 이번 작업의
 * 화면 이름에서 찾는다. 루트는 첫 화면이고, 그래도 모르면 일반 이름으로 선다 —
 * 화면 주소가 그대로 제목에 서는 일이 없게. 이번 작업의 화면과 같은 잣대로
 * 겨눈다(끝 슬래시 · `index` 표기 차이는 같은 화면이다).
 */
export function screenTitle(
  screen: { path: string; title: string | null },
  cycleScreens: ReadonlyArray<{ route: string; title: string }> | null | undefined,
  words: ScreenTitleWords,
): string {
  if (screen.title !== null && screen.title.trim() !== "") return screen.title;
  const path = screenKey(screenPath(screen.path));
  if (path === "/") return words.homeScreen;
  const found = cycleScreens?.find(
    (candidate) => candidate.title.trim() !== "" && screenKey(screenPath(candidate.route)) === path,
  );
  return found?.title ?? words.unknownScreen;
}

/** 말줄 역할 판정이 읽는 테이프의 모양 — 대화록(Block)에서 필요한 칸만. */
export interface RoleTapeBlock {
  type: string;
  id: string;
  agentId?: string | null;
}

/** 과정 문장의 역할 — 접는 줄이 서는 자리와 그 묶음의 열쇠, 답이 끝났는가. */
export interface StepRole {
  /** 접는 줄이 서는 자리 — 묶음의 첫 과정 문장. */
  head: boolean;
  /** 묶음의 첫 과정 문장 id — 펼침 상태의 열쇠. */
  key: string;
  /** 답이 끝났는가 — 끝나면 과정은 접힌다. */
  settled: boolean;
}

/** 한 답 묶음 안에서 글 블록의 역할 — 답 자리와 과정 문장들. */
export interface TextRoles {
  /** 최종 답 자리의 글 블록 id — 묶음마다 마지막 글. 도는 동안에도 이 자리는 답 모양이다. */
  answers: ReadonlySet<string>;
  /** 과정 문장 — 답이 끝나면 한 줄로 접힌다. */
  steps: ReadonlyMap<string, StepRole>;
}

/**
 * 한 답 묶음(사람의 말 뒤부터 답이 끝날 때까지)에서 어느 글이 최종 답 자리인가 —
 * 묶음마다 마지막 글이 답이고 그 앞의 글은 과정이다. 도는 중에도 마지막 글은
 * 답 자리다: 답이 끝나는 순간 모양이 바뀌며 다시 마운트되는 일이 없게. 뒤에 이어
 * 온 글이 답 자리를 받으면 앞의 글은 과정으로 내려간다. 답을 여는 말 · 답을
 * 닫는 기록이 묶음의 경계고, 생각 · 도구 · 알림은 묶음 안의 일이며 하위
 * 에이전트의 글(agentId)은 답도 과정도 아니다.
 */
export function textRoles(tape: readonly RoleTapeBlock[], live: boolean): TextRoles {
  const answers = new Set<string>();
  const steps = new Map<string, StepRole>();
  let bundle: string[] = [];
  const close = (settled: boolean) => {
    if (bundle.length === 0) return;
    answers.add(bundle[bundle.length - 1]!);
    const stepIds = bundle.slice(0, -1);
    stepIds.forEach((id, at) => {
      steps.set(id, { head: at === 0, key: stepIds[0]!, settled });
    });
    bundle = [];
  };
  for (const block of tape) {
    if (block.type === "text" && block.agentId == null) bundle.push(block.id);
    else if (
      block.type === "user" ||
      block.type === "turn" ||
      block.type === "human" ||
      block.type === "milestone" ||
      block.type === "save" ||
      block.type === "saveBlocked"
    ) {
      close(true);
    }
  }
  close(!live); // 꼬리의 묶음 — 답이 도는 중이면 아직 끝나지 않았다.
  return { answers, steps };
}
