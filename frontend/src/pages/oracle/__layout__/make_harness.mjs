/* Build a standalone page that renders the real topology markup against the
   real compiled stylesheets, so the layout can be measured rather than
   assumed. The markup mirrors the component's output for a two-node cluster;
   what is under test is the CSS and the grid, which is where the collision
   was. */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const DIST = 'E:/ACTMON V1/frontend/dist/assets';
const css = readdirSync(DIST)
  .filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(`${DIST}/${f}`, 'utf8'))
  .join('\n');

const node = (name, host, ip, border, n, sel) => `
  <div class="min-w-0 flex-1 rounded-2xl bg-surface p-card shadow-sm" data-node="${n}"
       style="border:2px solid ${border}">
    <header class="flex items-start gap-3">
      <span class="grid h-11 w-11 shrink-0 place-items-center rounded-xl" style="background:rgba(34,197,94,.12)"></span>
      <span class="min-w-0 flex-1">
        <span class="block truncate-safe text-[21px] font-black leading-tight text-fg">${name}</span>
        <span class="block truncate-safe text-[13px] font-semibold text-muted">${host}</span>
        <span class="block truncate-safe font-mono text-[13px] text-subtle">${ip}</span>
      </span>
      <span class="flex shrink-0 items-center gap-1">
        <span class="inline-flex items-center gap-1 rounded-full font-semibold whitespace-nowrap px-2 py-0.5 text-[11px] bg-neutral-soft text-muted">Node ${n}</span>
        <button class="h-7 w-7" data-ctl="${n}"></button>
      </span>
    </header>
    <div class="mt-gutter-sm flex flex-wrap gap-2">
      ${['Instance|OPEN', 'DB Status|ACTIVE', 'OS Status|Online'].map((b) => {
        const [l, v] = b.split('|');
        return `<div class="min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 py-2" data-state="${n}">
          <span class="flex items-center gap-1.5"><span style="width:8px;height:8px;background:#22C55E" class="inline-block shrink-0 rounded-full"></span>
          <span class="truncate-safe text-[12px] font-semibold text-muted">${l}</span></span>
          <span class="mt-0.5 block truncate-safe text-[15px] font-black text-fg">${v}</span></div>`;
      }).join('')}
    </div>
    <div class="mt-gutter-sm flex flex-wrap items-start divide-x divide-border border-t border-border pt-gutter-sm">
      ${['cpu|CPU|8%', 'ram|RAM|68%', 'disk|Disk|88%', 'up|Uptime|5d 7h'].map((m) => {
        const [k, l, v] = m.split('|');
        return `<div class="min-w-0 flex-1 px-3" data-metric="${n}-${k}">
          <span class="flex items-center gap-1.5 text-[12px] font-semibold text-muted">${l}</span>
          <span class="mt-0.5 block text-[17px] font-black leading-tight">${v}</span>
          <span class="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-sunken"></span></div>`;
      }).join('')}
    </div>
  </div>`;

const html = `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RAC topology layout harness</title>
<style>${css}</style>
<style>body{margin:0}#root{padding:16px}</style>
</head><body><div id="root">
<div class="rounded-2xl border border-border bg-bg-subtle p-card" data-root>
  <header class="flex flex-wrap items-center gap-x-4 gap-y-2.5" data-header>
    <span class="flex min-w-0 items-center gap-2.5">
      <span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-softer"></span>
      <h3 class="text-[20px] font-black text-fg">RAC Cluster Topology</h3>
      <span class="inline-flex items-center gap-1 rounded-full font-semibold whitespace-nowrap px-2 py-0.5 bg-accent-soft text-accent-text">2 Nodes</span>
    </span>
  </header>

  <div class="rac-grid mt-gutter" data-noderow>
    ${node('KCDB1', 'koebomebspatdb01', '10.240.72.239', '#22C55E', 1, true)}
    <div class="rac-interconnect" data-inter>
      <span class="text-[13px] font-bold leading-tight text-fg" data-label="title">RAC Interconnect</span>
      <span class="rac-interconnect-line" data-rail-line>
        <span class="grid h-5 w-5 shrink-0 place-items-center rounded bg-accent-softer"></span>
        <span class="rac-rail"><span class="rac-rail-dot"></span></span>
        <span class="grid h-5 w-5 shrink-0 place-items-center rounded bg-accent-softer"></span>
      </span>
      <span class="inline-flex max-w-full items-center gap-1 truncate rounded-full border border-accent-border bg-accent-softer px-2.5 py-1 text-[12px] font-bold text-accent-text" data-label="pill">Private Network</span>
      <span class="text-[11px] leading-tight text-subtle" data-label="caption">Cache fusion between instances</span>
    </div>
    ${node('KCDB2', 'koebomebspatdb02', '10.240.72.78', '#3B82F6', 2, false)}
  </div>

  <div class="rac-grid rac-connectors" data-connrow>
    <span class="rac-conn rac-conn--left"></span>
    <span class="rac-conn rac-conn--mid"></span>
    <span class="rac-conn rac-conn--right"></span>
  </div>

  <div class="flex justify-center" data-storagerow>
    <div class="w-full max-w-[36rem] rounded-2xl border border-border bg-surface p-card shadow-sm" data-storage>
      <header class="flex flex-wrap items-center gap-3">
        <span class="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent-softer"></span>
        <span class="min-w-0 flex-1">
          <span class="block text-[17px] font-black leading-tight text-fg">Shared ASM Storage</span>
          <span class="block text-[13px] font-semibold text-balance text-muted">ASM disk groups accessible by all instances</span>
        </span>
      </header>
      <div class="mt-gutter-sm flex flex-wrap gap-2.5">
        <div class="flex min-w-[15rem] flex-1 items-center gap-2.5 rounded-xl border border-border bg-sunken px-3 py-2.5">+DATA</div>
        <div class="flex min-w-[15rem] flex-1 items-center gap-2.5 rounded-xl border border-border bg-sunken px-3 py-2.5">+RECO</div>
      </div>
    </div>
  </div>

  <div class="mt-gutter flex flex-wrap items-center gap-x-gutter gap-y-2.5 rounded-2xl border border-border bg-surface px-card py-2.5" data-legend>
    <span class="text-[12px] font-bold text-muted">Legend:</span>
    <span class="text-[12px] font-bold text-fg">RAC Node</span>
    <span class="text-[12px] font-bold text-fg">RAC Interconnect</span>
    <span class="text-[12px] font-bold text-fg">Shared Storage</span>
  </div>
</div>
</div></body></html>`;

writeFileSync(process.argv[2], html);
console.log('harness written:', process.argv[2]);
