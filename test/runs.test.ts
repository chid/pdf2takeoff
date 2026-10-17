// Run lengths by line style on a synthetic site plan: one service stroked
// with a PDF dash pattern, another pre-broken into separate dash paths the
// way CAD exporters write them (corner dash split in two, letters in the
// gaps), plus look-alikes in other colours and widths that must not count.
// Runs the CLI like headless.test.ts.
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, rgb, type PDFPage } from 'pdf-lib';

const CLI = join(import.meta.dirname, '..', 'bin', 'pdf2takeoff.js');
const blue = rgb(0, 0, 0.78);
const red = rgb(0.88, 0.14, 0.12);
const black = rgb(0, 0, 0);

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

type XY = [number, number];

/** A polyline pre-broken into dash paths (dash on, gap off, from its start),
 *  a dash that runs round a corner split into one path per leg. Returns the
 *  length from the first dash's start to the last dash's end. */
function brokenDashes(page: PDFPage, line: XY[], dash: number, gap: number, color = red, thickness = 0.3): number {
  const legs = line.slice(1).map((b, i) => {
    const a = line[i];
    return { a, b, len: Math.hypot(b[0] - a[0], b[1] - a[1]) };
  });
  const total = legs.reduce((s, l) => s + l.len, 0);
  const at = (s: number): { p: XY; leg: number } => {
    let rest = s;
    for (let i = 0; i < legs.length; i++) {
      const { a, b, len } = legs[i];
      if (rest <= len || i === legs.length - 1) {
        const t = rest / len;
        return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], leg: i };
      }
      rest -= len;
    }
    throw new Error('unreachable');
  };
  let end = 0;
  for (let s = 0; s < total; s += dash + gap) {
    const e = Math.min(s + dash, total);
    const from = at(s);
    const to = at(e);
    const pts: XY[] = [from.p];
    for (let leg = from.leg; leg < to.leg; leg++) pts.push(legs[leg].b);
    pts.push(to.p);
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i - 1];
      const [x2, y2] = pts[i];
      if (Math.hypot(x2 - x1, y2 - y1) > 1e-9) page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color });
    }
    end = e;
  }
  return end;
}

/** A sideways "E" centred in a horizontal line's gap, as a sewer or power
 *  line labels itself: spine across the line, bars along it. */
function letterE(page: PDFPage, x: number, y: number) {
  const stroke = (x1: number, y1: number, x2: number, y2: number) =>
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.3, color: red });
  stroke(x - 0.8, y - 1.4, x - 0.8, y + 1.4);
  stroke(x - 0.8, y - 1.4, x + 0.8, y - 1.4);
  stroke(x - 0.8, y, x + 0.8, y);
  stroke(x - 0.8, y + 1.4, x + 0.8, y + 1.4);
}

async function sitePlan(): Promise<{ file: string; red: number }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([1191, 842]);

  // stormwater: blue, stroked with a dash pattern; an L (two strokes meeting
  // at the corner) and a separate straight run: 300 + 200 + 200 pt
  const dashed = { thickness: 0.3, color: blue, dashArray: [6, 4] };
  page.drawLine({ start: { x: 100, y: 100 }, end: { x: 400, y: 100 }, ...dashed });
  page.drawLine({ start: { x: 400, y: 100 }, end: { x: 400, y: 300 }, ...dashed });
  page.drawLine({ start: { x: 600, y: 100 }, end: { x: 800, y: 100 }, ...dashed });
  // a pit on the line: a closed shape, not pipe
  page.drawCircle({ x: 600, y: 100, size: 4, borderColor: blue, borderWidth: 0.3 });

  // sewer: red, every dash its own path, round a corner, letters in some gaps
  const sewer = brokenDashes(page, [[100, 500], [503, 500], [503, 300]], 6, 4);
  for (const x of [148, 248, 348]) letterE(page, x, 500);
  const branch = brokenDashes(page, [[100, 700], [300, 700]], 6, 4);

  // look-alikes that must not count: a wider red dashed line, a solid black
  // boundary and a blue line drawn solid in another width
  brokenDashes(page, [[100, 600], [500, 600]], 6, 4, red, 1);
  page.drawRectangle({ x: 50, y: 50, width: 1000, height: 740, borderColor: black, borderWidth: 1.4 });
  page.drawLine({ start: { x: 100, y: 150 }, end: { x: 400, y: 150 }, thickness: 0.6, color: blue });

  const file = join(mkdtempSync(join(tmpdir(), 'p2t-')), 'runs-sheet.pdf');
  writeFileSync(file, await doc.save());
  return { file, red: sewer + branch };
}

function runs(file: string, at: string, ...extra: string[]) {
  const r = cli('runs', file, '--page', '1', '--at', at, ...extra);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('runs measures a line stroked with a dash pattern, corners joined', async () => {
  const { file } = await sitePlan();
  const out = runs(file, '250,100.5', '--scale', '1:100');
  assert.equal(out.style.stroke, '#0000c7');
  assert.deepEqual(out.style.dash, [6, 4]);
  assert.equal(out.count, 2);
  assert.ok(Math.abs(out.runs[0].lengthPt - 500) < 0.01, `L run ${out.runs[0].lengthPt}`);
  assert.ok(Math.abs(out.runs[1].lengthPt - 200) < 0.01, `straight run ${out.runs[1].lengthPt}`);
  assert.ok(Math.abs(out.totalPt - 700) < 0.01);
  // 1:100: 700 pt = 700 / 72 * 25.4 mm on paper = 24.694 m
  assert.ok(Math.abs(out.totalMeters - 24.694) < 0.001, `total ${out.totalMeters} m`);
});

test('runs joins pre-broken dashes across gaps, corners and letters', async () => {
  const { file, red: expected } = await sitePlan();
  // 603 + 196 pt: each run from its first dash's start to its last dash's
  // end (the sewer's last dash is cut short by the line's end, and the dash
  // at 400-406 pt along it turns the corner at 403)
  assert.ok(Math.abs(expected - 799) < 1e-6);
  for (const at of ['103,500', '108,500.5']) {
    // on a dash, and in a gap between two
    const out = runs(file, at);
    assert.equal(out.style.width, 0.3);
    assert.deepEqual(out.style.dash, []);
    assert.equal(out.count, 2, JSON.stringify(out.runs.map((r: { lengthPt: number }) => r.lengthPt)));
    assert.ok(Math.abs(out.runs[0].lengthPt - 603) < 0.01, `sewer ${out.runs[0].lengthPt}`);
    assert.ok(Math.abs(out.runs[1].lengthPt - 196) < 0.01, `branch ${out.runs[1].lengthPt}`);
    assert.ok(Math.abs(out.totalPt - expected) < 0.01);
    assert.ok(!('totalMeters' in out), 'no metres without --scale');
  }
});

test('runs keeps lines of another width apart', async () => {
  const { file } = await sitePlan();
  const out = runs(file, '200,600');
  assert.equal(out.style.width, 1);
  assert.equal(out.count, 1);
  assert.ok(Math.abs(out.totalPt - 396) < 0.01, `wide red ${out.totalPt}`);
});

test('runs reports a click off every line', async () => {
  const { file } = await sitePlan();
  const r = cli('runs', file, '--page', '1', '--at', '900,450');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /click directly on a line/);
});
