// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행 + ?shell=next)로 다시 겨눈다.
await page.getByText('주문 관리', {exact:true}).last().click();
await wait(1000);
await shot('t7-01-orders');
await wait(2000);
await shot('t7-02-orders-3s');
