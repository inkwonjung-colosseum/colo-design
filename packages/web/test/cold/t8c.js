// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행)로 다시 겨눈다.
await page.mouse.click(1040, 157);
await wait(400);
await page.getByText('Claude · Sonnet 5 · 보통').first().click();
await wait(600);
await shot('t8-03-model-chip');
