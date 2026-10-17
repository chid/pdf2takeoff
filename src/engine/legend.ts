// Legend-driven schedules. Services and site sheets carry a legend (a key):
// each symbol drawn once beside its name. findLegends() reads the legend
// blocks off a sheet's live text and vector paths; legendSchedule() teaches
// the scan from every symbol swatch and counts it on the sheet (or every
// sheet), leaving the legend's own sample out of the count.
//
// Detection, per sheet:
//   1. headings: a line of text ending in KEY / LEGEND / SYMBOLS / SCHEDULE
//      (at most four words, an optional colon: "KEY", "LEGEND:", "SYMBOL
//      LEGEND", "LEGEND & NOTES"; never "KEY PLAN").
//   2. rows: text lines below the heading, read downward while they stay in
//      the heading's column, keep their left edge and the gaps stay small.
//      A line in two runs ("AW   AWNING WINDOW") is a text code + label.
//   3. swatch: the vector paths left of each label inside the row's band.
//      A long thin stroke (or dashes) is a line style, a wide box an area
//      (hatch) style, anything compact a symbol; no paths and no code means
//      the swatch isn't readable (a raster image, outlined text).
//   A heading with fewer than two readable rows isn't a legend (a drawing
//   schedule headed "NOTES & LEGEND" lists sheet names, not symbols).
//
// Text runs in any quarter-turn direction (sheets stored with /Rotate):
// each heading is read in its own text frame and the results mapped back
// to PDF user space. Sheets whose text is converted to outlines have no
// headings to find and report no legend.
//
// Line and area styles are reported as rows only (lengths and areas are
// other takeoffs); symbol rows are counted with the public scan API
// (teachSymbol / countTemplate), so this module never reaches into the
// matcher's internals.

import type { Pt, ScanHit } from './types.ts';
import type { RasterPage, ScanDeps } from './ports.ts';
import type { VectorPage, VectorPath } from './scan-vector.ts';
import { countTemplate, teachSymbol } from './scan.ts';

/** pdf.js getTextContent() items, accessed structurally. */
export interface TextItemLike {
  str: string;
  /** [a, b, c, d, e, f] in PDF user space. */
  transform: ArrayLike<number>;
  /** Advance width in PDF points (along the text direction). */
  width: number;
}

/** [x0, y0, x1, y1] in PDF points. */
export type Box = [number, number, number, number];

export type LegendRowKind = 'symbol' | 'line' | 'area' | 'code' | 'none';

export interface LegendRow {
  label: string;
  kind: LegendRowKind;
  /** The label text's box. */
  labelBox: Box;
  /** The swatch's paths' box ('symbol' | 'line' | 'area'). */
  swatch?: Box;
  /** Where to teach the scan from: the swatch's main shape ('symbol'). */
  at?: Pt;
  /** The text code standing in for a symbol ('code'). */
  code?: string;
  /** Live text drawn inside the symbol ('symbol'): the vector match sees
   *  only paths, so a copy must carry this text too (a circle with T is a
   *  tempering valve, a bare circle of the same size is not). */
  text?: string[];
}

export interface Legend {
  page: number;
  heading: string;
  /** Heading, labels and swatches: hits inside are the legend's samples. */
  box: Box;
  rows: LegendRow[];
}

// --- text frames -------------------------------------------------------------

/** Quarter turn of a text direction: 0 → reads +x, 1 → +y, 2 → -x, 3 → -y. */
type Dir = 0 | 1 | 2 | 3;
const COS = [1, 0, -1, 0];
const SIN = [0, 1, 0, -1];
/** PDF point → the text frame of direction q (text reads along +X). */
const toFrame = (q: Dir, x: number, y: number): [number, number] => [x * COS[q] + y * SIN[q], -x * SIN[q] + y * COS[q]];
/** Text frame of direction q → PDF point. */
const fromFrame = (q: Dir, X: number, Y: number): [number, number] => [X * COS[q] - Y * SIN[q], X * SIN[q] + Y * COS[q]];

function boxToFrame(q: Dir, [x0, y0, x1, y1]: Box): Box {
  const [ax, ay] = toFrame(q, x0, y0);
  const [bx, by] = toFrame(q, x1, y1);
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}
function boxFromFrame(q: Dir, [X0, Y0, X1, Y1]: Box): Box {
  const [ax, ay] = fromFrame(q, X0, Y0);
  const [bx, by] = fromFrame(q, X1, Y1);
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}
const union = (a: Box, b: Box): Box => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
export const inBox = (b: Box, x: number, y: number, pad = 0) =>
  x >= b[0] - pad && x <= b[2] + pad && y >= b[1] - pad && y <= b[3] + pad;

