// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행 + ?shell=next)로 다시 겨눈다.
await page.mouse.click(660, 806);
await wait(600);
await shot('t3-08-removed1');
await wait(2500);
await shot('t3-09-toast-gone');
