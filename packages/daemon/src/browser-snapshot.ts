/**
 * 스냅샷 한 줄 표기와 액션 요약 (PLAN-MCP §3.C, M-2 · M-3) — 순수 함수만
 * 담는다. Electron 도 와이어도 모르는 이 모듈의 소비자는 server.ts(렌더 ·
 * 요약 · 찾기)와 test/browser-snapshot.test.ts 둘뿐이다.
 *
 * 왜 한 줄 표기인가: 옛 답은 노드마다 `"states":[]` · `"children":[]` 가 붙는
 * JSON 트리라 액션 하나에 화면 전체를 다시 실었다 — 브라우저 호출이 많은 턴일수록
 * 컨텍스트와 시간이 함께 커졌다(§1.1). 같은 사실을 줄당 하나의 요소로 말하는
 * 것이 이 표기의 전부다. 드라이버 계약은 그대로 두고(트리를 그대로 돌려주고)
 * 압축은 이 자리에서만 한다.
 */
import type { ColoDesignCommentTarget } from "@colo-design/protocol";
import type { IdentityFiles } from "./pin-files.js";
import type { PreviewAxNode } from "./preview-driver.js";

/** 한 번의 스냅샷이 모델에게 보이는 기본 상한 — 이 크기가 곧 토큰 예산이다. */
export const SNAPSHOT_MAX_LINES = 400;
/** 요소 이름의 상한 — 긴 문단 이름 한 줄이 예산을 새는 일을 막는다. */
export const SNAPSHOT_NAME_LIMIT = 80;
/** 액션 요약의 바뀐 줄 상한 — 요약은 차이의 첫 장이지 전체가 아니다. */
export const SUMMARY_MAX_LINES = 20;
/** browser_find 의 기본 · 최대 줄 수 — 찾기는 좁히는 수단이므로 스냅샷보다 훨씬 작다. */
export const FIND_DEFAULT_LIMIT = 10;
export const FIND_MAX_LIMIT = 30;

/** 렌더 선택 — `ref` 는 그 노드의 부분 트리만 그리라고 하는 좁히기다. */
export interface SnapshotOptions {
  ref?: string;
  maxLines?: number;
}

/** 렌더 결과 — `lines` 는 `text` 와 항상 같은 내용이다. */
export interface SnapshotRender {
  text: string;
  lines: string[];
  truncated: boolean;
  /**
   * 잘리기 전의 온전한 줄 — 세션의 "마지막 렌더" 기억은 이것을 쓴다. 모델이
   * 본 것(잘린 `lines`)과 기억(전체)이 갈라지면 다음 액션 요약이 잘린 부분을
   * 통째로 "+" 로 세는 노이즈가 된다.
   */
  fullLines: string[];
}

/** 요약의 재료 — 주소 · 제목은 드라이버 액션 답이, 포커스는 스냅샷에서 뽑는다. */
export interface SummaryOptions {
  url: string;
  title: string;
  focus?: string | null;
  /**
   * navigate 의 정착 — false 일 때만 요약이 그 사실을 말한다. 정착 실패는
   * 오류가 아니라 사실이므로 요약의 한 줄로 내려가고, 다른 액션은 넘기지
   * 않는다(드라이버가 그 값을 알지 못한다).
   */
  settled?: boolean;
}

export interface ActionSummary {
  text: string;
  lines: string[];
}

export interface FindQuery {
  text?: string;
  role?: string;
  limit?: number;
}

export interface FindRender {
  text: string;
  lines: string[];
}

/** 한 줄의 내용과, 그 줄(또는 가장 가까운 조상)의 ref — 잘렸을 때 이어 읽을 곳. */
interface LineEntry {
  text: string;
  ref: string;
}

/** 이름의 인용 — 속의 따옴표와 역슬래시를 감춰 줄 구조가 깨지지 않게 한다. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 노드 한 줄 표기 — `role "이름" ref = "값" [상태, …]`. 빈 조각은 생략된다. */
export function renderNodeLine(node: PreviewAxNode): string {
  const name = node.name.slice(0, SNAPSHOT_NAME_LIMIT);
  const value = node.value === undefined ? "" : ` = ${quote(node.value)}`;
  const states = node.states.length > 0 ? ` [${node.states.join(", ")}]` : "";
  return (
    `${node.role}` +
    `${name === "" ? "" : ` ${quote(name)}`}` +
    `${node.ref === "" ? "" : ` ${node.ref}`}` +
    `${value}` +
    `${states}`
  );
}

