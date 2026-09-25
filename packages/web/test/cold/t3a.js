// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행 + ?shell=next)로 다시 겨눈다.
await page.mouse.click(1398, 171);
await wait(500);
await shot('t3-00-pin-on');
await page.mouse.move(1425, 308);
await wait(300);
await shot('t3-01-hover');
await page.mouse.click(1425, 308);
await wait(700);
await shot('t3-02-clicked');
