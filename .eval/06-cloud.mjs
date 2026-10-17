import { chromium } from 'playwright';
import fs from 'node:fs';
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1100 } });
p.on('console', m => { if (m.type() === 'error') log('CONSOLE', m.text().slice(0,200)); });
p.on('pageerror', e => log('PAGEERROR', String(e).slice(0,300)));
await p.goto('http://127.0.0.1:3000/upload', { waitUntil: 'networkidle' });
const escalation = "Meridian reports that invoice totals have been wrong since release 4.12, our finance team is blocked, and we have not had a reply to four messages. Please explain what happened and when this will be fixed. We need a written explanation and a firm fix date today.";
await p.locator('textarea').fill(escalation);
await p.locator('input[type=file]').first().setInputFiles('.eval/demo.zip');
await p.waitForTimeout(1200);
const btns = await p.locator('button').evaluateAll(els => els.map(e => [e.innerText, e.disabled]));
log('BUTTONS', JSON.stringify(btns));
await p.screenshot({ path: '.eval/12-upload-filled.png', fullPage: true });
const inv = p.getByRole('button', { name: /investigate these exports/i });
if (await inv.isDisabled()) { log('INVESTIGATE DISABLED'); await b.close(); process.exit(1); }
await inv.click();
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
  if (t !== last) { last = t; log('STATE', url.replace('http://127.0.0.1:3000',''), '|', t.slice(0, 350)); }
  if (url.includes('/investigations/') && !url.includes('progress')) {
    log('REPORT READY', url);
    await p.waitForTimeout(2500);
    fs.writeFileSync('.eval/fresh-url.txt', p.url());
    fs.writeFileSync('.eval/fresh-body.txt', await p.locator('body').innerText());
    await p.locator('body').screenshot({ path: '.eval/13-report-top.png' }).catch(()=>{});
    await p.screenshot({ path: '.eval/14-report-full.png', fullPage: true });
    break;
  }
  if (progressShot < 2 && Date.now() - start > 10000) {
    await p.screenshot({ path: `.eval/1${5+progressShot}-progress.png` });
    progressShot++;
  }
}
log('END', p.url());
await b.close();
