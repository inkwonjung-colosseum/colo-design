import { resultLine, type SelfUpdatePlan } from "./self-update.js";

/**
 * macOS 자가 교체의 교체 스크립트(DESIGN §7): 앱이 죽은 뒤에 도는 bash 한 장.
 * 계획·검증·결과 모양은 플랫폼 공통부(`self-update.ts`)가 갖는다 — 이 파일에는
 * mac 이 번들을 갈아 치우는 방법만 있다.
 */

/** bash 큰따옴표 없이 안전하게 — 경로에 공백(`Colo Design.app`)이 흔하다. */
function sh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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
  const target = sh(plan.target);
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
