/**
 * Electron 스위트의 마지막 한 걸음 — 닫히지 않는 앱을 걷어내는 일.
 *
 * Playwright 의 ElectronApplication.close() 는 창이 먹통이면 돌아오지 않는다.
 * xvfb 러너에서 comments 스위트가 마지막 검사를 통과하고도 끝나지 못해 레인
 * 하나가 CI 상한(12분)까지 끌려간 것이 정확히 그것이다. 여기서는 닫기에
 * 시간을 재고, 그 시간을 넘기면 프로세스를 직접 죽인다 — 다음 스위트가
 * 데스크톱 앱의 단일 인스턴스 잠금에 걸리지 않으려면 프로세스는 반드시
 * 사라져야 한다.
 */
export async function closeApp(app, timeoutMs = 15_000) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([app.close().catch(() => undefined), deadline]);
  clearTimeout(timer);
  try {
    app.process()?.kill("SIGKILL");
  } catch {
    // 이미 사라졌다 — 닫기가 제 시간에 끝났다는 뜻이다.
  }
}
