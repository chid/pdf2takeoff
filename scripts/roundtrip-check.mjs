#!/usr/bin/env node
// Annotation round-trip check: write markups with the engine's writer, read
// them back the way the app / CLI / MCP do (pdf.js annotations → parseMarkups)
// and assert labels, types, depths, re-save idempotence and viewport-aware
// comment text. Regression guard for: save duplicating markups, depth unit
// misreads (mm read as m), labels cut at the first ':', saved comment text
// ignoring viewport scales.

import { PDFDocument } from 'pdf-lib';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { buildAnnotatedPdf, ANNOTATION_AUTHOR } from '../src/engine/annotate.ts';
import { parseMarkups } from '../src/engine/read.ts';
import { metersPerPtForRatio, formatLength } from '../src/engine/units.ts';
import { markupLength } from '../src/engine/geometry.ts';
import { openPdf } from '../src/headless/pdfjs-node.ts';

function check(label, cond, detail = '') {
  if (!cond) {
    console.error(`FAIL: ${label} ${detail}`);
    process.exit(1);
  }
  console.log(`ok: ${label}`);
}

const round = (n, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;

async function basePdf() {
  const doc = await PDFDocument.create();
  doc.addPage([842, 595]);
  return doc.save();
}

/** Read every pdf2takeoff annotation back out of a PDF, ops.ts-style. */
async function readBack(bytes) {
  const doc = await openPdf(bytes);
  const found = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const annots = await page.getAnnotations({ intent: 'display' });
    found.push(...parseMarkups(annots, p, found.length));
  }
  return { doc, markups: found };
}

/** Raw Contents strings of our annotations on page 1 (pre-parser). */
async function rawContents(bytes) {
  const doc = await openPdf(bytes);
  const page = await doc.getPage(1);
  const annots = await page.getAnnotations({ intent: 'display' });
  return annots
    .filter((a) => (a.titleObj?.str ?? a.title) === ANNOTATION_AUTHOR)
    .map((a) => ({ subtype: a.subtype, contents: a.contentsObj?.str ?? a.contents ?? '' }));
}

const calibrations = new Map([[1, { metersPerPt: metersPerPtForRatio(100), source: 'test 1:100' }]]);

const markups = [
  { id: 't1', page: 1, type: 'length', label: 'External wall', points: [{ x: 60, y: 90 }, { x: 400.02, y: 90 }], createdAt: 1 },
  { id: 't2', page: 1, type: 'area', label: 'Zone A: lobby', points: [{ x: 60, y: 90 }, { x: 173.39, y: 90 }, { x: 173.39, y: 316.77 }, { x: 60, y: 316.77 }], createdAt: 2 },
  { id: 't3', page: 1, type: 'count', label: 'DL: type A', points: [{ x: 100, y: 100 }], createdAt: 3 },
  { id: 't4', page: 1, type: 'note', label: 'Check: ceiling height', points: [{ x: 120, y: 120 }], createdAt: 4 },
  { id: 't5', page: 1, type: 'volume', label: 'Slab', depth: 0.15, points: [{ x: 60, y: 90 }, { x: 173.39, y: 90 }, { x: 173.39, y: 316.77 }, { x: 60, y: 316.77 }], createdAt: 5 },
  { id: 't6', page: 1, type: 'angle', label: 'Corner 45° bend', points: [{ x: 60, y: 90 }, { x: 200, y: 90 }, { x: 60, y: 200 }], createdAt: 6 },
  { id: 't7', page: 1, type: 'perimeter', label: 'Room boundary', points: [{ x: 60, y: 90 }, { x: 173.39, y: 90 }, { x: 173.39, y: 316.77 }, { x: 60, y: 316.77 }], createdAt: 7 },
];

// --- round-trip across every display unit -----------------------------------
const bytes = await basePdf();
for (const unit of ['m', 'mm', 'cm', 'in', 'ft', 'ft-in']) {
  const saved = await buildAnnotatedPdf({ bytes, markups, calibrations, displayUnit: unit });
  const { markups: back } = await readBack(saved);
  check(`[${unit}] same markup count back`, back.length === markups.length, `got ${back.length}`);

  for (const orig of markups) {
    const m = back.find((x) => x.type === orig.type && x.label === orig.label);
    check(`[${unit}] ${orig.type} "${orig.label}" survives`, !!m);
  }
  check(`[${unit}] count label keeps its colon`, back.some((m) => m.type === 'count' && m.label === 'DL: type A'));
  check(`[${unit}] note text keeps its colon`, back.some((m) => m.type === 'note' && m.label === 'Check: ceiling height'));
  check(`[${unit}] angle label with ° stays an angle`, back.some((m) => m.type === 'angle' && m.label === 'Corner 45° bend'));

  const slab = back.find((m) => m.type === 'volume');
  check(`[${unit}] volume depth round-trips in metres`, slab?.depth !== undefined && Math.abs(slab.depth - 0.15) < 0.005, `got ${slab?.depth}`);

  // --- re-save on the saved bytes must replace, not stack --------------------
  const resaved = await buildAnnotatedPdf({ bytes: saved, markups: back, calibrations, displayUnit: unit });
  const { markups: twice } = await readBack(resaved);
  check(`[${unit}] re-save does not duplicate`, twice.length === back.length, `got ${twice.length}`);

  // --- deletions must persist through a re-save -------------------------------
  const pruned = back.filter((m) => !(m.type === 'length' && m.label === 'External wall'));
  const afterDelete = await buildAnnotatedPdf({ bytes: saved, markups: pruned, calibrations, displayUnit: unit });
  const { markups: post } = await readBack(afterDelete);
  check(`[${unit}] deleted markup stays deleted`, post.length === pruned.length && !post.some((m) => m.label === 'External wall'), `got ${post.length}`);
}

// --- saved comment text honours viewport scales ------------------------------
const mpp20 = metersPerPtForRatio(20);
const viewports = [
  {
    id: 'vp-1',
    page: 1,
    points: [{ x: 0, y: 0 }, { x: 842, y: 0 }, { x: 842, y: 595 }, { x: 0, y: 595 }],
    metersPerPt: mpp20,
    source: 'viewport 1:20',
  },
];
const savedVp = await buildAnnotatedPdf({ bytes, markups: [markups[0]], calibrations, displayUnit: 'm', viewports });
const wall = savedVp && (await rawContents(savedVp)).find((a) => a.subtype === 'Line');
const expectedVp = `External wall: ${formatLength(markupLength(markups[0], mpp20), 'm')}`;
const expectedPage = `External wall: ${formatLength(markupLength(markups[0], metersPerPtForRatio(100)), 'm')}`;
check('viewport scale used in saved comment text', wall?.contents === expectedVp, `got "${wall?.contents}", want "${expectedVp}"`);
check('viewport value differs from page-scale value', expectedVp !== expectedPage);

console.log('\nround-trip check: all steps passed');
