// Headless screenshot of the SPA, for verifying UI changes without a browser.
//
//   npm install --no-save playwright-core
//   node scripts/screenshot.mjs [tab] [out.png]
//
// Uses an already-downloaded Playwright Chromium; override with
// PLAYWRIGHT_CHROMIUM=/path/to/chrome.
import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const root = join(process.env.HOME ?? '', '.cache/ms-playwright');
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = join(root, dir, rel);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const tab = process.argv[2] ?? 'Graph';
const out = process.argv[3] ?? '/tmp/awsome/shot.png';
const url = process.env.AWSOME_URL ?? 'http://127.0.0.1:8000';

const executablePath = findChromium();
if (!executablePath) {
  console.error('no Chromium found — set PLAYWRIGHT_CHROMIUM, or run: npx playwright install chromium');
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
await page.getByRole('button', { name: tab, exact: true }).click();
await page.waitForSelector('.react-flow__node, .md-body, table', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(4000);

const stats = await page.evaluate(() => ({
  nodes: document.querySelectorAll('.react-flow__node').length,
  groups: document.querySelectorAll('.react-flow__node-group').length,
  edges: document.querySelectorAll('.react-flow__edge').length,
}));
console.log('rendered', JSON.stringify(stats));
console.log('console errors:', errors.length ? errors.slice(0, 8) : 'none');

await page.screenshot({ path: out });
console.log('screenshot ->', out);
await browser.close();
process.exit(errors.length ? 1 : 0);
