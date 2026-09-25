// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행 + ?shell=next)로 다시 겨눈다.
await page.getByText('그만두기', {exact:true}).click();
await wait(500);
await page.mouse.move(1300, 553);
await wait(500);
await shot('t5-06-hover1451');
const btns = await page.getByText('이 시점으로').all();
for (const b of btns) { if (await b.isVisible()) { const bb = await b.boundingBox(); console.log('visible btn at', JSON.stringify(bb)); } }
