/**
 * 라우트↔파일 지도 (2026-09-22): 이 프로젝트에서 어떤 화면을 고친 커밋이
 * 어떤 파일을 건드렸는지의 관찰 기록. 핀의 정체(testid·owners)가 후보를
 * 못 찾았을 때의 마지막 길 — `파일 후보:` 의 `(관찰)` 표식이 이 파일에서
 * 온다. 어디까지나 관찰이다: 판단은 여전히 AI 가 한다.
 *
 * 행은 자동 저장이 성공한 커밋마다 한 줄 — sha 와 그 커밋이 건드린 파일,
 * 그리고 그 턴이 가리킨 화면들. 상한 500행: 턴 통계가 7일을 사는 것과 같은
 * 정신이다(무기한 자라는 사용자 데이터 파일은 만들지 않는다). comments.json
 * 이 프로젝트 폴더에 사는 전례를 따라 같은 폴더에 둔다.
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 지도 파일의 행 수 상한 — 넘으면 오래된 것부터 버린다. */
const MAX_ROWS = 500;
/** 한 핀이 관찰로 받는 후보 수 — huntPinFiles 의 MAX_CANDIDATES 와 같은 결. */
const MAX_OBSERVED = 3;

export interface ScreenMapRow {
  at: string;
  sha: string;
  routes: string[];
  files: string[];
  /**
   * 그 턴의 화면을 미리보기 안의 경로로 고른 것과 AI 가 링크에 붙인 제목
   * (PLAN-UI U2 — `이번 작업` 의 바뀐 화면). 제목을 모르면 빈 문자열이다.
   * routes 는 날것 그대로 둔다 — 핀의 관찰 후보가 그 값으로 찾는다. 옛 행에는 없다.
   */
  screens?: Array<{ route: string; title: string }>;
}

/** 지도 전부 — 오래된 행부터. 없거나 깨진 파일은 빈 목록이다. */
export function readScreenMap(projectRoot: string): Promise<ScreenMapRow[]> {
  return readRows(join(projectRoot, "screen-map.jsonl"));
}

function readRows(file: string): Promise<ScreenMapRow[]> {
  return readFile(file, "utf8").then(
    (text) =>
      text
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as ScreenMapRow)
        .filter(
          (row) =>
            typeof row?.sha === "string" && Array.isArray(row?.routes) && Array.isArray(row?.files),
        ),
    () => [] as ScreenMapRow[],
  );
}

/** 자동 저장이 성공한 커밋의 행 하나를 얹는다 — 실패는 조용하다(지도는 판정이 아니다). */
export async function appendScreenMap(projectRoot: string, row: ScreenMapRow): Promise<void> {
  const file = join(projectRoot, "screen-map.jsonl");
  const rows = await readRows(file);
  rows.push(row);
  const kept = rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows;
  await writeFile(file, `${kept.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

/**
 * 화면 하나를 고친 파일들 — 최근 커밋부터, 아직 클론에 있는 것만. 후보는
 * 상한 3개: 관찰은 힌트지 답이 아니다. 파일은 레포 루트 상대 경로다.
 */
export async function observedFilesFor(
  projectRoot: string,
  repoRoot: string,
  route: string,
): Promise<string[]> {
  const rows = await readRows(join(projectRoot, "screen-map.jsonl")).catch(() => []);
  const out: string[] = [];
  for (const row of rows.reverse()) {
    if (!row.routes.includes(route)) continue;
    for (const file of row.files) {
      if (out.includes(file)) continue;
      // 없는 파일은 후보가 아니다 — 지도가 옛 모습을 기억해도 클론은 앞으로 산다.
      try {
        await stat(join(repoRoot, file));
      } catch {
        continue;
      }
      out.push(file);
      if (out.length >= MAX_OBSERVED) return out;
    }
  }
  return out;
}
