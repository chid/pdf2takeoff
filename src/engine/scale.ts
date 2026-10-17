// Auto-scale: read the drawing scale a sheet prints ("SCALE 1:100 @ A3"),
// correct it for the paper the sheet was actually issued on, and cross-check
// it against the sheet's own dimension strings.
//
// Pure text + geometry. The host supplies words in PDF user space (live text
// from pdf.js getTextContent via wordsFromTextItems, or OCR words) and,
// for the cross-check, the page's vector paths (scan-vector.ts vectorPage).
//
// Default-scale heuristic (readSheetScale): a sheet can print several
// scales — the title block's, one per viewport title, a scale bar's. The
// title block's scale field is the statement nearest the bottom-right corner
// (as displayed, so /Rotate is honoured) among those in the title band (the
// bottom or right 20% of the sheet) that carry a SCALE label beside them, say
// "SCALE …" themselves, or name a paper size ("@ A3", "(A1)"). When that
// field is a ratio it is the page default. When it says "As noted" / "NTS",
// or there is no field, the page default is the sheet's ratio only when
// every scale printed on the sheet agrees; differing viewport scales leave
// the default unset rather than guessing.

import type { Pt } from './types.ts';
import type { OcrWord } from './ocr.ts';
import type { VectorPage } from './scan-vector.ts';
import { METERS_PER_PT, metersPerPtForRatio } from './units.ts';

/** A positioned word: live text or OCR. dir = baseline direction in PDF
 *  space (unit vector, default +x); xPt/yPt = bbox centre; wPt along the
 *  baseline, hPt across it. */
export type SheetWord = OcrWord & { dir?: Pt };

export type PaperSize = 'A0' | 'A1' | 'A2' | 'A3' | 'A4';

/** ISO 216 sheet sizes in PDF points, [short, long]. */
export const PAPER_SIZES_PT: Record<PaperSize, [number, number]> = {
  A0: [2383.94, 3370.39],
  A1: [1683.78, 2383.94],
  A2: [1190.55, 1683.78],
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
};

/** The ISO A size a page is (either orientation, 2% slack), or null. */
export function paperSizeOf(widthPt: number, heightPt: number): PaperSize | null {
  const s = Math.min(widthPt, heightPt);
  const l = Math.max(widthPt, heightPt);
  for (const [name, [ps, pl]] of Object.entries(PAPER_SIZES_PT) as [PaperSize, [number, number]][]) {
    if (Math.abs(s / ps - 1) < 0.02 && Math.abs(l / pl - 1) < 0.02) return name;
  }
  return null;
}

/** pdf.js getTextContent() item, accessed structurally. */
export interface TextItemLike {
  str: string;
  transform: number[]; // [a, b, c, d, e, f]: text space → PDF user space
  width: number; // advance along the baseline, user space
  height: number;
}

/** Live text items → positioned words (bbox centre, baseline direction). */
export function wordsFromTextItems(items: TextItemLike[]): SheetWord[] {
  const out: SheetWord[] = [];
  for (const it of items) {
    if (typeof it.str !== 'string' || !it.str.trim() || !it.transform) continue;
    const [a, b, c, d, e, f] = it.transform;
    const along = Math.hypot(a, b);
    const across = Math.hypot(c, d);
    if (!(along > 0) || !(across > 0)) continue;
    const dir = { x: a / along, y: b / along };
    // "up" is the baseline turned a quarter left; pdf.js height ≈ font size
    const up = { x: -dir.y, y: dir.x };
    const h = it.height > 0 ? it.height : across;
    const w = it.width > 0 ? it.width : h * 0.5 * it.str.length;
    out.push({
      text: it.str,
      conf: 100,
      xPt: e + (dir.x * w) / 2 + up.x * h * 0.35,
      yPt: f + (dir.y * w) / 2 + up.y * h * 0.35,
      wPt: w,
      hPt: h,
      dir,
    });
  }
  return out;
}

/** Page geometry as the host knows it: pdf.js page.view and page.rotate. */
export interface SheetGeometry {
  view: number[]; // [x0, y0, x1, y1]
  rotate?: number; // 0 | 90 | 180 | 270
}

