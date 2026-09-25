// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행 + ?shell=next)로 다시 겨눈다.
await page.goto('file:///Users/developjik/.paseo/worktrees/37blf94g/durable-spider/mockups/redesign.html#screen=onboarding');
await page.evaluate(()=>{ if(!window.__errs){window.__errs=[]; window.addEventListener('error',e=>window.__errs.push(String(e.message))); window.addEventListener('unhandledrejection',e=>window.__errs.push('rej '+String(e.reason)));} });
await shot('t1-00-open');
await wait(3000);
await shot('t1-01-3s');
await wait(7000);
await shot('t1-02-10s');
