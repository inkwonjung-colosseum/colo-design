/**
 * 화면 색인 (PLAN-HARNESS §3.B, H-3): 주소와 파일을 레포 구조에서 잇는다.
 * 파일 내용은 읽지 않는다 — 파일 목록은 code-files 의 collectCodeFiles 를
 * 그대로 쓰므로 건너뛰는 폴더 · 확장자 · 상한이 사냥과 같다.
 *
 * 쓰이는 곳은 셋(H-4): `screen_files` 의 `(주소)` 줄, 핀의 `파일 후보:` (주소 표식),
 * 게이트의 입력(바뀐 파일 → 화면). 어느 쪽이든 후보는 힌트지 답이 아니다.
 *
 * 게이트로 가는 길은 보수적이다(H-5): `routesForFiles` 가 내는 주소는 관찰
 * 지도(screen-map)의 행과 Next.js 의 고정 경로 page 파일뿐이다 — 파일 이름에서
 * 주소를 지어내지 않는다. 없는 주소를 열면 404 가 "문제"로 잡혀 AI 가 없는
 * 화면을 고치므로, 확실한 두 길만 쓴다. 관찰 지도의 길은 두 겹으로 거른다(F1):
 * 코드 파일만, 그리고 이어진 화면이 MAX_ROUTES_PER_FILE 를 넘지 않는 파일만 —
 * 한 파일이 여러 화면에 이어지면 어느 화면이 바뀌었는지 모른다.
 */
import { relative, sep } from "node:path";
import { collectCodeFiles, isCodeFile } from "./code-files.js";
import { MAX_GATE_SCREENS } from "./screen-gate.js";
import { LOOPBACK, normalizeRoute, type ScreenMapRow } from "./screen-map.js";

/** 주소 → 파일 후보. 없으면 null. files 는 레포 루트 상대 경로(슬래시). */
export async function filesForRoute(
  repoRoot: string,
  route: string,
  max?: number, // 기본 3
): Promise<{ files: string[]; source: "path" | "dynamic" } | null> {
  const cap = max ?? 3;
  const segments = routeSegments(route);
  const rels = (await collectCodeFiles(repoRoot)).map((file) =>
    relative(repoRoot, file).split(sep).join("/"),
  );
  if (segments.length === 0) {
    // 루트(`/` · `index`)는 정해진 네 자리 — 그 문이 곧 화면이다.
    const root = rels.filter(isRootPage).sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
    return root.length > 0 ? { files: root.slice(0, cap), source: "path" } : null;
  }
  const path = rankPathMatches(segments, rels);
  if (path.length > 0) return { files: path.slice(0, cap), source: "path" };
  const dynamic = dynamicMatch(segments, rels);
  return dynamic === null ? null : { files: [dynamic], source: "dynamic" };
}

/** 바뀐 파일 → 게이트가 열 화면 주소(경로 모양 `/a/b`). 순수 함수.
 *
 * ① 관찰 지도의 길은 두 겹으로 거른다(F1): 바꾼 파일이 코드 파일(isCodeFile)
 * 이어야 하고, 지도 전체에서 그 파일이 이어진 서로 다른 화면 수가
 * MAX_ROUTES_PER_FILE 이하여야 한다 — 레포의 모든 화면이 한 파일에 사는
 * 경우(fixture 의 server.js)나 생성 문서(api.gen.md)가 화면에 이어진 경우,
 * 이번 턴과 무관한 화면의 문제를 AI 에게 넘기지 않기 위해서다.
 * ② Next.js 의 고정 경로 page 파일은 이 거름과 무관하다. */
