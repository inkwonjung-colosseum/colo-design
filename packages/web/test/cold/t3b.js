// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행)로 다시 겨눈다.
await page.mouse.click(1469, 344);
await wait(500);
await shot('t3-03-popover-x');
await page.mouse.move(1425, 349);
await wait(400);
await shot('t3-04-hover-btn');
await page.mouse.click(1425, 349);
await wait(700);
await shot('t3-05-btn-pinned');
