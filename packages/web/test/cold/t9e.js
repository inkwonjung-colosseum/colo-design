// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행 + ?shell=next)로 다시 겨눈다.
await wait(2500);
await shot('t9-07-pill');
await page.getByText('찍은 곳을 대화에서 보내기').first().click();
await wait(700);
await shot('t9-08-to-chat');
