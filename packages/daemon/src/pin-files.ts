/**
 * 핀 → 파일 후보 (빠른 수정, 2026-09-20): the daemon-side half of turning a
 * pinned element into the files it most plausibly lives in.
 *
 * 핀 턴은 이미 가리킨 요소의 정체를 실어 온다 — 컴포넌트 이름, testid,
 * 요소의 글자. 그 정체로 에이전트가 첫 tool call마다 반복하는 검색(그 요소가
 * 어느 파일의 것인가)을 데몬이 대신 한다: 클론을 한 번 훑어 후보를 매기고,
 * `파일 후보:` 줄을 턴 블록에 얹어 보낸다(2026-09-21 레포 마커 철거 —
 * `data-nova-src` 의 정확한 `파일:` 길은 폐지했다).
 *
 * 두 번의 빨라짐(같은 날): ① 훑은 파일 내용은 mtime·크기로 검증해 뿌리마다
 * 묶어 둔다 — 핀 턴마다 파일을 다시 읽지 않는다(에이전트가 편집하면 mtime 이
 * 움직여 다시 읽는다). ② 정확한 적중(점수 3 이상)에는 상위 후보의 해당 줄
 * 주변을 `파일 발췌` 로 턴에 얹는다 — 에이전트의 첫 Read 왕복을 대신하는 자리다.
 *
 * 실패는 조용하다: 후보가 없으면 줄이 없을 뿐, 턴은 그대로 간다.
 */

import { readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { SessionPinHint } from "@nova-design/protocol";
import { collectCodeFiles } from "./code-files.js";
import { filesForRoute } from "./route-index.js";
import { observedFilesFor } from "./screen-map.js";

/** 한 파일이 읽히는 크기 상한 — 생성물 한 덩어리가 예산을 삼키지 않게. */
const MAX_FILE_BYTES = 512 * 1024;
/** 핀 하나가 받는 후보 수. */
const MAX_CANDIDATES = 3;
/** 힌트 하나가 낚아 올릴 수 있는 적중 수 — 이 이상은 더 봐도 순위가 안 바뀐다. */
const MAX_HITS_PER_HINT = 8;

/** 바늘 하나 — 정확한 것일수록 점수가 높다. at 은 적중 자리(-1 은 빗나감). */
interface Needle {
  at: (content: string) => number;
  score: number;
}

/** 사냥의 적중 — 발췌가 적중 줄을 두를 때 at 이 쓰인다. */
export interface PinHit {
  file: string;
  score: number;
  at: number;
}

/** 한 힌트의 사냥 상태 — 파일마다 갱신되다가 순위로 정리된다. */
interface Hunt {
  hint: SessionPinHint;
  hits: PinHit[];
  needles: Needle[];
}

/**
 * 힌트 하나의 바늘들 — 정확한 것부터. testid 는 문장 그대로, 컴포넌트는
 * 정의 자리(`function X(` · `const X =`)만, 글자는 JSX 텍스트나 문자열로.
 * owners 는 가까운 것부터 — 첫 이름이 가장 안쪽 컴포넌트다.
 */
function needlesFor(hint: SessionPinHint): Needle[] {
  const needles: Needle[] = [];
  /** 셋 중 처음 나오는 자리 — 없으면 -1. */
  const firstAt = (content: string, ...literals: string[]): number => {
    let best = -1;
    for (const literal of literals) {
      const at = content.indexOf(literal);
      if (at >= 0 && (best < 0 || at < best)) best = at;
    }
    return best;
  };
  if (hint.testId) {
    needles.push({
      at: (content) =>
        firstAt(content, `data-testid="${hint.testId}"`, `data-testid='${hint.testId}'`),
      score: 4,
    });
  }
  for (const [index, name] of (hint.owners ?? []).slice(0, 3).entries()) {
    const def = new RegExp(
      `\\b(?:function|const|class|let|var)\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    );
    needles.push({
      at: (content) => def.exec(content)?.index ?? -1,
      score: 3 - index,
    });
  }
  const text = hint.text?.trim() ?? "";
  if (text.length >= 3 && text.length <= 80 && !text.includes("\n")) {
    needles.push({
      at: (content) => firstAt(content, `>${text}<`, `"${text}"`, `'${text}'`),
      score: 1,
    });
  }
  return needles;
}

/** 묶어 둔 파일 하나의 내용 — mtime·크기가 같으면 다시 읽지 않는다. */
interface CachedText {
  mtimeMs: number;
  size: number;
  text: string;
}

/** 뿌리 하나의 작업실 기억 — 핀 턴마다 파일을 다시 읽지 않게 한다. */
interface Workbench {
  texts: Map<string, CachedText>;
  bytes: number;
}

const workbenches = new Map<string, Workbench>();
/** 묶어 둘 수 있는 총 글자 수 — 넘으면 오래된 것부터 버린다. */
const MAX_CACHE_CHARS = 24_000_000;
/** 기억하는 뿌리 수 — 따뜻한 미리보기 서버의 상한과 같은 결. */
const MAX_ROOTS = 4;

/**
 * 코드 파일 하나의 내용 — stat 으로 mtime·크기를 검증해 묶어 둔 것을 돌려준다.
 * 에이전트가 파일을 고치면 mtime 이 움직이므로 다음 훑기는 새 내용을 읽는다.
 * 크거나 사라진 파일은 묶지 않고 null (훑기가 건너뛰던 옛 판정 그대로).
 */
async function readCodeFile(root: string, rel: string, file: string): Promise<string | null> {
  const info = await stat(file).catch(() => null);
  if (info === null || !info.isFile() || info.size > MAX_FILE_BYTES) return null;
  let bench = workbenches.get(root);
  if (bench === undefined) {
    if (workbenches.size >= MAX_ROOTS) {
      const oldest = workbenches.keys().next().value;
      if (oldest !== undefined) workbenches.delete(oldest);
    }
    bench = { texts: new Map(), bytes: 0 };
    workbenches.set(root, bench);
  }
  const kept = bench.texts.get(rel);
  if (kept !== undefined && kept.mtimeMs === info.mtimeMs && kept.size === info.size)
    return kept.text;
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  if (kept !== undefined) {
    bench.bytes -= kept.text.length;
    bench.texts.delete(rel);
  }
  bench.texts.set(rel, { mtimeMs: info.mtimeMs, size: info.size, text });
  bench.bytes += text.length;
  while (bench.bytes > MAX_CACHE_CHARS && bench.texts.size > 1) {
    const oldest = bench.texts.keys().next().value;
    const evicted = oldest === undefined ? undefined : bench.texts.get(oldest);
    if (oldest === undefined || evicted === undefined) break;
    bench.texts.delete(oldest);
    bench.bytes -= evicted.text.length;
  }
  return text;
}

/**
 * 힌트마다 후보 파일을 찾는다. 파일을 한 번씩만 읽어 모든 힌트에 동시에
 * 대입한다 — 핀 여럿이 같은 화면을 가리키는 경우가 보통이다. 읽기는
 * 묶어 둔 내용(readCodeFile)로 — 두 번째 핀 턴부터는 stat 만 돈다.
 */
export async function huntPinFiles(
  root: string,
  hints: SessionPinHint[],
): Promise<Map<string, PinHit[]>> {
  const result = new Map<string, PinHit[]>();
  const huntable = hints;
  if (huntable.length === 0) return result;
  const hunts: Hunt[] = huntable
    .map((hint) => ({ hint, hits: [] as Hunt["hits"], needles: needlesFor(hint) }))
    .filter((hunt) => hunt.needles.length > 0 && hunt.hint.id.length > 0);
  if (hunts.length === 0) return result;
  for (const file of await collectCodeFiles(root)) {
    const pending = hunts.filter((hunt) => hunt.hits.length < MAX_HITS_PER_HINT);
    if (pending.length === 0) break;
    const rel = relative(root, file).split(sep).join("/");
    const content = await readCodeFile(root, rel, file);
    if (content === null) continue;
    for (const hunt of pending) {
      let best = { score: 0, at: -1 };
      for (const needle of hunt.needles) {
        if (best.score >= needle.score) continue;
        const at = needle.at(content);
        if (at >= 0) best = { score: needle.score, at };
      }
      if (best.score > 0) hunt.hits.push({ file: rel, score: best.score, at: best.at });
    }
  }
  for (const hunt of hunts) {
    const top = hunt.hits
      .sort(
        (a, b) => b.score - a.score || a.file.length - b.file.length || (a.file < b.file ? -1 : 1),
      )
      .slice(0, MAX_CANDIDATES);
    if (top.length > 0) result.set(hunt.hint.id, top);
  }
  return result;
}

/** 표식 턴의 블록 머리(`1. label …`) — 줄 번호와 이미 정확한 `파일:` 유무. */
function blockHeads(lines: string[]): Array<{ head: number; hasFile: boolean }> {
  const heads: Array<{ head: number; hasFile: boolean }> = [];
  for (const [index, line] of lines.entries()) {
    if (!/^\d+\. /.test(line)) continue;
    let hasFile = false;
    for (let j = index + 1; j < lines.length; j++) {
      if (/^\d+\. /.test(lines[j] ?? "")) break;
      if ((lines[j] ?? "").startsWith("   파일:")) {
        hasFile = true;
        break;
      }
    }
    heads.push({ head: index, hasFile });
  }
  return heads;
}

/**
 * 핀 턴에 `파일 후보:` 줄을 얹는다. 마커의 items 순서가 블록 순서이고,
 * 힌트의 id 가 item 의 id 와 만나야 한다 — 순서로 짝짓지 않는다(대기줄
 * 복원이 이미 후보가 붙은 턴을 다시 보낼 수 있으므로 멱등이어야 한다:
 * 블록에 `파일 후보:` 가 이미 있으면 그 블록은 그대로 둔다).
 *
 * 정체(testid·owners·글자)가 못 찾은 힌트는 두 길을 차례로 얻는다 — 먼저 주소
 * (PLAN-HARNESS §3.B B-3): 레포 구조에서 주소와 같은 이름의 파일(`(주소)`
 * 표식). 그다음 관찰 지도(2026-09-22): 그 핀의 화면을 고친 커밋이 건드린
 * 파일 — `(관찰)` 표식이 그 출처를 밝힌다. 어디까지나 후보다.
 *
 * 돌려주는 `candidates` 는 이번에 댄 후보의 합집합(루트 상대경로) — 통계가
 * 에이전트의 편집과 비교해 pinHit 을 매기는 재료다.
 */
export async function enrichCommentsTurn(
  text: string,
  hints: SessionPinHint[],
  root: string,
  observed?: { projectRoot: string } | null,
): Promise<{ text: string; candidates: string[] }> {
  const untouched = { text, candidates: [] as string[] };
  if (!text.startsWith("<!-- nova-design:comments ") || hints.length === 0) return untouched;
  const markerEnd = text.indexOf(" -->");
  if (markerEnd < 0) return untouched;
  let marker: { items?: unknown };
  try {
    marker = JSON.parse(
      text.slice("<!-- nova-design:comments ".length, markerEnd),
    ) as typeof marker;
  } catch {
    return untouched;
  }
  const items = Array.isArray(marker.items) ? (marker.items as Array<{ id?: unknown }>) : [];
  const found = await huntPinFiles(root, hints);
  const lines = text.split("\n");
  const heads = blockHeads(lines);
  // 줄 삽입은 아래 블록부터 — 앞에서 삽입하면 뒤 머리의 번호가 밀린다.
  const inserts = new Map<number, string[]>();
  const candidates = new Set<string>();
  let excerptDone = false;
  for (const hint of hints) {
    const block = items.findIndex((item) => item.id === hint.id);
    const head = block >= 0 ? heads[block] : undefined;
    if (head === undefined) continue;
    if (head.hasFile) continue;
    const blockEnd = heads[block + 1]?.head ?? lines.length;
    const already = lines
      .slice(head.head, blockEnd)
      .some((line) => line.startsWith("   파일 후보:"));
    if (already) continue;
    const hits = found.get(hint.id) ?? [];
    for (const hit of hits) candidates.add(hit.file);
    let blockLines: string[] | null = null;
    if (hits.length > 0) {
      blockLines = [`   파일 후보: ${hits.map((hit) => hit.file).join(" · ")}`];
      // 발췌는 한 턴에 한 번, 첫 정확한 적중(점수 3 이상)의 상위 후보에서 —
      // 첫 Read 왕복을 대신하는 자리다. 낮은 점수(글자 적중)는 후보로만 쓴다.
      const top = hits[0];
      if (!excerptDone && top !== undefined && top.score >= EXCERPT_MIN_SCORE) {
        const content = await readCodeFile(root, top.file, join(root, top.file));
        if (content !== null) {
          blockLines.push(...excerptLines(top.file, content, top.at));
          excerptDone = true;
        }
      }
    } else if (hint.screen !== undefined) {
      // 주소의 길(§3.B B-3) — 레포 구조에서 주소와 같은 이름의 파일. 정체
      // 사냥이 빈손일 때의 첫 길이고, 관찰 지도는 그 다음이다.
      const routed = await filesForRoute(root, hint.screen)
        .then((found) => found?.files ?? [])
        .catch(() => [] as string[]);
      if (routed.length > 0) {
        for (const file of routed) candidates.add(file);
        blockLines = [`   파일 후보: ${routed.join(" · ")} (주소)`];
      } else if (observed) {
        // 관찰 지도의 길 — 최근 커밋부터, 아직 클론에 있는 파일만(상한 3).
        const files = await observedFilesFor(observed.projectRoot, root, hint.screen).catch(
          () => [] as string[],
        );
        if (files.length > 0) {
          for (const file of files) candidates.add(file);
          blockLines = [`   파일 후보: ${files.join(" · ")} (관찰)`];
        }
      }
    }
    if (blockLines !== null) inserts.set(head.head, blockLines);
  }
  if (inserts.size === 0) return { text, candidates: [...candidates] };
  for (const head of [...inserts.keys()].sort((a, b) => b - a)) {
    const blockLines = inserts.get(head);
    if (blockLines !== undefined) lines.splice(head + 1, 0, ...blockLines);
  }
  return { text: lines.join("\n"), candidates: [...candidates] };
}

/** 발췌의 두름(줄) — 적중 줄 위아래로. */
const EXCERPT_RADIUS_LINES = 30;
/** 발췌의 글자 상한 — 턴 하나가 후보 때문에 부풀지 않게. */
const EXCERPT_MAX_CHARS = 6_000;
/** 발췌를 얹을 최소 점수 — testid(4) · 첫 컴포넌트 정의(3) 만. */
const EXCERPT_MIN_SCORE = 3;

/** 발췌의 재료 — 줄 범위와 코드. 핀 블록(excerptLines)과 browser_inspect 의
 *  보강(enrichIdentity)이 같은 판정을 쓰는 자리다. */
function excerptRange(content: string, at: number): { from: number; to: number; code: string } {
  if (at < 0) at = 0;
  const lines = content.split("\n");
  const line = content.slice(0, at).split("\n").length; // 1-based
  const from = Math.max(1, line - EXCERPT_RADIUS_LINES);
  const to = Math.min(lines.length, line + EXCERPT_RADIUS_LINES);
  let code = lines.slice(from - 1, to).join("\n");
  if (code.length > EXCERPT_MAX_CHARS) code = code.slice(0, EXCERPT_MAX_CHARS);
  return { from, to, code };
}

/** 적중 자리 주변의 코드 — 블록 안쪽의 세 칸 들여쓰기를 유지한다. 핀 턴과
 *  browser_inspect 보강이 같은 발췌를 쓰므로 export 한다(PLAN-MCP §3.E-1). */
export function excerptLines(file: string, content: string, at: number): string[] {
  const range = excerptRange(content, at);
  return [
    `   파일 발췌 ${file} ${range.from}-${range.to}줄:`,
    ...range.code.split("\n").map((codeLine) => `   ${codeLine}`),
  ];
}

/** browser_inspect 의 파일 보강 결과 — 후보와 발췌, 관찰 출처 여부. */
export interface IdentityFiles {
  /** 레포 루트 상대 경로, 정확도 순(상한 3). */
  candidates: string[];
  /** 후보가 관찰 지도(screen-map)에서 왔는가 — 핀 턴의 `(관찰)` 표식과 같은 말이다. */
  observed: boolean;
  /** 첫 정확한 적중(점수 3 이상)의 발췌 — 머리줄이 만들어지는 재료. */
  excerpt?: { file: string; from: number; to: number; code: string };
}

/**
 * browser_inspect 의 정체 보강 (PLAN-MCP §3.E-1): enrichCommentsTurn 과 같은
 * 순서 · 같은 기준으로 클론을 훑는다 — 정체(testid·owners·글자)로
 * huntPinFiles 를 돌려 후보(상한 3)를, 첫 정확한 적중(점수 3 이상)이면
 * 발췌를 얹는다. 정체가 빈손이면 핀 턴처럼 관찰 지도의 마지막 길을 얻는다.
 * 요소 하나를 조사하는 자리라 블록 조립은 없고 재료만 돌려준다 — 문장을
 * 만드는 것은 renderIdentity(browser-snapshot)다.
 */
export async function enrichIdentity(
  root: string,
  hint: SessionPinHint,
  observed?: { projectRoot: string } | null,
): Promise<IdentityFiles> {
  const found = await huntPinFiles(root, [hint]);
  const hits = found.get(hint.id) ?? [];
  if (hits.length > 0) {
    const files: IdentityFiles = { candidates: hits.map((hit) => hit.file), observed: false };
    const top = hits[0];
    if (top !== undefined && top.score >= EXCERPT_MIN_SCORE) {
      const content = await readCodeFile(root, top.file, join(root, top.file));
      if (content !== null) {
        files.excerpt = { file: top.file, ...excerptRange(content, top.at) };
      }
    }
    return files;
  }
  if (observed && hint.screen !== undefined) {
    const files = await observedFilesFor(observed.projectRoot, root, hint.screen).catch(
      () => [] as string[],
    );
    if (files.length > 0) return { candidates: files, observed: true };
  }
  return { candidates: [], observed: false };
}
