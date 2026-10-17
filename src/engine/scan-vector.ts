// Scan provider, tier 0: exact matching on the drawing's own vector paths.
// CAD exports draw every copy of a block with the same path operators, so a
// symbol can be found by geometry instead of pixels: wall lines, hatching and
// labels that touch it are separate paths and don't get in the way, and the
// result doesn't depend on the raster scale. Scanned sheets and symbols drawn
// as images have no paths to match; scan.ts falls back to the raster tiers.
//
// The host hands over the page's pdf.js operator list as plain data;
// vectorPage() replays the transforms into PDF user space and vectorScan()
// matches the clicked symbol, allowing quarter turns and mirrors.

import type { Pt, ScanHit, ScanResult } from './types.ts';

export interface VectorPath {
  /** One char per segment: M move, L line, C cubic, Q quadratic, Z close. */
  cmds: string;
  /** Segment end/control points in PDF user space, x,y interleaved. */
  pts: Float64Array;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface VectorPage {
  /** Page view box [x0, y0, x1, y1] in PDF points. */
  view: number[];
  paths: VectorPath[];
}

/** pdf.js getOperatorList() output, accessed structurally. */
export interface OperatorListLike {
  fnArray: ArrayLike<number>;
  argsArray: unknown[];
}

/** The pdf.js OPS codes vectorPage() reads (pass pdfjs-dist's OPS). */
export type PdfOps = Record<
  | 'save'
  | 'restore'
  | 'transform'
  | 'constructPath'
  | 'endPath'
  | 'paintFormXObjectBegin'
  | 'paintFormXObjectEnd'
  | 'beginGroup'
  | 'endGroup',
  number
>;

// pdf.js DrawOPS: the segment codes inside a constructPath's path data
const DRAW = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 };

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const isMatrix = (v: unknown): v is Matrix =>
  (Array.isArray(v) || ArrayBuffer.isView(v)) && (v as ArrayLike<number>).length === 6;

/** Replay a page's operator list into paths in PDF user space. */
export function vectorPage(view: number[], ops: OperatorListLike, OPS: PdfOps): VectorPage {
  const paths: VectorPath[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  const push = () => stack.push(ctm);
  const pop = () => {
    ctm = stack.pop() ?? IDENTITY;
  };

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[] | null;
    if (fn === OPS.save) push();
    else if (fn === OPS.restore) pop();
    else if (fn === OPS.transform && args && args.length === 6) ctm = multiply(ctm, args as unknown as Matrix);
    else if (fn === OPS.paintFormXObjectBegin) {
      push();
      if (args && isMatrix(args[0])) ctm = multiply(ctm, Array.from(args[0]) as Matrix);
    } else if (fn === OPS.paintFormXObjectEnd) pop();
    else if (fn === OPS.beginGroup) {
      push();
      const m = (args?.[0] as { matrix?: unknown } | undefined)?.matrix;
      if (isMatrix(m)) ctm = multiply(ctm, Array.from(m) as Matrix);
    } else if (fn === OPS.endGroup) pop();
    else if (fn === OPS.constructPath && args) {
      // [paintOp, [pathData], minMax]; endPath only sets a clip, paints nothing
      if (args[0] === OPS.endPath) continue;
      const data = (args[1] as unknown[] | undefined)?.[0];
      if (!data || !ArrayBuffer.isView(data)) continue;
      const p = toPath(data as unknown as ArrayLike<number>, ctm);
      if (p) paths.push(p);
    }
  }

  return { view, paths };
}

function toPath(data: ArrayLike<number>, m: Matrix): VectorPath | null {
  let cmds = '';
  const pts: number[] = [];
  const add = (x: number, y: number) => pts.push(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
  for (let i = 0; i < data.length; ) {
    switch (data[i++]) {
      case DRAW.moveTo:
        cmds += 'M';
        add(data[i++], data[i++]);
        break;
      case DRAW.lineTo:
        cmds += 'L';
        add(data[i++], data[i++]);
        break;
      case DRAW.curveTo:
        cmds += 'C';
        for (let k = 0; k < 3; k++) add(data[i++], data[i++]);
        break;
      case DRAW.quadraticCurveTo:
        cmds += 'Q';
        for (let k = 0; k < 2; k++) add(data[i++], data[i++]);
        break;
      case DRAW.closePath:
        cmds += 'Z';
        break;
      default:
        return null; // unknown segment: the rest of the data can't be decoded
    }
  }
  if (pts.length < 4) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let k = 0; k < pts.length; k += 2) {
    x0 = Math.min(x0, pts[k]);
    x1 = Math.max(x1, pts[k]);
    y0 = Math.min(y0, pts[k + 1]);
    y1 = Math.max(y1, pts[k + 1]);
  }
  return { cmds, pts: Float64Array.from(pts), x0, y0, x1, y1 };
}

