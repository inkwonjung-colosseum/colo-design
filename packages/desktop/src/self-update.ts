import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, join } from "node:path";

/**
 * 자가 교체의 플랫폼 공통부: 계획 · sha256 검증 · 디스크 여유 ·
 * 결과 파일의 모양. 실제 교체 스크립트는 플랫폼마다 다르다 —
 * `mac-self-update.ts`(bash) · `win-self-update.ts`(PowerShell).
 *
 * 앱이 스스로 갈아입는 이유는 하나다: 이 배포는 미서명이고(사내 배포, 공증
 * 없음) electron-updater 는 미서명 앱을 갱신하지 못한다 — mac 은
 * Squirrel.Mac 이 서명을 요구하고, Windows 는 서명 없는 차분 패치를 신뢰할
 * 수 없다. 그래서 앱이 직접 — 에셋 다운로드 → sha256 검증 → 종료 →
 * 교체(mac 은 번들 치환, Windows 는 NSIS 설치 프로그램 무인 실행) → 재실행 —
 * 을 수행한다. 앱이 내려받은 파일엔 mac 에서 quarantine 이 붙지 않아
 * Gatekeeper 재승인도 없다.
 *
 * 이 모듈은 순수 로직만 갖고 실제 실행은 패키징된 앱 안에서만 이른다(guarded
 * in main.ts). 단위 테스트는 계획·검증·스크립트 조립을 돌린다.
 */

/**
 * 교체 스크립트가 종료 직전에 남기는 결과 — 스크립트는 앱이 죽은 뒤에 돌기
 * 때문에 성공·실패를 말할 창이 없다. 다음 실행이 이 파일을 읽어 사용자에게
 * 대신 말하고 지운다(main.ts reportSwapResult).
 */
export interface SwapResult {
  outcome: "done" | "failed";
  version: string;
  /** 실패 이유(사람이 읽는 한 줄). 성공이면 없다. */
  reason?: string;
  /** 교체 로그 — 실패 알림을 클릭하면 열리는 파일. */
  logPath: string;
}

/** 결과 파일 내용을 파싱한다 — 못 미더우면 null, 보고하지 않고 지운 쪽이 낫다. */
export function parseSwapResult(raw: string): SwapResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.outcome !== "done" && record.outcome !== "failed") return null;
  if (typeof record.version !== "string" || typeof record.logPath !== "string") return null;
  return {
    outcome: record.outcome,
    version: record.version,
    reason: typeof record.reason === "string" ? record.reason : undefined,
    logPath: record.logPath,
  };
}

export interface SelfUpdatePlan {
  assetUrl: string;
  expectedSha256: string;
  /** 다운로드가 저장될 경로. */
  downloadPath: string;
  /** 교체 대상 — mac 은 앱 번들, Windows 는 지금 도는 exe 의 경로. */
  target: string;
  /** 종료 직전까지 실행될 단계 목록(사람에게 보여도 되는 요약). */
  steps: string[];
}

/**
 * 교체 계획: 다운로드 → 검증 → 앱 종료 → 교체 → 재실행. 무엇을 내려받아
 * 무엇을 바꾸는지가 플랫폼마다 다르므로 platform 을 받아 갈라진다 — mac 은
 * zip 과 앱 번들, Windows 는 NSIS 설치 파일과 지금 도는 exe.
 * target 은 실행 순간의 경로로 다시 계획할 수 있게 파라미터로 받는다.
 */
export function planSelfUpdate(input: {
  url: string;
  sha256: string;
  downloadsDir: string;
  version: string;
  platform: NodeJS.Platform;
  target?: string;
}): SelfUpdatePlan {
  if (input.platform === "darwin") {
    const filename = `colo-design-${input.version}.zip`;
    return {
      assetUrl: input.url,
      expectedSha256: input.sha256,
      downloadPath: join(input.downloadsDir, filename),
      target: input.target ?? "/Applications/Colo Design.app",
      steps: [
        `${filename} 내려받기`,
        "sha256 검증",
        "앱 종료",
        "/Applications/Colo Design.app 교체",
        "다시 실행",
      ],
    };
  }
  if (input.platform === "win32") {
    // Windows 의 교체 대상은 "지금 도는 exe" 뿐이다 — 설치 위치는 레지스트리가
    // 들고 있고 기본값을 추측하면 엉뚱한 자리를 다시 띄운다. 그래서 필수다.
    if (!input.target) {
      throw new Error("Windows 자가 교체에는 교체 대상 실행 파일의 경로가 필요합니다");
    }
    const filename = `colo-design-Setup-${input.version}.exe`;
    return {
      assetUrl: input.url,
      expectedSha256: input.sha256,
      downloadPath: join(input.downloadsDir, filename),
      target: input.target,
      steps: [
        `${filename} 내려받기`,
        "sha256 검증",
        "앱 종료",
        "설치 프로그램 실행(무인)",
        "다시 실행",
      ],
    };
  }
  throw new Error(`이 운영체제(${input.platform})에서는 자가 교체를 지원하지 않습니다`);
}

/** 결과 JSON 한 줄 — 스크립트가 그대로 파일에 찍는다(이유는 고정 문구라 escaping 이 필요 없다). */
export function resultLine(input: {
  outcome: "done" | "failed";
  version: string;
  reason?: string;
  logPath: string;
}): string {
  return JSON.stringify({
    outcome: input.outcome,
    version: input.version,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    logPath: input.logPath,
  });
}

/** 파일의 sha256 을 스트림으로 계산한다(큰 zip 도 메모리에 올리지 않는다). */
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", () => resolve());
    stream.once("error", reject);
  });
  return hash.digest("hex");
}

/** 검증: 실패하면 한국어 오류와 함께 교체를 진행하지 않는다. */
export async function verifyDownload(path: string, expectedSha256: string): Promise<boolean> {
  const actual = await sha256OfFile(path);
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(
      `내려받은 파일의 무결성 검증에 실패했습니다 (${basename(path)}) — 릴리스를 다시 확인해 주세요.`,
    );
  }
  return true;
}

/** statfs 의 최소 모양 — Node 의 StatsFs 와 구조가 같다(주입 테스트 용도). */
export interface SpaceSnapshot {
  /** 블록 하나의 바이트 수. */
  bsize: number;
  /** 일반 사용자가 쓸 수 있는 블록 수. */
  bavail: number;
}

/**
 * 내려받기 직전의 디스크 여유 검사: 에셋(~200MB) + 풀린 번들·설치본 + 백업
 * 사본까지 합친 상한을 남겨 둔다 — 만석은 sha256 이 잡지 못하고 교체 단계에서
 * 뒤늦게 터진다. statfs 는 주입받는다(단위 테스트는 가짜 숫자로).
 */
export async function requireDiskSpace(input: {
  path: string;
  minBytes: number;
  statfs: (path: string) => Promise<SpaceSnapshot>;
}): Promise<void> {
  const snapshot = await input.statfs(input.path);
  const freeBytes = snapshot.bsize * snapshot.bavail;
  if (freeBytes < input.minBytes) {
    throw new Error(
      `디스크 공간이 부족합니다 — 업데이트에는 최소 ${Math.round(
        input.minBytes / 1024 ** 3,
      )}GB 의 여유가 필요합니다. (${input.path})`,
    );
  }
}