/** A text item in its frame: baseline-left (X, Y), advance w, font size s. */
interface Glyphs {
  str: string;
  X: number;
  Y: number;
  w: number;
  s: number;
  /** Paint order on the page (text items come in content order). */
  i: number;
}

/** A run of text on one line with no wide gap, in a frame. */
interface Run {
  str: string;
  X0: number;
  X1: number;
  /** Baseline. */
  Y: number;
  /** Font size of the run's main text. */
  s: number;
}

function direction(t: ArrayLike<number>): { q: Dir; s: number } | null {
  const [a, b, c, d] = [t[0], t[1], t[2], t[3]];
  const s = Math.hypot(a, b);
  if (s < 1e-6) return null;
  const tol = 0.05 * s;
  // only upright text (not mirrored) on a quarter turn
  if (Math.abs(b) <= tol && Math.abs(c) <= tol) return a > 0 && d > 0 ? { q: 0, s } : a < 0 && d < 0 ? { q: 2, s } : null;
  if (Math.abs(a) <= tol && Math.abs(d) <= tol) return b > 0 && c < 0 ? { q: 1, s } : b < 0 && c > 0 ? { q: 3, s } : null;
  return null;
}

const SUPERSCRIPT: Record<string, string> = { '2': '²', '3': '³' };

/** The text of direction q, merged into lines of runs (top line first). */
function runsIn(items: TextItemLike[], q: Dir): Run[][] {
  const glyphs: Glyphs[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.str || !it.str.trim()) continue;
    const dir = direction(it.transform);
    if (!dir || dir.q !== q) continue;
    const [X, Y] = toFrame(q, it.transform[4], it.transform[5]);
    glyphs.push({ str: it.str, X, Y, w: Math.max(0, it.width), s: dir.s, i });
  }
  // biggest text first, so a run's baseline is its main text, not a
  // superscript; then left to right
  glyphs.sort((a, b) => b.s - a.s || a.X - b.X);
  // runs: text on one baseline with no wide gap, built by proximity rather
  // than by whole page rows, so a notes column beside a legend never joins
  // it. Text printed over other text (two layers) stays apart.
  const runs: (Run & { parts: Glyphs[] })[] = [];
  for (const g of glyphs) {
    const run = runs.find(
      (r) =>
        Math.abs(r.Y - g.Y) <= (g.s < 0.8 * r.s ? 0.45 : 0.25) * r.s &&
        g.s <= r.s * 1.05 &&
        g.X <= r.X1 + 1.5 * r.s &&
        g.X + g.w >= r.X0 - 1.5 * r.s &&
        !r.parts.some((p) => g.X < p.X + p.w - 0.5 * r.s && g.X + g.w > p.X + 0.5 * r.s),
    );
    if (run) {
      run.parts.push(g);
      run.X0 = Math.min(run.X0, g.X);
      run.X1 = Math.max(run.X1, g.X + g.w);
    } else {
      runs.push({ str: '', X0: g.X, X1: g.X + g.w, Y: g.Y, s: g.s, parts: [g] });
    }
  }
  for (const run of runs) {
    let end = -Infinity;
    for (const g of run.parts.sort((a, b) => a.X - b.X)) {
      // letter-spaced CAD text ("K E Y") reads as a word
      let str = /^(\S )+\S$/.test(g.str.trim()) ? g.str.trim().replace(/ /g, '') : g.str.trim();
      const sup = g.s < 0.8 * run.s && g.Y > run.Y + 0.15 * run.s;
      if (sup && SUPERSCRIPT[str]) str = SUPERSCRIPT[str];
      run.str += run.str && g.X - end > 0.15 * run.s && !sup ? ' ' + str : str;
      end = Math.max(end, g.X + g.w);
    }
  }
  // text printed over other text: the sheet shows what was drawn last
  // (a revised legend over a masked-out older one), so drop the run drawn
  // first wherever two runs cover the same spot
  const order = (r: { parts: Glyphs[] }) => Math.max(...r.parts.map((g) => g.i));
  const covered = (a: Run, b: Run) => {
    const ox = Math.min(a.X1, b.X1) - Math.max(a.X0, b.X0);
    const oy = Math.min(a.Y + 0.7 * a.s, b.Y + 0.7 * b.s) - Math.max(a.Y, b.Y);
    return ox > 0.3 * Math.min(a.X1 - a.X0, b.X1 - b.X0) && oy > 0.3 * 0.7 * Math.min(a.s, b.s);
  };
  const shown = runs.filter((r) => !runs.some((o) => o !== r && order(o) > order(r) && covered(r, o)));
  // lines: runs sharing a baseline, top line first, each left to right
  shown.sort((a, b) => b.Y - a.Y);
  const lines: Run[][] = [];
  for (const { parts: _, ...run } of shown) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line[0].Y - run.Y) <= 0.25 * Math.max(line[0].s, run.s)) line.push(run);
    else lines.push([run]);
  }
  for (const line of lines) line.sort((a, b) => a.X0 - b.X0);
  return lines;
}

