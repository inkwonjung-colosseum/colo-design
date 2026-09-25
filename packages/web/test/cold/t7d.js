// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행 + ?shell=next)로 다시 겨눈다.
await page.mouse.click(150, 280);
await wait(500);
await page.getByText('알림 센터', {exact:true}).last().click();
await wait(700);
await shot('t7-04-noti-0s');
await wait(2500);
await shot('t7-05-noti-3s');
await wait(4000);
await shot('t7-06-noti-7s');
