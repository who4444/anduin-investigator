import { chromium } from 'playwright';
import fs from 'node:fs';

const arg = (k, d = '') => {
  const i = process.argv.indexOf(`--${k}`);
  return i === -1 ? d : process.argv[i + 1];
};
const kind = arg('kind', 'realistic');
const tag = arg('tag', kind);
const client = arg('client', '');
const escPath = arg('escalation', '');
const zip = arg('zip', '');
const escalation = escPath ? fs.readFileSync(escPath, 'utf8') : arg('esc', '');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1100 } });
p.on('console', m => { if (m.type() === 'error') log('CONSOLE', m.text().slice(0, 160)); });
p.on('pageerror', e => log('PAGEERROR', String(e).slice(0, 200)));

if (kind === 'demo') {
  await p.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' });
  await p.getByRole('button', { name: /load northwind scenario/i }).click();
  await p.waitForTimeout(1800);
  if (client) await p.locator('input').first().fill(client);
  await p.getByRole('button', { name: /^investigate$/i }).click();
} else {
  await p.goto('http://127.0.0.1:3000/upload', { waitUntil: 'networkidle' });
  await p.locator('textarea').first().fill(escalation);
  await p.locator('input[type=file]').first().setInputFiles(zip);
  await p.waitForTimeout(1200);
  await p.getByRole('button', { name: /investigate these exports/i }).click();
}
await p.waitForTimeout(3000);
log('URL', p.url());

const start = Date.now();
let last = '';
let progressShots = 0;
while (Date.now() - start < 12 * 60 * 1000) {
  await p.waitForTimeout(4000);
  const url = p.url();
  let t = '';
  try { t = (await p.locator('body').innerText()).replace(/\s+/g, ' '); } catch {}
  if (t !== last) { last = t; log('STATE', url.replace('http://127.0.0.1:3000', ''), '|', t.slice(0, 280)); }
  if (url.includes('/investigations/') && !url.includes('progress') && !/This page couldn/i.test(t)) {
    log('REPORT READY', url);
    await p.waitForTimeout(2500);
    fs.writeFileSync(`.eval/${tag}-url.txt`, p.url());
    fs.writeFileSync(`.eval/${tag}-body.txt`, await p.locator('body').innerText());
    await p.screenshot({ path: `.eval/${tag}-top.png` });
    // capture the whole page in viewport slices
    const h = await p.evaluate(() => document.body.scrollHeight);
    fs.writeFileSync(`.eval/${tag}-height.txt`, String(h));
    for (let y = 0, i = 0; y < h && i < 14; y += 1000, i++) {
      await p.evaluate(yy => window.scrollTo(0, yy), y);
      await p.waitForTimeout(120);
      await p.screenshot({ path: `.eval/${tag}-scroll-${i}.png` });
    }
    await p.evaluate(() => window.scrollTo(0, 0));
    // draft reply
    const draft = p.getByRole('button', { name: /draft the client reply/i });
    if (await draft.count()) {
      await draft.first().click();
      await p.waitForTimeout(18000);
      const t2 = await p.locator('body').innerText();
      fs.writeFileSync(`.eval/${tag}-with-reply.txt`, t2);
      const sec = p.getByRole('heading', { name: /^Draft reply$/ }).first();
      if (await sec.count()) {
        await sec.scrollIntoViewIfNeeded();
        await p.waitForTimeout(300);
        const s = sec.locator('xpath=ancestor::section[1]');
        if (await s.count()) await s.screenshot({ path: `.eval/${tag}-reply.png` }).catch(() => {});
      }
      await p.screenshot({ path: `.eval/${tag}-after-reply.png` });
      log('DRAFT', t2.slice(-1200));
    } else { log('NO DRAFT BUTTON'); }
    break;
  }
  if (progressShots < 3 && Date.now() - start > 8000) {
    await p.screenshot({ path: `.eval/${tag}-progress-${progressShots}.png` });
    progressShots++;
  }
}
log('END', p.url());
await b.close();