// --- detection ----------------------------------------------------------------

const HEADING = /^(?:[A-Z][A-Z&./-]*\s+){0,3}(?:KEY|LEGEND|SYMBOLS?|SCHEDULE)(?:\s*(?:&|AND)\s*NOTES)?\s*:?$/i;

/** Is this text a legend heading? ("KEY", "LEGEND:", "SYMBOL LEGEND"). */
export function isLegendHeading(text: string): boolean {
  const t = text.trim().replace(/\s+/g, ' ');
  return HEADING.test(t) && !NOT_A_KEY.test(t);
}

/** Schedules that list things other than symbols: sheets, doors, finishes. */
const NOT_A_KEY = /\b(DRAWINGS?|SHEETS?|REVISIONS?|ISSUES?|DOORS?|WINDOWS?|FINISH(ES)?|AREAS?|ROOMS?|COLOU?RS?)\b/i;

/** How far left of a label its swatch may start, in font sizes (≥ 60pt). */
const SWATCH_REACH = 9;
/** Largest text gap inside a legend, between rows, in font sizes. */
const ROW_GAP = 4.5;
/** First row's distance under the heading, in heading font sizes. */
const FIRST_GAP = 5;
/** A legend needs this many rows with a readable swatch. */
const MIN_ROWS = 2;

/** The legend blocks on a sheet, read from its text and vector paths. */
export function findLegends(page: number, items: TextItemLike[], vectors: VectorPage | null): Legend[] {
  const legends: Legend[] = [];
  const dirs = new Set<Dir>();
  for (const it of items) {
    const d = it.str && /(KEY|LEGEND|SYMBOL|SCHEDULE)/i.test(it.str.replace(/ /g, '')) ? direction(it.transform) : null;
    if (d) dirs.add(d.q);
  }
  for (const q of dirs) {
    const lines = runsIn(items, q);
    // paths in this frame, once
    const paths = (vectors?.paths ?? []).map((p) => ({ p, b: boxToFrame(q, [p.x0, p.y0, p.x1, p.y1]) }));
    for (let li = 0; li < lines.length; li++) {
      for (const head of lines[li]) {
        if (!isLegendHeading(head.str)) continue;
        const legend = readLegend(page, q, head, lines.slice(li + 1), paths);
        if (legend) legends.push(legend);
      }
    }
  }
  return legends;
}

interface FramePath {
  p: VectorPath;
  b: Box;
}

