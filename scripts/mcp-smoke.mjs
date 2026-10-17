#!/usr/bin/env node
// MCP smoke test: drives the server over real stdio JSON-RPC through the
// full agent workflow — open → render → calibrate → scan → measure →
// export → save → compare. Exits non-zero on the first failed step.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sample = join(root, 'public/examples/sample-floor-plan.pdf');
const revB = join(root, 'public/examples/sample-floor-plan-rev-b.pdf');

const proc = spawn(
  process.execPath,
  ['--experimental-strip-types', join(root, 'src/headless/mcp.ts')],
  { stdio: ['pipe', 'pipe', 'inherit'] },
);

let buf = '';
const pending = new Map();
let seq = 0;
proc.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function request(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 30000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}
const call = (name, args) => request('tools/call', { name, arguments: args });

function check(label, cond, detail = '') {
  if (!cond) {
    console.error(`FAIL: ${label} ${detail}`);
    process.exit(1);
  }
  console.log(`ok: ${label}`);
}
const textOf = (result) => JSON.parse(result.content.find((c) => c.type === 'text').text);

// --- protocol handshake ---
await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'mcp-smoke', version: '0.0.1' },
});
notify('notifications/initialized');
console.log('ok: initialize');

const tools = await request('tools/list', {});
const names = tools.tools.map((t) => t.name);
check('tools/list has all 12 tools', [
  'open_document', 'render_page', 'set_scale', 'read_scale', 'measure', 'scan_symbol',
  'compare_revisions', 'list_markups', 'set_status', 'delete_markup', 'export', 'save_annotated',
].every((n) => names.includes(n)), `got: ${names.join(', ')}`);

const opened = textOf(await call('open_document', { path: sample }));
check('open_document: 2 pages', opened.pageCount === 2);
check('open_document: no prior markups', opened.restoredMarkups === 0);
const docId = opened.id;

const rendered = await call('render_page', { id: docId, page: 1, scale: 1 });
const img = rendered.content.find((c) => c.type === 'image');
check('render_page: image + metadata', !!img && img.mimeType === 'image/png', '');
check('render_page: png bytes plausible', img.data.length > 10000, `base64 len ${img.data?.length}`);
const meta = JSON.parse(rendered.content.find((c) => c.type === 'text' && c.text.startsWith('{')).text);
check('render_page: 842x595pt sheet', meta.widthPt === 842 && meta.heightPt === 595);

const read = textOf(await call('read_scale', { id: docId, page: 1 }));
check('read_scale: title block 1:100 @ A4', read.stated === '1:100' && read.paper === 'A4' && read.effectiveRatio === 100, JSON.stringify(read));

const scale = textOf(await call('set_scale', { id: docId, ratio: '1:100', all_pages: true }));
check('set_scale: applied to all pages', scale.set.length === 2);

const scanned = textOf(await call('scan_symbol', { id: docId, page: 1, at: [88.35, 271.42] }));
check('scan_symbol: 8 downlights (matches browser)', scanned.count === 8, `got ${scanned.count}`);

const measured = textOf(
  await call('measure', { id: docId, page: 1, type: 'length', points: [[60, 90], [400.02, 90]], label: 'External wall' }),
);
check('measure: wall ~11.995 m', Math.abs(measured.value - 11.995) < 0.01, `got ${measured.value}`);
const wallId = measured.markupId;

const listed = textOf(await call('list_markups', { id: docId }));
check('list_markups: 9 rows', listed.markups.length === 9, `got ${listed.markups.length}`);

const statusSet = textOf(await call('set_status', { id: docId, markup_id: wallId, status: 'check' }));
check('set_status: marked for checking', statusSet.status === 'check');
const withStatus = textOf(await call('list_markups', { id: docId }));
check('list_markups: status visible', withStatus.markups.find((m) => m.id === wallId)?.status === 'check');

await call('delete_markup', { id: docId, markup_id: wallId });
const afterDelete = textOf(await call('list_markups', { id: docId }));
check('delete_markup: 8 rows left', afterDelete.markups.length === 8);
// put the wall back for the export
await call('measure', { id: docId, page: 1, type: 'length', points: [[60, 90], [400.02, 90]], label: 'External wall' });

const vol = textOf(
  await call('measure', {
    id: docId, page: 1, type: 'volume', depth: 0.2,
    points: [[60, 90], [173.39, 90], [173.39, 316.77], [60, 316.77]], label: 'Slab',
  }),
);
check('measure: volume ~6.41 m3', Math.abs(vol.value - 6.41) < 0.05, `got ${vol.value}`);

const ang = textOf(
  await call('measure', { id: docId, page: 1, type: 'angle', points: [[60, 90], [200, 90], [60, 200]], label: 'Corner' }),
);
check('measure: angle 90 deg (no calibration needed)', Math.abs(ang.value - 90) < 0.1, `got ${ang.value}`);

const per = textOf(
  await call('measure', {
    id: docId, page: 1, type: 'perimeter',
    points: [[60, 90], [173.39, 90], [173.39, 316.77], [60, 316.77]], label: 'Room boundary',
  }),
);
check('measure: perimeter ~24 m', Math.abs(per.value - 24.0) < 0.1, `got ${per.value}`);

const csvPath = '/tmp/mcp-takeoff.csv';
await call('export', { id: docId, format: 'csv', path: csvPath });
check('export: csv written with groups', existsSync(csvPath) && readFileSync(csvPath, 'utf8').includes('External wall'));

const pdfPath = '/tmp/mcp-annotated.pdf';
const saved = textOf(await call('save_annotated', { id: docId, path: pdfPath }));
check(
  'save_annotated: valid PDF written',
  saved.markups === 12 && existsSync(pdfPath) && readFileSync(pdfPath).subarray(0, 5).toString() === '%PDF-',
);

const compared = textOf(await call('compare_revisions', { a: sample, b: revB }));
check('compare_revisions: both sheets changed', JSON.stringify(compared.changedSheets) === '[1,2]');

// folder mode: batch compare across two revision directories
const dirA = '/tmp/mcp-revA';
const dirB = '/tmp/mcp-revB';
mkdirSync(dirA, { recursive: true });
mkdirSync(dirB, { recursive: true });
copyFileSync(sample, join(dirA, 'A-101.pdf'));
copyFileSync(revB, join(dirB, 'A-101.pdf')); // changed
copyFileSync(sample, join(dirA, 'A-102.pdf'));
copyFileSync(sample, join(dirB, 'A-102.pdf')); // unchanged
const folderCompare = textOf(await call('compare_revisions', { a: dirA, b: dirB }));
check(
  'compare_revisions (folders): 1 changed of 2 pairs',
  folderCompare.totals.pairs === 2 && folderCompare.totals.changed === 1 && folderCompare.totals.unchanged === 1,
  JSON.stringify(folderCompare.totals),
);

proc.kill();
console.log('\nMCP smoke test: all steps passed');
