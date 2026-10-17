// Auto-scale: title-block scale statements, the paper-size correction and
// the dimension cross-check, on synthetic sheets drawn like CAD output
// (ticked dimension chains, a rotated vertical dimension, prose that quotes
// ratios). The CLI runs end to end; the engine's heuristics are checked on
// hand-placed words too. Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { findScaleStatements, paperSizeOf, readSheetScale, type SheetWord } from '../src/engine/scale.ts';
import { findScaleRatio } from '../src/engine/ocr.ts';

const CLI = join(import.meta.dirname, '..', 'bin', 'pdf2takeoff.js');
const black = rgb(0, 0, 0);
const A3: [number, number] = [1190.55, 841.89];
const PT_PER_M = 72 / 0.0254;

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const line = (page: PDFPage, x1: number, y1: number, x2: number, y2: number, thickness = 0.5) =>
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color: black });

/** Horizontal dimension chain at height y: one line per dimension, witness
 *  lines and 45° ticks at every stop, the value centred above. */
function chainH(page: PDFPage, font: PDFFont, x: number, y: number, mm: number[], ratio: number) {
  let at = x;
  const stop = (sx: number) => {
    line(page, sx, y - 8, sx, y + 3);
    line(page, sx - 2, y - 2, sx + 2, y + 2);
  };
  stop(at);
  for (const v of mm) {
    const len = (v / 1000 / ratio) * PT_PER_M;
    line(page, at, y, at + len, y);
    const label = String(v);
    const w = font.widthOfTextAtSize(label, 7);
    page.drawText(label, { x: at + len / 2 - w / 2, y: y + 2, size: 7, font, color: black });
    at += len;
    stop(at);
  }
}

/** Vertical dimension at x, text turned a quarter left (reads bottom-up). */
function dimV(page: PDFPage, font: PDFFont, x: number, y: number, mm: number, ratio: number) {
  const len = (mm / 1000 / ratio) * PT_PER_M;
  line(page, x, y, x, y + len);
  for (const sy of [y, y + len]) {
    line(page, x - 8, sy, x + 3, sy);
    line(page, x - 2, sy - 2, x + 2, sy + 2);
  }
  const label = String(mm);
  const w = font.widthOfTextAtSize(label, 7);
  page.drawText(label, { x: x - 2, y: y + len / 2 - w / 2, size: 7, font, color: black, rotate: degrees(90) });
}

/** A plan at drawnRatio with a title block stating `scale`. */
async function sheet(name: string, opts: { scale: string; drawnRatio: number; size?: [number, number]; extra?: boolean }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage(opts.size ?? A3);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const r = opts.drawnRatio;
  // the building outline, dimensioned along the bottom and the left
  const m = (mm: number) => (mm / 1000 / r) * PT_PER_M;
  page.drawRectangle({ x: 150, y: 250, width: m(12000), height: m(8000), borderColor: black, borderWidth: 1.5 });
  chainH(page, font, 150, 220, [6000, 3500, 2500], r);
  chainH(page, font, 150, 200, [12000], r);
  dimV(page, font, 120, 250, 8000, r);
  // title block: SCALE label above the field, bottom-right
  const tbx = page.getWidth() - 200;
  page.drawRectangle({ x: tbx - 10, y: 20, width: 190, height: 60, borderColor: black, borderWidth: 1 });
  page.drawText('SCALE', { x: tbx, y: 55, size: 6, font, color: black });
  page.drawText(opts.scale, { x: tbx, y: 40, size: 10, font, color: black });
  page.drawText('DO NOT SCALE FROM THIS DRAWING', { x: tbx, y: 26, size: 5, font, color: black });
  if (opts.extra) {
    // prose that quotes ratios, and a detail viewport at its own scale
    page.drawText('Paving to be graded with a fall of not less than 1:300', { x: 700, y: 600, size: 7, font, color: black });
    page.drawText('CAR PARKING TO AS 2890.1:2004', { x: 700, y: 585, size: 7, font, color: black });
    page.drawText('DETAIL A', { x: 700, y: 520, size: 9, font, color: black });
    page.drawText('1:20', { x: 760, y: 520, size: 9, font, color: black });
  }
  const file = join(mkdtempSync(join(tmpdir(), 'p2t-scale-')), `${name}.pdf`);
  writeFileSync(file, await doc.save());
  return file;
}

