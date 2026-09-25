import type { Block } from "./daemon-client";

/**
 * 대화가 말한 화면들 — 순수 함수만 산다.
 *
 * 공통 규칙이 AI 에게 "화면을 만들거나 고치면 답변 끝에 `[제목](전체 주소)`
 * 를 남기라" 고 가르친다(common-instructions.ts). 그러니 대화 기록만 읽어도
 * 두 질문에 답할 수 있다: 방금 끝난 턴이 어느 화면을 고쳤나(미리보기가
 * 그리로 옮겨 간다), 이 대화에 어떤 화면이 있었나(주소창이 제목으로
 * 나열한다). 데몬의 게이트 입력(notePinned)과 같은 원천의 웹 쪽 읽기다 —
 * 선로를 새로 내지 않는다.
 *
 * 링크 주소가 이 미리보기의 화면인지는 부르는 쪽이 `toPath` 로 판정한다
 * (screen-link.ts 의 previewPathOf 를 지금 서버 주소로 묶은 것). 이 파일이
 * 형제 모듈을 부르지 않는 이유는 하나 — 단위 시험이 src 에서 곧장 읽는다.
 */

/** 화면 하나 — 미리보기 안의 경로와, AI 가 링크에 붙인 제목(없으면 null). */
export interface TurnScreen {
  path: string;
  title: string | null;
}

/** 링크 주소 → 미리보기 안의 경로, 이 미리보기의 화면이 아니면 null. */
export type ToPath = (href: string) => string | null;

/** 마크다운 링크 `[제목](주소)` — 꺾쇠로 감싼 주소와 제목 따옴표도 받는다. */
const MD_LINK = /\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
/** 맨 주소 — 링크로 감싸지 않고 적힌 것. 제목이 없다. */
const BARE_URL = /\bhttps?:\/\/[^\s)<>\]"'`]+/g;

/**
 * 같은 화면인가의 잣대 — 끝 슬래시와 해시는 화면을 바꾸지 않는다. 쿼리는
 * 주소의 일부로 남는다(2026-09-21 상태 축 철거 뒤 주소가 곧 화면이다).
 */
export function screenKey(path: string): string {
  const noHash = path.split("#")[0] ?? "";
  const [rawPath = "", query] = noHash.split("?");
  const trimmed = rawPath.replace(/\/+$/, "");
  const base = trimmed === "" ? "/" : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return query ? `${base}?${query}` : base;
}

/** 링크 제목에서 마크다운 강조만 벗긴다 — `**회원 목록**` 은 `회원 목록` 이다. */
function cleanTitle(raw: string): string | null {
  const title = raw.replace(/[*`]/g, "").trim();
  return title === "" ? null : title;
}

/** 한 덩어리의 글에서 이 미리보기의 화면 링크를 나온 순서대로. */
export function screenLinksOf(text: string, toPath: ToPath): TurnScreen[] {
  const found: Array<{ at: number; screen: TurnScreen }> = [];
  const covered: Array<[number, number]> = [];
  for (const match of text.matchAll(MD_LINK)) {
    const at = match.index ?? 0;
    covered.push([at, at + match[0].length]);
    const path = toPath(match[2] ?? "");
    if (path === null) continue;
    found.push({ at, screen: { path, title: cleanTitle(match[1] ?? "") } });
  }
  for (const match of text.matchAll(BARE_URL)) {
    const at = match.index ?? 0;
    if (covered.some(([start, end]) => at >= start && at < end)) continue;
    // 문장 끝의 구두점은 주소가 아니다.
    const path = toPath(match[0].replace(/[.,;:!?]+$/, ""));
    if (path === null) continue;
    found.push({ at, screen: { path, title: null } });
  }
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.screen);
}

/** 본 에이전트의 답변 글 — 하위 에이전트의 중간 보고는 사용자의 답이 아니다. */
function answerTexts(blocks: readonly Block[]): string[] {
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.agentId === null) texts.push(block.text);
  }
  return texts;
}

/**
 * 방금 끝난 턴이 말한 화면들 — 마지막 사람(또는 기계) 턴 뒤의 답변에서,
 * 나온 순서대로, 같은 화면은 한 번. 첫 항목이 미리보기가 옮겨 갈 곳이다.
 */
export function lastTurnScreens(blocks: readonly Block[], toPath: ToPath): TurnScreen[] {
  let start = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]?.type === "user") {
      start = index + 1;
      break;
    }
  }
  const seen = new Set<string>();
  const screens: TurnScreen[] = [];
  for (const text of answerTexts(blocks.slice(start))) {
    for (const screen of screenLinksOf(text, toPath)) {
      const key = screenKey(screen.path);
      if (seen.has(key)) continue;
      seen.add(key);
      screens.push(screen);
    }
  }
  return screens;
}

/**
 * 이 대화에 나온 화면 전부 — 가장 최근에 말한 것이 앞에 선다. 같은 화면이
 * 여러 번 나오면 마지막으로 붙은 제목을 입는다(제목 없는 맨 주소는 앞선
 * 제목을 지우지 않는다).
 */
export function threadScreens(blocks: readonly Block[], toPath: ToPath): TurnScreen[] {
  const byKey = new Map<string, TurnScreen>();
  for (const text of answerTexts(blocks)) {
    for (const screen of screenLinksOf(text, toPath)) {
      const key = screenKey(screen.path);
      const prior = byKey.get(key);
      // 지우고 다시 넣어야 Map 의 순서가 "마지막으로 말한 때" 가 된다.
      byKey.delete(key);
      byKey.set(key, {
        path: screen.path,
        title: screen.title ?? prior?.title ?? null,
      });
    }
  }
  return [...byKey.values()].reverse();
}

/** 경로의 제목 — 이 대화가 그 화면을 제목으로 부른 적이 있으면. */
export function titleOfPath(screens: readonly TurnScreen[], path: string): string | null {
  const key = screenKey(path);
  return screens.find((screen) => screenKey(screen.path) === key)?.title ?? null;
}
