// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행 + ?shell=next)로 다시 겨눈다.
await page.getByRole('button', {name:'다음', exact:true}).click();
await wait(600);
await shot('t2-02-tip2');
await page.getByRole('button', {name:'다음', exact:true}).click().catch(e=>console.log('no next', e.message.slice(0,80)));
await wait(600);
await shot('t2-03-tip3');