export function routesForFiles(changed: string[], rows: ScreenMapRow[]): string[] {
  const changedCode = new Set(changed.filter(isCodeFile));
  const out: string[] = [];
  const add = (route: string): void => {
    if (route === "" || out.includes(route)) return;
    out.push(route);
  };
  // 행이 가리킨 화면 — screens 가 먼저, 없으면 routes 를 normalizeRoute 로 편
  // 것. 세는 자리와 내는 자리가 같은 판정을 써야 하므로 한 곳에 둔다.
  const routesOfRow = (row: ScreenMapRow): string[] =>
    (row.screens?.map((screen) => screen.route) ?? row.routes)
      .map(normalizeRoute)
      .filter((route) => route !== "");
  // 공용 파일 거름 — 지도 전체에서 파일마다 이어진 화면 수를 센다. 주소는
  // normalizeRoute 로 편 모양으로(`notice/X` 와 `/notice/X` 는 하나) 센다.
  const routesOfFile = new Map<string, Set<string>>();
  for (const row of rows) {
    const routes = routesOfRow(row);
    if (routes.length === 0) continue;
    for (const file of row.files) {
      const set = routesOfFile.get(file) ?? new Set<string>();
      for (const route of routes) set.add(route);
      routesOfFile.set(file, set);
    }
  }
  const shared = new Set(
    [...routesOfFile]
      .filter(([, routes]) => routes.size > MAX_ROUTES_PER_FILE)
      .map(([file]) => file),
  );
  // ① 관찰 지도 — 최근 행부터. 바뀐 코드 파일이 하나라도 있으면 그 턴이
  // 가리킨 화면. 공용 파일은 건너뛴다.
  for (const row of [...rows].reverse()) {
    if (!row.files.some((file) => changedCode.has(file) && !shared.has(file))) continue;
    for (const route of routesOfRow(row)) add(route);
  }
  // ② Next.js 의 고정 경로 page 파일 — 동적 규칙으로 읽어 `[` 가 없는 패턴만.
  // 파일 이름에서 주소를 지어내는 것이 아니라, 라우터가 정한 문의 위치를 읽는 것이다.
  for (const file of changed) {
    const pattern = nextRoutePattern(file);
    if (pattern === null || pattern.some((seg) => seg.kind !== "fixed")) continue;
    add(`/${pattern.map((seg) => (seg.kind === "fixed" ? seg.raw : "")).join("/")}`);
  }
  return out.slice(0, MAX_GATE_SCREENS);
}

/** 한 파일이 이어질 수 있는 화면 수의 상한 — 한 파일이 여러 화면에 이어지면
 *  어느 화면이 바뀌었는지 모른다. 넘는 파일은 공용 파일로 건너뛴다. */
export const MAX_ROUTES_PER_FILE = 2;

/**
 * 주소의 조각들 — `/member/list` · `member/list` · `index`(= 루트) · 전체 주소
 * (루프백이면 경로만, 아니면 빈 결과) 를 받는다. `?` · `#` 뒤는 버리고 각 조각은
 * decodeURIComponent, 빈 조각은 버린다. 루프백 집합은 screen-map 과 같은 것이다.
 */
export function routeSegments(route: string): string[] {
  const noHash = route.split("#")[0] ?? "";
  const path = noHash.split("?")[0] ?? "";
  let body = path;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      if (!LOOPBACK.has(url.hostname)) return [];
      body = url.pathname;
    } catch {
      return [];
    }
  }
  // `index` 는 핀의 루트 화면 id — normalizeRoute 와 같은 취급로 루트와 같다.
  const trimmed = body.replace(/^\/+|\/+$/g, "");
  if (trimmed === "" || trimmed === "index") return [];
  const segments: string[] = [];
  for (const raw of trimmed.split("/")) {
    if (raw === "" || raw === ".") continue;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // 못 여는 조각은 인코딩 그대로 둔다.
    }
    if (decoded !== "") segments.push(decoded);
  }
  return segments;
}

/** 파일 조각 — 폴더들과, 확장자를 모두 벗긴 이름. */
export interface FileSegments {
  /** 레포 루트부터의 폴더들 — `page`·`index` 파일의 바로 위 폴더는 빠진다. */
  dirs: string[];
  /** 확장자를 모두 벗긴 이름(`MemberList.screen.tsx` → `MemberList`). */
  name: string;
}

