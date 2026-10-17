import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
await p.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' });
await p.screenshot({ path: '.eval/01-start.png', fullPage: true });
console.log(await p.locator('body').innerText());
await b.close();
