/**
 * 설치 진행기의 날 줄을 세 단계로 가린다 — 설치 프로그램이 내는 원문(영어 명령
 * 출력 · 바이트 수)은 화면에 내리지 않고, 지금 어느 걸음인지의 한국어 말만
 * 선다. 줄이 어느 단계인지 말할 수 없으면 null — 받는 쪽이 직전 단계를
 * 유지한다(설치 프로그램은 한 차례에 여러 줄을 쏟기도 한다).
 */

export type InstallStep = "download" | "install" | "verify";

/** 배열의 앞일수록 파이프라인의 뒤 걸음이다 — 한 줄에 여러 단계의 말이 섞이면 뒤 걸음을 택한다.
 *  한글의 말모이는 이스케이프로 적는다 — 문장 검사가 정규식 리터럴 안도 본다. */
const STEPS: ReadonlyArray<readonly [InstallStep, RegExp]> = [
  ["install", /install|unpack|extract|\uC124\uCE58/i],
  ["verify", /verif|digest|sha-?256|checksum|\uD655\uC778/i],
  ["download", /download|fetch|\uB0B4\uB824\uBC1B/i],
];

/** 한 줄의 단계 — 모르는 줄이면 null. */
export function classifyInstallLine(line: string): InstallStep | null {
  for (const [step, pattern] of STEPS) {
    if (pattern.test(line)) return step;
  }
  return null;
}

/** 줄이 옮겨올 때의 단계 — 모르는 줄은 직전 단계를 그대로 두고, 빈 줄은 처음부터. */
export function advanceInstallStep(
  prev: InstallStep | null,
  line: string | null | undefined,
): InstallStep | null {
  if (line === null || line === undefined || line.trim() === "") return null;
  return classifyInstallLine(line) ?? prev;
}