/** PDF point → sheet position as displayed, 0..1 from the top-left. */
function displayUV(p: Pt, g: SheetGeometry): { u: number; v: number } {
  const [x0, y0, x1, y1] = g.view;
  const W = x1 - x0 || 1;
  const H = y1 - y0 || 1;
  switch ((((g.rotate ?? 0) % 360) + 360) % 360) {
    case 90:
      return { u: (p.y - y0) / H, v: (p.x - x0) / W };
    case 180:
      return { u: (x1 - p.x) / W, v: (p.y - y0) / H };
    case 270:
      return { u: (y1 - p.y) / H, v: (x1 - p.x) / W };
    default:
      return { u: (p.x - x0) / W, v: (y1 - p.y) / H };
  }
}

/** One scale statement printed on the sheet. */
export interface ScaleStatement {
  /** ratio: "1:100"; nts: not to scale; as-noted: "As noted" / "As shown";
   *  paper: a paper size printed in its own field with no ratio near it. */
  kind: 'ratio' | 'nts' | 'as-noted' | 'paper';
  /** N of 1:N as printed (null for NTS / "as noted"). */
  ratio: number | null;
  /** Paper the ratio is stated for ("@ A3", "(A1)", "A3 paper size"). */
  paper: PaperSize | null;
  /** The printed phrase. */
  text: string;
  /** Phrase centre, PDF points. */
  x: number;
  y: number;
  /** A SCALE label beside it, or "SCALE" in the phrase itself. */
  labelled: boolean;
  /** In the title-block band (bottom/right 20% of the sheet as displayed). */
  titleBand: boolean;
  /** OCR dropped the colon ("1100" after "scale:") and it was read as 1:100. */
  repaired?: boolean;
}

// A phrase: words on one baseline, read in order.
interface Phrase {
  text: string;
  x: number;
  y: number;
  h: number;
  dir: Pt;
  t0: number; // extent along dir
  t1: number;
}

/** "1 : 2 0 0" / "S C A L E" (letter-spaced CAD text) → "1:200" / "SCALE". */
function unspace(s: string): string {
  const t = s.trim();
  return /^(\S )+\S$/.test(t) ? t.replace(/ /g, '') : t;
}

function phrasesOf(words: SheetWord[]): Phrase[] {
  type W = { text: string; c: Pt; dir: Pt; h: number; t0: number; t1: number; s: number };
  const ws: W[] = [];
  for (const w of words) {
    const text = unspace(w.text);
    if (!text) continue;
    const dir = w.dir ?? { x: 1, y: 0 };
    const n = { x: -dir.y, y: dir.x };
    const tc = w.xPt * dir.x + w.yPt * dir.y;
    ws.push({ text, c: { x: w.xPt, y: w.yPt }, dir, h: Math.max(1, w.hPt), t0: tc - w.wPt / 2, t1: tc + w.wPt / 2, s: w.xPt * n.x + w.yPt * n.y });
  }
  // group words that share a baseline direction and line, then chain by gap
  ws.sort((a, b) => a.t0 - b.t0);
  const used = new Array<boolean>(ws.length).fill(false);
  const out: Phrase[] = [];
  for (let i = 0; i < ws.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const chain = [ws[i]];
    let last = ws[i];
    for (let j = i + 1; j < ws.length; j++) {
      if (used[j]) continue;
      const w = ws[j];
      if (w.dir.x * last.dir.x + w.dir.y * last.dir.y < 0.995) continue;
      const h = Math.max(w.h, last.h);
      if (Math.max(w.h, last.h) / Math.min(w.h, last.h) > 1.8) continue;
      if (Math.abs(w.s - last.s) > 0.45 * h) continue;
      const gap = w.t0 - last.t1;
      if (gap < -0.5 * h || gap > 1.5 * h) continue;
      used[j] = true;
      chain.push(w);
      last = w;
    }
    const n = chain.length;
    out.push({
      text: chain.map((w) => w.text).join(' '),
      x: chain.reduce((s, w) => s + w.c.x, 0) / n,
      y: chain.reduce((s, w) => s + w.c.y, 0) / n,
      h: Math.max(...chain.map((w) => w.h)),
      dir: chain[0].dir,
      t0: chain[0].t0,
      t1: chain[n - 1].t1,
    });
  }
  return out;
}

