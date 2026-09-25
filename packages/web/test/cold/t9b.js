// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행 + ?shell=next)로 다시 겨눈다.
const box = page.getByPlaceholder('만들거나 고치고 싶은 것을 말해 주세요');
await box.click();
await box.type('회원 목록 표 아래에 페이지 번호를 넣어 줘', {delay: 15});
await page.keyboard.press('Enter');
await wait(8000);
await shot('t9-02-narrow-answered');
await page.getByText('화면 · 회원 목록').first().click();
await wait(700);
await shot('t9-03-narrow-screen');
