/**
 * 버전 문자열 비교 (PLAN-UI U12) — 순수 함수. 에이전트 CLI 가 내는 버전은
 * 모양이 제각각이다: `2.1.4 (Claude Code)` · `codex-cli 0.46.0` · 릴리스 태그
 * `rust-v0.46.0` · `v1.2.0-beta.1`. 글 속의 첫 `숫자(.숫자)*(-꼬리)?` 를
 * 버전으로 읽고, semver 의 순서를 따른다 — 꼬리(프리릴리스)가 있는 쪽이 같은
 * 본판보다 앞선다.
 */

export interface ParsedVersion {
  numbers: number[];
  prerelease: string[];
}

/** 글 속의 첫 버전을 읽는다 — 없으면 null. `+빌드` 꼬리는 순서에 쓰지 않는다. */
export function parseVersion(text: string | null | undefined): ParsedVersion | null {
  if (!text) return null;
  const match = /(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(text);
  if (!match?.[1]) return null;
  return {
    numbers: match[1].split(".").map((part) => Number(part)),
    prerelease: match[2] ? match[2].split(".") : [],
  };
}

/** 본판만 — `2.1.4 (Claude Code)` → `2.1.4`. 읽지 못하면 null. */
export function plainVersion(text: string | null | undefined): string | null {
  const parsed = parseVersion(text);
  if (!parsed) return null;
  const core = parsed.numbers.join(".");
  return parsed.prerelease.length > 0 ? `${core}-${parsed.prerelease.join(".")}` : core;
}

/**
 * a 가 앞이면 음수, 같으면 0, 뒤면 양수. 읽을 수 없는 쪽은 가장 앞으로 친다
 * (둘 다 못 읽으면 0) — 「새 버전 있음」 이 헛된 글로 켜지지 않게.
 */
export function compareVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  // 본판이 같으면: 꼬리 없는 쪽이 뒤(정식판), 둘 다 있으면 조각별로.
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return Math.sign(right.prerelease.length - left.prerelease.length);
  }
  const tail = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < tail; index += 1) {
    const x = left.prerelease[index];
    const y = right.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return Math.sign(diff);
    } else if (xNumeric !== yNumeric) {
      // semver: 숫자 조각이 글자 조각보다 앞선다.
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** latest 가 current 보다 새것인가 — 어느 쪽이든 읽지 못하면 거짓. */
export function isNewerVersion(
  latest: string | null | undefined,
  current: string | null | undefined,
): boolean {
  if (!parseVersion(latest) || !parseVersion(current)) return false;
  return compareVersions(latest, current) > 0;
}
