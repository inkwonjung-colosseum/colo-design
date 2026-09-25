// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행)로 다시 겨눈다.
await page.getByText('쓸 수 없는 AI', {exact:false}).first().click();
await wait(400);
const opts = await page.locator('select').evaluateAll(els => els.map(e => [...e.options].map(o=>o.text)));
console.log('select options', JSON.stringify(opts));
await page.getByText('문제 해결 도구 펼치기').first().click();
await wait(500);
await shot('t8-01-expanded');
const dlg = page.getByText('설정', {exact:true}).first();
await page.mouse.move(760, 700);
await page.mouse.wheel(0, 800);
await wait(400);
await shot('t8-02-scrolled');
