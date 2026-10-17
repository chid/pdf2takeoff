// Document operations shared by the CLI and the MCP server: one code path
// for scanning, comparing and annotation reading, whatever drives it.

import { writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { createCanvas } from '@napi-rs/canvas';
import { renderRasterNode, rasterizeToNode } from './raster-node.ts';
import { openPdf, textItemsNode, vectorPageNode } from './pdfjs-node.ts';
import { legendSchedule, type LegendDeps } from '../engine/legend.ts';
import type { VectorPage } from '../engine/scan-vector.ts';
import { countTemplate, scanForSimilar, teachSymbol } from '../engine/scan.ts';
import type { ScanDeps } from '../engine/ports.ts';
import { blendOverlay } from '../engine/compare.ts';
import { diffMask, maskRegions } from '../engine/diff.ts';
import type { Pt, ScanHit } from '../engine/types.ts';

/** Scan at a click point, in PDF points: the vector tier, else tier-1 CV. */
export async function scanDocAt(doc: PDFDocumentProxy, page: number, at: Pt) {
  return scanForSimilar(page, at, scanDeps(doc));
}

function scanDeps(doc: PDFDocumentProxy): ScanDeps {
  return {
    renderRaster: (p, scale) => renderRasterNode(doc, p, scale),
    detector: async () => null,
    vectors: (p) => vectorPageNode(doc, p),
  };
}

/** A sheet counts as changed above this fraction of changed pixels. */
export const CHANGED_SHEET_FRACTION = 0.0005;
/** Raster px per PDF point used when diffing revisions. */
export const COMPARE_SCALE = 2;

export interface CompareSheetResult {
  page: number;
  widthPt: number;
  heightPt: number;
  changedFraction: number;
  changed: boolean;
  regions: { xPt: number; yPt: number; wPt: number; hPt: number }[];
}

export interface CompareSummary {
  comparedSheets: number;
  changedSheets: number[];
  summary: { changed: number; unchanged: number; onlyInA: number; onlyInB: number };
  sheets: CompareSheetResult[];
}

export async function compareDocs(
  docA: PDFDocumentProxy,
  docB: PDFDocumentProxy,
  opts: { png?: string; threshold?: number } = {},
): Promise<CompareSummary> {
  const threshold = opts.threshold ?? 24;
  const sheets: CompareSheetResult[] = [];
  const changedSheets: number[] = [];
  const pairs = Math.min(docA.numPages, docB.numPages);

  for (let p = 1; p <= pairs; p++) {
    const pageA = await docA.getPage(p);
    const vp1 = pageA.getViewport({ scale: 1 });
    const w = Math.max(1, Math.round(vp1.width * COMPARE_SCALE));
    const h = Math.max(1, Math.round(vp1.height * COMPARE_SCALE));
    const ra = await rasterizeToNode(docA, p, w, h);
    const rb = await rasterizeToNode(docB, p, w, h);
    const { mask, changedPx } = diffMask(ra, rb, { threshold });
    const fraction = changedPx / Math.max(1, w * h);
    const changed = fraction > CHANGED_SHEET_FRACTION;
    const regions = changed
      ? maskRegions(mask, w, h, 16 * COMPARE_SCALE).map((r) => ({
          xPt: Math.round(r.x / COMPARE_SCALE),
          yPt: Math.round(r.y / COMPARE_SCALE),
          wPt: Math.round(r.w / COMPARE_SCALE),
          hPt: Math.round(r.h / COMPARE_SCALE),
        }))
      : [];
    sheets.push({
      page: p,
      widthPt: Math.round(vp1.width),
      heightPt: Math.round(vp1.height),
      changedFraction: Math.round(fraction * 10000) / 10000,
      changed,
      regions,
    });
    if (changed) changedSheets.push(p);

    if (opts.png && changedSheets.length === 1) {
      const out = new Uint8ClampedArray(ra.width * ra.height * 4);
      blendOverlay(ra, rb, 0, 0, false, out);
      const cnv = createCanvas(ra.width, ra.height);
      const ctx = cnv.getContext('2d');
      const img = ctx.createImageData(ra.width, ra.height);
      img.data.set(out);
      ctx.putImageData(img, 0, 0);
      writeFileSync(opts.png, cnv.toBuffer('image/png'));
    }
  }

  return {
    comparedSheets: pairs,
    changedSheets,
    summary: {
      changed: changedSheets.length,
      unchanged: pairs - changedSheets.length,
      onlyInA: docA.numPages > pairs ? docA.numPages - pairs : 0,
      onlyInB: docB.numPages > pairs ? docB.numPages - pairs : 0,
    },
    sheets,
  };
}

// --- batch compare across folders ---

function listPdfs(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith('.pdf')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

export interface FolderPairResult {
  sheet: string; // basename
  aPages: number;
  bPages: number;
  changedSheets: number[];
  summary: { changed: number; unchanged: number; onlyInA: number; onlyInB: number };
}

export interface FolderCompareResult {
  a: string;
  b: string;
  pairs: FolderPairResult[];
  addedInB: string[]; // sheets only in the newer set
  removedFromA: string[]; // sheets only in the older set
  totals: { pairs: number; changed: number; unchanged: number };
  notes: string[];
}

/** Recursively pair PDFs across two revision folders by filename and diff every pair. */
export async function compareFolders(
  dirA: string,
  dirB: string,
  opts: { pngDir?: string; threshold?: number } = {},
): Promise<FolderCompareResult> {
  const byBase = (dir: string) => {
    const map = new Map<string, string[]>();
    for (const f of listPdfs(dir)) {
      const key = basename(f);
      map.set(key, [...(map.get(key) ?? []), f]);
    }
    return map;
  };
  const a = byBase(dirA);
  const b = byBase(dirB);
  const notes: string[] = [];
  for (const [side, map] of [
    ['a', a],
    ['b', b],
  ] as const) {
    for (const [key, files] of map) {
      if (files.length > 1) notes.push(`${side}: ${files.length} files share the name "${key}"; using the first (${files[0]})`);
    }
  }

  const pairs: FolderPairResult[] = [];
  let changed = 0;
  let unchanged = 0;
  for (const sheet of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const fa = a.get(sheet)?.[0];
    const fb = b.get(sheet)?.[0];
    if (fa && !fb) continue; // handled by removedFromA below
    if (!fa && fb) continue;
    const docA = await openPdf(new Uint8Array(readFileSync(fa!)));
    const docB = await openPdf(new Uint8Array(readFileSync(fb!)));
    const result = await compareDocs(docA, docB, {
      threshold: opts.threshold,
      ...(opts.pngDir ? { png: join(opts.pngDir, `${sheet.replace(/\.pdf$/i, '')}-overlay.png`) } : {}),
    });
    pairs.push({
      sheet,
      aPages: docA.numPages,
      bPages: docB.numPages,
      changedSheets: result.changedSheets,
      summary: result.summary,
    });
    if (result.summary.changed > 0) changed++;
    else unchanged++;
  }

  return {
    a: dirA,
    b: dirB,
    pairs,
    addedInB: [...b.keys()].filter((k) => !a.has(k)).sort(),
    removedFromA: [...a.keys()].filter((k) => !b.has(k)).sort(),
    totals: { pairs: pairs.length, changed, unchanged },
    notes,
  };
}

/** Teach a symbol from a click on one page, then count it on every page
 *  (pages without it count 0). The taught template travels between pages,
 *  not the click point, so each sheet is searched for that symbol wherever
 *  it sits. */
export async function scanDocAllPages(doc: PDFDocumentProxy, page: number, at: Pt) {
  if (page > doc.numPages) throw new Error(`page ${page} is past the last page (${doc.numPages})`);
  const deps = scanDeps(doc);
  // a symbol drawn once per sheet is still worth counting across the set
  const taught = await teachSymbol(page, at, deps, 1);
  if ('error' in taught) throw new Error(`page ${page}: ${taught.error}`);
  const pages: { page: number; count: number; hits: ScanHit[]; error?: string }[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    try {
      const result = p === page ? taught.result : await countTemplate(p, taught.template, deps);
      if ('error' in result) pages.push({ page: p, count: 0, hits: [], error: result.error });
      else pages.push({ page: p, count: result.hits.length, hits: result.hits });
    } catch (err) {
      pages.push({ page: p, count: 0, hits: [], error: err instanceof Error ? err.message : String(err) });
    }
  }
  return {
    taughtOn: page,
    provider: taught.result.provider,
    pages,
    total: pages.reduce((s, x) => s + x.count, 0),
  };
}

/** Legend-driven schedule: find the legend blocks on a page (or every
 *  page), teach the scan from each symbol swatch and count it on the same
 *  page(s), leaving the legend's own samples out. Line styles are listed;
 *  rows that can't be counted come back with a reason. */
export async function legendDoc(doc: PDFDocumentProxy, opts: { page?: number; allPages?: boolean } = {}) {
  const page = opts.page ?? 1;
  if (!opts.allPages && (!Number.isInteger(page) || page < 1 || page > doc.numPages)) {
    throw new Error(`page ${page} is out of range (1-${doc.numPages})`);
  }
  const pages = opts.allPages ? Array.from({ length: doc.numPages }, (_, i) => i + 1) : [page];
  // every symbol row re-reads the sheets: replay each operator list once
  const vectors = new Map<number, Promise<VectorPage>>();
  const deps: LegendDeps = {
    ...scanDeps(doc),
    vectors: (p) => {
      if (!vectors.has(p)) vectors.set(p, vectorPageNode(doc, p));
      return vectors.get(p)!;
    },
    text: (p) => textItemsNode(doc, p),
  };
  return legendSchedule(pages, deps);
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** legendDoc() as plain JSON with coordinates rounded to 0.01 pt (the CLI
 *  and MCP output). */
export async function legendReport(doc: PDFDocumentProxy, opts: { page?: number; allPages?: boolean } = {}) {
  const result = await legendDoc(doc, opts);
  return {
    pages: opts.allPages ? 'all' : result.pages[0],
    legendsFound: result.legends.length,
    ...(result.legends.length
      ? {}
      : { note: 'no legend found: no KEY / LEGEND / SYMBOLS heading with swatched rows in the sheet text (text converted to outlines cannot be read)' }),
    schedule: result.schedule.map((s) => ({
      label: s.label,
      count: s.count,
      page: s.page,
      provider: s.provider,
      ...(s.note ? { note: s.note } : {}),
      ...(s.pages ? { pages: s.pages.filter((p) => p.count > 0) } : {}),
      hits: s.hits.map((h) => ({ page: h.page, x: r2(h.x), y: r2(h.y) })),
    })),
    lines: result.lines.map((l) => ({ label: l.label, page: l.page })),
    unmatched: result.unmatched,
    legends: result.legends.map((l) => ({
      page: l.page,
      heading: l.heading,
      box: l.box.map(r2),
      rows: l.rows.map((row) => ({
        label: row.label,
        kind: row.kind,
        ...(row.code ? { code: row.code } : {}),
        ...(row.swatch ? { swatch: row.swatch.map(r2) } : {}),
        ...(row.at ? { at: [r2(row.at.x), r2(row.at.y)] } : {}),
        ...(row.text ? { text: row.text } : {}),
      })),
    })),
  };
}
