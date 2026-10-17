// Scan provider, tier 1: classic computer vision, no model download.
// Click one instance of a repeated symbol; the host rasterizes the page, and
// this pass binarizes the ink, extracts connected components, and matches
// every component to the clicked one by size, aspect, fill and a normalized
// shape signature. Runs in well under a second per sheet on typed arrays
// alone. Tier 2 (scan-onnx.ts) is a trained detector that slots in behind
// the same ScanResult interface; scan.ts picks whichever is available.
// cvTemplate() keeps the clicked component as a CvTemplate, and
// matchCvTemplate() counts it on another sheet's raster.

import type { Pt, ScanHit } from './types.ts';
import type { RasterPage } from './ports.ts';
import type { ScanResult } from './types.ts';

const SIG = 20; // signature grid
const MIN_COMPONENT_PX = 12;
const MATCH_DIST = 0.16; // signature L1 distance threshold (0 = identical)
const SIZE_BAND = 0.55; // sqrt area ratio bounds (1/x .. x)
const ASPECT_BAND = 0.3; // |log aspect ratio difference|
const FILL_BAND = 0.18;

interface Component {
  label: number;
  count: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  fill: number;
  sig: Float32Array;
}

/** A component taught on one sheet. Its size is kept with the raster scale
 *  it was measured at (px per PDF point), so another sheet rendered at any
 *  scale compares in physical units; aspect, fill and signature are
 *  scale-free. */
export interface CvTemplate {
  /** Ink pixels at pxPerPt. */
  px: number;
  pxPerPt: number;
  aspect: number;
  fill: number;
  sig: Float32Array;
}

export function cvScan(raster: RasterPage, clicked: Pt): ScanResult {
  const taught = cvTemplate(raster, clicked);
  if ('error' in taught) return taught;
  return { hits: taught.hits, provider: 'cv', templatePx: taught.template.px };
}

/** Teach the scan from a click: the clicked component as a template, and
 *  its matches on this sheet in reading order. */
export function cvTemplate(raster: RasterPage, clicked: Pt): { template: CvTemplate; hits: ScanHit[] } | { error: string } {
  const w = raster.width;
  const h = raster.height;
  const mask = inkMask(raster);

  // clicked point → raster px (with a small tolerance for anti-aliased edges)
  const click = raster.toRaster(clicked.x, clicked.y);
  const px = Math.round(click.x);
  const py = Math.round(click.y);
  let clickedLabel = 0;
  if (px >= 0 && py >= 0 && px < w && py < h) {
    // ring search up to ~3.3 PDF pt so a click anywhere inside a symbol
    // (not just exactly on a stroke) still teaches the scan
    for (let r = 0; r <= 10 && !clickedLabel; r++) {
      for (let dy = -r; dy <= r && !clickedLabel; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = px + dx;
          const y = py + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          if (mask[y * w + x]) {
            clickedLabel = -1; // marker: ink found, label assigned after pass
            break;
          }
        }
      }
    }
  }
  if (!clickedLabel) return { error: 'click directly on a symbol to teach the scan' };

  const { labels, comps } = components(mask, w, h);

  // resolve the clicked component (first ink pixel at/around the click)
  let found: Component | undefined;
  if (px >= 0 && py >= 0 && px < w && py < h) {
    outer: for (let r = 0; r <= 10; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = px + dx;
          const y = py + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const l = labels[y * w + x];
          if (l) {
            found = comps.find((c) => c.label === l);
            break outer;
          }
        }
      }
    }
  }
  if (!found)
    return {
      error: 'that symbol is too small or part of a large structure; try a smaller, isolated symbol',
    };

  const template: CvTemplate = {
    px: found.count,
    pxPerPt: pxPerPt(raster),
    aspect: (found.x1 - found.x0 + 1) / (found.y1 - found.y0 + 1),
    fill: found.fill,
    sig: found.sig,
  };
  return { template, hits: matchComponents(raster, comps, template) };
}

/** Every match of a taught component on a sheet (any sheet), in reading order. */
export function matchCvTemplate(raster: RasterPage, template: CvTemplate): ScanHit[] {
  return matchComponents(raster, components(inkMask(raster), raster.width, raster.height).comps, template);
}

