// Document operations shared by the CLI and the MCP server: one code path
// for scanning, comparing and annotation reading, whatever drives it.

import { writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { createCanvas } from '@napi-rs/canvas';
import { renderRasterNode, rasterizeToNode } from './raster-node.ts';
import { openPdf, vectorPageNode } from './pdfjs-node.ts';
import { countTemplate, scanForSimilar, teachSymbol } from '../engine/scan.ts';
import type { ScanDeps } from '../engine/ports.ts';
import { lineRuns } from '../engine/runs.ts';
import { blendOverlay } from '../engine/compare.ts';
import { diffMask, maskRegions } from '../engine/diff.ts';
import type { Pt, ScanHit } from '../engine/types.ts';
import {
  readSheetScale,
  checkDimensions,
  wordsFromTextItems,
  type DimensionCheck,
  type DimensionVerdict,
  type PaperSize,
  type ScaleStatement,
  type TextItemLike,
} from '../engine/scale.ts';

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

/** Every run drawn in the style of the line at a click point (PDF points),
 *  with lengths in metres when a scale is given. */
export async function runsDocAt(doc: PDFDocumentProxy, page: number, at: Pt, opts: { metersPerPt?: number; gap?: number } = {}) {
  const result = lineRuns(await vectorPageNode(doc, page), at, { gap: opts.gap });
  if ('error' in result) return result;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const m = opts.metersPerPt;
  return {
    style: result.style,
    gapTolerancePt: r2(result.gapTolerance),
    count: result.runs.length,
    totalPt: r2(result.total),
    ...(m ? { totalMeters: Math.round(result.total * m * 1000) / 1000 } : {}),
    runs: result.runs.map((run) => ({
      lengthPt: r2(run.length),
      ...(m ? { meters: Math.round(run.length * m * 1000) / 1000 } : {}),
      pieces: run.pieces,
      points: run.points.map((p) => [r2(p.x), r2(p.y)]),
    })),
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

// --- auto-scale: the sheet's printed scale, cross-checked by dimensions ---

export interface PageScaleResult {
  page: number;
  /** Page default as printed, e.g. "1:100" (null when none could be chosen). */
  stated: string | null;
  statedText: string | null;
  /** Paper the stated ratio refers to, and the sheet's own ISO size. */
  paper: PaperSize | null;
  pagePaper: PaperSize | null;
  /** Ratio that holds on this sheet as issued (stated × paper correction). */
  effectiveRatio: number | null;
  metersPerPt: number | null;
  /** Where the words came from: the PDF's live text or OCR. */
  source: 'text' | 'ocr' | null;
  rule: string;
  verified: { status: DimensionVerdict['status']; checked: number; agreeing: number; suggestedRatio?: number };
  statements: {
    kind: ScaleStatement['kind'];
    text: string;
    ratio: number | null;
    paper: PaperSize | null;
    at: [number, number];
    titleBlock: boolean;
  }[];
  warnings: string[];
  dimensions?: DimensionCheck[];
}

/** Live text of a page as positioned words. */
export async function pageWordsNode(doc: PDFDocumentProxy, page: number) {
  const tc = await (await doc.getPage(page)).getTextContent();
  return wordsFromTextItems(tc.items.filter((i) => 'str' in i) as TextItemLike[]);
}

/**
 * Read a sheet's scale from its live text — or, with ocr, from OCR when the
 * live text states none (text converted to outlines) — then cross-check the
 * effective ratio against the printed dimensions on the vector paths.
 */
export async function readDocScale(
  doc: PDFDocumentProxy,
  page: number,
  opts: { ocr?: boolean; details?: boolean } = {},
): Promise<PageScaleResult> {
  const pdfPage = await doc.getPage(page);
  const sheet = { view: pdfPage.view as number[], rotate: pdfPage.rotate };
  const live = await pageWordsNode(doc, page);
  let reading = readSheetScale(live, sheet);
  let source: PageScaleResult['source'] = reading.stated ? 'text' : null;
  let words = live;
  if (opts.ocr && !reading.stated) {
    const { ocrPageNode } = await import('./ocr-node.ts');
    const ocrWords = await ocrPageNode(doc, page);
    // live words win where both read the same spot
    const extra = ocrWords.filter(
      (o) => !live.some((l) => Math.hypot(l.xPt - o.xPt, l.yPt - o.yPt) < Math.max(l.hPt, o.hPt)),
    );
    words = [...live, ...extra];
    const byOcr = readSheetScale(words, sheet, { ocr: true });
    if (byOcr.stated || byOcr.statements.length > reading.statements.length) {
      reading = byOcr;
      if (byOcr.stated) source = 'ocr';
    }
  }
  const verdict = checkDimensions(words, await vectorPageNode(doc, page), reading.effectiveRatio);
  const warnings = [...reading.warnings];
  if (!opts.ocr && !reading.stated && live.length < 20) {
    warnings.push('little or no live text (drawn as outlines?): rerun with OCR to read it');
  }
  if (verdict.status === 'contradicted' && verdict.suggestedRatio) {
    warnings.push(`printed dimensions disagree with 1:${reading.effectiveRatio}: they measure about 1:${verdict.suggestedRatio}`);
  } else if (!reading.stated && verdict.suggestedRatio) {
    warnings.push(`no stated scale; printed dimensions measure about 1:${verdict.suggestedRatio}`);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    page,
    stated: reading.stated ? `1:${reading.stated.ratio}` : null,
    statedText: reading.stated?.text ?? null,
    paper: reading.statedPaper,
    pagePaper: reading.pagePaper,
    effectiveRatio: reading.effectiveRatio,
    metersPerPt: reading.metersPerPt === null ? null : Math.round(reading.metersPerPt * 1e10) / 1e10,
    source,
    rule: reading.rule,
    verified: {
      status: verdict.status,
      checked: verdict.checked,
      agreeing: verdict.agreeing,
      ...(verdict.suggestedRatio !== undefined ? { suggestedRatio: verdict.suggestedRatio } : {}),
    },
    statements: reading.statements.map((s) => ({
      kind: s.kind,
      text: s.text,
      ratio: s.ratio,
      paper: s.paper,
      at: [r2(s.x), r2(s.y)] as [number, number],
      titleBlock: s.titleBand && (s.labelled || s.paper !== null),
    })),
    warnings,
    ...(opts.details ? { dimensions: verdict.checks } : {}),
  };
}
