// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행)로 다시 겨눈다.
await page.mouse.move(1300, 553);
await wait(300);
await page.mouse.click(1432, 557);
await wait(600);
await shot('t5-07-confirm1451');
await page.getByRole('button', {name:'되돌리기', exact:true}).first().click();
await wait(800);
await shot('t5-08-reverted');
await wait(2500);
await shot('t5-09-reverted-3s');
