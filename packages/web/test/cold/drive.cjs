// 사용: node drive.cjs <url> <steps.js> [width] [height]
// steps.js 는 page · shot · wait · log 를 받는 async 함수 본문 (콜드 리뷰 러너와 같은 꼴)
const { chromium } = require('/Users/developjik/.local/lib/node_modules/playwright');
const fs = require('fs');
const [url, stepsFile, w = '1440', h = '900'] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: +w, height: +h } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
  const shot = async (name) => { await page.screenshot({ path: (process.env.SHOT_DIR || '/tmp/colo-smoke/shots') + '/' + name + '.png' }); console.log('shot', name); };
  const wait = (ms) => page.waitForTimeout(ms);
  const log = (...a) => console.log('LOG', ...a);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await wait(4000);
  const code = fs.readFileSync(stepsFile, 'utf8');
  const fn = new Function('page', 'shot', 'wait', 'log', 'return (async()=>{' + code + '})()');
  try { await fn(page, shot, wait, log); } catch (e) { console.log('STEP ERROR', e.message.split('\n').slice(0, 3).join(' | ')); }
  console.log('ERRS', errs.length ? errs.join('\n') : 'none');
  await b.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
