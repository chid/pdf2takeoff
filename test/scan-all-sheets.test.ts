// Teach once, count every sheet: `scan --all-pages` teaches the symbol on
// --page and counts that symbol on every sheet, wherever it sits, not
// whatever happens to be under the same point on the other sheets. Covers
// the vector tier (CAD blocks) and the raster tier (symbols drawn as images).
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, concatTransformationMatrix, popGraphicsState, pushGraphicsState, rgb, type PDFImage, type PDFPage } from 'pdf-lib';

const CLI = join(import.meta.dirname, '..', 'bin', 'pdf2takeoff.js');
const black = rgb(0, 0, 0);

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

function place(page: PDFPage, x: number, y: number, quarterTurns: number, draw: () => void) {
  const [c, s] = [[1, 0], [0, 1], [-1, 0], [0, -1]][quarterTurns % 4];
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(c, s, -s, c, x, y));
  draw();
  page.pushOperators(popGraphicsState());
}

const line = (page: PDFPage, x1: number, y1: number, x2: number, y2: number) =>
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.7, color: black });

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

/** Walls the symbols sit among, the same on every sheet. */
function walls(page: PDFPage) {
  line(page, 100, 200, 1000, 200);
  line(page, 100, 200, 100, 700);
  line(page, 100, 700, 1000, 700);
}

async function save(doc: PDFDocument, name: string): Promise<string> {
  const file = join(mkdtempSync(join(tmpdir(), 'p2t-')), name);
  writeFileSync(file, await doc.save());
  return file;
}

/** p1: 3 fittings (one taught at 200,400); p2: 4 fittings elsewhere, nothing
 *  at 200,400; p3: look-alikes only, one right at 200,400. */
async function vectorSet(): Promise<string> {
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([1191, 842]);
  walls(p1);
  place(p1, 200, 400, 0, fitting(p1));
  place(p1, 300, 400, 0, fitting(p1));
  place(p1, 500, 600, 1, fitting(p1));

  const p2 = doc.addPage([1191, 842]);
  walls(p2);
  place(p2, 250, 300, 0, fitting(p2));
  place(p2, 650, 300, 2, fitting(p2));
  place(p2, 650, 500, 3, fitting(p2));
  place(p2, 900, 650, 0, fitting(p2));

  const p3 = doc.addPage([1191, 842]);
  walls(p3);
  place(p3, 200, 400, 0, plus(p3));
  place(p3, 700, 400, 0, plus(p3));
  return save(doc, 'vector-set.pdf');
}

test('all-pages counts the taught vector symbol on every sheet, not the click point', async () => {
  const file = await vectorSet();
  const r = cli('scan', file, '--page', '1', '--at', '203,403', '--all-pages');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.pages.map((p: { count: number }) => p.count), [3, 4, 0]);
  assert.equal(out.provider, 'vector');
  assert.equal(out.taughtOn, 1);
  assert.equal(out.total, 7);
  // the hits are the copies on each sheet, not the click point
  assert.deepEqual(
    out.pages[1].hits.map((h: { x: number; y: number }) => [Math.round(h.x), Math.round(h.y)]).sort(),
    [[250, 300], [650, 300], [650, 500], [900, 650]].sort(),
  );
});

test('all-pages teaches on --page', async () => {
  const file = await vectorSet();
  // a fitting on p2; p1 has nothing at this point
  const r = cli('scan', file, '--page', '2', '--at', '903,653', '--all-pages');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.pages.map((p: { count: number }) => p.count), [3, 4, 0]);
  assert.equal(out.taughtOn, 2);
});

test('all-pages fails clearly when the click teaches nothing', async () => {
  const file = await vectorSet();
  const r = cli('scan', file, '--page', '1', '--at', '800,780', '--all-pages');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /page 1: click directly on a symbol/);
});

/** A symbol drawn as an image, so only the raster tier can see it. */
function symbolPng(kind: 'fitting' | 'box'): Uint8Array {
  const S = 60;
  const cnv = createCanvas(S, S);
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#000';
  ctx.lineWidth = 3;
  if (kind === 'fitting') {
    ctx.beginPath();
    ctx.arc(30, 30, 24, 0, Math.PI * 2);
    ctx.moveTo(13, 13);
    ctx.lineTo(47, 47);
    ctx.moveTo(13, 47);
    ctx.lineTo(47, 13);
    ctx.stroke();
    ctx.fillRect(38, 22, 8, 5);
  } else {
    ctx.strokeRect(8, 8, 44, 44);
    ctx.fillRect(22, 22, 16, 16);
  }
  return cnv.toBuffer('image/png');
}

/** p1: 2 image fittings (one taught at 200,400); p2: 3 elsewhere; p3: a
 *  different image right at 200,400. */
async function rasterSet(): Promise<string> {
  const doc = await PDFDocument.create();
  const fit = await doc.embedPng(symbolPng('fitting'));
  const box = await doc.embedPng(symbolPng('box'));
  const put = (page: PDFPage, img: PDFImage, x: number, y: number) => page.drawImage(img, { x: x - 10, y: y - 10, width: 20, height: 20 });
  const p1 = doc.addPage([842, 595]);
  put(p1, fit, 200, 400);
  put(p1, fit, 400, 300);
  const p2 = doc.addPage([842, 595]);
  put(p2, fit, 150, 150);
  put(p2, fit, 600, 450);
  put(p2, fit, 700, 200);
  const p3 = doc.addPage([842, 595]);
  put(p3, box, 200, 400);
  return save(doc, 'raster-set.pdf');
}

test('all-pages carries a raster-tier template across sheets', async () => {
  const file = await rasterSet();
  const r = cli('scan', file, '--page', '1', '--at', '200,410', '--all-pages');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.pages.map((p: { count: number }) => p.count), [2, 3, 0]);
  assert.equal(out.provider, 'cv');
  assert.equal(out.total, 5);
});
