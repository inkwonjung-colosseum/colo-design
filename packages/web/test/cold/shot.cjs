// 사용: node shot.cjs <url> <out.png> [width] [height] [waitMs]
const { chromium } = require('/Users/developjik/.local/lib/node_modules/playwright');
const [url, out, w = '1440', h = '900', waitMs = '4000'] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: +w, height: +h } });
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
  await p.goto(url, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(+waitMs);
  await p.screenshot({ path: out, fullPage: false });
  const text = (await p.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 600);
  console.log('TEXT', text);
  console.log('ERRS', errs.length ? errs.join('\n') : 'none');
  await b.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