function readLegend(page: number, q: Dir, head: Run, under: Run[][], paths: FramePath[]): Legend | null {
  const rows: { code?: Run; label: Run }[] = [];
  let lastY = head.Y;
  let lastS = head.s;
  // the rows' left edge (code or label) and the labels' left edge
  let alignX: number | null = null;
  let labelX: number | null = null;
  for (const line of under) {
    if (line[0].Y >= head.Y) continue;
    const s = line[0].s;
    const reach = Math.max(60, SWATCH_REACH * s);
    // runs in the heading's column: the label (and its swatch room) overlaps
    // the heading's span; text elsewhere on the sheet at this height is not
    // the legend's business
    const inColumn = line.filter((r) => r.X0 - reach <= head.X1 + head.s && r.X1 >= head.X0 - head.s);
    if (!inColumn.length) continue;
    const gap = lastY - (inColumn[0].Y + s);
    const limit = rows.length ? ROW_GAP * Math.max(s, lastS) : FIRST_GAP * head.s;
    if (gap > limit) break;
    const isCode = (r: Run) => r.str.replace(/\s/g, '').length <= 5;
    let label: Run | undefined;
    if (alignX === null || labelX === null) {
      label = inColumn.length >= 2 && isCode(inColumn[0]) ? inColumn[1] : inColumn[0];
    } else {
      // once the rows' edges are known, only text on them is a row; a
      // neighbouring legend's column or a tag drawn in a swatch ('A' over
      // a pit) is skipped, and text running across the labels ends it
      const lx: number = labelX;
      const ax: number = alignX;
      label = inColumn.find((r) => Math.abs(r.X0 - lx) <= 2 * s);
      if (!label) {
        const lead: Run | undefined = inColumn.find((r) => Math.abs(r.X0 - ax) <= 2 * s && isCode(r));
        if (lead) label = inColumn[inColumn.indexOf(lead) + 1];
      }
      if (!label) {
        if (inColumn.some((r) => r.X0 < lx + 4 * s && r.X1 > lx + s)) break;
        continue;
      }
    }
    // a short run just left of the label is its text code ("AW  AWNING WINDOW")
    const at: Run = label;
    const before: Run[] = line.filter((r) => r !== at && r.X1 <= at.X0 && r.X1 >= at.X0 - reach);
    const code: Run | undefined = before.length && isCode(before[before.length - 1]) ? before[before.length - 1] : undefined;
    if (alignX === null) {
      alignX = code ? code.X0 : label.X0;
      labelX = label.X0;
    }
    rows.push({ code, label });
    lastY = label.Y;
    lastS = s;
  }
  if (!rows.length) return null;

  // swatches: the row bands split halfway between baselines
  const mid = (r: Run) => r.Y + 0.35 * r.s;
  const out: LegendRow[] = [];
  let box: Box = [head.X0, head.Y - 0.25 * head.s, head.X1, head.Y + head.s];
  for (let i = 0; i < rows.length; i++) {
    const { code, label } = rows[i];
    const s = label.s;
    const above = i > 0 ? (mid(rows[i - 1].label) - mid(label)) / 2 : 1.5 * s;
    const below = i + 1 < rows.length ? (mid(label) - mid(rows[i + 1].label)) / 2 : 1.5 * s;
    const labelBox: Box = [label.X0, label.Y - 0.25 * s, label.X1, label.Y + s];
    box = union(box, labelBox);
    const row: LegendRow = { label: label.str, kind: 'none', labelBox: boxFromFrame(q, labelBox) };
    const win: Box = [label.X0 - Math.max(60, SWATCH_REACH * s), mid(label) - below, label.X0 - 0.3 * s, mid(label) + above];
    const swatch = swatchBeside(
      paths.filter(({ b }) => b[0] >= win[0] && b[2] <= win[2] && b[1] >= win[1] && b[3] <= win[3]),
      label.X0,
      s,
    );
    // text inside a drawn shape (SD in a smoke alarm's circle) is part of
    // the symbol, not a text code standing in for one
    // and so is text breaking a line style ("—EXS—")
    const enclosed =
      code &&
      (swatch.some(({ b }) => b[0] <= code.X0 && b[2] >= code.X1 && b[1] <= code.Y && b[3] >= code.Y + 0.6 * code.s) ||
        (swatch.length > 0 && Math.min(...swatch.map((x) => x.b[0])) < code.X0));
    if (code && !enclosed) {
      row.kind = 'code';
      row.code = code.str;
      box = union(box, [code.X0, code.Y - 0.25 * s, code.X1, code.Y + s]);
      out.push(row);
      continue;
    }
    if (swatch.length) {
      let sb: Box = swatch[0].b;
      for (const { b } of swatch) sb = union(sb, b);
      const W = sb[2] - sb[0];
      const H = sb[3] - sb[1];
      const biggest = swatch.reduce((m, x) => (area(x.b) > area(m.b) ? x : m), swatch[0]);
      // straight strokes only, all on one level: a line style, even when a
      // text code breaks it into a short piece ("—EXS—")
      const strokes = swatch.every(({ p, b }) => /^(ML+)+$/.test(p.cmds) && b[3] - b[1] <= 1);
      if (H <= Math.max(1, 0.2 * W) && (W >= 2 * s || strokes)) row.kind = 'line';
      else if (isRect(biggest.p) && W >= 1.4 * H && W >= 2.5 * s) row.kind = 'area';
      else row.kind = 'symbol';
      row.swatch = boxFromFrame(q, sb);
      if (row.kind === 'symbol') {
        const [x, y] = fromFrame(q, (biggest.b[0] + biggest.b[2]) / 2, (biggest.b[1] + biggest.b[3]) / 2);
        row.at = { x, y };
        // letters drawn inside the symbol (T in a tempering valve's circle)
        const inner = under
          .flat()
          .filter((r) => {
            const cx = (r.X0 + r.X1) / 2;
            const cy = r.Y + 0.35 * r.s;
            return cx > sb[0] && cx < sb[2] && cy > sb[1] && cy < sb[3] && r.X1 - r.X0 < sb[2] - sb[0];
          })
          .map((r) => r.str.replace(/\s/g, ''));
        if (inner.length) row.text = inner;
      }
      box = union(box, sb);
    }
    // no swatch, at the label indent of the row above, and the text reads
    // on from it ("... INSTALLED ON" / "APPROVED SAFE TRAY"): a wrapped
    // label. Anything else stays its own row (reported as unreadable).
    const prev = rows[i - 1];
    if (
      row.kind === 'none' &&
      prev &&
      out.length &&
      prev.label.Y - label.Y <= 1.6 * s &&
      Math.abs(prev.label.X0 - label.X0) <= s &&
      (/^[a-z@(&+]/.test(label.str) || /(\b(ON|TO|WITH|AND|OR|OF|FOR|IN|AT)|[,&+-])$/i.test(out[out.length - 1].label))
    ) {
      const last = out[out.length - 1];
      last.label += ' ' + label.str;
      const lb = last.labelBox;
      last.labelBox = union(lb, boxFromFrame(q, labelBox));
      continue;
    }
    out.push(row);
  }
  if (out.filter((r) => r.kind !== 'none').length < MIN_ROWS) return null;
  return { page, heading: head.str, box: boxFromFrame(q, box), rows: out };
}

/** The paths drawn as one swatch just left of a label: starting next to
 *  the label, growing leftward while the paths keep close together, so a
 *  drawing line that happens to pass within reach isn't taken for it. */
function swatchBeside(inWindow: FramePath[], labelX: number, s: number): FramePath[] {
  const byRight = [...inWindow].sort((a, b) => b.b[2] - a.b[2]);
  if (!byRight.length || byRight[0].b[2] < labelX - 4 * s) return [];
  const out: FramePath[] = [];
  let left = Infinity;
  for (const fp of byRight) {
    if (out.length && fp.b[2] < left - 2.5 * s) break;
    out.push(fp);
    left = Math.min(left, fp.b[0]);
  }
  return out;
}

const area = (b: Box) => Math.max(b[2] - b[0], 0.01) * Math.max(b[3] - b[1], 0.01);

/** A four-cornered closed outline on the axes (a box swatch). */
function isRect(p: VectorPath): boolean {
  if (!/^ML{3,4}Z?$/.test(p.cmds)) return false;
  const tol = 0.05 * Math.max(p.x1 - p.x0, p.y1 - p.y0, 0.1);
  for (let k = 0; k < p.pts.length; k += 2) {
    const onX = Math.abs(p.pts[k] - p.x0) <= tol || Math.abs(p.pts[k] - p.x1) <= tol;
    const onY = Math.abs(p.pts[k + 1] - p.y0) <= tol || Math.abs(p.pts[k + 1] - p.y1) <= tol;
    if (!onX || !onY) return false;
  }
  return true;
}

// --- schedule -----------------------------------------------------------------

const HEADING_WORD = /(KEY|LEGEND|SYMBOL|SCHEDULE)/i;
/** Raster px per PDF point for the text visibility check. */
const INK_SCALE = 2;
/** Share of a text item's box that must be inked for it to show. */
const MIN_INK = 0.06;

/** Does a text item leave ink on the rendered sheet? */
function shows(raster: RasterPage, it: TextItemLike): boolean {
  const t = it.transform;
  const s = Math.hypot(t[0], t[1]) || 1;
  const ux = t[0] / s;
  const uy = t[1] / s;
  const vx = t[2] / (Math.hypot(t[2], t[3]) || 1);
  const vy = t[3] / (Math.hypot(t[2], t[3]) || 1);
  const w = Math.max(it.width, 0.5 * s);
  // the band between just above the baseline and mid-height, along the
  // text: glyph strokes always cross it, and a line of text set a little
  // above or below doesn't reach into it
  const lo = 0.1 * s;
  const hi = 0.5 * s;
  const corners = [
    [t[4] + vx * lo, t[5] + vy * lo],
    [t[4] + ux * w + vx * lo, t[5] + uy * w + vy * lo],
    [t[4] + vx * hi, t[5] + vy * hi],
    [t[4] + ux * w + vx * hi, t[5] + uy * w + vy * hi],
  ].map(([x, y]) => raster.toRaster(x, y));
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.x))));
  const x1 = Math.min(raster.width - 1, Math.ceil(Math.max(...corners.map((c) => c.x))));
  const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.y))));
  const y1 = Math.min(raster.height - 1, Math.ceil(Math.max(...corners.map((c) => c.y))));
  if (x1 < x0 || y1 < y0) return false;
  let inked = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * raster.width + x) * 4;
      const d = raster.data;
      if (d[i + 3] > 0 && Math.min(d[i], d[i + 1], d[i + 2]) < 200) inked++;
    }
  }
  return inked >= MIN_INK * (x1 - x0 + 1) * (y1 - y0 + 1);
}

