// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행 + ?shell=next)로 다시 겨눈다.
await page.mouse.move(997, 391);
await wait(300);
await page.mouse.click(997, 391);
await wait(700);
await shot('t9-05-narrow-pinned');
await page.keyboard.type('이름을 바꿔 줘', {delay: 20});
await page.keyboard.press('Enter');
await wait(700);
await shot('t9-06-narrow-after-enter');
