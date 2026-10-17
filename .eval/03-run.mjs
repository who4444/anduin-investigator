import { chromium } from 'playwright';
import fs from 'node:fs';

const log = (...a) => { console.log(new Date().toISOString().slice(11,19), ...a); };
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
p.on('console', m => { if (m.type() === 'error') log('CONSOLE ERR', m.text().slice(0,300)); });
await p.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' });
await p.getByRole('button', { name: /load northwind scenario/i }).click();
await p.waitForTimeout(500);
await p.getByRole('button', { name: /^investigate$/i }).click();
await p.waitForTimeout(3000);
log('URL', p.url());
await p.screenshot({ path: '.eval/03-progress-early.png', fullPage: true });

const start = Date.now();
let lastText = '';
let i = 0;
while (Date.now() - start < 12 * 60 * 1000) {
  await p.waitForTimeout(5000);
  const url = p.url();
  let text = '';
  try { text = (await p.locator('body').innerText()).replace(/\s+/g, ' '); } catch {}
  if (text !== lastText) {
    lastText = text;
    log('CHANGED', url, '|', text.slice(0, 700));
  }
  // detect transition to report
  if (/\/investigations\/[0-9a-f-]+\/?$/.test(url) && !url.includes('progress')) {
    log('REPORT URL', url);
    break;
  }
  if (/error|failed/i.test(text) && /retry|try again/i.test(text)) { log('ERROR STATE'); break; }
  if (i === 3) await p.screenshot({ path: '.eval/04-progress-mid.png', fullPage: true });
  i++;
}
await p.screenshot({ path: '.eval/05-final.png', fullPage: true });
fs.writeFileSync('.eval/final-url.txt', p.url());
const body = await p.locator('body').innerText();
fs.writeFileSync('.eval/final-body.txt', body);
log('DONE', p.url(), 'chars', body.length);
await b.close();
