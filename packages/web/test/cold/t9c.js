// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행)로 다시 겨눈다.
await page.mouse.click(958, 220);
await wait(600);
await shot('t9-04-narrow-pinon');
const b = await page.getByText('회원 추가', {exact:false}).all();
for (const x of b) { if (await x.isVisible()) { const bb = await x.boundingBox(); console.log(JSON.stringify(bb)); } }