export interface LegendDeps extends ScanDeps {
  /** The page's text items (pdf.js getTextContent().items). */
  text(pageNum: number): Promise<TextItemLike[]>;
}

export interface ScheduleRow {
  label: string;
  /** The page whose legend the symbol was taught from. */
  page: number;
  count: number;
  hits: (ScanHit & { page: number })[];
  provider: string;
  /** Per-page counts when counting across sheets. */
  pages?: { page: number; count: number }[];
  /** Matches left out, and why. */
  note?: string;
}

/** A path around a swatch and well beyond it (a legend frame, a fill). */
function encloses(p: VectorPath, [x0, y0, x1, y1]: Box): boolean {
  const pad = 1;
  const holds = p.x0 <= x0 + 0.01 && p.y0 <= y0 + 0.01 && p.x1 >= x1 - 0.01 && p.y1 >= y1 - 0.01;
  return holds && (x0 - p.x0 > pad || p.x1 - x1 > pad || y0 - p.y0 > pad || p.y1 - y1 > pad);
}

/** Is `str` printed (any direction) centred within `reach` of a point? */
function textAt(it: TextItemLike, str: string, at: Pt, reach: number): boolean {
  if (it.str.replace(/\s/g, '') !== str) return false;
  const t = it.transform;
  const s = Math.hypot(t[0], t[1]) || 1;
  const cx = t[4] + (t[0] / s) * (it.width / 2) + (t[2] / s) * 0.35 * s;
  const cy = t[5] + (t[1] / s) * (it.width / 2) + (t[3] / s) * 0.35 * s;
  return Math.abs(cx - at.x) <= reach && Math.abs(cy - at.y) <= reach;
}

