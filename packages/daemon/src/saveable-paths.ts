/**
 * 보관이 담을 경로의 거름 — 콜드 리뷰 N1 (2026-09-25, PLAN-UI 9.3 D1).
 *
 * 락파일 없는 레포에서 미리보기 명령(`pnpm dev`)이 스스로 설치를 돌려
 * `pnpm-lock.yaml` · `node_modules/` 를 만들 수 있다(pnpm 11 의 run 앞 자동
 * 설치). 그 변경은 사용자가 만든 것이 아니므로 보관이 담으면 안 된다 —
 * 담는 순간 아무 것도 만들지 않은 사람의 트리에 기계의 커밋이 남는다.
 *
 * 규칙은 둘이다:
 * - `node_modules` 는 경로의 어느 마디든 있으면 뺀다(무시 규칙이 없는 레포에서
 *   도구의 설치가 남기는 것이다).
 * - 락파일은 레포가 **추적하지 않을 때만** 뺀다. 추적 중인 락파일의 변경은
 *   AI 가 의존성을 더한 정당한 편집이므로 담는다.
 */
import type { DiffFile } from "@colo-design/protocol";

/** 도구의 설치가 남길 수 있는 락파일 — 바닥글 이름으로 어느 깊이에서든. */
const LOCKFILE_BASENAMES: Record<string, true> = {
  "pnpm-lock.yaml": true,
  "package-lock.json": true,
  "yarn.lock": true,
  "bun.lock": true,
  "bun.lockb": true,
};

/**
 * 보관이 담을 변경만 골라 낸다. `tracked` 는 `git ls-files` 의 목록(레포가
 * 추적하는 경로 전부)이다. 순수 함수 — 디스크도 git 도 만지지 않는다.
 */
export function saveablePaths(files: DiffFile[], tracked: ReadonlySet<string>): DiffFile[] {
  return files.filter((file) => {
    const segments = file.path.split("/");
    if (segments.includes("node_modules")) return false;
    const base = segments[segments.length - 1] ?? "";
    if (LOCKFILE_BASENAMES[base] === true && !tracked.has(file.path)) return false;
    return true;
  });
}
