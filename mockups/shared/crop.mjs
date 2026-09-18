// Screenshot one element: node crop.mjs url selector out.png [width]
import { chromium } from '/home/easha/repo/tbtt/node_modules/playwright/index.mjs';
const [,, url, sel, out, w] = process.argv;
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: +w || 1440, height: 900 } });
await p.goto(url); await p.waitForTimeout(400);
await p.locator(sel).first().screenshot({ path: out }); await b.close();
