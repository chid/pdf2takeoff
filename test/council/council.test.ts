// Local suite over real council drawing sets (see manifest.json). The PDFs
// are fetched into cache/ by scripts/fetch-council.mjs and never committed;
// sets that aren't cached are skipped. The checks are invariants that need
// no hand labelling (renders without crashing, scan hits land on the sheet,
// markups round-trip, other annotations survive), plus optional hand-checked
// counts under a set's "expect".
// Run: npm run test:council

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { ANNOTATION_AUTHOR, buildAnnotatedPdf, pdfText } from '../../src/engine/annotate.ts';
import { readPdfMarkups } from '../../src/engine/read.ts';
import { loadEncryptedPdf } from '../../src/engine/incremental.ts';
import { RASTER_SCALE } from '../../src/engine/ports.ts';
import { metersPerPtForRatio } from '../../src/engine/units.ts';
import { markupLength } from '../../src/engine/geometry.ts';
import type { Calibration, Markup } from '../../src/engine/types.ts';
import { openPdf } from '../../src/headless/pdfjs-node.ts';
import { renderRasterNode } from '../../src/headless/raster-node.ts';
import { cvScan } from '../../src/engine/scan-cv.ts';
import { parseScaleSpec } from '../../src/headless/spec.ts';
import { parsePages } from './pages.ts';
import { ocrCacheDir } from '../../src/headless/ocr-node.ts';

type Expectation = { page: number; what: string; knownIssue?: string } & (
  | { kind: 'length'; scale: string; points: [number, number][]; meters: number; tolerance: number }
  | { kind: 'count'; at: [number, number]; count: number; checks?: number; flags?: string[] }
  | { kind: 'schedule'; at: [number, number]; counts: Record<string, number>; checks?: Record<string, number> }
  | { kind: 'runs'; at: [number, number]; scale: string; meters: number; tolerance: number }
  | {
      kind: 'scale';
      stated: string | null;
      paper: string | null;
      effectiveRatio: number | null;
      ocr?: boolean;
      verified?: 'verified' | 'contradicted' | 'unverified';
      /** hand-checked ends of printed dimensions the cross-check must find */
      dimensions?: { text: string; from: [number, number]; to: [number, number] }[];
    }
  | { kind: 'legend'; counts: Record<string, number>; lines?: string[] }
);

interface CouncilSet {
  id: string;
  application: string;
  sha256: string;
  pages: number;
  drawingPages: string;
  rotatedPages: string;
  encrypted: boolean;
  expect?: Expectation[];
}

const here = import.meta.dirname;
const root = join(here, '..', '..');
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8')) as { sets: CouncilSet[] };

function node(args: string[]) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 << 20 });
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

/** Our annotations vs everyone else's, read from the raw dictionaries. */
async function annotationCounts(bytes: Uint8Array): Promise<{ ours: number; foreign: number }> {
  let doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) doc = (await loadEncryptedPdf(bytes, doc.context)).doc;
  let ours = 0;
  let foreign = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const d = annots!.lookup(i);
      if (d instanceof PDFDict && pdfText(d.lookup(PDFName.of('T'))) === ANNOTATION_AUTHOR) ours++;
      else foreign++;
    }
  }
  return { ours, foreign };
}

/** One of each markup type, placed relative to the page's visible box. */
function markupsFor(page: number, view: number[]): Markup[] {
  const [x0, y0, x1, y1] = view;
  const at = (fx: number, fy: number) => ({ x: x0 + (x1 - x0) * fx, y: y0 + (y1 - y0) * fy });
  const base = { page, createdAt: 0 };
  return [
    { ...base, id: `p${page}-len`, type: 'length', label: 'Stormwater: DN100', points: [at(0.2, 0.8), at(0.6, 0.3)] },
    { ...base, id: `p${page}-run`, type: 'length', label: 'Skirting', points: [at(0.1, 0.1), at(0.3, 0.1), at(0.3, 0.4)], layer: 'Finishes' },
    { ...base, id: `p${page}-area`, type: 'area', label: 'Slab', points: [at(0.4, 0.4), at(0.7, 0.4), at(0.55, 0.7)], status: 'confirmed' },
    { ...base, id: `p${page}-vol`, type: 'volume', label: 'Footing', points: [at(0.1, 0.5), at(0.2, 0.5), at(0.2, 0.6), at(0.1, 0.6)], depth: 0.45 },
    { ...base, id: `p${page}-count`, type: 'count', label: 'DL: downlight', points: [at(0.5, 0.5)], status: 'check' },
    { ...base, id: `p${page}-note`, type: 'note', label: 'Check: RL to survey', points: [at(0.8, 0.2)] },
  ] as Markup[];
}