test('scale: title block 1:100 @ A3 on A3, verified by the printed dimensions', async () => {
  const file = await sheet('plan', { scale: '1:100 @ A3', drawnRatio: 100, extra: true });
  const r = cli('scale', file, '--details');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.stated, '1:100');
  assert.equal(out.paper, 'A3');
  assert.equal(out.pagePaper, 'A3');
  assert.equal(out.effectiveRatio, 100);
  assert.ok(Math.abs(out.metersPerPt - 0.0254 / 72 * 100) < 1e-9);
  assert.equal(out.source, 'text');
  assert.equal(out.rule, 'title block');
  // 6000, 3500, 2500, 12000 and the turned 8000 all measure 1:100
  assert.equal(out.verified.status, 'verified');
  assert.equal(out.verified.checked, 5, JSON.stringify(out.dimensions));
  assert.equal(out.verified.agreeing, 5);
  assert.ok(out.dimensions.some((d: { text: string; agrees: boolean }) => d.text === '8000' && d.agrees), 'rotated dimension');
  // prose ratios are not scales; the detail's 1:20 is listed but not the default
  const ratios = out.statements.map((s: { ratio: number | null }) => s.ratio).sort();
  assert.deepEqual(ratios, [100, 20]);
  assert.ok(out.warnings.some((w: string) => w.includes('1:20')));
});

test('scale: an A1 drawing issued on A3 paper is corrected to 1:200', async () => {
  const file = await sheet('a1-on-a3', { scale: 'SCALE 1:100 @ A1', drawnRatio: 200 });
  const out = JSON.parse(cli('scale', file).stdout);
  assert.equal(out.stated, '1:100');
  assert.equal(out.paper, 'A1');
  assert.equal(out.pagePaper, 'A3');
  assert.ok(Math.abs(out.effectiveRatio - 200) < 0.5, `effective ${out.effectiveRatio}`);
  assert.ok(out.warnings.some((w: string) => /stated for A1 but this sheet is A3/.test(w)), out.warnings.join(' | '));
  // the dimensions agree with the corrected ratio, not the printed one
  assert.equal(out.verified.status, 'verified');
  assert.equal(out.verified.agreeing, out.verified.checked);
});

test('scale: dimensions that contradict the stated scale are flagged', async () => {
  const file = await sheet('wrong', { scale: '1:100 @ A3', drawnRatio: 50 });
  const out = JSON.parse(cli('scale', file).stdout);
  assert.equal(out.stated, '1:100');
  assert.equal(out.verified.status, 'contradicted');
  assert.equal(out.verified.agreeing, 0);
  assert.equal(out.verified.suggestedRatio, 50);
  assert.ok(out.warnings.some((w: string) => w.includes('about 1:50')));
});

test('scale: a sheet with no text reports no scale text instead of guessing', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A3);
  page.drawRectangle({ x: 100, y: 100, width: 400, height: 300, borderColor: black, borderWidth: 1 });
  const file = join(mkdtempSync(join(tmpdir(), 'p2t-scale-')), 'outlines.pdf');
  writeFileSync(file, await doc.save());
  const r = cli('scale', file, '--all-pages');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.pages.length, 1);
  const p = out.pages[0];
  assert.equal(p.stated, null);
  assert.equal(p.metersPerPt, null);
  assert.equal(p.verified.status, 'unverified');
  assert.ok(p.warnings.some((w: string) => w.startsWith('no scale text')), p.warnings.join(' | '));
});

// --- engine heuristics on hand-placed words ---

const word = (text: string, x: number, y: number, h = 8, dir?: { x: number; y: number }): SheetWord => ({
  text,
  conf: 100,
  xPt: x,
  yPt: y,
  wPt: text.length * h * 0.55,
  hPt: h,
  ...(dir ? { dir } : {}),
});

