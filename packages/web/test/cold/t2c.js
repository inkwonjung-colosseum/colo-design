// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행)로 다시 겨눈다.
await page.getByRole('button', {name:'알겠어요', exact:true}).click();
await wait(400);
const box = page.getByPlaceholder('만들거나 고치고 싶은 것을 말해 주세요');
await box.click();
await box.type('회원 목록 표 아래에 페이지 번호를 넣어 줘', {delay: 20});
await shot('t2-04-typed');
await page.keyboard.press('Enter');
await wait(700);
await shot('t2-05-sent');
await wait(2500);
await shot('t2-06-3s');
await wait(5000);
await shot('t2-07-8s');
console.log(JSON.stringify(await page.evaluate(()=>window.__errs)));
