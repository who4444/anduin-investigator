import { chromium } from 'playwright';
import fs from 'node:fs';
const url = process.argv[2];
const tag = process.argv[3] || 'report';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1100 } });
await p.goto(url, { waitUntil: 'networkidle' });
await p.waitForTimeout(800);
const body = await p.locator('body').innerText();
fs.writeFileSync(`.eval/${tag}.txt`, body);
// section screenshots by heading
const h = await p.locator('h1,h2,h3').allInnerTexts();
console.log('HEADINGS:', JSON.stringify(h, null, 1));
await p.screenshot({ path: `.eval/${tag}-full.png`, fullPage: true });
// evidence buttons count
const btns = await p.locator('button').allInnerTexts();
console.log('BUTTONS:', JSON.stringify(btns));
await b.close();