test('scale engine: ISO paper sizes either way round', () => {
  assert.equal(paperSizeOf(1190.55, 841.89), 'A3');
  assert.equal(paperSizeOf(842, 1191), 'A3');
  assert.equal(paperSizeOf(2384, 1684), 'A1');
  assert.equal(paperSizeOf(612, 792), null); // US letter
});

test('scale engine: letter-spaced CAD text and a separate paper field', () => {
  // ArchiCAD: "1 : 2 0 0" and "@ A 3" as separate letter-spaced items
  const words = [word('S C A L E', 1036, 38, 7), word('1 : 2 0 0', 1049, 28, 9), word('@ A 3', 1083, 28, 9)];
  const r = readSheetScale(words, { view: [0, 0, 1190.55, 841.89] });
  assert.equal(r.stated?.ratio, 200);
  assert.equal(r.statedPaper, 'A3');
  // "PAPER (A3)" printed in its own box next to the ratio
  const boxed = readSheetScale([word('SCALE', 1097, 80, 4), word('1:200', 1103, 68), word('PAPER', 1140, 80, 4), word('(A3)', 1141, 68)], {
    view: [0, 0, 1190.55, 841.89],
  });
  assert.equal(boxed.stated?.ratio, 200);
  assert.equal(boxed.statedPaper, 'A3');
  assert.equal(boxed.statements.length, 1);
});

test('scale engine: "As noted" title block defers to viewports only when they agree', () => {
  const view = [0, 0, 2384, 1684];
  const title = [word('SCALE', 2260, 140, 10), word('AS SHOWN', 2260, 128, 10)];
  const same = readSheetScale([...title, word('SECTION A 1:50', 900, 500), word('SECTION B 1:50', 1500, 500)], { view });
  assert.equal(same.stated, null, 'no SCALE label on the sections: prose-like, not a scale');
  const agree = readSheetScale([...title, word('SCALE 1:50', 900, 500), word('SCALE 1:50', 1500, 500)], { view });
  assert.equal(agree.stated?.ratio, 50);
  const differ = readSheetScale([...title, word('SCALE 1:20 (A1)', 600, 337), word('SCALE 1:10 (A1)', 1255, 224)], { view });
  assert.equal(differ.stated, null);
  assert.ok(differ.warnings.some((w) => w.includes('several scales')));
  const nts = readSheetScale([word('SCALE', 2260, 140, 10), word('NTS', 2260, 128, 10)], { view });
  assert.equal(nts.stated, null);
  assert.ok(nts.warnings.some((w) => w.includes('NTS')));
});

test('scale engine: the title block is found on a /Rotate 270 sheet', () => {
  // A3 portrait in user space, shown landscape: display bottom-right is
  // user-space small x, small y; text runs down the page (dir 0,-1)
  const down = { x: 0, y: -1 };
  const sheet = { view: [0, 0, 841.89, 1190.55], rotate: 270 };
  const words = [
    word('SCALE', 36, 240, 4, down),
    word('1:100 @ A3', 30, 236, 6, down), // title block field
    // a detail at display top-right: unrotated, it would be the corner
    word('SCALE 1:20 @ A3', 800, 60, 6, down),
  ];
  const r = readSheetScale(words, sheet);
  assert.equal(r.stated?.ratio, 100);
  assert.equal(r.rule, 'title block');
  assert.equal(readSheetScale(words, { view: sheet.view }).stated?.ratio, 20, 'rotation decides it');
});

test('scale engine: OCR that dropped the colon is repaired only beside SCALE', () => {
  const ocr = [word('scale:', 100, 50), word('1100', 130, 50), word('@A3', 160, 50)];
  const st = findScaleStatements(ocr, { view: [0, 0, 1190.55, 841.89] }, { ocr: true });
  assert.equal(st.length, 1);
  assert.equal(st[0].ratio, 100);
  assert.equal(st[0].repaired, true);
  // live text never repairs; a bare 1100 is a dimension
  assert.equal(findScaleStatements(ocr, undefined).length, 0);
  assert.equal(findScaleStatements([word('1100', 130, 50)], undefined, { ocr: true }).length, 0);
  // the legacy helper reads through the same parser
  assert.equal(findScaleRatio([word('SCALE', 100, 60), word('1:200', 100, 50)])?.ratio, 200);
});
