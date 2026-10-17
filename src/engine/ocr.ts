// OCR word parsing: turn recognized words into calibration suggestions.
// Pure text + geometry heuristics; the host runs the actual recognizer and
// supplies words positioned in PDF-point space (origin bottom-left).

import type { Pt } from './types.ts';
import type { Unit } from './units.ts';
import { findScaleStatements } from './scale.ts';

export interface OcrWord {
  text: string;
  conf: number; // recognizer confidence 0..100
  xPt: number; // bbox centre
  yPt: number;
  wPt: number;
  hPt: number;
}

/** A drawing ratio read from the sheet, e.g. 1:100 from a title block. */
export interface ScaleHit {
  ratio: number;
  source: string;
}

/**
 * Find a drawing ratio (1:N) in the recognized text — the scale.ts parser
 * without sheet geometry: hits beside a SCALE label or naming their paper
 * size ("@ A1") win, since detail viewports often print secondary ratios.
 * readSheetScale (scale.ts) is the full reader: title block, paper-size
 * correction and the page default.
 */
export function findScaleRatio(words: OcrWord[]): ScaleHit | null {
  const hits = findScaleStatements(words, undefined, { ocr: true }).filter((s) => s.ratio !== null);
  if (hits.length === 0) return null;
  const score = (s: (typeof hits)[number]) => (s.labelled ? 2 : 0) + (s.paper ? 1 : 0);
  hits.sort((a, b) => score(b) - score(a));
  return { ratio: hits[0].ratio as number, source: `OCR 1:${hits[0].ratio}` };
}

/** A printed dimension value near a clicked line. */
export interface DimensionHit {
  value: number;
  unit: Unit;
  text: string;
}

const NUM_RE = /^(\d{1,2}[.,]\d{1,2}|\d{3,5})(\s*(mm|cm|m|ft|in|'|"))?$/i;

/**
 * Numeric dimension text nearest (and roughly aligned with) the a→b segment
 * the user just clicked. "12.00" reads as metres, "12000" as millimetres; a
 * printed unit suffix wins. Labels sit just off the line near its middle.
 */
export function nearestDimensionValue(words: OcrWord[], a: Pt, b: Pt): DimensionHit | null {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const lenX = Math.abs(b.x - a.x);
  const lenY = Math.abs(b.y - a.y);
  const horizontal = lenX >= lenY;
  const lineLen = Math.max(lenX, lenY);

  let best: { d: number; hit: DimensionHit } | null = null;
  for (const w of words) {
    const m = w.text.trim().match(NUM_RE);
    if (!m) continue;
    const raw = m[1].replace(',', '.');
    // decimals look like metres ("12.00"); bare 3-5 digit integers like mm ("12000")
    let unit: Unit = raw.includes('.') ? 'm' : 'mm';
    const suffix = (m[2] ?? '').trim().toLowerCase();
    if (suffix === 'mm' || suffix === 'cm' || suffix === 'm' || suffix === 'ft' || suffix === 'in') unit = suffix;
    else if (suffix === "'") unit = 'ft';
    else if (suffix === '"') unit = 'in';
    const value = parseFloat(raw);
    if (!Number.isFinite(value) || value <= 0) continue;

    const dx = Math.abs(w.xPt - mid.x);
    const dy = Math.abs(w.yPt - mid.y);
    const along = horizontal ? dx : dy; // distance along the line from its middle
    const across = horizontal ? dy : dx; // perpendicular offset (text sits off-line)
    if (along > lineLen / 2 + 30) continue; // not near this line
    if (across > 40) continue; // too far off the line to be its label
    const d = Math.hypot(dx, dy) - w.wPt / 4; // slight bias toward wider text
    if (!best || d < best.d) best = { d, hit: { value, unit, text: w.text.trim() } };
  }
  return best?.hit ?? null;
}