const RATIO_RE = /(?<![\w.,:/])1\s?:\s?([1-9]\d{0,4}(?:\.\d+)?)(?![\d:])/g;
const PAPER_RES = [
  /@\s?A\s?([0-4])\b/i,
  /\(\s?A([0-4])\s?\)/i,
  /\bA([0-4])\s*(?:paper|sheet|size)/i,
  /(?:paper|sheet)(?:\s*size)?\s*:?\s*A([0-4])\b/i,
];
const SCALE_WORD_RE = /\bscale\b|\bhoriz|\bvert(?:ical)?\b/i;
const LABEL_RE = /^(?:drawing\s+)?scales?\s*:?$/i;
const NOT_A_SCALE_RE = /\b(?:fall|grade|gradient|slope|batter|pitch|mix|ratio|in\s+\d)/i;
const NTS_RE = /\bN\.?\s?T\.?\s?S\b\.?|\bnot\s+to\s+scale\b/i;
const AS_NOTED_RE = /\bas\s+(?:noted|shown|indicated|marked)\b|\bvari(?:es|ous)\b/i;
/** Ratios printed on drawings, for repairing OCR that lost the colon. */
const COMMON_RATIOS = new Set([
  2, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000, 1250, 1500, 2000, 2500, 3000, 5000, 10000,
]);

