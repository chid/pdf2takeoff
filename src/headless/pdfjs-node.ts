// pdf.js document loading for Node (the legacy build runs on the main
// thread with no worker). Mirrors the browser's viewer.ts loading options.

// @ts-ignore -- pdfjs-dist's legacy build ships without type declarations
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { vectorPage, type VectorPage } from '../engine/scan-vector.ts';
import type { TextItemLike } from '../engine/legend.ts';

const require = createRequire(import.meta.url);

// Standard-14 font data for PDFs that reference Helvetica & co. without
// embedding them (the bundled samples do). pdf.js's Node font loader needs a
// file:// URL — a bare filesystem path silently misses and segfaults later
// inside the glyph fallback.
function standardFontsUrl(): string | undefined {
  try {
    const pkg = require.resolve('pdfjs-dist/package.json');
    return pathToFileURL(join(dirname(pkg), 'standard_fonts') + '/').href;
  } catch {
    try {
      const main = require.resolve('pdfjs-dist');
      return pathToFileURL(join(dirname(main), '..', 'standard_fonts') + '/').href;
    } catch {
      return undefined;
    }
  }
}

interface CanvasAndContext {
  canvas: Canvas | null;
  context: SKRSContext2D | null;
}

// pdf.js paints images, patterns and soft masks onto scratch canvases from
// its own canvas factory, which requires whichever @napi-rs/canvas copy sits
// next to pdfjs-dist — not necessarily ours. Drawing a canvas from one native
// copy into a context from another segfaults (every real drawing with a
// raster logo in its title block did). Hand pdf.js a factory built on the
// same @napi-rs/canvas the raster adapter renders with.
class NapiCanvasFactory {
  create(width: number, height: number): CanvasAndContext {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }

  reset(cc: CanvasAndContext, width: number, height: number): void {
    if (!cc.canvas) throw new Error('Canvas is not specified');
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    cc.canvas.width = width;
    cc.canvas.height = height;
  }

  destroy(cc: CanvasAndContext): void {
    if (!cc.canvas) throw new Error('Canvas is not specified');
    cc.canvas.width = cc.canvas.height = 0;
    cc.canvas = null;
    cc.context = null;
  }
}

export async function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  return pdfjsLib.getDocument({
    data: data.slice(),
    verbosity: 0,
    standardFontDataUrl: standardFontsUrl(),
    CanvasFactory: NapiCanvasFactory,
  }).promise;
}

/** A page's vector paths for the vector scan. Annotations are left out, so
 *  earlier count markups never teach or match the scan. */
export async function vectorPageNode(doc: PDFDocumentProxy, pageNum: number): Promise<VectorPage> {
  const page = await doc.getPage(pageNum);
  const ops = await page.getOperatorList({ annotationMode: pdfjsLib.AnnotationMode.DISABLE });
  return vectorPage(page.view, ops, pdfjsLib.OPS);
}

/** A page's text items (strings with their PDF-space transforms), for
 *  legend detection. */
export async function textItemsNode(doc: PDFDocumentProxy, pageNum: number): Promise<TextItemLike[]> {
  const page = await doc.getPage(pageNum);
  const content = await page.getTextContent();
  return (content.items as { str?: string; transform?: number[]; width?: number }[])
    .filter((it) => typeof it.str === 'string' && Array.isArray(it.transform))
    .map((it) => ({ str: it.str!, transform: it.transform!, width: it.width ?? 0 }));
}
