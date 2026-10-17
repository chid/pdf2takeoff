// Document operations shared by the CLI and the MCP server: one code path
// for scanning, comparing and annotation reading, whatever drives it.

import { writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { createCanvas } from '@napi-rs/canvas';
import { renderRasterNode, rasterizeToNode } from './raster-node.ts';
import { openPdf, vectorPageNode } from './pdfjs-node.ts';
import { scanForSimilar } from '../engine/scan.ts';
import { blendOverlay } from '../engine/compare.ts';
import { diffMask, maskRegions } from '../engine/diff.ts';
import type { Pt } from '../engine/types.ts';

/** Scan at a click point, in PDF points: the vector tier, else tier-1 CV. */
export async function scanDocAt(doc: PDFDocumentProxy, page: number, at: Pt) {
  return scanForSimilar(page, at, {
    renderRaster: (p, scale) => renderRasterNode(doc, p, scale),
    detector: async () => null,
    vectors: (p) => vectorPageNode(doc, p),
  });
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

/** Scan a symbol across every page; pages without it count 0. */
export async function scanDocAllPages(doc: PDFDocumentProxy, at: Pt) {
  const pages: { page: number; count: number }[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    try {
      const result = await scanDocAt(doc, p, at);
      pages.push({ page: p, count: 'error' in result ? 0 : result.hits.length });
    } catch {
      pages.push({ page: p, count: 0 });
    }
  }
  return { pages, total: pages.reduce((s, x) => s + x.count, 0) };
}
