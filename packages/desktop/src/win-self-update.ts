import { resultLine, type SelfUpdatePlan } from "./self-update.js";

/**
 * Windows 자가 교체의 교체 스크립트(DESIGN §7): 앱이 죽은 뒤에 도는 PowerShell
 * 한 장. mac 처럼 파일을 손으로 갈아 치우지 않는다 — NSIS 설치 프로그램을 무인
 * (/S)으로 돌리는 것이 교체다. 설치 위치는 설치 프로그램이 레지스트리에서
 * 그대로 읽으므로 /D= 는 넘기지 않는다(셸을 통과하는 /D 의 따옴표 규칙은
 * 깨지기 쉽고, 사용자가 고른 설치 위치를 옮길 위험도 있다).
 *
 * 계획·검증·결과 모양은 플랫폼 공통부(`self-update.ts`)가 갖는다.
 */

/** PowerShell 리터럴로 안전하게 — 단일 인용, 내부의 ' 는 두 번 찍는다. */
function ps(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** 설치 프로그램의 종료 코드를 실행 시점에 끼워 넣는 자리 — JSON 은 미리 만든다. */
const EXIT_CODE_PLACEHOLDER = "__EXIT__";

/**
 * 교체 스크립트: 앱 종료를 기다렸다가(최대 30초) 설치 프로그램을 무인으로
 * 돌리고, 끝나기를 기다려 종료 코드를 확인한 뒤 다시 띄운다. 모든 출력은 로그
 * 파일로 붙고, 종료 직전엔 결과 파일(resultPath)에 한 줄을 남긴다 — 다음
 * 실행이 이를 사용자에게 보고한다. main.ts 가 detached 로 띄우고 곧바로
 * 종료한다.
 *
 * mac 스크립트에 있는 롤백이 여기엔 없다: 되돌릴 대상이 파일 한 벌이 아니라
 * 설치 프로그램의 작업 전체이고, 실패하면 이전 설치가 대개 그 자리에 남는다.
 * 그래서 이 스크립트가 지키는 것은 "실패를 조용히 넘기지 않는다" 하나다.
 */
export function buildSwapScript(input: {
  plan: SelfUpdatePlan;
  pid: number;
  logPath: string;
  resultPath: string;
  version: string;
}): string {
  const { plan, pid, logPath, resultPath, version } = input;
  const doneResult = resultLine({ outcome: "done", version, logPath });
  const notQuitResult = resultLine({
    outcome: "failed",
    version,
    reason: "앱이 끝나지 않아 교체를 포기했습니다",
    logPath,
  });
  const installFailedResult = resultLine({
    outcome: "failed",
    version,
    reason: `설치 프로그램이 오류로 끝났습니다 (종료 코드 ${EXIT_CODE_PLACEHOLDER})`,
    logPath,
  });
  const launchFailedResult = resultLine({
    outcome: "failed",
    version,
    reason: "설치 프로그램을 실행하지 못했습니다",
    logPath,
  });
  return `# Colo Design 자가 교체(Windows) — 종료 대기 → 무인 설치 → 재실행.
# 오류 하나가 스크립트를 끊으면 결과 파일이 비어 다음 실행이 아무 말도 못 한다.
$ErrorActionPreference = 'Continue'
$logPath = ${ps(logPath)}
$resultPath = ${ps(resultPath)}
$installer = ${ps(plan.downloadPath)}
$target = ${ps(plan.target)}
# BOM 없는 UTF-8 인코더 — 결과 파일과 로그가 함께 쓴다. Windows PowerShell
# 5.1 의 Set-Content·Add-Content 에는 -Encoding utf8NoBOM 이 없다: utf8 은
# BOM 을 붙여 다음 실행의 JSON.parse 를 그대로 던지게 하고, 기본값은 ANSI 라
# 한국어를 ? 로 바꿔 로그를 읽을 수 없게 만든다. .NET 인코더는 5.1 과 7 에서
# 똑같이 동작하므로 이 자리에서는 그것이 유일하게 안전한 선택이다.
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
# 로그는 직접 붙여 쓴다 — Start-Transcript 는 전사가 이미 돌고 있거나 로그
# 파일이 잠겨 있으면 그 자체가 스크립트를 죽인다. 기록은 사후 설명일 뿐이니
# 실패해도 교체를 막지 않게 삼킨다.
function Write-SwapLog([string]$line) {
  try {
    [System.IO.File]::AppendAllText($logPath, "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $line" + [char]10, $utf8NoBom)
  } catch {
  }
}
# 결과는 한 줄 — mac 스크립트가 남기는 것과 같은 모양이다(parseSwapResult 가 둘 다 읽는다).
function Write-SwapResult([string]$line) {
  [System.IO.File]::WriteAllText($resultPath, $line + [char]10, $utf8NoBom)
}
Write-SwapLog "swap start pid=${pid}"
# 도는 exe 는 잠겨 있다 — 앱이 살아 있는 동안의 설치는 파일을 덮어쓰지 못하고
# 실패한다. 그래서 이 기다림은 Windows 에서 선택이 아니다.
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Process -Id ${pid} -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 200
}
if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) {
  Write-SwapLog "앱이 끝나지 않아 교체를 포기합니다"
  Write-SwapResult ${ps(notQuitResult)}
  exit 1
}
# NSIS 무인 설치. -Wait 없이는 이 스크립트가 설치 도중에 끝나 결과를 알 수 없다.
$process = $null
try {
  $process = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
} catch {
  Write-SwapLog "설치 프로그램을 실행하지 못했습니다 — $($_.Exception.Message)"
  Write-SwapResult ${ps(launchFailedResult)}
  exit 1
}
if ($null -eq $process -or $process.ExitCode -ne 0) {
  $code = if ($null -eq $process) { '알 수 없음' } else { [string]$process.ExitCode }
  Write-SwapLog "설치 프로그램이 오류로 끝났습니다 (종료 코드 $code)"
  Write-SwapResult (${ps(installFailedResult)} -replace ${ps(EXIT_CODE_PLACEHOLDER)}, $code)
  exit 1
}
Write-SwapLog "설치가 끝났습니다"
Write-SwapResult ${ps(doneResult)}
# 재실행 — 실패해도 설치의 성공을 뒤집지 않는다(mac 스크립트와 같은 태도):
# 이미 갈아입은 앱을 "실패"로 보고하면 다음 실행이 거짓말을 한다.
# 무인 설치가 스스로 앱을 띄우는 경우가 있어 살아 있으면 건드리지 않는다 —
# 이 앱에는 단일 인스턴스 잠금이 없어 두 번 띄우면 창이 둘이 된다.
$name = [System.IO.Path]::GetFileNameWithoutExtension($target)
if (Get-Process -Name $name -ErrorAction SilentlyContinue) {
  Write-SwapLog "설치 프로그램이 이미 새 버전을 띄웠습니다"
} else {
  try {
    Start-Process -FilePath $target | Out-Null
    Write-SwapLog "새 버전을 다시 띄웠습니다"
  } catch {
    Write-SwapLog "다시 띄우지 못했습니다 — 직접 실행해 주세요: $($_.Exception.Message)"
  }
}
Write-SwapLog "swap done"
`;
}
