// Markups written into encrypted (edit-restricted) PDFs via an incremental
// update, and read back. The fixtures are encrypted by qpdf (see
// scripts/make-encrypted-fixtures.py), an independent implementation.
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDict, PDFName } from 'pdf-lib';
import { ANNOTATION_AUTHOR, ENCRYPTED_PDF_MESSAGE, buildAnnotatedPdf, pdfText } from '../src/engine/annotate.ts';
import { readPdfMarkups } from '../src/engine/read.ts';
import { loadEncryptedPdf } from '../src/engine/incremental.ts';
import { md5, rc4 } from '../src/engine/pdfcrypt.ts';
import { metersPerPtForRatio } from '../src/engine/units.ts';
import type { Calibration, Markup } from '../src/engine/types.ts';
import { openPdf } from '../src/headless/pdfjs-node.ts';

const fixture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures', 'encrypted', `${name}.pdf`)));

const square = [
  { x: 100, y: 100 },
  { x: 200, y: 100 },
  { x: 200, y: 200 },
  { x: 100, y: 200 },
];
const mk = (id: string, type: Markup['type'], label: string, points = square, extra: Partial<Markup> = {}): Markup => ({ id, page: 1, type, label, points, createdAt: 0, ...extra });
const markups = [
  mk('a', 'volume', 'Slab', square, { depth: 0.15, status: 'confirmed', layer: 'Concrete' }),
  mk('b', 'note', 'Check: ceiling height', [{ x: 300, y: 300 }]),
  mk('c', 'count', 'DL: type A', [{ x: 340, y: 300 }], { status: 'check' }),
  mk('d', 'area', 'Floor 地板 ²', square),
  mk('e', 'length', 'Pipe', [{ x: 10, y: 300 }, { x: 250, y: 50 }]),
  mk('f', 'angle', 'Corner', [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 100, y: 200 }]),
];
const calibrations = (): Map<number, Calibration> => new Map([[1, { metersPerPt: metersPerPtForRatio(100), source: '1:100' }]]);

const essentials = (ms: Markup[]) =>
  Object.fromEntries(ms.map((m) => [m.id, { type: m.type, label: m.label, page: m.page, points: m.points, depth: m.depth, status: m.status, layer: m.layer }]));

/** Titles of every annotation on page 1, decrypted. */
async function titles(bytes: Uint8Array): Promise<(string | null)[]> {
  const annots = (await loadEncryptedPdf(bytes)).doc.getPage(0).node.Annots();
  return Array.from({ length: annots?.size() ?? 0 }, (_, i) => pdfText(annots!.lookup(i, PDFDict).lookup(PDFName.of('T'))));
}

test('md5 and rc4 match their reference vectors', () => {
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));
  assert.equal(hex(md5(bytes(''))), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(hex(md5(bytes('The quick brown fox jumps over the lazy dog'))), '9e107d9d372bb6826bd81d3542a419d6');
  assert.equal(hex(md5(bytes('x'.repeat(1000)))), createHash('md5').update('x'.repeat(1000)).digest('hex'));
  assert.equal(hex(rc4(bytes('Key'), bytes('Plaintext'))), 'bbf316e8d940af0ad3');
});

for (const name of ['rc4-40', 'rc4-128', 'aes-128', 'aes-128-objstm', 'aes-256', 'aes-256-objstm']) {
  test(`markups round-trip through an encrypted PDF (${name})`, async () => {
    const original = fixture(name);
    assert.deepEqual(await readPdfMarkups(original), []);

    const saved = await buildAnnotatedPdf({ bytes: original, markups, calibrations: calibrations(), displayUnit: 'mm' });
    // an incremental update: the original bytes are untouched, still encrypted
    assert.deepEqual(saved.subarray(0, original.length), original);
    const enc = await loadEncryptedPdf(saved);
    assert.ok(enc.doc.isEncrypted);
    assert.equal(enc.doc.getTitle(), 'Encrypted fixture');
    assert.equal(enc.doc.getProducer(), 'pdf2takeoff 0.1.0');

    assert.deepEqual(essentials(await readPdfMarkups(saved)), essentials(markups));
    assert.deepEqual(await titles(saved), ['Reviewer', ...markups.map(() => ANNOTATION_AUTHOR)]);

    // pdf.js decrypts the appended objects with the file's key
    const page = await (await openPdf(saved)).getPage(1);
    const seen = (await page.getAnnotations()) as { titleObj?: { str?: string }; contentsObj?: { str?: string } }[];
    assert.deepEqual(
      seen.map((a) => [a.titleObj?.str, a.contentsObj?.str]),
      [
        ['Reviewer', 'see me ü'],
        [ANNOTATION_AUTHOR, 'Slab: 1866782407 mm³ (depth 150 mm) [confirmed] [layer:Concrete]'],
        [ANNOTATION_AUTHOR, 'Check: ceiling height'],
        [ANNOTATION_AUTHOR, 'DL: type A: 1 [check]'],
        [ANNOTATION_AUTHOR, 'Floor 地板 ²: 12445216 mm²'],
        [ANNOTATION_AUTHOR, 'Pipe: 12226 mm'],
        [ANNOTATION_AUTHOR, 'Corner: 90.0°'],
      ],
    );

    // re-saving replaces rather than stacks, and deletions stick
    const reopened = await readPdfMarkups(saved);
    const again = await buildAnnotatedPdf({ bytes: saved, markups: reopened, calibrations: calibrations(), displayUnit: 'mm' });
    assert.deepEqual(essentials(await readPdfMarkups(again)), essentials(markups));
    assert.equal((await titles(again)).length, markups.length + 1);
    const pruned = await buildAnnotatedPdf({ bytes: again, markups: reopened.slice(1), calibrations: calibrations(), displayUnit: 'mm' });
    assert.deepEqual((await readPdfMarkups(pruned)).map((m) => m.id), markups.slice(1).map((m) => m.id));
    const cleared = await buildAnnotatedPdf({ bytes: pruned, markups: [], calibrations: calibrations(), displayUnit: 'mm' });
    assert.deepEqual(await titles(cleared), ['Reviewer']);
    assert.equal((await (await (await openPdf(cleared)).getPage(1)).getAnnotations()).length, 1);
  });
}

test('an encrypted PDF whose permissions forbid annotating is refused clearly', async () => {
  const bytes = fixture('no-annotate');
  await assert.rejects(buildAnnotatedPdf({ bytes, markups, calibrations: calibrations(), displayUnit: 'mm' }), { message: ENCRYPTED_PDF_MESSAGE });
  assert.deepEqual(await readPdfMarkups(bytes), []);
});

test('a PDF that needs a password to open is refused clearly', async () => {
  const bytes = fixture('open-password');
  await assert.rejects(buildAnnotatedPdf({ bytes, markups, calibrations: calibrations(), displayUnit: 'mm' }), /needs a password to open.*export CSV or Excel instead/);
  assert.deepEqual(await readPdfMarkups(bytes), []);
});
