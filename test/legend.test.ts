// Legend-driven schedules: `pdf2takeoff legend` reads a sheet's KEY block,
// teaches the scan from each symbol swatch and counts it on the sheet (or
// every sheet), leaving the legend's own sample out. Line styles are listed,
// text-coded rows come back unmatched, and look-alikes, a "KEY PLAN" title
// and a legend heading without swatches don't count.
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, concatTransformationMatrix, popGraphicsState, pushGraphicsState, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { isLegendHeading } from '../src/engine/legend.ts';

const CLI = join(import.meta.dirname, '..', 'bin', 'pdf2takeoff.js');
const black = rgb(0, 0, 0);

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Draw in a frame at (x, y) turned by quarter turns. */
function place(page: PDFPage, x: number, y: number, quarterTurns: number, draw: () => void) {
  const [c, s] = [[1, 0], [0, 1], [-1, 0], [0, -1]][quarterTurns % 4];
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(c, s, -s, c, x, y));
  draw();
  page.pushOperators(popGraphicsState());
}

const line = (page: PDFPage, x1: number, y1: number, x2: number, y2: number, thickness = 0.7) =>
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color: black });

/** Light fitting: circle, diagonal cross, a dot in one quadrant. */
const fitting = (page: PDFPage) => () => {
  page.drawCircle({ x: 0, y: 0, size: 8, borderColor: black, borderWidth: 0.7 });
  line(page, -5.6, -5.6, 5.6, 5.6);
  line(page, -5.6, 5.6, 5.6, -5.6);
  page.drawRectangle({ x: 2.5, y: 0.5, width: 2, height: 1.2, color: black });
};

/** Look-alike: same circle, upright cross. */
const plus = (page: PDFPage) => () => {
  page.drawCircle({ x: 0, y: 0, size: 8, borderColor: black, borderWidth: 0.7 });
  line(page, -8, 0, 8, 0);
  line(page, 0, -8, 0, 8);
};

/** Stormwater pit: a 10 x 10 box with one diagonal. */
const pit = (page: PDFPage) => () => {
  page.drawRectangle({ x: -5, y: -5, width: 10, height: 10, borderColor: black, borderWidth: 0.7 });
  line(page, -5, -5, 5, 5);
};

/** One sheet, drawn in local coordinates (1191 x 842): walls, 3 fittings,
 *  2 pits, a look-alike, and a KEY block with a sample of each plus a
 *  dashed line style and a text-coded row. Decoys: a "KEY PLAN" title and
 *  a "SYMBOL LEGEND" heading over plain notes. */
function sheet(page: PDFPage, font: PDFFont) {
  const text = (str: string, x: number, y: number, size = 7) => page.drawText(str, { x, y, size, font, color: black });
  line(page, 100, 200, 900, 200);
  line(page, 100, 200, 100, 700);
  line(page, 100, 700, 900, 700);
  place(page, 200, 400, 0, fitting(page));
  place(page, 300, 400, 0, fitting(page));
  place(page, 500, 600, 1, fitting(page));
  place(page, 400, 300, 0, pit(page));
  place(page, 700, 300, 1, pit(page));
  place(page, 600, 450, 0, plus(page));
  // a services line running past the pits
  for (let x = 380; x < 720; x += 6) line(page, x, 300, x + 4, 300);

  // KEY block: heading, then [swatch, label] rows 24pt apart
  text('KEY', 950, 300, 9);
  for (let x = 950; x < 975; x += 6) line(page, x, 278, x + 4, 278);
  text('SEWER MAIN', 985, 276);
  place(page, 962, 254.5, 0, fitting(page));
  text('LIGHT FITTING', 985, 252);
  place(page, 962, 230.5, 0, pit(page));
  text('STORMWATER PIT', 985, 228);
  text('WC', 952, 204);
  text('WATER CLOSET', 985, 204);

  // decoys
  text('KEY PLAN', 980, 760, 9);
  page.drawRectangle({ x: 980, y: 700, width: 60, height: 40, borderColor: black, borderWidth: 0.5 });
  text('SYMBOL LEGEND', 120, 160, 9);
  text('SEE GENERAL NOTES', 120, 140);
  text('ALL WORK TO AS3500', 120, 128);
}

