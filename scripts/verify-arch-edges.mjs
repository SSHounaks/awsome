// Asserts the architecture view draws the paths that bypass the exposure chain,
// that risk is legible as colour, and that the legend and the HTML export agree
// with the canvas. Exits non-zero on any violation.
//
//   node scripts/verify-arch-edges.mjs

import { chromium } from 'playwright-core';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function findChromium() {
  const root = join(process.env.HOME, '.cache/ms-playwright');
  for (const d of readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = join(root, d, rel);
      if (existsSync(p)) return p;
    }
}

// The canvas renders colour, not claim names, so the check reads colour back and
// maps it through the same table the app styles with.
const PALETTE = {
  'rgb(52, 211, 153)': 'uses',
  'rgb(56, 189, 248)': 'forwards',
  'rgb(167, 139, 250)': 'trusts',
  'rgb(71, 85, 105)': 'reaches',
  'rgb(244, 114, 182)': 'admits (no risk)',
  'rgb(251, 191, 36)': 'MEDIUM risk',
  'rgb(248, 113, 113)': 'HIGH risk',
  'rgb(249, 115, 22)': 'references (component view)',
};

const fail = [];
const check = (ok, msg) => { console.log(`${ok ? ' ok ' : 'FAIL'}  ${msg}`); if (!ok) fail.push(msg); };

const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1200 }, acceptDownloads: true });
await page.goto('http://127.0.0.1:8000', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Graph', exact: true }).click();
await page.waitForSelector('.react-flow__node');

const readEdges = () => page.evaluate(() => {
  const paths = [...document.querySelectorAll('.react-flow__edge-path')];
  const by = {};
  for (const p of paths) {
    const s = getComputedStyle(p).stroke;
    by[s] = (by[s] ?? 0) + 1;
  }
  const ids = [...document.querySelectorAll('.react-flow__node')].map((e) => e.getAttribute('data-id'));
  return { by, total: paths.length, ids };
});

// ---- architecture view ------------------------------------------------------
await page.getByRole('button', { name: 'architecture', exact: true }).click();
await page.waitForTimeout(3500);
const arch = await readEdges();

console.log('\narchitecture view');
const named = {};
for (const [rgb, n] of Object.entries(arch.by)) named[PALETTE[rgb] ?? rgb] = n;
console.log('  edges by colour:', JSON.stringify(named, null, 0));
console.log(`  ${arch.total} edges, ${arch.ids.length} nodes`);

check(arch.total > 0, 'the architecture view draws edges');
check((named['HIGH risk'] ?? 0) > 0, 'high-risk paths are drawn in red');
check((named['MEDIUM risk'] ?? 0) > 0, 'medium-risk paths are drawn in amber');

const cidrNodes = arch.ids.filter((id) => id && id.startsWith('__cidr__'));
console.log('  address-range origins:', JSON.stringify(cidrNodes));
check(cidrNodes.length > 0, 'wide internal ranges become origin nodes instead of fanning out');

// The whole point: the internet must connect to more than the load balancers.
const inet = await page.evaluate(() => {
  const t = [...document.querySelectorAll('.react-flow__edge')]
    .map((e) => e.getAttribute('data-id') || '')
    .filter((id) => id.startsWith('__internet__'));
  return { count: t.length, kinds: [...new Set(t.map((id) => id.split('→').pop()))] };
});
console.log('  edges out of the internet node:', inet.count, JSON.stringify(inet.kinds));
check(inet.count > 3, 'the internet reaches more than the three internet-facing load balancers');
check(inet.kinds.includes('ADMITS'), 'direct security-group admission from outside is drawn');
check(inet.kinds.includes('TUNNELS'), 'the outbound-established tunnel path is drawn');

// ---- legend -----------------------------------------------------------------
const toggle = page.getByRole('button', { name: 'What the lines mean' });
check(await toggle.isVisible(), 'the legend button sits on the canvas');
check(await page.locator('text=what the lines mean').count() === 0, 'the legend starts collapsed');
await toggle.click();
await page.waitForTimeout(200);
const legendRows = await page.evaluate(() =>
  [...document.querySelectorAll('.grid.grid-cols-\\[34px_76px_1fr\\]')].map((e) => e.querySelector('b')?.textContent));
console.log('  legend rows:', JSON.stringify(legendRows));
check(legendRows.includes('tunnels') && legendRows.includes('admits'), 'the legend explains the new claims');
check(legendRows.includes('high') && legendRows.includes('medium'), 'the legend explains the risk colours');
await toggle.click();
await page.waitForTimeout(200);
check(await page.locator('text=what the lines mean').count() === 0, 'clicking the button again collapses it');

// ---- HTML export ------------------------------------------------------------
const dl = page.waitForEvent('download');
await page.getByRole('button', { name: 'HTML' }).click();
const file = await (await dl).path();
const html = readFileSync(file, 'utf8');
console.log('\nHTML export');
check(html.includes('id="legend"'), 'the export carries the legend');
check(html.includes('class="collapsed"'), 'the exported legend starts collapsed');
check(html.includes('lg-toggle'), 'the exported legend is expandable');
check(/"r":"high"/.test(html), 'the export carries per-edge risk');
check(html.includes('#f87171') && html.includes('#fbbf24'), 'the exported SVG uses the same risk colours');
check(!html.includes('"__internet__":{'), 'origin nodes get no empty detail panel in the export');

// ---- component view must be untouched --------------------------------------
await page.getByRole('button', { name: 'component', exact: true }).click();
await page.waitForTimeout(2500);
const comp = await readEdges();
const compNamed = {};
for (const [rgb, n] of Object.entries(comp.by)) compNamed[PALETTE[rgb] ?? rgb] = n;
console.log('\ncomponent view');
console.log('  edges by colour:', JSON.stringify(compNamed));
check(!compNamed['HIGH risk'] && !compNamed['MEDIUM risk'], 'risk colouring stays out of the component view');
check(comp.ids.filter((id) => id && id.startsWith('__cidr__')).length === 0, 'address-range origins stay out of the component view');
const compToggle = page.getByRole('button', { name: 'What the lines mean' });
await compToggle.click();
await page.waitForTimeout(200);
const compRows = await page.evaluate(() =>
  [...document.querySelectorAll('.grid.grid-cols-\\[34px_76px_1fr\\]')].map((e) => e.querySelector('b')?.textContent));
console.log('  legend rows:', JSON.stringify(compRows));
check(compRows.includes('references') && !compRows.includes('tunnels'),
  'the component view gets its own legend, not the architecture one');

await browser.close();
console.log(fail.length ? `\n${fail.length} FAILED` : '\nall checks passed');
process.exit(fail.length ? 1 : 0);
