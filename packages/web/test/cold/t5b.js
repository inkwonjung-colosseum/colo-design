// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행)로 다시 겨눈다.
await page.getByText('작업 기록에서 되돌리기').first().click();
await wait(800);
await shot('t5-01-history');
