import { chromium } from 'playwright';
import fs from 'node:fs';
const url = process.argv[2];
const tag = process.argv[3] || 'r';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1100 } });
await p.goto(url, { waitUntil: 'networkidle' });
await p.waitForTimeout(1000);
const height = await p.evaluate(() => document.body.scrollHeight);
console.log('height', height);
let i = 0;
for (let y = 0; y < height && i < 8; y += 1000) {
  await p.evaluate(yy => window.scrollTo(0, yy), y);
  await p.waitForTimeout(300);
  await p.screenshot({ path: `.eval/${tag}-scroll-${i}.png` });
  i++;
}
// open first evidence button in the promises area
const ev = p.locator('button', { hasText: /^evidence$/ });
console.log('evidence count', await ev.count());
if (await ev.count()) {
  // find one inside the promises section: scroll to heading then click nearest following evidence
  await p.evaluate(() => window.scrollTo(0, 0));
  const buttons = await p.getByRole('button', { name: 'evidence' }).all();
  for (let k = 0; k < buttons.length; k++) {
    const box = await buttons[k].boundingBox();
    if (box && box.y > 0) {
      await buttons[k].click();
      await p.waitForTimeout(600);
      await p.screenshot({ path: `.eval/${tag}-drawer-${k}.png`, fullPage: false });
      const t = await p.locator('body').innerText();
      fs.writeFileSync(`.eval/${tag}-drawer-${k}.txt`, t);
      await p.keyboard.press('Escape').catch(()=>{});
      break;
    }
  }
}
await b.close();
