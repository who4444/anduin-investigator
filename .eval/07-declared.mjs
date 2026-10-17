import { chromium } from 'playwright';
import fs from 'node:fs';
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1100 } });
p.on('console', m => { if (m.type() === 'error') log('CONSOLE', m.text().slice(0,200)); });
p.on('pageerror', e => log('PAGEERROR', String(e).slice(0,300)));
await p.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' });
await p.getByRole('button', { name: /load northwind scenario/i }).click();
await p.waitForTimeout(1800);
await p.locator('input').first().fill('Northwind Logistics Ltd');
await p.getByRole('button', { name: /^investigate$/i }).click();
await p.waitForTimeout(3000);
log('URL', p.url());
const start = Date.now();
let last = '';
let progressShot = 0;
while (Date.now() - start < 10 * 60 * 1000) {
  await p.waitForTimeout(4000);
  const url = p.url();
  let t = '';
  try { t = (await p.locator('body').innerText()).replace(/\s+/g, ' '); } catch {}
  if (t !== last) { last = t; log('STATE', url.replace('http://127.0.0.1:3000',''), '|', t.slice(0, 300)); }
  if (url.includes('/investigations/') && !url.includes('progress') && !/This page couldn/i.test(t)) {
    log('REPORT READY', url);
    await p.waitForTimeout(2500);
    fs.writeFileSync('.eval/declared-url.txt', p.url());
    fs.writeFileSync('.eval/declared-body.txt', await p.locator('body').innerText());
    await p.screenshot({ path: '.eval/20-report-top.png' });
    await p.screenshot({ path: '.eval/21-report-full.png', fullPage: true });
    // draft the client reply
    const draft = p.getByRole('button', { name: /draft the client reply/i });
    if (await draft.count()) {
      await draft.first().click();
      await p.waitForTimeout(15000);
      const t2 = await p.locator('body').innerText();
      fs.writeFileSync('.eval/declared-body-with-reply.txt', t2);
      await p.screenshot({ path: '.eval/22-report-draft-reply.png', fullPage: true });
      log('DRAFT', t2.slice(-1500));
    } else { log('NO DRAFT BUTTON'); }
    break;
  }
  if (progressShot < 3 && Date.now() - start > 8000) {
    await p.screenshot({ path: `.eval/2${3+progressShot}-progress.png` });
    progressShot++;
  }
}
log('END', p.url());
await b.close();
