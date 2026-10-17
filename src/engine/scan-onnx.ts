// Scan provider, tier 2: decode + geometry half of a trained symbol detector.
// The host loads the ONNX model (see DetectorSession in ports.ts) and supplies
// the rasterized page; this module does the deterministic parts — letterbox
// preprocessing, output decoding, per-class NMS, and mapping detections back
// to PDF points — so browser and Node runs produce identical results.
//
// The user's mental model stays "click one, count them all": the detector
// runs page-wide, then keeps only the class of the detection nearest the
// click, so a click on a downlight returns every downlight, pre-labelled.

import type { Pt, ScanHit, ScanResult } from './types.ts';
import type { DetectorSession, RasterPage } from './ports.ts';

const MAX_DET = 500;

/**
 * Letterbox a raster into the model's square input (white padding) and pack
 * it as CHW RGB floats in [0,1]. Pure bilinear resampling — no canvas — so
 * every environment produces bit-identical inputs.
 */
function letterboxCHW(r: RasterPage, S: number): { input: Float32Array; scale: number; dw: number; dh: number } {
  const scale = Math.min(S / r.width, S / r.height);
  const dw = (S - r.width * scale) / 2;
  const dh = (S - r.height * scale) / 2;
  const input = new Float32Array(3 * S * S);
  const src = r.data;
  const sw = r.width;
  const sh = r.height;
  const sample = (fx: number, fy: number, ch: number): number => {
    // bilinear with clamped weights; anything outside the page area is white
    if (fx < -0.5 || fy < -0.5 || fx > sw - 0.5 || fy > sh - 0.5) return 255;
    const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
    const x1 = Math.min(sw - 1, x0 + 1);
    const y1 = Math.min(sh - 1, y0 + 1);
    const tx = Math.min(1, Math.max(0, fx - x0));
    const ty = Math.min(1, Math.max(0, fy - y0));
    const i00 = (y0 * sw + x0) * 4 + ch;
    const i10 = (y0 * sw + x1) * 4 + ch;
    const i01 = (y1 * sw + x0) * 4 + ch;
    const i11 = (y1 * sw + x1) * 4 + ch;
    const top = src[i00] + (src[i10] - src[i00]) * tx;
    const bot = src[i01] + (src[i11] - src[i01]) * tx;
    return top + (bot - top) * ty;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const fx = (x - dw) / scale;
      const fy = (y - dh) / scale;
      const i0 = y * S + x;
      input[i0] = sample(fx, fy, 0) / 255;
      input[S * S + i0] = sample(fx, fy, 1) / 255;
      input[2 * S * S + i0] = sample(fx, fy, 2) / 255;
    }
  }
  return { input, scale, dw, dh };
}

/** A class taught on one sheet: counted on another by running the detector
 *  there and keeping that class. */
export interface DetectorTemplate {
  cls: number;
  label: string;
}

export async function detectorScan(
  raster: RasterPage,
  clicked: Pt,
  det: DetectorSession,
): Promise<ScanResult> {
  const taught = await detectorTemplate(raster, clicked, det);
  if ('error' in taught) return taught;
  return {
    hits: taught.hits,
    provider: 'detector',
    note: `${taught.template.label} · ${det.modelName}`,
  };
}

/** Teach the scan from a click: the class of the detection nearest it, and
 *  every detection of that class on this sheet. */
export async function detectorTemplate(
  raster: RasterPage,
  clicked: Pt,
  det: DetectorSession,
): Promise<{ template: DetectorTemplate; hits: ScanHit[] } | { error: string }> {
  const kept = await detect(raster, det);
  if (kept.length === 0) {
    return { error: 'the detector found no symbols on this sheet; try the classic scan' };
  }

  // class of the detection nearest the click
  let nearest = kept[0];
  let nd = Infinity;
  for (const d of kept) {
    const dist = (d.x - clicked.x) ** 2 + (d.y - clicked.y) ** 2;
    if (dist < nd) {
      nd = dist;
      nearest = d;
    }
  }
  const template = { cls: nearest.cls, label: det.classes[nearest.cls] ?? `symbol ${nearest.cls}` };
  return { template, hits: ofClass(kept, template) };
}

