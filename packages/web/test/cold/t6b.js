// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행 + ?shell=next)로 다시 겨눈다.
await page.mouse.move(890, 800);
await page.mouse.wheel(0, 600);
await wait(500);
await shot('t6-01-home-scrolled');
await page.mouse.wheel(0, -1200);
await wait(300);
await page.getByRole('button', {name:'표에도 보여 주기'}).click();
await wait(800);
await shot('t6-02-answered');
await wait(3000);
await shot('t6-03-answered-3s');