/** Raster px per PDF point, read off the page transform. */
function pxPerPt(raster: RasterPage): number {
  const a = raster.toRaster(0, 0);
  const b = raster.toRaster(1, 0);
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Ink mask — vector CAD output is high-contrast, a fixed threshold is enough. */
function inkMask(raster: RasterPage): Uint8Array {
  const data = raster.data;
  const mask = new Uint8Array(raster.width * raster.height);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const lum = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
    mask[i] = lum < 150 ? 1 : 0;
  }
  return mask;
}

/** Connected components, 8-connectivity, iterative flood fill. Specks and
 *  sheet-sized structures (borders, walls) are labelled but not kept. */
function components(mask: Uint8Array, w: number, h: number): { labels: Int32Array; comps: Component[] } {
  const labels = new Int32Array(w * h);
  const comps: Component[] = [];
  const stack: number[] = [];
  let nextLabel = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const id = ++nextLabel;
    stack.length = 0;
    stack.push(start);
    labels[start] = id;
    let count = 0;
    let sx = 0;
    let sy = 0;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    while (stack.length) {
      const idx = stack.pop()!;
      const y = (idx / w) | 0;
      const x = idx - y * w;
      count++;
      sx += x;
      sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const nidx = ny * w + nx;
          if (mask[nidx] && !labels[nidx]) {
            labels[nidx] = id;
            stack.push(nidx);
          }
        }
      }
    }
    if (count < MIN_COMPONENT_PX || count > (w * h) / 16) continue;
    comps.push(makeComponent(id, count, x0, y0, x1, y1, sx / count, sy / count, labels, w));
  }
  return { labels, comps };
}

/** Match every component against the template. */
function matchComponents(raster: RasterPage, comps: Component[], t: CvTemplate): ScanHit[] {
  // the template's ink area at this raster's scale (exactly t.px on the
  // sheet it was taught on)
  const scale = pxPerPt(raster) / t.pxPerPt;
  const px = scale === 1 ? t.px : t.px * scale * scale;
  const hits: ScanHit[] = [];
  for (const c of comps) {
    const sizeRatio = Math.sqrt(px / c.count);
    if (sizeRatio < SIZE_BAND || sizeRatio > 1 / SIZE_BAND) continue;
    const aspectC = (c.x1 - c.x0 + 1) / (c.y1 - c.y0 + 1);
    if (Math.abs(Math.log(t.aspect / aspectC)) > ASPECT_BAND) continue;
    if (Math.abs(t.fill - c.fill) > FILL_BAND) continue;
    let d = 0;
    for (let i = 0; i < t.sig.length; i++) d += Math.abs(t.sig[i] - c.sig[i]);
    if (d <= MATCH_DIST) {
      hits.push(raster.toPdf(c.cx, c.cy));
    }
  }

  // stable numbering: reading order, rows then columns
  hits.sort((a, b) => (Math.abs(b.y - a.y) > 8 ? b.y - a.y : a.x - b.x));
  return hits;
}


function makeComponent(
  label: number,
  count: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cx: number,
  cy: number,
  labels: Int32Array,
  w: number,
): Component {
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  // shape signature: ink coverage downsampled to a SIG x SIG grid over the bbox
  const sig = new Float32Array(SIG * SIG);
  const cellW = bw / SIG;
  const cellH = bh / SIG;
  for (let y = y0; y <= y1; y++) {
    const row = y * w;
    const gy = Math.min(SIG - 1, Math.floor((y - y0) / cellH));
    for (let x = x0; x <= x1; x++) {
      if (labels[row + x] === label) {
        const gx = Math.min(SIG - 1, Math.floor((x - x0) / cellW));
        sig[gy * SIG + gx] += 1;
      }
    }
  }
  const perCell = cellW * cellH;
  for (let i = 0; i < sig.length; i++) sig[i] = Math.min(1, sig[i] / perCell);
  return { label, count, x0, y0, x1, y1, cx, cy, fill: count / (bw * bh), sig };
}
