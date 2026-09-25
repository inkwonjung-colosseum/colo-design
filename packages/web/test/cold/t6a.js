// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행)로 다시 겨눈다.
await page.mouse.click(1444, 171);
await wait(600);
await shot('t5-12-clock');
await page.mouse.click(1472, 225);
await wait(300);
await page.getByText('홈', {exact:true}).first().click();
await wait(800);
await shot('t6-00-home');
