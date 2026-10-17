import { chromium } from 'playwright';
import fs from 'node:fs';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1100 } });
p.on('pageerror', e => log('PAGEERROR', String(e).slice(0, 300)));
await p.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' });
await p.getByRole('button', { name: /load northwind scenario/i }).click();
await p.waitForTimeout(1200);
// A fresh client spelling forces a new content hash, so this is a real run
// rather than the old cached demo (kept to prove single-issue compatibility).
await p.locator('input').first().fill('Northwind Logistics Inc');
await p.getByRole('button', { name: /^investigate$/i }).click();
await p.waitForTimeout(3000);
log('URL', p.url());
const start = Date.now();
let last = '';
while (Date.now() - start < 10 * 60 * 1000) {
  await p.waitForTimeout(4000);
  const url = p.url();
  let t = '';
  try { t = (await p.locator('body').innerText()).replace(/\s+/g, ' '); } catch {}
  if (t !== last) { last = t; log('STATE', url.replace('http://127.0.0.1:3000', ''), '|', t.slice(0, 300)); }
  if (await p.locator('.issue-review').count()) {
    log('SINGLE REVIEW APPEARED');
    await p.screenshot({ path: '.eval/50-single-review.png', fullPage: true });
    const confirm = p.getByRole('button', { name: /Confirm \d+ issues? and investigate/i });
    if (await confirm.count()) await confirm.click();
  }
  if (url.includes('/investigations/') && !url.includes('progress') && !/This page couldn/i.test(t)) {
    log('REPORT READY', url); break;
  }
}
await p.waitForTimeout(2000);
fs.writeFileSync('.eval/50-single-url.txt', p.url());
fs.writeFileSync('.eval/50-single-body.txt', await p.locator('body').innerText());
await p.screenshot({ path: '.eval/50-single-top.png' });
log('ISSUE INDEX', await p.locator('.issue-index').count());
log('END', p.url());
await b.close();