/** 후보가 아닌 이름 조각 — `.test.` · `.spec.` · `.stories.` · `.d.ts` 의 `test` · `spec` · `stories` · `d`. */
const NON_CANDIDATE_PARTS: Record<string, true> = {
  test: true,
  spec: true,
  stories: true,
  d: true,
};

/**
 * 파일 경로의 조각. `.test.` · `.spec.` · `.stories.` · `.d.ts` 와 `__tests__`
 * 폴더 안의 파일은 null — 후보가 아니다. 이름이 `page` · `index` 면 이름은 바로
 * 위 폴더 이름이 되고 그 폴더는 dirs 에서 빠진다(`app/member/list/page.tsx` 는
 * dirs `app/member`, 이름 `list`).
 */
export function fileSegments(rel: string): FileSegments | null {
  const parts = rel.split("/");
  if (parts.includes("__tests__")) return null;
  const base = parts.pop() ?? "";
  const dotted = base.split(".");
  let name = dotted[0] ?? "";
  if (name === "" || dotted.length < 2) return null;
  for (const part of dotted.slice(1)) {
    if (NON_CANDIDATE_PARTS[part] === true) return null;
  }
  if ((name === "page" || name === "index") && parts.length > 0) {
    name = parts.pop() ?? name;
  }
  return { dirs: parts, name };
}

/** 비교 열쇠 — 소문자, `-` · `_` · 공백 제거. `member-list` = `MemberList`. */
export function segmentKey(s: string): string {
  return s.toLowerCase().replace(/[-_\s]/g, "");
}

/**
 * 주소 조각에 온전히 들어맞는 파일들 — 마지막 주소 조각의 열쇠가 파일 이름의
 * 열쇠와 같고, 나머지 주소 조각이 파일의 dirs 에 순서대로(부분열) 모두 나오는
 * 것. 정렬: 이름에 `.mock.` · `.data.` · `.fixture.` 가 없는 것 먼저 → 경로 짧은
 * 것 → 사전순.
 */
export function rankPathMatches(segments: string[], files: string[]): string[] {
  const last = segments[segments.length - 1];
  if (last === undefined) return [];
  const lastKey = segmentKey(last);
  const rest = segments.slice(0, -1);
  const matches: string[] = [];
  for (const file of files) {
    const segs = fileSegments(file);
    if (segs === null || segmentKey(segs.name) !== lastKey) continue;
    // 나머지 주소 조각이 dirs 의 순서 있는 부분열인가.
    const dirKeys = segs.dirs.map(segmentKey);
    let at = 0;
    let ok = true;
    for (const seg of rest) {
      const found = dirKeys.indexOf(segmentKey(seg), at);
      if (found < 0) {
        ok = false;
        break;
      }
      at = found + 1;
    }
    if (ok) matches.push(file);
  }
  return matches.sort(
    (a, b) =>
      Number(isDataFile(a)) - Number(isDataFile(b)) || a.length - b.length || (a < b ? -1 : 1),
  );
}

/** 루트(`/`)의 문 — `app/page.*` · `src/app/page.*` · `pages/index.*` · `src/pages/index.*`. */
function isRootPage(rel: string): boolean {
  if (fileSegments(rel) === null) return false;
  return /^(?:src\/)?(?:app\/page|pages\/index)\.[^/]+$/.test(rel);
}

/** 이름에 `.mock.` · `.data.` · `.fixture.` 가 있는 파일 — 후보로는 뒤로 간다. */
function isDataFile(rel: string): boolean {
  const dotted = rel.split("/").pop()?.split(".") ?? [];
  return dotted.slice(1).some((part) => part === "mock" || part === "data" || part === "fixture");
}

/** Next.js 동적 경로 패턴의 조각 하나. */
export type PatternSegment =
  | { kind: "fixed"; raw: string; key: string }
  | { kind: "one" } // [x] — 조각 하나
  | { kind: "many" } // [...x] — 하나 이상
  | { kind: "opt" }; // [[...x]] — 0개 이상

