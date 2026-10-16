// Save → reopen round-trips for markups written into a PDF as annotations.
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { ANNOTATION_AUTHOR, buildAnnotatedPdf, pdfText } from '../src/engine/annotate.ts';
import { readPdfMarkups } from '../src/engine/read.ts';
import { metersPerPtForRatio } from '../src/engine/units.ts';
import type { Calibration, Markup } from '../src/engine/types.ts';
import type { Viewport } from '../src/engine/viewports.ts';

const square = [
  { x: 100, y: 100 },
  { x: 200, y: 100 },
  { x: 200, y: 200 },
  { x: 100, y: 200 },
];

function mk(id: string, type: Markup['type'], label: string, points = square, extra: Partial<Markup> = {}): Markup {
  return { id, page: 1, type, label, points, createdAt: 0, ...extra };
}

async function blankPdf(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([600, 400]);
  return doc.save();
}

const at100 = (): Map<number, Calibration> => new Map([[1, { metersPerPt: metersPerPtForRatio(100), source: '1:100' }]]);

/** The fields a round-trip must preserve, keyed by id. */
function essentials(ms: Markup[]) {
  return Object.fromEntries(
    ms.map((m) => [m.id, { type: m.type, label: m.label, page: m.page, points: m.points, depth: m.depth, status: m.status, layer: m.layer }]),
  );
}

/** Raw annotation dictionaries on page 1 (pdf-lib, no parsing). */
async function rawAnnots(bytes: Uint8Array): Promise<PDFDict[]> {
  const page = (await PDFDocument.load(bytes)).getPage(0);
  const annots = page.node.Annots();
  if (!annots) return [];
  return Array.from({ length: annots.size() }, (_, i) => annots.lookup(i, PDFDict));
}

test('every markup field survives save → reopen, whatever the display unit', async () => {
  const markups = [
    mk('a', 'volume', 'Slab', square, { depth: 0.15, status: 'confirmed', layer: 'Concrete' }),
    mk('b', 'note', 'Check: ceiling height', [{ x: 300, y: 300 }]),
    mk('c', 'note', 'Doors on level: 1', [{ x: 320, y: 300 }]),
    mk('d', 'count', 'DL: type A', [{ x: 340, y: 300 }], { status: 'check' }),
    mk('e', 'area', 'Floor 地板 ²', square),
    mk('f', 'perimeter', 'Skirting', square),
    mk('g', 'length', 'Pipe', [{ x: 10, y: 300 }, { x: 250, y: 50 }]), // drawn down-right
    mk('h', 'length', 'Run', [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 90 }]),
    mk('i', 'angle', 'Corner', [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 100, y: 200 }]),
  ];
  for (const displayUnit of ['mm', 'cm', 'm', 'in', 'ft', 'ft-in'] as const) {
    const out = await buildAnnotatedPdf({ bytes: await blankPdf(), markups, calibrations: at100(), displayUnit });
    assert.deepEqual(essentials(await readPdfMarkups(out)), essentials(markups), displayUnit);
  }
});

test('saving a reopened file replaces its markups instead of duplicating them', async () => {
  const markups = [mk('a', 'area', 'Room', square), mk('b', 'count', 'Socket', [{ x: 300, y: 300 }])];
  const first = await buildAnnotatedPdf({ bytes: await blankPdf(), markups, calibrations: at100(), displayUnit: 'm' });
  const reopened = await readPdfMarkups(first);
  const second = await buildAnnotatedPdf({ bytes: first, markups: reopened, calibrations: at100(), displayUnit: 'm' });
  assert.equal((await readPdfMarkups(second)).length, 2);

  // a markup deleted after reopening stays deleted
  const third = await buildAnnotatedPdf({ bytes: second, markups: reopened.slice(1), calibrations: at100(), displayUnit: 'm' });
  assert.deepEqual((await readPdfMarkups(third)).map((m) => m.label), ['Socket']);
});

test("other tools' annotations are kept on save", async () => {
  const doc = await PDFDocument.load(await blankPdf());
  const page = doc.getPage(0);
  const foreign = doc.context.register(
    doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [0, 0, 20, 20], T: PDFString.of('Reviewer'), Contents: PDFString.of('see me') }),
  );
  page.node.set(PDFName.of('Annots'), doc.context.obj([foreign]));
  const bytes = await doc.save();

  const once = await buildAnnotatedPdf({ bytes, markups: [mk('a', 'area', 'Room')], calibrations: at100(), displayUnit: 'm' });
  const twice = await buildAnnotatedPdf({ bytes: once, markups: [], calibrations: at100(), displayUnit: 'm' });
  const titles = (await rawAnnots(twice)).map((d) => pdfText(d.lookup(PDFName.of('T'))));
  assert.deepEqual(titles, ['Reviewer']);
});

test('comments use the viewport scale for markups inside a viewport', async () => {
  const detail: Viewport = { id: 'v', page: 1, points: [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }], metersPerPt: metersPerPtForRatio(20), source: '1:20' };
  // 72 pt = 1 inch of paper = 0.508 m at 1:20 (2.54 m at the page's 1:100)
  const line = mk('a', 'length', 'Detail', [{ x: 10, y: 10 }, { x: 82, y: 10 }]);
  const out = await buildAnnotatedPdf({ bytes: await blankPdf(), markups: [line], calibrations: at100(), displayUnit: 'm', viewports: [detail] });
  const [annot] = await rawAnnots(out);
  assert.equal(pdfText(annot.lookup(PDFName.of('Contents'))), 'Detail: 0.51 m');
});

test('legacy files without the payload still parse labels, notes and depths', async () => {
  const doc = await PDFDocument.load(await blankPdf());
  const page = doc.getPage(0);
  const legacy = (subtype: string, contents: string, geometry: Record<string, number[]>) =>
    doc.context.register(
      doc.context.obj({ Type: 'Annot', Subtype: subtype, T: PDFString.of(ANNOTATION_AUTHOR), Contents: PDFHexString.fromText(contents), ...geometry }),
    );
  const verts = square.flatMap((p) => [p.x, p.y]);
  page.node.set(
    PDFName.of('Annots'),
    doc.context.obj([
      legacy('Polygon', 'Slab: 2.82 m³ (depth 150 mm) [confirmed] [layer:Concrete]', { Rect: [96, 96, 204, 204], Vertices: verts }),
      legacy('Polygon', "Footing: 1.5 ft³ (depth 1'-6\")", { Rect: [96, 96, 204, 204], Vertices: verts }),
      legacy('FreeText', 'Check: ceiling height', { Rect: [286, 291, 314, 309] }),
      legacy('Line', 'Pipe: 2: east: 4.20 m', { Rect: [0, 0, 300, 300], L: [10, 300, 250, 50] }),
    ]),
  );
  const got = await readPdfMarkups(await doc.save());
  assert.deepEqual(
    got.map((m) => [m.type, m.label, m.depth, m.status, m.layer]),
    [
      ['volume', 'Slab', 0.15, 'confirmed', 'Concrete'],
      ['volume', 'Footing', 1.5 * 0.3048, undefined, undefined],
      ['note', 'Check: ceiling height', undefined, undefined, undefined],
      ['length', 'Pipe: 2: east', undefined, undefined, undefined],
    ],
  );
  assert.deepEqual(got[3].points, [{ x: 10, y: 300 }, { x: 250, y: 50 }]);
});

test('unreadable bytes yield no markups instead of throwing', async () => {
  assert.deepEqual(await readPdfMarkups(new Uint8Array([1, 2, 3])), []);
});