// ---------------------------------------------------------------------------

/** Largest symbol, as a fraction of the page's shorter side. */
const MAX_SYMBOL = 0.25;
/** Reach (pt) for a click that lands near, not on, a symbol. */
const CLICK_REACH = 3.3;
/** Coverage grid cells per side, over a symbol's box. */
const COVER = 16;
/** Share of the clicked symbol's ink a copy must carry (one cell of slack). */
const COVER_KEPT = 0.9;
/** Share of a copy's ink that must belong to the symbol: the rest may be
 *  lines that cross it (dashed services, hatch), never parts of a different
 *  symbol that shares the outline. */
const COVER_OWN = 0.75;
/** Smallest shape, relative to the biggest one under the click, worth
 *  teaching the scan: a stroke deep inside a symbol isn't the symbol. */
const MIN_SEED = 0.3;

// the 8 quarter-turn rotations and mirrors, as 2x2 [a, b, c, d]
type Variant = [number, number, number, number];
const VARIANTS: Variant[] = [
  [1, 0, 0, 1],
  [0, 1, -1, 0],
  [-1, 0, 0, -1],
  [0, -1, 1, 0],
  [-1, 0, 0, 1],
  [1, 0, 0, -1],
  [0, 1, 1, 0],
  [0, -1, -1, 0],
];

type Box = [number, number, number, number];
const size = (p: VectorPath) => Math.max(p.x1 - p.x0, p.y1 - p.y0);

/** A path's points relative to an origin, turned by a variant. */
function turned(p: VectorPath, ox: number, oy: number, v: Variant): Float64Array {
  const out = new Float64Array(p.pts.length);
  for (let k = 0; k < p.pts.length; k += 2) {
    const x = p.pts[k] - ox;
    const y = p.pts[k + 1] - oy;
    out[k] = v[0] * x + v[2] * y;
    out[k + 1] = v[1] * x + v[3] * y;
  }
  return out;
}

/** Does path c trace `shape` (points relative to (ax, ay)) within tol? */
function traces(c: VectorPath, cmds: string, shape: Float64Array, ax: number, ay: number, tol: number): boolean {
  if (c.cmds !== cmds || c.pts.length !== shape.length) return false;
  for (let k = 0; k < shape.length; k += 2) {
    if (Math.abs(c.pts[k] - ax - shape[k]) > tol || Math.abs(c.pts[k + 1] - ay - shape[k + 1]) > tol) return false;
  }
  return true;
}

/** Symbol-sized paths overlapping a box. Long paths (walls, grid lines,
 *  borders) are never part of a symbol, so they're left out of the index:
 *  a wall running into a symbol can't change how it compares. */
type Index = (b: Box) => Set<VectorPath>;

function index(paths: VectorPath[], maxSize: number): Index {
  const cell = Math.max(4, maxSize / 4);
  const cells = new Map<string, VectorPath[]>();
  for (const p of paths) {
    if (size(p) > maxSize) continue;
    for (let gx = Math.floor(p.x0 / cell); gx <= Math.floor(p.x1 / cell); gx++) {
      for (let gy = Math.floor(p.y0 / cell); gy <= Math.floor(p.y1 / cell); gy++) {
        const key = `${gx},${gy}`;
        const list = cells.get(key);
        if (list) list.push(p);
        else cells.set(key, [p]);
      }
    }
  }
  return ([x0, y0, x1, y1]) => {
    const out = new Set<VectorPath>();
    for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) {
      for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) {
        for (const p of cells.get(`${gx},${gy}`) ?? []) {
          if (p.x1 >= x0 && p.x0 <= x1 && p.y1 >= y0 && p.y0 <= y1) out.add(p);
        }
      }
    }
    return out;
  };
}