/**
 * 접는 규칙 — ref 도 이름도 없는 구조 노드(generic · none 따위)는 제 줄을
 * 생략하고 자식만 올린다. 들여쓰기 한 단을 아끼는 것이 접기의 전부다.
 */
function foldable(node: PreviewAxNode): boolean {
  return node.ref === "" && node.name === "";
}

function collectLines(
  nodes: PreviewAxNode[],
  depth: number,
  inherited: string,
  out: LineEntry[],
): void {
  for (const node of nodes) {
    if (foldable(node)) {
      collectLines(node.children, depth, inherited, out);
      continue;
    }
    const ref = node.ref !== "" ? node.ref : inherited;
    out.push({ text: `${"  ".repeat(depth)}${renderNodeLine(node)}`, ref });
    collectLines(node.children, depth + 1, ref, out);
  }
}

/**
 * ref 가 가리키는 노드의 부분 트리 — 드라이버의 ref 는 그 세대의 스냅샷에
 * 묶여 있으므로, 데몬이 지금 세대의 결과에서 그 노드를 찾아 자르는 것으로
 * 충분하다(드라이버 계약 변경 없음).
 */
function subtreeAtRef(nodes: PreviewAxNode[], ref: string): PreviewAxNode[] | null {
  for (const node of nodes) {
    if (node.ref === ref) return [node];
    const found = subtreeAtRef(node.children, ref);
    if (found !== null) return found;
  }
  return null;
}

/**
 * 접근성 트리를 한 줄 표기로 그린다. 상한을 넘으면 마지막 줄이 남은 줄 수와
 * 이어 읽는 방법(잘린 첫 줄의 가장 가까운 ref)을 말한다. `ref` 가 없는
 * 노드를 가리키면 드라이버의 낡은 ref 오류와 같은 문장으로 던진다 — 세대가
 * 갈렸다는 뜻이므로 다시 읽게 하는 것이 답이다.
 */
export function renderSnapshot(
  nodes: PreviewAxNode[],
  options: SnapshotOptions = {},
): SnapshotRender {
  let target = nodes;
  if (options.ref !== undefined) {
    const found = subtreeAtRef(nodes, options.ref);
    if (found === null) {
      throw new Error(
        `${options.ref} 는 지금 화면의 것이 아닙니다 — snapshot 으로 다시 읽으십시오.`,
      );
    }
    target = found;
  }
  const entries: LineEntry[] = [];
  collectLines(target, 0, "", entries);
  const fullLines = entries.map((entry) => entry.text);
  const maxLines = Math.max(0, options.maxLines ?? SNAPSHOT_MAX_LINES);
  if (fullLines.length <= maxLines) {
    return { text: fullLines.join("\n"), lines: fullLines, truncated: false, fullLines };
  }
  const remaining = fullLines.length - maxLines;
  // 이어 읽을 곳 — 잘린 첫 줄의 가장 가까운 ref (자신 또는 조상). 없으면
  // 부분 읽기를 좁힐 수 없으므로 전체 읽기로 안내한다.
  const nextRef = entries[maxLines]?.ref ?? "";
  const hint =
    nextRef === ""
      ? "browser_snapshot 으로 그 아래를 읽으십시오"
      : `browser_snapshot { ref: "${nextRef}" } 로 그 아래를 읽으십시오`;
  const lines = [...fullLines.slice(0, maxLines), `… ${remaining}개 더 — ${hint}`];
  return { text: lines.join("\n"), lines, truncated: true, fullLines };
}

/** 온전한 줄 목록 — 액션 요약의 before/after 재료. 잘리지 않는다. */
export function snapshotLines(nodes: PreviewAxNode[]): string[] {
  const entries: LineEntry[] = [];
  collectLines(nodes, 0, "", entries);
  return entries.map((entry) => entry.text);
}

