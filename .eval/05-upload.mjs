import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1100 } });
await p.goto('http://127.0.0.1:3000/upload', { waitUntil: 'networkidle' });
await p.screenshot({ path: '.eval/06-upload.png', fullPage: true });
console.log(await p.locator('body').innerText());
console.log('INPUTS:', await p.locator('input').evaluateAll(els => els.map(e => `${e.type}:${e.name||e.id}:${e.placeholder||''}`)));
console.log('BUTTONS:', await p.locator('button').allInnerTexts());
await b.close();
