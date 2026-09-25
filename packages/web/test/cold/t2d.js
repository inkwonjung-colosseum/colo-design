// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행)로 다시 겨눈다.
console.log(page.frames().map(f=>f.url().slice(0,80)).join('\n'));
// try click "2" in pagination by coordinates as a user would
await page.mouse.click(1102, 717);
await wait(600);
await shot('t2-08-page2');
await page.mouse.click(1197, 378);
await wait(600);
await shot('t2-09-vipchip');