function paperIn(text: string): PaperSize | null {
  for (const re of PAPER_RES) {
    const m = text.match(re);
    if (m) return `A${m[1]}` as PaperSize;
  }
  return null;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Every scale statement on the sheet: ratios ("1:100", "SCALE 1:200 (m)"),
 * "NTS" and "As noted" scale fields. Ratios inside prose ("fall of not less
 * than 1:300", "AS 2890.1:2004") are left out: a ratio counts only beside a
 * SCALE label or standing alone (a viewport title's "1:100").
 */
export function findScaleStatements(
  words: SheetWord[],
  sheet?: SheetGeometry,
  opts: { ocr?: boolean } = {},
): ScaleStatement[] {
  const phrases = phrasesOf(words);
  const labels = phrases.filter((p) => LABEL_RE.test(p.text.trim()));
  const nearLabel = (p: Phrase) => labels.some((l) => l !== p && dist(l, p) <= Math.max(40, 6 * p.h));
  const band = (p: Pt) => {
    if (!sheet) return false;
    const { u, v } = displayUV(p, sheet);
    return u > 0.8 || v > 0.8;
  };

  const out: ScaleStatement[] = [];
  const paperOnly: { paper: PaperSize; p: Phrase }[] = [];
  for (const p of phrases) {
    const text = p.text;
    const hasScaleWord = SCALE_WORD_RE.test(text) && !/do\s+not\s+scale/i.test(text);
    const labelled = hasScaleWord || nearLabel(p);
    const paper = paperIn(text);
    const base = { text, x: p.x, y: p.y, labelled, titleBand: band(p) };

    const ratios: { n: number; repaired?: boolean }[] = [];
    for (const m of text.matchAll(RATIO_RE)) ratios.push({ n: parseFloat(m[1]) });
    if (ratios.length === 0 && opts.ocr && labelled) {
      // OCR often drops the colon: "scale: 1100 @A3" is 1:100
      const m = text.match(/(?:^|\s)1[;.,|il]?([1-9]\d{0,4})(?=\s|@|$)/i);
      if (m && COMMON_RATIOS.has(parseInt(m[1], 10)) && (hasScaleWord || paper)) {
        ratios.push({ n: parseInt(m[1], 10), repaired: true });
      }
    }

    if (ratios.length > 0) {
      if (!hasScaleWord && NOT_A_SCALE_RE.test(text)) continue;
      // standing alone: nothing but the ratio, its paper size and units
      const rest = text
        .replace(RATIO_RE, ' ')
        .replace(/(?:^|\s)1[;.,|il]?[1-9]\d{0,4}(?=\s|@|$)/i, ' ')
        .replace(/@\s?A\s?[0-4]|\(\s?A[0-4]\s?\)|\((?:m|mm)\)|\bscale\b|\bhoriz\w*|\bvert\w*|[:@()]/gi, ' ');
      const standalone = rest.replace(/[^a-z0-9]/gi, '').length <= 2;
      if (!labelled && !standalone) continue;
      for (const r of ratios) {
        if (!(r.n >= 1 && r.n <= 10000)) continue;
        out.push({ kind: 'ratio', ratio: r.n, paper, ...base, ...(r.repaired ? { repaired: true } : {}) });
      }
      continue;
    }
    if (labelled && NTS_RE.test(text)) {
      out.push({ kind: 'nts', ratio: null, paper, ...base });
      continue;
    }
    if (labelled && AS_NOTED_RE.test(text)) {
      out.push({ kind: 'as-noted', ratio: null, paper, ...base });
      continue;
    }
    if (paper) paperOnly.push({ paper, p });
  }

  // a paper size printed in its own field ("PAPER (A3)", "A3 paper size")
  // belongs to the nearest statement within reach
  for (const { paper, p } of paperOnly) {
    let best: ScaleStatement | null = null;
    for (const s of out) {
      if (s.paper) continue;
      const d = dist(s, p);
      if (d <= Math.max(60, 8 * p.h) && (!best || d < dist(best, p))) best = s;
    }
    if (best) best.paper = paper;
    else if (band(p) && !out.some((s) => s.paper === paper && dist(s, p) <= Math.max(60, 8 * p.h))) {
      out.push({ kind: 'paper', ratio: null, paper, text: p.text, x: p.x, y: p.y, labelled: false, titleBand: true });
    }
  }
  return out;
}

export interface SheetScale {
  /** The page default chosen from the statements (see the file header). */
  stated: ScaleStatement | null;
  /** Why that statement (or none) was chosen. */
  rule: string;
  statements: ScaleStatement[];
  /** Paper the stated ratio refers to (its own, else the title block's). */
  statedPaper: PaperSize | null;
  /** ISO size of this page, or null for a non-standard sheet. */
  pagePaper: PaperSize | null;
  /** statedPaper's long side / this page's: 2 for an A1 drawing issued on A3. */
  sizeFactor: number;
  /** Ratio that holds on this page: stated × sizeFactor. */
  effectiveRatio: number | null;
  metersPerPt: number | null;
  warnings: string[];
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const fmtRatio = (n: number) => `1:${round(n, 1)}`;

/** Read the sheet's scale: statements, page default, paper-size correction. */
export function readSheetScale(words: SheetWord[], sheet: SheetGeometry, opts: { ocr?: boolean } = {}): SheetScale {
  const statements = findScaleStatements(words, sheet, opts);
  const [x0, y0, x1, y1] = sheet.view;
  const pageW = x1 - x0;
  const pageH = y1 - y0;
  const pagePaper = paperSizeOf(pageW, pageH);
  const warnings: string[] = [];

  const score = (s: ScaleStatement) => (s.labelled ? 2 : 0) + (s.paper ? 2 : 0) + (s.titleBand ? 1 : 0);
  const cornerDist = (s: ScaleStatement) => {
    const { u, v } = displayUV(s, sheet);
    return Math.hypot(1 - u, 1 - v);
  };
  const isTitle = (s: ScaleStatement) => s.titleBand && (s.labelled || s.paper !== null);
  const rank = (a: ScaleStatement, b: ScaleStatement) => score(b) - score(a) || cornerDist(a) - cornerDist(b);

  const ratios = statements.filter((s) => s.kind === 'ratio');
  // the title block's own scale field: of the labelled / paper-sized
  // statements in the title band, the one nearest the bottom-right corner
  const field = statements
    .filter((s) => s.kind !== 'paper' && isTitle(s))
    .sort((a, b) => cornerDist(a) - cornerDist(b) || score(b) - score(a))[0];
  const distinct = [...new Set(ratios.map((s) => s.ratio as number))];

  let stated: ScaleStatement | null = null;
  let rule: string;
  if (field?.kind === 'ratio') {
    stated = field;
    rule = 'title block';
  } else if (distinct.length === 1) {
    stated = [...ratios].sort(rank)[0];
    rule = field
      ? `title block says "${field.text}"; every scale on the sheet is ${fmtRatio(distinct[0])}`
      : 'the only scale on the sheet';
  } else if (distinct.length > 1) {
    rule = 'several scales and no title-block scale: no page default';
    warnings.push(`sheet prints several scales (${distinct.map(fmtRatio).join(', ')}): calibrate each viewport`);
  } else if (field?.kind === 'nts') {
    rule = 'title block says not to scale';
    warnings.push('sheet is marked NTS (not to scale)');
  } else if (statements.length > 0) {
    rule = 'no ratio printed';
    const shown = field ?? statements[0];
    warnings.push(`scale field reads "${shown.text}" and no ratio could be read on the sheet`);
  } else {
    rule = 'no scale text';
    warnings.push(
      words.length === 0
        ? 'no scale text: the sheet has no readable text (converted to outlines?)'
        : 'no scale text found on the sheet',
    );
  }

  if (stated) {
    const others = [...new Set(ratios.filter((s) => s.ratio !== stated!.ratio).map((s) => s.ratio as number))];
    if (others.length > 0) warnings.push(`sheet also prints ${others.map(fmtRatio).join(', ')} (viewports/scale bars may differ from the page default)`);
    if (stated.repaired) warnings.push(`OCR read "${stated.text}" without its colon; taken as ${fmtRatio(stated.ratio as number)}`);
  }

  // paper the ratio refers to: its own, else a paper size in the title block
  const statedPaper = stated
    ? (stated.paper ?? statements.filter((s) => s.paper && s.titleBand).sort(rank)[0]?.paper ?? null)
    : null;
  let sizeFactor = 1;
  if (stated && statedPaper) {
    const pageLong = Math.max(pageW, pageH);
    const f = PAPER_SIZES_PT[statedPaper][1] / pageLong;
    if (Math.abs(f - 1) > 0.02) {
      sizeFactor = f;
      warnings.push(
        `scale is stated for ${statedPaper} but this sheet is ${pagePaper ?? `${Math.round(pageW)}×${Math.round(pageH)} pt`}: ` +
          `${fmtRatio(stated.ratio as number)} @ ${statedPaper} is ${fmtRatio((stated.ratio as number) * f)} on this sheet`,
      );
    }
  } else if (stated) {
    warnings.push('paper size not stated: ratio assumed to hold on this sheet as issued');
  }
  const effectiveRatio = stated ? (stated.ratio as number) * sizeFactor : null;
  return {
    stated,
    rule,
    statements,
    statedPaper,
    pagePaper,
    sizeFactor: round(sizeFactor, 4),
    effectiveRatio: effectiveRatio === null ? null : round(effectiveRatio, 3),
    metersPerPt: effectiveRatio === null ? null : metersPerPtForRatio(effectiveRatio),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Cross-check: printed dimensions against the lines they label.

export interface DimensionCheck {
  text: string;
  /** Printed value, millimetres. */
  valueMm: number;
  /** Text centre, PDF points. */
  at: [number, number];
  /** Ends of the dimension it labels, PDF points. */
  from: [number, number];
  to: [number, number];
  lengthPt: number;
  /** Ratio this dimension implies: value / paper length. */
  impliedRatio: number;
  agrees: boolean;
}

export interface DimensionVerdict {
  status: 'verified' | 'contradicted' | 'unverified';
  checked: number;
  agreeing: number;
  /** Ratio most dimensions agree on, when it isn't the one checked. */
  suggestedRatio?: number;
  checks: DimensionCheck[];
}

/** Agreement tolerance between printed and measured dimensions. */
export const DIMENSION_TOLERANCE = 0.01;

const DIM_RE = /^(?:\d{3,6}|\d{1,3}(?:,\d{3})+)$/;

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

function segmentsOf(page: VectorPage): Seg[] {
  const segs: Seg[] = [];
  for (const p of page.paths) {
    let k = 0;
    let cx = 0;
    let cy = 0;
    let sx = 0;
    let sy = 0;
    for (const c of p.cmds) {
      if (c === 'M') {
        cx = sx = p.pts[k++];
        cy = sy = p.pts[k++];
      } else if (c === 'L') {
        const x = p.pts[k++];
        const y = p.pts[k++];
        segs.push({ ax: cx, ay: cy, bx: x, by: y });
        cx = x;
        cy = y;
      } else if (c === 'C' || c === 'Q') {
        k += c === 'C' ? 4 : 2;
        cx = p.pts[k++];
        cy = p.pts[k++];
      } else if (c === 'Z') {
        if (cx !== sx || cy !== sy) segs.push({ ax: cx, ay: cy, bx: sx, by: sy });
        cx = sx;
        cy = sy;
      }
    }
  }
  return segs.filter((s) => s.ax !== s.bx || s.ay !== s.by);
}

const CELL = 64;

/** Uniform grid over segments for neighbourhood queries. */
function gridOf(segs: Seg[]): (x0: number, y0: number, x1: number, y1: number) => Seg[] {
  const cells = new Map<string, Seg[]>();
  for (const s of segs) {
    const gx0 = Math.floor(Math.min(s.ax, s.bx) / CELL);
    const gx1 = Math.floor(Math.max(s.ax, s.bx) / CELL);
    const gy0 = Math.floor(Math.min(s.ay, s.by) / CELL);
    const gy1 = Math.floor(Math.max(s.ay, s.by) / CELL);
    if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) > 4096) continue; // page-spanning border lines
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const key = `${gx},${gy}`;
        const list = cells.get(key);
        if (list) list.push(s);
        else cells.set(key, [s]);
      }
    }
  }
  return (x0, y0, x1, y1) => {
    const seen = new Set<Seg>();
    for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) {
      for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
        for (const s of cells.get(`${gx},${gy}`) ?? []) seen.add(s);
      }
    }
    return [...seen];
  };
}

