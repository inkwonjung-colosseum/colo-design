// 콜드 리뷰 스크립트 — 지금은 목업 mockups/redesign.html 을 겨눈다. PLAN-UI 단계 8 에서 실제 셸(개발 실행)로 다시 겨눈다.
const { chromium } = require('/Users/developjik/.local/lib/node_modules/playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find(p => !p.url().startsWith('about:') ) || ctx.pages()[0];
  if (!page) page = await ctx.newPage();
  await page.setViewportSize({ width: 1520, height: 960 });
  if (!global.__hooked) {
    page.on('pageerror', e => fs.appendFileSync('/tmp/ui/errors.log', new Date().toISOString()+' PAGEERROR '+e.message+'\n'));
    page.on('console', m => { if (m.type()==='error') fs.appendFileSync('/tmp/ui/errors.log', new Date().toISOString()+' CONSOLE '+m.text()+'\n'); });
  }
  const shot = async (name, opts={}) => { await page.screenshot({ path: '/tmp/ui/cold/'+name+'.png', ...opts }); console.log('shot', name); };
  const wait = ms => page.waitForTimeout(ms);
  const code = fs.readFileSync(process.argv[2], 'utf8');
  const fn = new Function('page','shot','wait','ctx', 'return (async()=>{'+code+'})()');
  try { await fn(page, shot, wait, ctx); } catch (e) { console.log('STEP ERROR', e.message.split('\n').slice(0,4).join('\n')); }
  await browser.close().catch(()=>{});
})();
