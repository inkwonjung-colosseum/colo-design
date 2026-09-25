// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행 + ?shell=next)로 다시 겨눈다.
await page.mouse.move(1460, 121);
await wait(700);
await shot('t4-08-submit-disabled-hover');
await page.mouse.click(1460, 121);
await wait(500);
await shot('t4-09-submit-disabled-click');