async function legendSet(): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // p1: the sheet as drawn
  sheet(doc.addPage([1191, 842]), font);
  // p2: no legend; 2 fittings and a pit elsewhere
  const p2 = doc.addPage([1191, 842]);
  place(p2, 250, 300, 0, fitting(p2));
  place(p2, 650, 500, 2, fitting(p2));
  place(p2, 800, 200, 0, pit(p2));
  // p3: the p1 sheet drawn a quarter turn round (portrait page, text running up)
  const p3 = doc.addPage([842, 1191]);
  place(p3, 842, 0, 1, () => sheet(p3, font));
  const file = join(mkdtempSync(join(tmpdir(), 'p2t-legend-')), 'legend-set.pdf');
  writeFileSync(file, await doc.save());
  return file;
}

type Out = {
  legendsFound: number;
  schedule: { label: string; count: number; pages?: { page: number; count: number }[]; hits: { page: number; x: number; y: number }[] }[];
  lines: { label: string }[];
  unmatched: { label: string; kind: string; reason: string; code?: string }[];
  legends: { heading: string; rows: { label: string; kind: string }[] }[];
};

function run(...args: string[]): Out {
  const r = cli('legend', ...args);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const counts = (out: Out) => Object.fromEntries(out.schedule.map((s) => [s.label, s.count]));

test('legend headings: KEY / LEGEND / SYMBOLS, never a key plan or a drawing schedule', () => {
  for (const h of ['KEY', 'LEGEND:', 'K E Y', 'SYMBOL LEGEND', 'LEGEND & NOTES', 'ELECTRICAL SYMBOLS', 'DRAINAGE SCHEDULE']) {
    assert.ok(isLegendHeading(h.replace(/(\S) (?=\S( |$))/g, '$1')), h);
  }
  for (const h of ['KEY PLAN', 'KEYNOTES APPLY', 'DRAWING SCHEDULE', 'DOOR SCHEDULE', 'SITE PLAN']) {
    assert.ok(!isLegendHeading(h), h);
  }
});

test('legend schedules each keyed symbol on the sheet, without the legend sample', async () => {
  const file = await legendSet();
  const out = run(file, '--page', '1');
  assert.equal(out.legendsFound, 1, 'the KEY block only: not KEY PLAN, not a swatchless SYMBOL LEGEND');
  assert.equal(out.legends[0].heading, 'KEY');
  assert.deepEqual(
    out.legends[0].rows.map((r) => [r.label, r.kind]),
    [
      ['SEWER MAIN', 'line'],
      ['LIGHT FITTING', 'symbol'],
      ['STORMWATER PIT', 'symbol'],
      ['WATER CLOSET', 'code'],
    ],
  );
  // 3 fittings (one turned), 2 pits (one turned); not the look-alike, not the samples
  assert.deepEqual(counts(out), { 'LIGHT FITTING': 3, 'STORMWATER PIT': 2 });
  const fit = out.schedule.find((s) => s.label === 'LIGHT FITTING')!;
  assert.deepEqual(fit.hits.map((h) => [Math.round(h.x), Math.round(h.y)]).sort(), [[200, 400], [300, 400], [500, 600]].sort());
  assert.ok(out.schedule.every((s) => s.hits.every((h) => h.x < 900)), 'no hit inside the legend');
  assert.deepEqual(out.lines.map((l) => l.label), ['SEWER MAIN']);
  assert.equal(out.unmatched.length, 1);
  assert.equal(out.unmatched[0].label, 'WATER CLOSET');
  assert.equal(out.unmatched[0].code, 'WC');
  assert.match(out.unmatched[0].reason, /text code/);
});

test('legend --all-pages counts every keyed symbol on every sheet', async () => {
  const file = await legendSet();
  const out = run(file, '--all-pages');
  // the p1 and p3 keys are the same legend: each symbol is scheduled once,
  // from p1, and counted on all three sheets
  assert.equal(out.legendsFound, 2);
  assert.deepEqual(counts(out), { 'LIGHT FITTING': 8, 'STORMWATER PIT': 5 });
  const fit = out.schedule.find((s) => s.label === 'LIGHT FITTING')!;
  assert.deepEqual(fit.pages, [
    { page: 1, count: 3 },
    { page: 2, count: 2 },
    { page: 3, count: 3 },
  ]);
});

test('legend reads a key whose text runs up the page', async () => {
  const file = await legendSet();
  const out = run(file, '--page', '3');
  assert.equal(out.legendsFound, 1);
  assert.deepEqual(counts(out), { 'LIGHT FITTING': 3, 'STORMWATER PIT': 2 });
  assert.deepEqual(out.lines.map((l) => l.label), ['SEWER MAIN']);
});

test('legend reports no legend on a sheet without one', async () => {
  const file = await legendSet();
  const out = run(file, '--page', '2');
  assert.equal(out.legendsFound, 0);
  assert.deepEqual(out.schedule, []);
});