/** Points sampled every `step` along the paths' outlines (curves
 *  flattened), keeping those inside the box, relative to its corner. */
function ink(paths: Iterable<VectorPath>, [x0, y0, x1, y1]: Box, step: number): number[] {
  const out: number[] = [];
  const line = (ax: number, ay: number, bx: number, by: number) => {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let i = 0; i <= n; i++) {
      const x = ax + ((bx - ax) * i) / n;
      const y = ay + ((by - ay) * i) / n;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out.push(x - x0, y - y0);
    }
  };
  for (const p of paths) {
    const q = p.pts;
    let k = 0;
    let [cx, cy, sx, sy] = [0, 0, 0, 0];
    for (const cmd of p.cmds) {
      if (cmd === 'M') {
        [cx, cy] = [q[k], q[k + 1]];
        [sx, sy] = [cx, cy];
        k += 2;
      } else if (cmd === 'L') {
        line(cx, cy, q[k], q[k + 1]);
        [cx, cy] = [q[k], q[k + 1]];
        k += 2;
      } else if (cmd === 'C' || cmd === 'Q') {
        const n = cmd === 'C' ? 3 : 2;
        const ctrl = Array.from(q.subarray(k, k + n * 2));
        let [px, py] = [cx, cy];
        for (let i = 1; i <= 8; i++) {
          const t = i / 8;
          // de Casteljau over [current, ...controls]
          const xs = [cx, ...ctrl.filter((_, j) => j % 2 === 0)];
          const ys = [cy, ...ctrl.filter((_, j) => j % 2 === 1)];
          for (let r = xs.length - 1; r > 0; r--) {
            for (let j = 0; j < r; j++) {
              xs[j] += (xs[j + 1] - xs[j]) * t;
              ys[j] += (ys[j + 1] - ys[j]) * t;
            }
          }
          line(px, py, xs[0], ys[0]);
          [px, py] = [xs[0], ys[0]];
        }
        [cx, cy] = [px, py];
        k += n * 2;
      } else if (cmd === 'Z') {
        line(cx, cy, sx, sy);
        [cx, cy] = [sx, sy];
      }
    }
  }
  return out;
}

/** Which cells of a COVER x COVER grid over a w x h box hold ink. */
function cover(pts: number[], w: number, h: number): Uint8Array {
  const grid = new Uint8Array(COVER * COVER);
  const fx = COVER / Math.max(w, 1e-6);
  const fy = COVER / Math.max(h, 1e-6);
  for (let k = 0; k < pts.length; k += 2) {
    const gx = Math.min(COVER - 1, Math.max(0, Math.floor(pts[k] * fx)));
    const gy = Math.min(COVER - 1, Math.max(0, Math.floor(pts[k + 1] * fy)));
    grid[gy * COVER + gx] = 1;
  }
  return grid;
}

/** Share of a's inked cells with ink in b within one cell. */
function within(a: Uint8Array, b: Uint8Array): number {
  let inked = 0;
  let met = 0;
  for (let gy = 0; gy < COVER; gy++) {
    for (let gx = 0; gx < COVER; gx++) {
      if (!a[gy * COVER + gx]) continue;
      inked++;
      search: for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = gx + dx;
          const y = gy + dy;
          if (x >= 0 && y >= 0 && x < COVER && y < COVER && b[y * COVER + x]) {
            met++;
            break search;
          }
        }
      }
    }
  }
  return inked ? met / inked : 1;
}

