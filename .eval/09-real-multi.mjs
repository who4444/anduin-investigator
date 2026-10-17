import { chromium } from 'playwright';
import fs from 'node:fs';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1100 } });
p.on('console', m => { if (m.type() === 'error') log('CONSOLE', m.text().slice(0, 200)); });
p.on('pageerror', e => log('PAGEERROR', String(e).slice(0, 300)));

await p.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' });
await p.getByRole('button', { name: /load multi-issue scenario/i }).click();
await p.waitForTimeout(1200);
// A different declared-client spelling forces a fresh real run (the earlier
// Contoso run is cached), so this also checks the tuned issue-splitting prompt.
await p.locator('input').first().fill('Contoso Inc');
await p.screenshot({ path: '.eval/40-multi-intake.png' });
await p.getByRole('button', { name: /^investigate$/i }).click();
await p.waitForTimeout(3000);
log('URL', p.url());

const start = Date.now();
let review = false;
let last = '';
while (Date.now() - start < 10 * 60 * 1000) {
  await p.waitForTimeout(4000);
  const url = p.url();
  let t = '';
  try { t = (await p.locator('body').innerText()).replace(/\s+/g, ' '); } catch {}
  if (t !== last) { last = t; log('STATE', url.replace('http://127.0.0.1:3000', ''), '|', t.slice(0, 320)); }
  if (await p.locator('.issue-review').count()) {
    review = true;
    const issues = await p.locator('.issue-edit-card').count();
    log('ISSUE REVIEW', issues);
    fs.writeFileSync('.eval/41-multi-review.txt', await p.locator('body').innerText());
    await p.screenshot({ path: '.eval/41-multi-review.png', fullPage: true });
    break;
  }
  if (url.includes('/investigations/') && !url.includes('progress') && !/This page couldn/i.test(t)) {
    log('REPORT WITHOUT REVIEW');
    break;
  }
  if (/failed|error state|Something went wrong/i.test(t) && /retry|reload/i.test(t)) {
    log('ERROR STATE'); await p.screenshot({ path: '.eval/49-multi-error.png', fullPage: true }); break;
  }
}

if (review) {
  const confirm = p.getByRole('button', { name: /Confirm \d+ issues? and investigate/i });
  log('CONFIRM BUTTON', await confirm.count(), await confirm.isEnabled().catch(() => false));
  await confirm.click();
  const wait = Date.now();
  while (Date.now() - wait < 10 * 60 * 1000) {
    await p.waitForTimeout(4000);
    const url = p.url();
    let t = '';
    try { t = (await p.locator('body').innerText()).replace(/\s+/g, ' '); } catch {}
    if (t !== last) { last = t; log('AFTER CONFIRM', url.replace('http://127.0.0.1:3000', ''), '|', t.slice(0, 300)); }
    if (url.includes('/investigations/') && !url.includes('progress') && !/This page couldn/i.test(t)) {
      log('REPORT READY', url); break;
    }
    if (/failed: A stage is already running/i.test(t)) { log('LEASE ERROR'); break; }
  }
}

await p.waitForTimeout(2500);
const url = p.url();
fs.writeFileSync('.eval/42-multi-url.txt', url);
fs.writeFileSync('.eval/42-multi-body.txt', await p.locator('body').innerText());
await p.screenshot({ path: '.eval/42-multi-top.png' });

if (await p.locator('.issue-index').count()) {
  const links = await p.locator('.issue-index a').allInnerTexts();
  log('ISSUE LINKS', JSON.stringify(links));
  if (links.length > 2) {
    await p.locator('.issue-index a').nth(2).click();
    await p.waitForTimeout(1200);
    fs.writeFileSync('.eval/43-issue2.txt', await p.locator('body').innerText());
    await p.screenshot({ path: '.eval/43-issue2-top.png' });
    await p.locator('.issue-index a').first().click();
    await p.waitForTimeout(800);
  }
  // Draft a reply for the current/first issue if possible.
  const draft = p.getByRole('button', { name: /draft the client reply/i });
  if (await draft.count()) {
    await draft.first().click();
    await p.waitForTimeout(18000);
    fs.writeFileSync('.eval/44-multi-reply.txt', await p.locator('body').innerText());
    const sec = p.getByRole('heading', { name: /^Draft reply$/ }).first();
    if (await sec.count()) {
      await sec.scrollIntoViewIfNeeded();
      await p.waitForTimeout(300);
      const s = sec.locator('xpath=ancestor::section[1]');
      if (await s.count()) await s.screenshot({ path: '.eval/44-multi-reply.png' }).catch(() => {});
    }
  }
}
log('END', p.url());
await b.close();
