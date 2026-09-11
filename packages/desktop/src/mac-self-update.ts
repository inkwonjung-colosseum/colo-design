import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, join } from "node:path";

/**
 * macOS 자가 교체(DESIGN §7): electron-updater 는 미서명 앱을 갱신하지
 * 못하므로(Squirrel.Mac 제약) 앱이 직접 — zip 다운로드 → sha256 검증 →
 * 종료 시 번들 교체 → 재실행 — 을 수행한다. 앱이 내려받은 파일엔 quarantine
 * 이 붙지 않아 Gatekeeper 재승인이 없다.
 *
 * 이 모듈은 계획(plan)·검증(sha256)·교체 스크립트 조립만 갖고, 실제 실행은
 * 패키징된 앱 안에서만 이른다(guarded in main.ts). 단위 테스트는 계획·검증·
 * 스크립트 조립을 돌린다.
 */
export interface SelfUpdatePlan {
  zipUrl: string;
  expectedSha256: string;
  /** 다운로드가 저장될 경로. */
  downloadPath: string;
  /** 교체 대상 앱 번들. */
  targetApp: string;
  /** 종료 직전까지 실행될 단계 목록(사람에게 보여도 되는 요약). */
  steps: string[];
}

/**
 * 교체 계획: 다운로드 → 검증 → 앱 종료 → 번들 교체 → 재실행.
 * targetApp 은 실행 순간의 경로로 다시 계획할 수 있게 파라미터로 받는.
 */
export function planSelfUpdate(input: {
  url: string;
  sha256: string;
  downloadsDir: string;
  version: string;
  targetApp?: string;
}): SelfUpdatePlan {
  const filename = `cds-design-${input.version}.zip`;
  return {
    zipUrl: input.url,
    expectedSha256: input.sha256,
    downloadPath: join(input.downloadsDir, filename),
    targetApp: input.targetApp ?? "/Applications/CDS Design.app",
    steps: [
      `${filename} 내려받기`,
      "sha256 검증",
      "앱 종료",
      "/Applications/CDS Design.app 교체",
      "다시 실행",
    ],
  };
}

/** bash 큰따옴표 없이 안전하게 — 경로에 공백(`CDS Design.app`)이 흔하다. */
function sh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * 교체 스크립트: 앱 종료를 기다렸다가(최대 30초) zip 을 풀고 기존 번들을
 * 갈아입힌 뒤 다시 연다. 모든 출력은 로그 파일로 — 실패해도 흔적이 남는다.
 * main.ts 가 detached 로 띄우고 곧바로 종료한다.
 */
export function buildSwapScript(input: { plan: SelfUpdatePlan; pid: number; logPath: string }): string {
  const { plan, pid, logPath } = input;
  return `#!/bin/bash
# CDS Design 자가 교체 — 종료 대기 → zip 풀기 → 번들 교체 → 재실행.
exec >> ${sh(logPath)} 2>&1
echo "swap start $(date '+%F %T') pid=${pid}"
for _ in $(seq 1 150); do
  kill -0 ${pid} 2>/dev/null || break
  sleep 0.2
done
if kill -0 ${pid} 2>/dev/null; then
  echo "앱이 끝나지 않아 교체를 포기합니다"
  exit 1
fi
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
/usr/bin/ditto -x -k ${sh(plan.downloadPath)} "$STAGE" || { echo "zip 풀기 실패"; exit 1; }
SRC="$(/usr/bin/find "$STAGE" -maxdepth 1 -name '*.app' | /usr/bin/head -n 1)"
if [ -z "$SRC" ]; then
  echo "zip 안에 .app 이 없습니다"
  exit 1
fi
rm -rf ${sh(plan.targetApp)} || { echo "기존 앱 제거 실패"; exit 1; }
mv "$SRC" ${sh(plan.targetApp)} || { echo "새 앱을 자리에 놓지 못했습니다"; exit 1; }
/usr/bin/open ${sh(plan.targetApp)}
echo "swap done $(date '+%F %T')"
`;
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