export function vectorScan(page: VectorPage, clicked: Pt): ScanResult {
  const [vx0, vy0, vx1, vy1] = page.view;
  const maxSize = MAX_SYMBOL * Math.min(vx1 - vx0, vy1 - vy0);
  const small = page.paths.filter((p) => size(p) <= maxSize && size(p) > 0);
  if (!small.length) return { error: 'no vector paths on this sheet' };

  // the clicked path: the biggest small path whose box holds the click (so a
  // click inside a circle-with-cross teaches the circle, not one stroke of
  // the cross), else the nearest one within reach
  const holding = small
    .filter((p) => clicked.x >= p.x0 - 1 && clicked.x <= p.x1 + 1 && clicked.y >= p.y0 - 1 && clicked.y <= p.y1 + 1)
    .sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
  const dist = (p: VectorPath) =>
    Math.hypot(Math.max(p.x0 - clicked.x, 0, clicked.x - p.x1), Math.max(p.y0 - clicked.y, 0, clicked.y - p.y1));
  const nearest = small.filter((p) => dist(p) <= CLICK_REACH).sort((a, b) => dist(a) - dist(b));
  const candidates = (holding.length ? holding : nearest.slice(0, 1)).filter((p) => size(p) >= MIN_SEED * size(holding[0] ?? p));
  if (!candidates.length) return { error: 'click directly on a symbol to teach the scan' };

  const near = index(page.paths, maxSize);
  let hits: ScanHit[] = [];
  // a click may sit in several boxes (a wall segment beside the symbol):
  // take the biggest one that repeats
  for (const seed of candidates.slice(0, 8)) {
    const found = matchSymbol(page, seed, near);
    if (found.length > hits.length) hits = found;
    if (hits.length >= 2) break;
  }
  hits.sort((a, b) => (Math.abs(b.y - a.y) > 8 ? b.y - a.y : a.x - b.x));
  return { hits, provider: 'vector' };
}

/** Every copy of the symbol around `seed`: paths tracing the seed's exact
 *  shape (in any quarter turn or mirror) whose surroundings, inside the
 *  symbol's box, carry the same ink. */
function matchSymbol(page: VectorPage, seed: VectorPath, near: Index): ScanHit[] {
  const sw = seed.x1 - seed.x0;
  const sh = seed.y1 - seed.y0;
  const tol = Math.max(0.1, 0.02 * Math.max(sw, sh));
  const margin = Math.max(0.5, 0.03 * Math.max(sw, sh));
  const step = Math.max(0.05, Math.max(sw, sh) / COVER / 2);
  const box: Box = [seed.x0 - margin, seed.y0 - margin, seed.x1 + margin, seed.y1 + margin];
  const template = ink(near(box), box, step);

  const hits: ScanHit[] = [];
  const seen = (x: number, y: number) => hits.some((h) => Math.abs(h.x - x) <= tol * 2 && Math.abs(h.y - y) <= tol * 2);

  for (const v of VARIANTS) {
    // the seed turned by v, re-anchored at its new bbox minimum
    const shape = turned(seed, seed.x0, seed.y0, v);
    let mx = Infinity;
    let my = Infinity;
    for (let k = 0; k < shape.length; k += 2) {
      mx = Math.min(mx, shape[k]);
      my = Math.min(my, shape[k + 1]);
    }
    for (let k = 0; k < shape.length; k += 2) {
      shape[k] -= mx;
      shape[k + 1] -= my;
    }
    // the template's ink turned the same way, relative to a copy's box
    const [w, h] = v[0] ? [sw, sh] : [sh, sw];
    const turnedInk: number[] = [];
    for (let k = 0; k < template.length; k += 2) {
      const x = template[k] + box[0] - seed.x0;
      const y = template[k + 1] + box[1] - seed.y0;
      turnedInk.push(v[0] * x + v[2] * y - mx + margin, v[1] * x + v[3] * y - my + margin);
    }
    const want = cover(turnedInk, w + 2 * margin, h + 2 * margin);

    for (const c of page.paths) {
      if (!traces(c, seed.cmds, shape, c.x0, c.y0, tol)) continue;
      const cx = (c.x0 + c.x1) / 2;
      const cy = (c.y0 + c.y1) / 2;
      if (seen(cx, cy)) continue;
      const cbox: Box = [c.x0 - margin, c.y0 - margin, c.x0 + w + margin, c.y0 + h + margin];
      const got = cover(ink(near(cbox), cbox, step), w + 2 * margin, h + 2 * margin);
      const kept = within(want, got);
      const own = within(got, want);
      if (kept >= COVER_KEPT && own >= COVER_OWN) hits.push({ x: cx, y: cy, score: Math.min(kept, own) });
    }
  }
  return hits;
}
