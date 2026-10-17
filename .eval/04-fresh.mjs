import { chromium } from 'playwright';
import fs from 'node:fs';
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1100 } });
await p.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' });
await p.getByRole('button', { name: /load northwind scenario/i }).click();
await p.waitForTimeout(400);
const ta = p.locator('textarea');
const orig = await ta.inputValue();
await ta.fill(orig + ' We need a written explanation and a firm fix date today.');
await p.getByRole('button', { name: /^investigate$/i }).click();
await p.waitForTimeout(4000);
log('URL', p.url());
const start = Date.now();
let shot = 0;
let last = '';
while (Date.now() - start < 8 * 60 * 1000) {
  await p.waitForTimeout(4000);
  const url = p.url();
  let t = '';
  try { t = (await p.locator('body').innerText()).replace(/\s+/g, ' '); } catch {}
  if (t !== last) { last = t; log('STATE', url.replace('http://127.0.0.1:3000',''), '|', t.slice(0, 400)); }
  if (url.includes('/investigations/') && !url.includes('progress')) {
    log('REPORT READY', url);
    await p.waitForTimeout(2500);
    await p.screenshot({ path: '.eval/10-report-top.png' });
    break;
  }
  if (shot < 2 && Date.now() - start > 12000 && Date.now() - start < 60000) {
    await p.screenshot({ path: `.eval/1${shot}-progress.png`, fullPage: false });
    shot++;
    await p.waitForTimeout(20000);
  }
  if (/Something went wrong|Investigation failed|Try again/i.test(t)) { log('ERROR STATE'); await p.screenshot({path:'.eval/19-error.png', fullPage:true}); break; }
}
fs.writeFileSync('.eval/fresh-url.txt', p.url());
if (!p.url().includes('progress')) {
  fs.writeFileSync('.eval/fresh-body.txt', await p.locator('body').innerText());
  await p.screenshot({ path: '.eval/11-report-full.png', fullPage: true });
}
log('END', p.url());
await b.close();
