// Vector scan on drawings shaped like real ones: copies of a block placed
// rotated, run into by a wall, or labelled right against the outline, next to
// a look-alike that shares the outline. Runs the CLI like headless.test.ts.
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PDFDocument,
  StandardFonts,
  concatTransformationMatrix,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type PDFPage,
} from 'pdf-lib';

const CLI = join(import.meta.dirname, '..', 'bin', 'pdf2takeoff.js');
const black = rgb(0, 0, 0);

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

/** A CAD-style block: drawn about its own origin, placed with a transform,
 *  so a turned copy turns every path in it. */
function place(page: PDFPage, x: number, y: number, quarterTurns: number, draw: () => void) {
  const [c, s] = [[1, 0], [0, 1], [-1, 0], [0, -1]][quarterTurns % 4];
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(c, s, -s, c, x, y));
  draw();
  page.pushOperators(popGraphicsState());
}

const line = (page: PDFPage, x1: number, y1: number, x2: number, y2: number) =>
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.7, color: black });

/** Light fitting: circle with a diagonal cross and a dot in one quadrant
 *  (so a quarter turn is a different picture). */
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

async function sheet(): Promise<string> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([1191, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // walls, a room and a grid line the symbols sit against
  line(page, 100, 200, 1000, 200);
  line(page, 100, 200, 100, 700);
  line(page, 100, 700, 1000, 700);
  page.drawRectangle({ x: 600, y: 300, width: 300, height: 250, borderColor: black, borderWidth: 2 });

  place(page, 200, 400, 0, fitting(page));
  place(page, 300, 400, 0, fitting(page));
  place(page, 400, 400, 1, fitting(page)); // turned a quarter
  place(page, 500, 400, 2, fitting(page)); // turned a half
  place(page, 600, 450, 0, fitting(page)); // centred on the room's wall
  place(page, 300, 600, 0, fitting(page));
  page.drawText('L1', { x: 308, y: 596, size: 9, font, color: black }); // label on the outline
  place(page, 200, 600, 0, plus(page));
  place(page, 750, 620, 0, plus(page));

  const file = join(mkdtempSync(join(tmpdir(), 'p2t-')), 'vector-sheet.pdf');
  writeFileSync(file, await doc.save());
  return file;
}

test('vector scan counts every copy of a block, however placed', async () => {
  const file = await sheet();
  const r = cli('scan', file, '--page', '1', '--at', '203,403');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.provider, 'vector');
  assert.equal(out.count, 6);
});

test('vector scan tells a look-alike sharing the outline apart', async () => {
  const file = await sheet();
  const r = cli('scan', file, '--page', '1', '--at', '200,605');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.provider, 'vector');
  assert.equal(out.count, 2);
});
