// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행 + ?shell=next)로 다시 겨눈다.
await page.goto('about:blank');
await page.goto('file:///Users/developjik/.paseo/worktrees/37blf94g/durable-spider/mockups/redesign.html#cycle=review');
await wait(1500);
await shot('t10-00-review');
await page.getByText('대시보드 가입자 카드', {exact:true}).first().click();
await wait(800);
await shot('t10-01-failed-conv');
await page.getByText('도구가 한 일', {exact:false}).first().click();
await wait(500);
await shot('t10-02-tool-work');
