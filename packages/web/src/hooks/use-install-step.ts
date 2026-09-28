import { useEffect, useState } from "react";
import { advanceInstallStep, type InstallStep } from "../next/lib/install-step";

/**
 * 설치 진행기의 날 줄을 화면용 단계로 갈아 입는 갈무리 — 줄이 바뀔 때마다
 * 판정하고, 모르는 줄은 직전 단계를 유지한다. 진행이 끊기면(빈 줄) 처음부터.
 */
export function useInstallStep(line: string | null | undefined): InstallStep | null {
  const [step, setStep] = useState<InstallStep | null>(null);
  useEffect(() => {
    setStep((prev) => advanceInstallStep(prev, line));
  }, [line]);
  return step;
}