/**
 * 포커스가 있는 노드의 한 줄 표기 — 없으면 null. 드라이버가 상태로 올리는
 * `focused`(AX_STATE_PROPERTIES) 하나로 안다. 포커스 줄은 요약의 둘째 줄에
 * 그대로 실려 "지금 어디에 쓰고 있었는지"를 말한다.
 */
export function focusLineOf(nodes: PreviewAxNode[]): string | null {
  for (const node of nodes) {
    if (node.states.includes("focused")) return renderNodeLine(node);
    const inner = focusLineOf(node.children);
    if (inner !== null) return inner;
  }
  return null;
}

/**
 * 액션의 답 — 주소 · 제목 · 포커스 · 바뀐 줄(집합 차, 상한 20). 차이는 줄의
 * 집합 차다: 같은 줄은 그대로이고, 온 줄은 `+`, 간 줄은 `−` 로 붙는다.
 * `before` 가 비면(세션의 첫 액션 · 데몬 재시작 뒤) 차이를 재지 않는다 —
 * 온 그림을 "+" 줄로 쏟는 것은 요약이 아니므로(§6 O-5). 대신 마지막 줄이
 * 전체 읽기의 길을 알린다.
 */
export function summarizeAction(
  before: string[],
  after: string[],
  options: SummaryOptions,
): ActionSummary {
  const lines: string[] = [`${options.title} · ${options.url}`];
  if (options.settled === false) {
    lines.push("화면이 끝까지 로드되지 않았습니다 — browser_wait 로 기다리거나 다시 읽으십시오");
  }
  if (options.focus !== null && options.focus !== undefined && options.focus !== "") {
    lines.push(`포커스: ${options.focus}`);
  }
  if (before.length > 0) {
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const added = after.filter((line) => !beforeSet.has(line));
    const removed = before.filter((line) => !afterSet.has(line));
    lines.push(`바뀐 줄: +${added.length} −${removed.length}`);
    const diff = [...added.map((line) => `+ ${line}`), ...removed.map((line) => `− ${line}`)];
    if (diff.length > SUMMARY_MAX_LINES) {
      lines.push(...diff.slice(0, SUMMARY_MAX_LINES));
      lines.push("… 더 바뀜 — browser_snapshot 으로 읽으십시오");
    } else {
      lines.push(...diff);
    }
  } else {
    lines.push("화면 전체는 browser_snapshot 으로 읽으십시오");
  }
  return { text: lines.join("\n"), lines };
}

/**
 * 스냅샷 읽기가 세션의 차이 기준을 갈아야 하는가 — 부분 트리(`ref`)는 페이지
 * 전체가 아니므로 기준이 될 수 없다: 갈아 두면 다음 액션이 부분 트리 밖의
 * 온 페이지를 "+" 로 센다. `maxLines` 는 fullLines 가 온전하므로 상관 없다.
 */
export function isWholeSnapshot(params: { ref?: unknown }): boolean {
  return params.ref === undefined;
}

/**
 * 스냅샷에서 조건에 맞는 줄만 찾는다 — 이름의 부분 일치와 역할의 일치(둘 다
 * 대소문자 무시, 둘 다 주어지면 둘 다). 접힌 노드는 스냅샷에 보이지 않으므로
 * 찾기에도 내놓지 않는다. 빈손이면 오류가 아니라 안내 한 줄.
 */
