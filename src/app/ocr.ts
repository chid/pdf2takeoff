// Browser OCR adapter: lazily loads tesseract.js (WASM) on first use, reads
// the current page, and maps recognized words into PDF-point space for the
// engine's calibration heuristics. The first run fetches the language pack
// from a CDN (~4 MB, then cached) — everything after that is local.
// pageTextWords reads the PDF's own live text instead: instant, no download.

import { renderRaster } from './raster';
import { getPdfDoc } from './viewer';
import { wordsFromTextItems, type SheetGeometry, type SheetWord, type TextItemLike } from '../engine/scale';

let workerPromise: Promise<import('tesseract.js').Worker> | null = null;

async function getWorker() {
  workerPromise ??= (async () => {
    const { createWorker } = await import('tesseract.js');
    return createWorker('eng');
  })();
  return workerPromise;
}

const OCR_SCALE = 3;

export async function ocrPage(pageNum: number): Promise<SheetWord[]> {
  const raster = await renderRaster(pageNum, OCR_SCALE);
  // the recognizer reads a canvas; rebuild one from the raster bytes
  const cnv = document.createElement('canvas');
  cnv.width = raster.width;
  cnv.height = raster.height;
  const ctx = cnv.getContext('2d')!;
  const img = ctx.createImageData(raster.width, raster.height);
  img.data.set(raster.data as Uint8ClampedArray);
  ctx.putImageData(img, 0, 0);

  const worker = await getWorker();
  const { data } = await worker.recognize(cnv, {}, { blocks: true, text: true });

  // v7 nests words under blocks -> paragraphs -> lines -> words
  const raw: { text: string; conf: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const w of line.words ?? []) raw.push({ text: w.text ?? '', conf: w.confidence ?? 0, bbox: w.bbox });
      }
    }
  }

  // upright text runs along the raster's x-axis; in PDF space that is
  // rotated on /Rotate sheets, so carry the direction with each word
  const o = raster.toPdf(0, 0);
  const ex = raster.toPdf(1, 0);
  const len = Math.hypot(ex.x - o.x, ex.y - o.y) || 1;
  const dir = { x: (ex.x - o.x) / len, y: (ex.y - o.y) / len };

  const words: SheetWord[] = [];
  for (const w of raw) {
    const text = w.text.trim();
    const b = w.bbox;
    if (!text || !b) continue;
    const c = raster.toPdf((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
    words.push({
      text,
      conf: w.conf,
      xPt: c.x,
      yPt: c.y,
      wPt: (b.x1 - b.x0) / OCR_SCALE,
      hPt: (b.y1 - b.y0) / OCR_SCALE,
      dir: { ...dir },
    });
  }
  return words;
}

/** The page's live text as positioned words, plus its geometry. */
export async function pageTextWords(pageNum: number): Promise<{ words: SheetWord[]; sheet: SheetGeometry }> {
  const doc = getPdfDoc();
  if (!doc) throw new Error('open a drawing first');
  const page = await doc.getPage(pageNum);
  const tc = await page.getTextContent();
  return {
    words: wordsFromTextItems(tc.items.filter((i) => 'str' in i) as TextItemLike[]),
    sheet: { view: page.view, rotate: page.rotate },
  };
}