/** Longest dimension line considered, PDF points. */
const MAX_DIM_PT = 1500;

/**
 * Measure the dimension a printed number labels: the nearest line parallel
 * to the text that runs under (or through) it, cut at the nearest
 * crossings (ticks, witness lines) or line ends on either side of the text.
 */
function measureDimension(w: SheetWord, near: ReturnType<typeof gridOf>): { from: Pt; to: Pt; lengthPt: number } | null {
  const d = w.dir ?? { x: 1, y: 0 };
  const n = { x: -d.y, y: d.x };
  const h = Math.max(2, w.hPt);
  const c = { x: w.xPt, y: w.yPt };
  const tOf = (x: number, y: number) => (x - c.x) * d.x + (y - c.y) * d.y;
  const sOf = (x: number, y: number) => (x - c.x) * n.x + (y - c.y) * n.y;
  const reach = MAX_DIM_PT / 2;
  const cand = near(c.x - reach, c.y - reach, c.x + reach, c.y + reach);
  const maxOff = 2.5 * h + 2;

  // the dimension line: parallel, passes the text, long enough to carry it
  type Local = { t0: number; t1: number; s: number };
  const parallel: Local[] = [];
  const crossing: Seg[] = [];
  for (const g of cand) {
    const len = Math.hypot(g.bx - g.ax, g.by - g.ay);
    const cross = ((g.bx - g.ax) * d.y - (g.by - g.ay) * d.x) / len;
    if (Math.abs(cross) < 0.01) {
      const ta = tOf(g.ax, g.ay);
      const tb = tOf(g.bx, g.by);
      parallel.push({ t0: Math.min(ta, tb), t1: Math.max(ta, tb), s: (sOf(g.ax, g.ay) + sOf(g.bx, g.by)) / 2 });
    } else if (Math.abs(cross) > 0.3) crossing.push(g);
  }
  let line: Local | null = null;
  for (const p of parallel) {
    if (Math.abs(p.s) > maxOff || p.t0 > 0 || p.t1 < 0) continue;
    if (p.t1 - p.t0 < Math.max(w.wPt, 3 * h)) continue;
    // the text's own glyph outlines (OCR'd outlined text) sit inside its box
    if (Math.abs(p.s) < h * 0.5 && p.t1 - p.t0 < w.wPt * 1.5) continue;
    if (!line || Math.abs(p.s) < Math.abs(line.s)) line = p;
  }
  if (!line) return null;
  const s0 = line.s;
  const at = (t: number): Pt => ({ x: c.x + d.x * t + n.x * s0, y: c.y + d.y * t + n.y * s0 });

  // crossings in the line's frame: ticks, witness lines, arrowheads
  const crossLocal = crossing.map((g) => ({ ta: tOf(g.ax, g.ay), sa: sOf(g.ax, g.ay), tb: tOf(g.bx, g.by), sb: sOf(g.bx, g.by) }));
  const marked = (t: number) =>
    crossLocal.some((g) => {
      const dt = g.tb - g.ta;
      const ds = g.sb - g.sa;
      const k = Math.max(0, Math.min(1, ((t - g.ta) * dt + (s0 - g.sa) * ds) / (dt * dt + ds * ds)));
      return Math.hypot(g.ta + dt * k - t, g.sa + ds * k - s0) <= 1;
    });

  let left: number;
  let right: number;
  if (marked(line.t0) && marked(line.t1)) {
    // one line per dimension, both ends marked: that is the dimension
    left = line.t0;
    right = line.t1;
  } else {
    // a chain on one run: cut at the nearest crossings either side
    const pieces = parallel.filter((p) => Math.abs(p.s - s0) < 0.3).sort((a, b) => a.t0 - b.t0);
    let lo = line.t0;
    let hi = line.t1;
    for (let changed = true; changed; ) {
      changed = false;
      for (const p of pieces) {
        if (p.t1 >= lo - 1 && p.t0 <= hi + 1 && (p.t0 < lo || p.t1 > hi)) {
          lo = Math.min(lo, p.t0);
          hi = Math.max(hi, p.t1);
          changed = true;
        }
      }
    }
    const stops: number[] = [lo, hi];
    for (const g of crossLocal) {
      if (Math.min(g.sa, g.sb) > s0 + 0.5 || Math.max(g.sa, g.sb) < s0 - 0.5) continue;
      const k = g.sa === g.sb ? 0 : (s0 - g.sa) / (g.sb - g.sa);
      const t = g.ta + (g.tb - g.ta) * k;
      if (t >= lo - 0.5 && t <= hi + 0.5) stops.push(t);
    }
    left = -Infinity;
    right = Infinity;
    for (const t of stops) {
      if (t < -0.5 && t > left) left = t;
      if (t > 0.5 && t < right) right = t;
    }
    if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  }
  const lengthPt = right - left;
  // a number much wider than its gap is labelling something else
  if (lengthPt < w.wPt * 0.6) return null;
  // dimension text sits over the middle of its line; off-centre numbers
  // (a short dimension's text pushed outside onto its neighbour) are skipped
  if (Math.abs((left + right) / 2) > 0.3 * lengthPt + 0.5 * w.wPt) return null;
  return { from: at(left), to: at(right), lengthPt };
}