export function findInSnapshot(nodes: PreviewAxNode[], query: FindQuery): FindRender {
  const needle = query.text?.trim().toLowerCase() ?? "";
  const role = query.role?.trim().toLowerCase() ?? "";
  if (needle === "" && role === "") {
    const text = "찾을 조건이 없습니다 — text 나 role 을 하나 이상 주십시오.";
    return { text, lines: [text] };
  }
  const rawLimit = query.limit ?? FIND_DEFAULT_LIMIT;
  const limit = Math.min(
    FIND_MAX_LIMIT,
    Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : FIND_DEFAULT_LIMIT),
  );
  const matches: string[] = [];
  const walk = (items: PreviewAxNode[], depth: number): void => {
    for (const node of items) {
      if (foldable(node)) {
        walk(node.children, depth);
        continue;
      }
      const nameHit = needle === "" || node.name.toLowerCase().includes(needle);
      const roleHit = role === "" || node.role.toLowerCase() === role;
      if (nameHit && roleHit) {
        matches.push(`${"  ".repeat(depth)}${renderNodeLine(node)}`);
      }
      walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  if (matches.length === 0) {
    const text = "맞는 요소가 없습니다 — browser_snapshot 으로 화면을 읽으십시오.";
    return { text, lines: [text] };
  }
  if (matches.length > limit) {
    const lines = [
      ...matches.slice(0, limit),
      `… ${matches.length - limit}개 더 — 조건을 좁혀 다시 찾으십시오`,
    ];
    return { text: lines.join("\n"), lines };
  }
  return { text: matches.join("\n"), lines: matches };
}

// ---------------------------------------------------------------------------
// browser_inspect 의 답 (PLAN-MCP §3.E-1) — 핀 블록이 정체를 사람 말로 적던
// 모양(web 의 preview-turns)을 도구 결과 한 장으로 옮긴다. 없는 칸은 줄째
// 빠지고 긴 값은 자른다 — 이 답의 독자는 모델이다.
// ---------------------------------------------------------------------------

/** 이름 · testid 의 상한 — 핀의 ownText(80) 와 같은 결. */
export const IDENTITY_NAME_LIMIT = 80;
/** CSS 경로의 상한 — 깊은 중첩이 한 줄을 잡아먹지 않게. */
export const IDENTITY_PATH_LIMIT = 160;

/** 긴 값 자르기 — 잘렸으면 말줄임표를 단다. */
function identityCap(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * 요소 정체 한 장 — 요소 · testid·경로 · 글자 · 파일 후보 · 발췌 · 스타일 의
 * 줄 단위 표기. 파일 칸은 enrichIdentity(pin-files) 가 채운 재료고, 요소 칸은
 * 핀 봉투의 element(ColoDesignCommentTarget) 그대로다 — 드라이버와 핀이 같은
 * 판정을 냈으므로 여기서 다시 해석하지 않는다.
 */
export function renderIdentity(element: ColoDesignCommentTarget, files: IdentityFiles): string {
  const lines: string[] = [];
  const role = element.a11y?.role ?? element.component;
  const name = element.a11y?.name ?? element.text;
  const head = name === "" ? role : `${role} ${quote(identityCap(name, IDENTITY_NAME_LIMIT))}`;
  const owners = element.owners ?? [];
  lines.push(`요소: ${head}${owners.length > 0 ? `  (컴포넌트: ${owners.join(" › ")})` : ""}`);
  const facts: string[] = [];
  if (element.attrs?.testId) {
    facts.push(`testid: ${identityCap(element.attrs.testId, IDENTITY_NAME_LIMIT)}`);
  }
  if (element.path !== "") facts.push(`경로: ${identityCap(element.path, IDENTITY_PATH_LIMIT)}`);
  if (facts.length > 0) lines.push(facts.join(" · "));
  if (element.text !== "") lines.push(`글자: ${element.text}`);
  if (files.candidates.length > 0) {
    lines.push(
      `파일 후보: ${files.candidates.map((file) => identityCap(file, IDENTITY_PATH_LIMIT)).join(" · ")}${
        files.observed ? " (관찰)" : ""
      }`,
    );
  }
  if (files.excerpt) {
    lines.push(`파일 발췌 ${files.excerpt.file} ${files.excerpt.from}-${files.excerpt.to}줄:`);
    for (const codeLine of files.excerpt.code.split("\n")) lines.push(`  ${codeLine}`);
  }
  // 스타일은 색 · 배경 · 글꼴 몇 칸만 — 봉투의 부분(열두 칸) 중 앞 여섯 칸이다.
  const styleRows = Object.entries(element.styles ?? {})
    .slice(0, 6)
    .map(([key, value]) => `${key} ${identityCap(value, 60)}`);
  if (styleRows.length > 0) lines.push(`스타일: ${styleRows.join(" · ")}`);
  return lines.join("\n");
}
