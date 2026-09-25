// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행)로 다시 겨눈다.
await page.keyboard.press('Escape');
await wait(300);
const pagesBefore = ctx.pages().length;
await page.getByText('보낸 내용 열기').first().click();
await wait(1000);
console.log('pages', pagesBefore, ctx.pages().length, ctx.pages().map(p=>p.url().slice(0,100)));
await shot('t4-06-open-sent');
await page.getByRole('button', {name:'답하기'}).first().click().catch(e=>console.log('no reply btn'));
await wait(600);
await shot('t4-07-reply');
