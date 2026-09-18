import { chromium } from '/home/easha/repo/tbtt/node_modules/playwright/index.mjs';
const [,, url, out, w, h] = process.argv;
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: +w || 1000, height: +h || 700 } });
const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
await p.goto(url); await p.waitForTimeout(400);
await p.screenshot({ path: out, fullPage: true }); await b.close();
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no errors');
