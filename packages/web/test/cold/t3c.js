// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행 + ?shell=next)로 다시 겨눈다.
await page.keyboard.type('이름을 바꿔 줘', {delay: 30});
await wait(200);
await shot('t3-06-typed-pin');
await page.keyboard.press('Enter');
await wait(600);
await shot('t3-07-after-enter');