/**
 * Check a ratio against the sheet's printed millimetre dimensions: each
 * number is matched to the dimension line it labels and the ratio it implies
 * compared (agreement = within 1%). Conservative by design — numbers that
 * can't be matched to a line aren't counted (door sizes, levels and
 * off-centre labels still can be, and simply disagree), "verified" needs at
 * least two agreeing dimensions and no larger group agreeing on another
 * ratio, and "contradicted" needs three or more dimensions agreeing on one
 * other ratio, more than twice as many as agree with the stated one.
 */
export function checkDimensions(words: SheetWord[], page: VectorPage, ratio: number | null): DimensionVerdict {
  const near = gridOf(segmentsOf(page));
  const checks: DimensionCheck[] = [];
  for (const w of words) {
    const text = unspace(w.text);
    if (!DIM_RE.test(text)) continue;
    const valueMm = parseInt(text.replace(/,/g, ''), 10);
    if (!(valueMm >= 100)) continue;
    const m = measureDimension(w, near);
    if (!m) continue;
    const impliedRatio = valueMm / 1000 / (m.lengthPt * METERS_PER_PT);
    checks.push({
      text,
      valueMm,
      at: [round(w.xPt), round(w.yPt)],
      from: [round(m.from.x), round(m.from.y)],
      to: [round(m.to.x), round(m.to.y)],
      lengthPt: round(m.lengthPt),
      impliedRatio: round(impliedRatio, 1),
      agrees: ratio !== null && Math.abs(impliedRatio / ratio - 1) <= DIMENSION_TOLERANCE,
    });
  }
  const agreeing = checks.filter((c) => c.agrees).length;
  // the largest group of dimensions implying one ratio (within tolerance)
  // other than the one checked: noise scatters, a real scale clusters
  let other: { r: number; n: number } | null = null;
  for (const c of checks) {
    if (c.agrees) continue;
    const members = checks.filter((o) => !o.agrees && Math.abs(o.impliedRatio / c.impliedRatio - 1) <= DIMENSION_TOLERANCE);
    if (!other || members.length > other.n) {
      other = { r: members.reduce((s, o) => s + o.impliedRatio, 0) / members.length, n: members.length };
    }
  }
  const rival = other && other.n >= 3 ? other : null;
  let status: DimensionVerdict['status'] = 'unverified';
  if (ratio !== null && agreeing >= 2 && agreeing >= (rival?.n ?? 0)) status = 'verified';
  else if (ratio !== null && rival && agreeing * 2 < rival.n) status = 'contradicted';
  const out: DimensionVerdict = { status, checked: checks.length, agreeing, checks };
  if (rival && rival.n > agreeing) out.suggestedRatio = round(rival.r, 1);
  return out;
}