/**
 * 파일을 Next.js 페이지의 경로 패턴으로 읽는다 — `app|src/app` 아래 이름이
 * `page` 인 파일과 `pages|src/pages` 아래 파일(`api/` 폴더 · `_app` · `_document`
 * · `_error` 제외). 페이지 파일이 아니면 null. `(group)` 폴더는 없는 셈,
 * `@slot` · `_private` 폴더 안은 제외.
 */
export function nextRoutePattern(rel: string): PatternSegment[] | null {
  const parts = rel.split("/");
  const base = parts.pop() ?? "";
  const dotted = base.split(".");
  const stem = dotted[0] ?? "";
  if (stem === "" || dotted.length < 2) return null;
  // 시험 · 스토리 · 선언 파일은 문이 아니다 — fileSegments 와 같은 규칙.
  for (const part of dotted.slice(1)) {
    if (NON_CANDIDATE_PARTS[part] === true) return null;
  }
  const first = parts[0];
  let router: string;
  let dirs: string[];
  if (first === "src") {
    router = parts[1] ?? "";
    if (router !== "app" && router !== "pages") return null;
    dirs = parts.slice(2);
  } else if (first === "app" || first === "pages") {
    router = first;
    dirs = parts.slice(1);
  } else {
    return null;
  }
  if (router === "pages") {
    if (stem === "_app" || stem === "_document" || stem === "_error") return null;
    if (dirs.includes("api")) return null;
    // pages 라우터는 모든 파일이 문이다 — `index` 는 폴더 자체.
    if (stem !== "index") dirs = [...dirs, stem];
  } else if (stem !== "page") {
    // app 라우터는 `page` 파일이 문이다(route.ts 같은 이름붙은 문은 여기가 아니다).
    return null;
  }
  const out: PatternSegment[] = [];
  for (const dir of dirs) {
    if (dir.startsWith("@") || dir.startsWith("_")) return null;
    if (dir.startsWith("(") && dir.endsWith(")")) continue;
    if (dir.startsWith("[[...") && dir.endsWith("]]")) out.push({ kind: "opt" });
    else if (dir.startsWith("[...")) out.push({ kind: "many" });
    else if (dir.startsWith("[") && dir.endsWith("]")) out.push({ kind: "one" });
    else out.push({ kind: "fixed", raw: dir, key: segmentKey(dir) });
  }
  return out;
}

/** 패턴이 주소 조각에 들어맞는가 — 고정 조각은 열쇠로, 동적 조각은 칸수로. */
function patternMatches(pattern: PatternSegment[], segments: string[]): boolean {
  const walk = (p: number, s: number): boolean => {
    if (p >= pattern.length) return s >= segments.length;
    const seg = pattern[p];
    if (seg === undefined) return false;
    if (seg.kind === "fixed") {
      const cur = segments[s];
      return cur !== undefined && segmentKey(cur) === seg.key && walk(p + 1, s + 1);
    }
    if (seg.kind === "one") return s < segments.length && walk(p + 1, s + 1);
    const least = seg.kind === "many" ? 1 : 0; // opt 는 0개 이상
    for (let k = s + least; k <= segments.length; k++) {
      if (walk(p + 1, k)) return true;
    }
    return false;
  };
  return walk(0, 0);
}

/** 동적 경로의 보조 — 맞는 패턴 중 고정 조각이 가장 많은 파일 하나. 없으면 null. */
function dynamicMatch(segments: string[], files: string[]): string | null {
  let best: { file: string; fixed: number; total: number } | null = null;
  for (const file of files) {
    const pattern = nextRoutePattern(file);
    if (pattern === null || !patternMatches(pattern, segments)) continue;
    const fixed = pattern.filter((seg) => seg.kind === "fixed").length;
    const candidate = { file, fixed, total: pattern.length };
    if (
      best === null ||
      candidate.fixed > best.fixed ||
      (candidate.fixed === best.fixed &&
        (candidate.total < best.total ||
          (candidate.total === best.total && candidate.file < best.file)))
    ) {
      best = candidate;
    }
  }
  return best?.file ?? null;
}
