// Asserts the architecture view draws the paths that bypass the exposure chain,
// that risk is legible as colour, and that the legend and the HTML export agree
// with the canvas. Exits non-zero on any violation.
//
//   node scripts/verify-arch-edges.mjs

import { chromium } from 'playwright-core';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
await page.getByRole('button', { name: '.html', exact: true }).click();
// Saved to a stable path: a download's own temp file is not guaranteed to
// outlive the handle, and the report has to be loaded back to be checked.
const file = join(tmpdir(), 'awsome-verify-report.html');
await (await dl).saveAs(file);
const html = readFileSync(file, 'utf8');
console.log('\nHTML export');
check(html.includes('id="legend"'), 'the export carries the legend');
check(html.includes('class="collapsed"'), 'the exported legend starts collapsed');
check(html.includes('lg-toggle'), 'the exported legend is expandable');
check(/"r":"high"/.test(html), 'the export carries per-edge risk');
check(html.includes('#f87171') && html.includes('#fbbf24'), 'the exported SVG uses the same risk colours');
check(!html.includes('"__internet__":{'), 'origin nodes get no empty detail panel in the export');
check(html.includes('id="t-drift"'), 'the export has a drift tab alongside diagram and findings');
check(html.includes('class="stats"') && !html.includes('class="dnone"'),
  'the drift tab carries a real comparison, fetched at export time if the overlay was never on');
check(/<details class="rb/.test(html), 'drift resources expand without needing script');

// the report must work with no server, no network and no build step
const report = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const offline = [];
report.on('requestfailed', (r) => offline.push(r.url()));
report.on('request', (r) => { if (!r.url().startsWith('file:')) offline.push(r.url()); });
await report.goto(`file://${file}`);
await report.waitForTimeout(500);
check(offline.length === 0, `the exported report loads offline (${offline.length} external requests)`);

for (const [tab, panel] of [['drift', '#drift'], ['findings', '#findings'], ['diagram', '#diagram']]) {
  await report.locator(`#t-${tab}`).click();
  await report.waitForTimeout(150);
  const vis = await report.evaluate((sel) => {
    const shown = ['#diagram', '#findings', '#drift'].filter((s) => getComputedStyle(document.querySelector(s)).display !== 'none');
    return { shown, legend: document.getElementById('legend') ? getComputedStyle(document.getElementById('legend')).display : 'absent' };
  }, panel);
  check(vis.shown.length === 1 && vis.shown[0] === panel, `the ${tab} tab shows only ${tab}`);
  check(tab === 'diagram' ? vis.legend !== 'none' : vis.legend === 'none',
    `the legend ${tab === 'diagram' ? 'returns with' : 'leaves with'} the diagram`);
}
const drift = await report.evaluate(() => {
  const el = document.querySelector('#drift .rb');
  if (!el) return null;
  el.querySelector('summary').click();
  return { open: el.open, lines: el.querySelectorAll('.ln').length, stats: document.querySelectorAll('#drift .stat').length };
});
console.log('  drift tab:', JSON.stringify(drift));
check(drift && drift.open && drift.lines > 0, 'a drift resource expands to its line diff');
check(drift && drift.stats === 8, 'the drift tab carries the full count row');
await report.close();

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
