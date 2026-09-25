// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행 + ?shell=next)로 다시 겨눈다.
await page.mouse.move(1460, 121);
await wait(600);
await shot('t4-00-hover-submit');
await page.mouse.click(1460, 121);
await wait(300);
await shot('t4-01-click');
await wait(1200);
await shot('t4-02-1_5s');
await wait(2000);
await shot('t4-03-3_5s');