/** Every detection of a taught class on a sheet (any sheet), in reading order. */
export async function matchDetectorTemplate(raster: RasterPage, template: DetectorTemplate, det: DetectorSession): Promise<ScanHit[]> {
  return ofClass(await detect(raster, det), template);
}

function ofClass(kept: Detection[], t: DetectorTemplate): ScanHit[] {
  const hits: ScanHit[] = kept.filter((d) => d.cls === t.cls).map((d) => ({ x: d.x, y: d.y, label: t.label, score: d.score }));
  // stable numbering: reading order, rows then columns
  hits.sort((a, b) => (Math.abs(b.y - a.y) > 8 ? b.y - a.y : a.x - b.x));
  return hits;
}

/** A kept detection: its box centre in PDF points. */
interface Detection {
  x: number;
  y: number;
  cls: number;
  score: number;
}

/** Run the detector page-wide: decoded, thresholded, per-class NMS. */
async function detect(raster: RasterPage, det: DetectorSession): Promise<Detection[]> {
  const S = det.inputSize;
  const { input, scale, dw, dh } = letterboxCHW(raster, S);
  const { data: arr, dims } = await det.run(input, S);

  // Rows are [x1,y1,x2,y2,obj,cls...] in [1, N, 5+C] (or a transposed
  // [1, 5+C, N]). Anchor the row width to the manifest's class count —
  // picking it by "larger dim" misorients [1, N, 5+C] whenever N > 5+C.
  const rowW = 5 + det.classes.length;
  const stride = dims.includes(rowW) ? rowW : Math.max(dims[1] ?? 0, dims[2] ?? 1);
  const rows = Math.floor(arr.length / stride);
  const rowMajor = dims[dims.length - 1] === stride;
  const nCls = stride - 5;
  const at = (r: number, c: number) => (rowMajor ? arr[r * stride + c] : arr[c * rows + r]);

  interface Det {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    score: number;
    cls: number;
  }
  const dets: Det[] = [];
  for (let r = 0; r < rows; r++) {
    const obj = at(r, 4);
    let bestC = -1;
    let bestP = 0;
    for (let c = 0; c < nCls; c++) {
      const p = at(r, 5 + c);
      if (p > bestP) {
        bestP = p;
        bestC = c;
      }
    }
    const score = det.head === 'mmdet' ? bestP : obj * bestP;
    if (score < det.score) continue;
    dets.push({
      x1: at(r, 0),
      y1: at(r, 1),
      x2: at(r, 2),
      y2: at(r, 3),
      score,
      cls: bestC,
    });
  }

  // per-class NMS
  dets.sort((a, b) => b.score - a.score);
  const keep = new Set<number>();
  for (let i = 0; i < dets.length && keep.size < MAX_DET; i++) {
    if (keep.has(i)) continue;
    keep.add(i);
    for (let j = i + 1; j < dets.length; j++) {
      if (keep.has(j) || dets[j].cls !== dets[i].cls) continue;
      const ix1 = Math.max(dets[i].x1, dets[j].x1);
      const iy1 = Math.max(dets[i].y1, dets[j].y1);
      const ix2 = Math.min(dets[i].x2, dets[j].x2);
      const iy2 = Math.min(dets[i].y2, dets[j].y2);
      const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
      const a1 = (dets[i].x2 - dets[i].x1) * (dets[i].y2 - dets[i].y1);
      const a2 = (dets[j].x2 - dets[j].x1) * (dets[j].y2 - dets[j].y1);
      if (inter / Math.max(1e-6, a1 + a2 - inter) > det.iou) keep.add(j);
    }
  }

  // letterbox px -> PDF points (viewport transform is uniform for 0/90/180/270)
  const toPdf = (x: number, y: number): Pt => raster.toPdf((x - dw) / scale, (y - dh) / scale);

  return [...keep].map((i) => {
    const d = dets[i];
    const c = toPdf((d.x1 + d.x2) / 2, (d.y1 + d.y2) / 2);
    return { x: c.x, y: c.y, cls: d.cls, score: d.score };
  });
}
