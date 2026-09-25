// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행)로 다시 겨눈다.
await page.keyboard.press('Escape');
await page.mouse.click(521, 809);
await wait(600);
await shot('t5-00-answer-menu');
