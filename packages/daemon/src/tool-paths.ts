/**
 * 편집 도구 입력 → 파일 경로 (2026-09-22): 세 프로바이더의 도구 모양이
 * 제각각이라, 통계(pinHit)가 경로를 뽑으려면 모양표가 필요하다. 코어에
 * 산다 — 드라이버를 import 하면 코어→드라이버의 계층 위반이다.
 *
 * 아는 키만 뽑는다: Claude SDK 의 Edit·Write·MultiEdit·NotebookEdit 는
 * `file_path`·`notebook_path`·`path`, Codex 의 fileChange 는 `changes[].path`,
 * omp 의 edit·write·ast_edit·notebook_edit 는 `path`·`file`·`file_path` 와
 * 여러 파일의 `paths[]`(omp 분류기의 editPaths 와 같은 모양, 2026-09-23 —
 * 이 키들을 몰라 omp 핀 턴의 적중이 늘 null 이었다). 못 찾으면 빈 배열 —
 * 없는 사실을 지어내지 않는다.
 */
const PATH_KEYS: readonly string[] = ["file_path", "notebook_path", "path", "file"];

export function editPathsOf(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];
  const record = input as Record<string, unknown>;
  const paths: string[] = [];
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) paths.push(value);
  }
  const many = record.paths;
  if (Array.isArray(many)) {
    for (const value of many) if (typeof value === "string" && value.length > 0) paths.push(value);
  }
  const changes = record.changes;
  if (Array.isArray(changes)) {
    for (const change of changes) {
      if (typeof change !== "object" || change === null) continue;
      const path = (change as Record<string, unknown>).path;
      if (typeof path === "string" && path.length > 0) paths.push(path);
    }
  }
  return paths;
}
