// Near-exact vector matching: copies of a symbol that can't be traced
// exactly (a circle drawn as Béziers in one copy and as a polygon in
// another, or as a ring of loose segments; the same block on a sheet drawn
// at another scale) are found as near hits, ranked after exact ones and
// flagged for checking, while look-alikes that share the outline stay out.
// Runs the CLI like headless.test.ts.
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, concatTransformationMatrix, popGraphicsState, pushGraphicsState, rgb, type PDFPage } from 'pdf-lib';

const CLI = join(import.meta.dirname, '..', 'bin', 'pdf2takeoff.js');
const black = rgb(0, 0, 0);

function scan(file: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, 'scan', file, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

/** A block drawn about its own origin, placed (and scaled) with a transform. */
function place(page: PDFPage, x: number, y: number, scale: number, draw: () => void) {
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(scale, 0, 0, scale, x, y));
  draw();
  page.pushOperators(popGraphicsState());
}

const line = (page: PDFPage, x1: number, y1: number, x2: number, y2: number, thickness = 0.7) =>
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color: black });

/** A circle as an n-gon, one closed path. */
function polygon(page: PDFPage, r: number, n: number, phase = 0) {
  let d = '';
  for (let i = 0; i < n; i++) {
    const a = phase + (2 * Math.PI * i) / n;
    d += `${i ? 'L' : 'M'} ${(r * Math.cos(a)).toFixed(3)} ${(r * Math.sin(a)).toFixed(3)} `;
  }
  page.drawSvgPath(d + 'Z', { x: 0, y: 0, borderColor: black, borderWidth: 0.7 });
}

/** A circle as a ring of n separate 2-point paths (some exporters write
 *  every segment on its own). */
function ring(page: PDFPage, r: number, n: number) {
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    const b = (2 * Math.PI * (i + 1)) / n;
    line(page, r * Math.cos(a), r * Math.sin(a), r * Math.cos(b), r * Math.sin(b));
  }
}

/** Light fitting: a circle, a diagonal cross and a dot in one quadrant;
 *  `circle` draws the outline however this copy was exported. */
const fitting = (page: PDFPage, circle: () => void) => () => {
  circle();
  line(page, -5.6, -5.6, 5.6, 5.6);
  line(page, -5.6, 5.6, 5.6, -5.6);
  page.drawRectangle({ x: 2.5, y: 0.5, width: 2, height: 1.2, color: black });
};
const bezier = (page: PDFPage) => () => page.drawCircle({ x: 0, y: 0, size: 8, borderColor: black, borderWidth: 0.7 });

/** Drawing-title bubble: circle, a line through it, a dash above and below. */
const bubble = (page: PDFPage) => () => {
  page.drawCircle({ x: 0, y: 0, size: 14, borderColor: black, borderWidth: 0.9 });
  line(page, -17, 0, 24, 0, 0.9);
  line(page, -1.5, 7, 1.5, 7, 0.9);
  line(page, -1.5, -7, 1.5, -7, 0.9);
};
/** Its look-alike on a services sheet: a pit the same size, a smaller
 *  circle inside and a leader arrow ending at the centre. */
const pit = (page: PDFPage) => () => {
  page.drawCircle({ x: 0, y: 0, size: 14, borderColor: black, borderWidth: 0.9 });
  page.drawCircle({ x: 0, y: 0, size: 9, borderColor: black, borderWidth: 0.9 });
  line(page, 0, 0, 26, 26, 0.6);
  page.drawSvgPath('M 0 0 L 4.5 -1.5 L 1.5 -4.5 Z', { x: 0, y: 0, color: black });
};

async function save(doc: PDFDocument, name: string): Promise<string> {
  const file = join(mkdtempSync(join(tmpdir(), 'p2t-')), name);
  writeFileSync(file, await doc.save());
  return file;
}

function walls(page: PDFPage) {
  line(page, 100, 200, 1000, 200);
  line(page, 100, 200, 100, 700);
  line(page, 100, 700, 1000, 700);
}

