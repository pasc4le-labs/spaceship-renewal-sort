import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, '..', 'spaceship-renewal-sort.user.js');
const QUERY = process.env.QUERY || 'qzxvbnmp';
const SHOT = process.env.SHOT || path.join(here, '..', 'docs', 'screenshot.png');
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const source = await readFile(scriptPath, 'utf8');
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, userAgent: UA, locale: 'en-US' });
const page = await context.newPage();

const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
await page.addInitScript({ content: 'try{localStorage.removeItem("sprs:sortByRenewal")}catch(e){}' });
await page.addInitScript({ content: source });

await page.goto(`https://www.spaceship.com/domain-search/?query=${QUERY}&beast=false&tab=beast`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
for (const label of ['Reject all', "No, don't change"]) {
  const button = page.getByRole('button', { name: label }).first();
  if (await button.count()) {
    await button.click().catch(() => {});
    await page.waitForTimeout(400);
  }
}

await page.getByRole('button', { name: /generate/i }).first().click();
await page.waitForTimeout(12000);
await page.waitForFunction(() => document.querySelectorAll('[data-index] .beast-tab-item__container').length > 0, null, {
  timeout: 30000,
}).catch(() => {});

const readRows = () =>
  page.evaluate(() => {
    const items = [...document.querySelectorAll('[data-index]')].filter((el) => el.querySelector('.beast-tab-item__container'));
    return items
      .map((el) => {
        const badge = el.querySelector('.sprs-renew');
        return {
          top: Math.round(el.getBoundingClientRect().top),
          taken: el.innerText.includes('TAKEN'),
          renewal: badge ? Number(String(badge.textContent).replace(/[^0-9.]/g, '')) : null,
          text: (el.innerText || '').replace(/\n/g, ' ').slice(0, 60),
        };
      })
      .sort((a, b) => a.top - b.top);
  });

const before = await readRows();
if (!before.length) {
  console.error('FAIL: no rows rendered after Generate');
  process.exit(1);
}

await page.locator('.sprs-toggle').first().click();
await page.waitForTimeout(6000);
const sorted = await readRows();

const priced = sorted.filter((row) => row.renewal != null && !row.taken);
const ascending = priced.every((row, index) => index === 0 || row.renewal >= priced[index - 1].renewal);
const pricedFirst = sorted.slice(0, priced.length).every((row) => row.renewal != null);
const tagsOnlyOnAvailableRows = sorted.every((row) => (row.taken ? row.renewal == null : true));

await page.screenshot({ path: SHOT });

await page.locator('.sprs-toggle').first().click();
await page.waitForTimeout(2000);
const restored = await readRows();
const orderRestored = JSON.stringify(restored.map((row) => row.text)) === JSON.stringify(before.map((row) => row.text));
const badgesCleared = restored.every((row) => row.renewal == null);

const results = [
  ['rows rendered', before.length > 0],
  ['ascending renewal order', ascending],
  ['priced rows before unpriced/taken', pricedFirst],
  ['renewal tags on available rows only', tagsOnlyOnAvailableRows && priced.length > 0],
  ['toggle off restores site order', orderRestored],
  ['toggle off clears tags', badgesCleared],
  ['no page errors from the script', pageErrors.filter((message) => /sprs|renewal-sort/i.test(message)).length === 0],
];

console.log(`query=${QUERY}  rows=${before.length}  priced=${priced.length}`);
for (const row of sorted) console.log(`  ${row.renewal == null ? '    n/a' : String(row.renewal).padStart(7)}  ${row.text}`);

let failed = 0;
for (const [name, ok] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}

await browser.close();
process.exit(failed ? 1 : 0);