const essentials = (ms: Markup[]) =>
  Object.fromEntries(
    ms.map((m) => [
      m.id,
      { type: m.type, label: m.label, page: m.page, depth: m.depth, status: m.status, layer: m.layer, points: m.points.map((p) => [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000]) },
    ]),
  );

for (const set of manifest.sets) {
  const file = join(here, 'cache', `${set.id}.pdf`);
  const cached = existsSync(file);

  test(`${set.id} (${set.application})`, { skip: !cached && `not cached — run: node scripts/fetch-council.mjs` }, async (t) => {
    const bytes = new Uint8Array(readFileSync(file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), set.sha256, 'cached bytes differ from the manifest');

    await t.test('info reads the set', () => {
      const r = node([join(root, 'bin', 'pdf2takeoff.js'), 'info', file]);
      assert.equal(r.signal, null, r.stderr);
      assert.equal(r.status, 0, r.stderr);
      const info = JSON.parse(r.stdout);
      assert.equal(info.pageCount, set.pages);
      assert.equal(info.annotations.pdf2takeoff, 0);
    });

    await t.test('every drawing renders and scan hits land on the sheet', () => {
      const r = node(['--experimental-strip-types', join(here, 'probe.ts'), file, set.drawingPages]);
      assert.equal(r.signal, null, `probe crashed: ${r.stderr.slice(-500)}`);
      assert.equal(r.status, 0, r.stderr.slice(-500));
      const pages = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
      assert.deepEqual(pages.map((p) => p.page), parsePages(set.drawingPages, set.pages));
      const rotated = new Set(parsePages(set.rotatedPages, set.rotatedPages ? set.pages : 0));

      let scanned = 0;
      for (const p of pages) {
        const where = `p${p.page}`;
        assert.equal(rotated.has(p.page), p.rotate % 360 !== 0, `${where}: /Rotate ${p.rotate} vs manifest`);
        // a quarter-turn page renders with width and height swapped
        const [w, h] = [p.view[2] - p.view[0], p.view[3] - p.view[1]];
        const [ew, eh] = p.rotate % 180 === 0 ? [w, h] : [h, w];
        assert.ok(Math.abs(p.raster[0] - ew * RASTER_SCALE) <= 1 && Math.abs(p.raster[1] - eh * RASTER_SCALE) <= 1, `${where}: raster ${p.raster} for view ${p.view} rot ${p.rotate}`);
        assert.ok(p.inkFraction > 0.001 && p.inkFraction < 0.5, `${where}: ink ${p.inkFraction} — blank or failed render?`);
        if (!p.scan) continue;
        scanned++;
        assert.equal(p.scan.offPage, 0, `${where}: scan hits off the page`);
        assert.equal(p.scan.offRaster, 0, `${where}: scan hits outside the raster`);
        // a connected component of N px spans at most N px, so the clicked
        // symbol's own hit is within templatePx / RASTER_SCALE pt of the click
        assert.ok(p.scan.nearestPt <= p.scan.templatePx / RASTER_SCALE + 2, `${where}: no hit near the click (${p.scan.nearestPt} pt)`);
        if (p.vector?.hits) assert.equal(p.vector.offPage, 0, `${where}: vector scan hits off the page`);
      }
      t.diagnostic(`${pages.length} sheets rendered; scan exercised on ${scanned}, ${pages.filter((p) => p.scan && p.rotate % 360).length} of them rotated`);
      assert.ok(scanned > 0, 'the scan found no repeated symbol on any sheet — invariants untested');
    });

    await t.test('markups round-trip through the real file', async () => {
      const doc = await openPdf(bytes);
      const pages = parsePages(set.drawingPages, set.pages);
      const views = await Promise.all(pages.map(async (p) => (await doc.getPage(p)).view as number[]));
      const markups = pages.flatMap((p, i) => markupsFor(p, views[i]));
      const calibrations = new Map<number, Calibration>(pages.map((p) => [p, { metersPerPt: metersPerPtForRatio(100), source: '1:100' }]));

      const before = await annotationCounts(bytes);

      const saved = await buildAnnotatedPdf({ bytes, markups, calibrations, displayUnit: 'mm' });
      // encrypted sets get an incremental update: the original bytes stay put
      if (set.encrypted) assert.deepEqual(saved.subarray(0, bytes.length), bytes);
      assert.deepEqual(essentials(await readPdfMarkups(saved)), essentials(markups));
      assert.deepEqual(await annotationCounts(saved), { ours: markups.length, foreign: before.foreign });

      // pdf.js (the viewer) still opens it and sees our annotations
      const reopened = await openPdf(saved);
      assert.equal(reopened.numPages, set.pages);
      const seen = (await (await reopened.getPage(pages[0])).getAnnotations()).filter((a: { titleObj?: { str?: string } }) => a.titleObj?.str === ANNOTATION_AUTHOR);
      assert.equal(seen.length, markupsFor(pages[0], views[0]).length);
      assert.ok(seen.some((a: { contentsObj?: { str?: string } }) => a.contentsObj?.str === 'Check: RL to survey'), 'pdf.js reads the comment text');

      // saving the reopened file again replaces rather than stacks
      const again = await buildAnnotatedPdf({ bytes: saved, markups: await readPdfMarkups(saved), calibrations, displayUnit: 'mm' });
      assert.deepEqual(await annotationCounts(again), { ours: markups.length, foreign: before.foreign });
    });

    // one all-pages run per taught symbol, shared by its schedule checks
    const schedules = new Map<string, { status: number | null; stdout: string; stderr: string }>();
    const allPages = (page: number, at: [number, number]) => {
      const key = `${page}@${at.join(',')}`;
      if (!schedules.has(key)) schedules.set(key, node([join(root, 'bin', 'pdf2takeoff.js'), 'scan', file, '--page', String(page), '--at', at.join(','), '--all-pages']));
      return schedules.get(key)!;
    };

    for (const e of set.expect ?? []) {
      const todo = e.knownIssue ?? false;
      if (e.kind === 'schedule') {
        await t.test(`taught on p${e.page}, counted on every sheet: ${e.what}`, { todo }, (st) => {
          const r = allPages(e.page, e.at);
          assert.equal(r.status, 0, r.stderr);
          const out = JSON.parse(r.stdout);
          const got = Object.fromEntries(Object.keys(e.counts).map((p) => [p, out.pages[Number(p) - 1].count]));
          st.diagnostic(`${out.provider} tier, ${out.total} across the set, ${out.checks} to check`);
          assert.deepEqual(got, e.counts);
          // near hits (status 'check'): exactly the listed ones, none elsewhere
          const checks = Object.fromEntries(Object.keys(e.counts).map((p) => [p, out.pages[Number(p) - 1].checks]));
          assert.deepEqual(checks, Object.fromEntries(Object.keys(e.counts).map((p) => [p, e.checks?.[p] ?? 0])));
        });
        continue;
      }
      if (e.kind === 'legend') {
        await t.test(`p${e.page} legend schedules ${JSON.stringify(e.counts)}: ${e.what}`, { todo }, (st) => {
          const r = node([join(root, 'bin', 'pdf2takeoff.js'), 'legend', file, '--page', String(e.page)]);
          assert.equal(r.status, 0, r.stderr);
          const out = JSON.parse(r.stdout);
          const got = Object.fromEntries(
            (out.schedule as { label: string; count: number }[]).filter((s) => s.label in e.counts).map((s) => [s.label, s.count]),
          );
          st.diagnostic(`${out.legendsFound} legend(s); lines: ${out.lines.map((l: { label: string }) => l.label).join(', ')}`);
          assert.deepEqual(got, e.counts);
          if (e.lines) assert.deepEqual(out.lines.map((l: { label: string }) => l.label), e.lines);
        });
        continue;
      }
      if (e.kind === 'length') {
        await t.test(`p${e.page} measures ${e.meters} m at ${e.scale}: ${e.what}`, { todo }, () => {
          const points = e.points.map(([x, y]) => ({ x, y }));
          const m = markupLength({ id: 'e', page: e.page, type: 'length', label: e.what, points, createdAt: 0 }, parseScaleSpec(e.scale));
          assert.ok(Math.abs(m - e.meters) <= e.tolerance, `measured ${m.toFixed(3)} m, printed ${e.meters} m`);
        });
      } else if (e.kind === 'runs') {
        await t.test(`p${e.page} runs total ${e.meters} m at ${e.scale}: ${e.what}`, { todo }, (st) => {
          const r = node([join(root, 'bin', 'pdf2takeoff.js'), 'runs', file, '--page', String(e.page), '--at', e.at.join(','), '--scale', e.scale]);
          assert.equal(r.status, 0, r.stderr);
          const out = JSON.parse(r.stdout);
          st.diagnostic(`${out.count} runs of ${out.style.stroke} w${out.style.width}, gap ${out.gapTolerancePt} pt`);
          assert.ok(Math.abs(out.totalMeters - e.meters) <= e.tolerance, `measured ${out.totalMeters} m, expected ${e.meters} m`);
        });
      } else if (e.kind === 'scale') {
        const label = e.stated ? `${e.stated}${e.paper ? ` @ ${e.paper}` : ''}` : 'no page scale';
        await t.test(`p${e.page} reads ${label}${e.ocr ? ' (OCR)' : ''}: ${e.what}`, { todo }, (st) => {
          const args = [join(root, 'bin', 'pdf2takeoff.js'), 'scale', file, '--page', String(e.page), '--details'];
          if (e.ocr) args.push('--ocr');
          const r = node(args);
          if (e.ocr && r.status !== 0 && !existsSync(join(ocrCacheDir(), 'eng.traineddata'))) {
            st.skip('OCR language pack not cached and could not be fetched (offline?)');
            return;
          }
          assert.equal(r.status, 0, r.stderr.slice(-500));
          const out = JSON.parse(r.stdout);
          st.diagnostic(`stated ${out.stated} paper ${out.paper} effective ${out.effectiveRatio} source ${out.source}; dimensions ${out.verified.agreeing}/${out.verified.checked} agree (${out.verified.status})`);
          assert.equal(out.stated, e.stated, `statements: ${JSON.stringify(out.statements)}; ${out.warnings.join(' | ')}`);
          assert.equal(out.paper, e.paper);
          if (e.effectiveRatio === null) assert.equal(out.effectiveRatio, null);
          else assert.ok(Math.abs(out.effectiveRatio / e.effectiveRatio - 1) < 0.005, `effective ${out.effectiveRatio}`);
          if (e.stated === null) assert.ok(out.warnings.length > 0, 'no page scale must say why');
          if (e.verified) assert.equal(out.verified.status, e.verified, JSON.stringify(out.verified));
          for (const d of e.dimensions ?? []) {
            const near = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= 2;
            const hit = out.dimensions.find(
              (c: { text: string; from: number[]; to: number[] }) =>
                c.text === d.text && ((near(c.from, d.from) && near(c.to, d.to)) || (near(c.from, d.to) && near(c.to, d.from))),
            );
            assert.ok(hit?.agrees, `${d.text}: no agreeing check between ${d.from} and ${d.to}`);
          }
        });
      } else {
        await t.test(`p${e.page} scan counts ${e.count} × ${e.what}`, { todo }, async (st) => {
          const r = node([join(root, 'bin', 'pdf2takeoff.js'), 'scan', file, '--page', String(e.page), '--at', e.at.join(','), ...(e.flags ?? [])]);
          assert.equal(r.status, 0, r.stderr);
          const out = JSON.parse(r.stdout);
          // the raster tier on its own, for comparison
          const raster = await renderRasterNode(await openPdf(bytes), e.page, RASTER_SCALE);
          const cv = cvScan(raster, { x: e.at[0], y: e.at[1] });
          st.diagnostic(`${out.provider} tier: ${out.count} (${out.checks} to check); raster CV alone: ${'error' in cv ? cv.error : cv.hits.length}`);
          assert.equal(out.count, e.count);
          assert.equal(out.checks ?? 0, e.checks ?? 0, 'near hits (to check)');
        });
      }
    }
  });
}