test('a circle re-tessellated (polygon, ring of segments) is a near hit', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([1191, 842]);
  walls(page);
  place(page, 200, 400, 1, fitting(page, bezier(page)));
  place(page, 300, 400, 1, fitting(page, bezier(page)));
  place(page, 400, 400, 1, fitting(page, () => polygon(page, 8, 48)));
  place(page, 500, 400, 1, fitting(page, () => polygon(page, 8, 32, 0.05)));
  place(page, 600, 400, 1, fitting(page, () => ring(page, 8, 40)));
  // look-alike: a 48-gon with an upright cross
  place(page, 700, 400, 1, () => {
    polygon(page, 8, 48);
    line(page, -8, 0, 8, 0);
    line(page, 0, -8, 0, 8);
  });
  const file = await save(doc, 'tessellated.pdf');

  const out = scan(file, '--page', '1', '--at', '203,403');
  assert.equal(out.provider, 'vector');
  assert.deepEqual(
    out.hits.map((h: { x: number; match: string }) => [Math.round(h.x), h.match]),
    // the ring of loose segments isn't looked for from a seed drawn with
    // curves (rejoining a sheet's segments costs more than the match)
    [[200, 'exact'], [300, 'exact'], [400, 'near'], [500, 'near']],
    'exact hits first, near ones after',
  );
  assert.equal(out.checks, 2);
  for (const h of out.hits) {
    if (h.match === 'near') assert.ok(h.score < 0.75 && Math.abs(h.scale - 1) < 0.03, JSON.stringify(h));
    else assert.ok(h.score >= 0.75, JSON.stringify(h));
  }
  assert.equal(scan(file, '--page', '1', '--at', '203,403', '--exact-only').count, 2);

  // taught from the ring of segments, the Bézier and polygon copies match
  const fromRing = scan(file, '--page', '1', '--at', '606,402');
  assert.equal(fromRing.provider, 'vector');
  assert.deepEqual(fromRing.hits.map((h: { x: number }) => Math.round(h.x)).sort(), [200, 300, 400, 500, 600]);
});

test('a block at another scale: other sheets yes (one scale a sheet), the clicked sheet only when asked', async () => {
  const doc = await PDFDocument.create();
  // sheet 1: the taught bubble, and a 1.07x one beside it (a different
  // symbol here: same-sheet size differences mean different things)
  const p1 = doc.addPage([1191, 842]);
  walls(p1);
  place(p1, 200, 300, 1, bubble(p1));
  place(p1, 400, 300, 1.07, bubble(p1));
  // sheet 2: drawn at another annotation scale, every bubble 1.07x, and a
  // look-alike pit at that size
  const p2 = doc.addPage([1191, 842]);
  walls(p2);
  place(p2, 200, 300, 1.07, bubble(p2));
  place(p2, 500, 500, 1.07, bubble(p2));
  place(p2, 700, 500, 1.07, pit(p2));
  // sheet 3: the taught size, plus a 0.93x copy: not this sheet's scale
  const p3 = doc.addPage([1191, 842]);
  walls(p3);
  place(p3, 200, 300, 1, bubble(p3));
  place(p3, 600, 300, 0.93, bubble(p3));
  // sheet 4: the pit at the taught size, no bubble at all
  const p4 = doc.addPage([1191, 842]);
  walls(p4);
  place(p4, 300, 300, 1, pit(p4));
  // sheet 5: twice the size is no annotation scale the band allows
  const p5 = doc.addPage([1191, 842]);
  walls(p5);
  place(p5, 300, 300, 2, bubble(p5));
  const file = await save(doc, 'scaled.pdf');

  const out = scan(file, '--page', '1', '--at', '200,300', '--all-pages');
  assert.equal(out.provider, 'vector');
  assert.deepEqual(out.pages.map((p: { count: number }) => p.count), [1, 2, 1, 0, 0]);
  assert.deepEqual(out.pages.map((p: { checks: number }) => p.checks), [0, 2, 0, 0, 0]);
  for (const h of out.pages[1].hits) assert.ok(h.match === 'near' && Math.abs(h.scale - 1.07) < 0.01, JSON.stringify(h));
  assert.ok(out.pages[2].hits[0].match === 'exact' && Math.round(out.pages[2].hits[0].x) === 200);

  // one sheet: the 1.07x bubble only with --scale-tolerant, and flagged
  const one = doc.addPage([1191, 842]);
  walls(one);
  place(one, 200, 300, 1, bubble(one));
  place(one, 300, 300, 1, bubble(one));
  place(one, 400, 300, 1.3, bubble(one));
  place(one, 600, 300, 0.7, bubble(one));
  place(one, 800, 300, 1, pit(one));
  const file2 = await save(doc, 'scaled-one-sheet.pdf');
  assert.equal(scan(file2, '--page', '6', '--at', '200,300').count, 2);
  const tolerant = scan(file2, '--page', '6', '--at', '200,300', '--scale-tolerant');
  assert.equal(tolerant.count, 4);
  assert.equal(tolerant.checks, 2);
  assert.deepEqual(tolerant.hits.map((h: { scale?: number }) => h.scale ?? 1), [1, 1, 1.3, 0.7]);
});

test('a same-size circle with an arrowhead at its centre is not the bubble', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([1191, 842]);
  walls(page);
  place(page, 200, 300, 1, bubble(page));
  place(page, 300, 300, 1, bubble(page));
  place(page, 500, 300, 1, pit(page));
  place(page, 700, 500, 1, pit(page));
  const file = await save(doc, 'pit.pdf');
  const out = scan(file, '--page', '1', '--at', '200,300');
  assert.equal(out.provider, 'vector');
  assert.deepEqual(out.hits.map((h: { x: number }) => Math.round(h.x)), [200, 300]);
});
