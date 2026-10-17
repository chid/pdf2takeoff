// Node OCR adapter (opt-in): tesseract.js reads sheets whose text was
// converted to outlines, returning words in PDF-point space for the
// engine's scale reader. The English language pack (~5 MB) is fetched once
// on first use and cached under ~/.cache/pdf2takeoff (PDF2TAKEOFF_CACHE
// overrides); the drawing itself never leaves the machine.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { renderRasterNode } from './raster-node.ts';
import type { SheetWord } from '../engine/scale.ts';

type Worker = Awaited<ReturnType<typeof import('tesseract.js').createWorker>>;
let workerPromise: Promise<Worker> | null = null;

export function ocrCacheDir(): string {
  return process.env.PDF2TAKEOFF_CACHE ?? join(homedir(), '.cache', 'pdf2takeoff');
}

async function getWorker(): Promise<Worker> {
  workerPromise ??= (async () => {
    const { createWorker } = await import('tesseract.js');
    const cachePath = ocrCacheDir();
    mkdirSync(cachePath, { recursive: true });
    return createWorker('eng', 1, { cachePath });
  })();
  return workerPromise;
}

/** Stop the OCR worker so the process can exit. */
export async function closeOcr(): Promise<void> {
  if (!workerPromise) return;
  const w = await workerPromise.catch(() => null);
  workerPromise = null;
  await w?.terminate();
}

/** Longest raster side handed to the recognizer, px. */
const MAX_OCR_PX = 5000;

/** OCR one page; words carry their baseline direction in PDF space, so
 *  rotated sheets (/Rotate) come back in the same frame as live text. */
export async function ocrPageNode(doc: PDFDocumentProxy, pageNum: number): Promise<SheetWord[]> {
  const page = await doc.getPage(pageNum);
  const vp = page.getViewport({ scale: 1 });
  const scale = Math.min(3, MAX_OCR_PX / Math.max(vp.width, vp.height));
  const raster = await renderRasterNode(doc, pageNum, scale);
  const cnv = createCanvas(raster.width, raster.height);
  const ctx = cnv.getContext('2d');
  const img = ctx.createImageData(raster.width, raster.height);
  img.data.set(raster.data);
  ctx.putImageData(img, 0, 0);

  const worker = await getWorker();
  const { data } = await worker.recognize(cnv.toBuffer('image/png'), {}, { blocks: true, text: true });

  // raster x-axis in PDF space: the baseline of upright text
  const o = raster.toPdf(0, 0);
  const ex = raster.toPdf(1, 0);
  const dir = { x: ex.x - o.x, y: ex.y - o.y };
  const dl = Math.hypot(dir.x, dir.y) || 1;
  dir.x /= dl;
  dir.y /= dl;

  const words: SheetWord[] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const w of line.words ?? []) {
          const text = (w.text ?? '').trim();
          const b = w.bbox;
          if (!text || !b) continue;
          const c = raster.toPdf((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
          words.push({
            text,
            conf: w.confidence ?? 0,
            xPt: c.x,
            yPt: c.y,
            wPt: (b.x1 - b.x0) / scale,
            hPt: (b.y1 - b.y0) / scale,
            dir: { ...dir },
          });
        }
      }
    }
  }
  return words;
}