export interface LegendRowReport {
  label: string;
  page: number;
  kind: LegendRowKind;
  reason?: string;
  code?: string;
}

export interface LegendSchedule {
  legends: Legend[];
  /** Symbol rows counted (legend samples excluded), count > 0. */
  schedule: ScheduleRow[];
  /** Line-style rows, reported only (no lengths). */
  lines: LegendRowReport[];
  /** Rows that weren't counted, and why. */
  unmatched: LegendRowReport[];
  /** Pages searched for legends and counted on. */
  pages: number[];
}

/** Detect legends on `pages` and count every symbol row on the same pages,
 *  leaving out hits inside any legend block (the legend's own samples). A
 *  symbol keyed on several sheets is scheduled once, from its first legend. */
export async function legendSchedule(pages: number[], deps: LegendDeps): Promise<LegendSchedule> {
  const texts = new Map<number, Promise<TextItemLike[]>>();
  const textOf = (p: number) => {
    if (!texts.has(p)) texts.set(p, deps.text(p));
    return texts.get(p)!;
  };
  const legends: Legend[] = [];
  for (const p of pages) {
    let items = await textOf(p);
    if (!items.some((it) => HEADING_WORD.test(it.str.replace(/ /g, '')))) continue;
    // text the sheet doesn't show (clipped away, painted over) must not
    // read as legend rows: keep the items with ink under them
    try {
      const raster = await deps.renderRaster(p, INK_SCALE);
      items = items.filter((it) => !it.str.trim() || shows(raster, it));
    } catch (err) {
      deps.warn?.(`page ${p}: could not render to check text visibility: ${err instanceof Error ? err.message : String(err)}`);
    }
    const vectors = deps.vectors ? await deps.vectors(p) : null;
    legends.push(...findLegends(p, items, vectors));
  }
  const boxesOn = (p: number) => legends.filter((l) => l.page === p).map((l) => l.box);
  const schedule: ScheduleRow[] = [];
  const lines: LegendRowReport[] = [];
  const unmatched: LegendRowReport[] = [];
  // the same legend repeated on several sheets is scheduled once; two rows
  // of one legend may share a label (a red and a blue STOP VALVE)
  const seen = new Map<string, Legend>();

  for (const legend of legends) {
    for (const row of legend.rows) {
      const sw = row.swatch ? `${Math.round(row.swatch[2] - row.swatch[0])}x${Math.round(row.swatch[3] - row.swatch[1])}` : '';
      const key = `${row.kind}|${row.label.toUpperCase().replace(/\s+/g, ' ')}|${sw}`;
      const first = seen.get(key);
      if (first && first !== legend) continue;
      seen.set(key, legend);
      const base = { label: row.label, page: legend.page, kind: row.kind };
      if (row.kind === 'line') {
        lines.push(base);
        continue;
      }
      if (row.kind === 'area') {
        unmatched.push({ ...base, reason: 'area (hatch) style: measure it as an area, not a count' });
        continue;
      }
      if (row.kind === 'code') {
        unmatched.push({ ...base, code: row.code, reason: 'keyed by a text code, not a drawn symbol' });
        continue;
      }
      if (row.kind === 'none' || !row.at) {
        unmatched.push({ ...base, reason: 'no vector swatch beside the label (raster image or outlined)' });
        continue;
      }
      // teach from the swatch's own paths: a legend's frame or background
      // fill holds the click too, and the scan would teach that instead
      const swatch = row.swatch!;
      const teachDeps: ScanDeps = {
        ...deps,
        vectors: async (p) => {
          const page = deps.vectors ? await deps.vectors(p) : null;
          if (!page || p !== legend.page) return page;
          return { ...page, paths: page.paths.filter((x) => !encloses(x, swatch)) };
        },
      };
      const taught = await teachSymbol(legend.page, row.at, teachDeps, 1);
      if ('error' in taught) {
        unmatched.push({ ...base, reason: `could not teach from the swatch: ${taught.error}` });
        continue;
      }
      const hits: (ScanHit & { page: number })[] = [];
      const perPage: { page: number; count: number }[] = [];
      const errors: string[] = [];
      let withoutText = 0;
      const reach = row.swatch ? 0.75 * Math.max(row.swatch[2] - row.swatch[0], row.swatch[3] - row.swatch[1]) : 0;
      for (const p of pages) {
        const result = p === legend.page ? taught.result : await countTemplate(p, taught.template, deps);
        if ('error' in result) {
          errors.push(`page ${p}: ${result.error}`);
          perPage.push({ page: p, count: 0 });
          continue;
        }
        const boxes = boxesOn(p);
        let kept = result.hits.filter((h) => !boxes.some((b) => inBox(b, h.x, h.y, 1)));
        if (row.text && kept.length) {
          const items = await textOf(p);
          const before = kept.length;
          kept = kept.filter((h) => row.text!.every((str) => items.some((it) => textAt(it, str, h, reach))));
          withoutText += before - kept.length;
        }
        hits.push(...kept.map((h) => ({ ...h, page: p })));
        perPage.push({ page: p, count: kept.length });
      }
      const textNote = withoutText
        ? `${withoutText} same-shape match(es) without the symbol's text (${row.text!.join(' ')}) left out`
        : undefined;
      if (!hits.length) {
        unmatched.push({
          ...base,
          reason: errors.length
            ? errors.join('; ')
            : textNote
              ? `no copy carries the symbol's text: ${textNote}`
              : 'only the legend sample matched: no exact copy of the swatch on the counted sheets (absent, or drawn differently there)',
        });
        continue;
      }
      schedule.push({
        label: row.label,
        page: legend.page,
        count: hits.length,
        hits,
        provider: taught.result.provider,
        ...(pages.length > 1 ? { pages: perPage } : {}),
        ...(textNote ? { note: textNote } : {}),
      });
    }
  }
  return { legends, schedule, lines, unmatched, pages };
}
