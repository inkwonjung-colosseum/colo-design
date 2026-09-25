// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행)로 다시 겨눈다.
await page.keyboard.press('Escape');
await page.goto('about:blank');
await page.goto('file:///Users/developjik/.paseo/worktrees/37blf94g/durable-spider/mockups/redesign.html#narrow=1');
await wait(1500);
await shot('t9-00-narrow');
await wait(2500);
await shot('t9-01-narrow-4s');
