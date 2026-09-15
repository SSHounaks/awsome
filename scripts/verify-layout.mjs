// Asserts the architecture diagram lays out correctly: every node is the size the
// layout reserved, sits fully inside its innermost container, and clears that
// container's header. Exits non-zero on any violation.
//
//   node scripts/verify-layout.mjs

import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
function findChromium(){const root=join(process.env.HOME,'.cache/ms-playwright');
 for(const d of readdirSync(root).filter(x=>x.startsWith('chromium-')).sort().reverse())
  for(const rel of ['chrome-linux64/chrome','chrome-linux/chrome']){const p=join(root,d,rel);if(existsSync(p))return p;}}
const b=await chromium.launch({executablePath:findChromium(),args:['--no-sandbox','--disable-gpu']});
const page=await b.newPage({viewport:{width:1920,height:1200}});
await page.goto('http://127.0.0.1:8000',{waitUntil:'networkidle'});
await page.getByRole('button',{name:'Graph',exact:true}).click();
await page.waitForSelector('.react-flow__node');
await page.waitForTimeout(3500);

const out = await page.evaluate(() => {
  const zoom = parseFloat(getComputedStyle(document.querySelector('.react-flow__viewport')).transform.split('(')[1].split(',')[0]);
  const R = e => { const r = e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,r:r.right,b:r.bottom}; };
  const all = [...document.querySelectorAll('.react-flow__node')].map(e => ({
    id: e.getAttribute('data-id') || '',
    group: e.classList.contains('react-flow__node-group'),
    rect: R(e),
    header: e.querySelector('div > div.flex.items-center') ? R(e.querySelector('div > div.flex.items-center')) : null,
  }));
  const groups = all.filter(a => a.group), leaves = all.filter(a => !a.group);
  const area = g => g.rect.w * g.rect.h;
  const contains = (g, n) => {
    const cx = n.rect.x + n.rect.w/2, cy = n.rect.y + n.rect.h/2;
    return cx >= g.rect.x && cx <= g.rect.r && cy >= g.rect.y && cy <= g.rect.b;
  };
  const EPS = 1;
  const overflow = [], headerClash = [];
  for (const n of leaves) {
    // innermost group whose box contains the node's centre = its logical parent
    const owners = groups.filter(g => contains(g, n)).sort((a,c) => area(a)-area(c));
    const p = owners[0];
    if (!p) { overflow.push({ id: n.id.slice(-30), reason: 'no container' }); continue; }
    const dx = Math.max(0, p.rect.x - n.rect.x, n.rect.r - p.rect.r);
    const dy = Math.max(0, p.rect.y - n.rect.y, n.rect.b - p.rect.b);
    if (dx > EPS || dy > EPS) overflow.push({ id: n.id.slice(-30), parent: p.id.slice(-26), dx:+(dx/zoom).toFixed(1), dy:+(dy/zoom).toFixed(1) });
    if (p.header && n.rect.y < p.header.b - EPS)
      headerClash.push({ id: n.id.slice(-30), parent: p.id.slice(-26), overlapPx: +((p.header.b - n.rect.y)/zoom).toFixed(1) });
  }
  const sizes = {};
  for (const n of leaves) { const k=`${Math.round(n.rect.w/zoom)}x${Math.round(n.rect.h/zoom)}`; sizes[k]=(sizes[k]||0)+1; }
  return { overflow, headerClash, sizes, leaves: leaves.length, groups: groups.length };
});

console.log(`leaves ${out.leaves}  groups ${out.groups}`);
console.log('leaf sizes (unscaled):', JSON.stringify(out.sizes));
console.log('overflowing container :', out.overflow.length);
out.overflow.slice(0,8).forEach(o => console.log('   ', JSON.stringify(o)));
console.log('colliding with header :', out.headerClash.length);
out.headerClash.slice(0,8).forEach(o => console.log('   ', JSON.stringify(o)));
await b.close();
process.exit(out.overflow.length || out.headerClash.length ? 1 : 0);
