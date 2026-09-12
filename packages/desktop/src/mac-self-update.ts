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
  const filename = `colo-design-${input.version}.zip`;
  return {
    zipUrl: input.url,
    expectedSha256: input.sha256,
    downloadPath: join(input.downloadsDir, filename),
    targetApp: input.targetApp ?? "/Applications/Colo Design.app",
    steps: [
      `${filename} 내려받기`,
      "sha256 검증",
      "앱 종료",
      "/Applications/Colo Design.app 교체",
      "다시 실행",
    ],
  };
}

/** bash 큰따옴표 없이 안전하게 — 경로에 공백(`Colo Design.app`)이 흔하다. */
function sh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** 결과 JSON 한 줄 — 스크립트가 그대로 파일에 찍는다(이유는 고정 문구라 escaping 이 필요 없다). */
function resultLine(input: {
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

/**
 * 교체 스크립트: 앱 종료를 기다렸다가(최대 30초) zip 을 풀고 기존 번들을
 * 백업으로 치운 뒤 새 번들을 자리에 놓고 다시 연다. 새 번들의 이동이
 * 실패하면 백업을 되돌리고 이전 앱을 다시 띄워 앱 부재 상태로 끝나지
 * 않게 한다(sha256 은 zip 무결성만 증명한다 — 디스크 만석이나 권한은
 * 여기서 실패한다). 모든 출력은 로그 파일로 — 실패해도 흔적이 남는다.
 * 종료 직전엔 결과 파일(resultPath)에 한 줄을 남긴다 — 다음 실행이 이를
 * 사용자에게 보고한다. main.ts 가 detached 로 띄우고 곧바로 종료한다.
 */
export function buildSwapScript(input: {
  plan: SelfUpdatePlan;
  pid: number;
  logPath: string;
  resultPath: string;
  version: string;
}): string {
  const { plan, pid, logPath, resultPath, version } = input;
  const target = sh(plan.targetApp);
  const doneResult = resultLine({ outcome: "done", version, logPath });
  const failResult = (reason: string) =>
    resultLine({ outcome: "failed", version, reason, logPath });
  return `#!/bin/bash
# Colo Design 자가 교체 — 종료 대기 → zip 풀기 → 백업 교체 → 재실행.
exec >> ${sh(logPath)} 2>&1
RESULT=${sh(resultPath)}
write_result() { /usr/bin/printf '%s\\n' "$1" > "$RESULT"; }
fail() { write_result "$2"; echo "$1"; exit 1; }
echo "swap start $(date '+%F %T') pid=${pid}"
for _ in $(seq 1 150); do
  kill -0 ${pid} 2>/dev/null || break
  sleep 0.2
done
if kill -0 ${pid} 2>/dev/null; then
  fail "앱이 끝나지 않아 교체를 포기합니다" ${sh(failResult("앱이 끝나지 않아 교체를 포기했습니다"))}
fi
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
/usr/bin/ditto -x -k ${sh(plan.downloadPath)} "$STAGE" || fail "zip 풀기 실패" ${sh(failResult("내려받은 zip 을 풀지 못했습니다"))}
SRC="$(/usr/bin/find "$STAGE" -maxdepth 1 -name '*.app' | /usr/bin/head -n 1)"
if [ -z "$SRC" ]; then
  fail "zip 안에 .app 이 없습니다" ${sh(failResult("내려받은 zip 안에 앱이 없습니다"))}
fi
TARGET=${target}
BACKUP="$(dirname "$TARGET")/.$(basename "$TARGET").swap-backup"
rm -rf "$BACKUP"
mv "$TARGET" "$BACKUP" || fail "기존 앱을 백업으로 치우지 못했습니다" ${sh(failResult("기존 앱을 치우지 못했습니다 — 설치 위치의 권한을 확인해 주세요"))}
if mv "$SRC" "$TARGET"; then
  echo "새 앱이 자리를 잡았습니다"
else
  echo "새 앱을 자리에 놓지 못했습니다 — 이전 앱을 되돌립니다"
  if mv "$BACKUP" "$TARGET"; then
    echo "이전 앱을 복원했습니다"
  else
    echo "복원 실패 — $BACKUP 을 직접 확인해 주세요"
  fi
  write_result ${sh(failResult("새 앱 배치에 실패해 이전 버전으로 되돌렸습니다"))}
  /usr/bin/open "$TARGET" || echo "이전 앱 실행에도 실패했습니다 — 직접 열어 주세요"
  exit 1
fi
write_result ${sh(doneResult)}
if /usr/bin/open "$TARGET"; then
  echo "새 앱이 살아났습니다"
else
  echo "새 앱 실행에 실패했습니다 — 직접 열어 주세요"
fi
rm -rf "$BACKUP"
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

/** statfs 의 최소 모양 — Node 의 StatsFs 와 구조가 같다(주입 테스트 용도). */
export interface SpaceSnapshot {
  /** 블록 하나의 바이트 수. */
  bsize: number;
  /** 일반 사용자가 쓸 수 있는 블록 수. */
  bavail: number;
}

/**
 * 내려받기 직전의 디스크 여유 검사: zip(~200MB) + 풀린 번들 + 백업 사본까지
 * 합친 상한을 남겨 둔다 — 만석은 sha256 이 잡지 못하고 교체 단계에서 뒤늦게
 * 터진다. statfs 는 주입받는다(단위 테스트는 가짜 숫자로).
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
