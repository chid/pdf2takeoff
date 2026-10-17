// Scan provider, tier 0: exact matching on the drawing's own vector paths.
// CAD exports draw every copy of a block with the same path operators, so a
// symbol can be found by geometry instead of pixels: wall lines, hatching and
// labels that touch it are separate paths and don't get in the way, and the
// result doesn't depend on the raster scale. Scanned sheets and symbols drawn
// as images have no paths to match; scan.ts falls back to the raster tiers.
//
// The host hands over the page's pdf.js operator list as plain data;
// vectorPage() replays the transforms into PDF user space and vectorScan()
// matches the clicked symbol, allowing quarter turns and mirrors. The same
// match runs from a VectorTemplate (vectorTemplate() teaches one from a
// click), so a symbol taught on one sheet can be counted on every other.
//
// Every copy must carry the template's ink in its box twice over: on a
// coarse grid with a cell of slack, then on a grid twice as fine, so a
// different symbol sharing the outline can't hide in the slack.
//
// A second, near-exact pass finds copies with no exact trace: the outline
// re-tessellated (a circle as Béziers in one copy, a 48-gon in the next, a
// ring of loose segments rejoined), or the block at another scale. They're
// compared by outline (points resampled by arc length, so the segmentation
// doesn't matter) and by ink normalised to the box (so the size doesn't),
// and come out after the exact hits as match 'near' with a lower score, for
// an estimator to check. Scaled copies count only where the caller allows
// (VectorMatchOptions): by default only on other sheets, at one scale per
// sheet and never beside copies of the taught size.

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

/** A path's outline as polylines, one per subpath, x,y interleaved; curves
 *  are flattened to 8 chords. */
function polylines(cmds: string, q: ArrayLike<number>): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  const flush = () => {
    if (cur.length >= 4) out.push(cur);
    cur = [];
  };
  let k = 0;
  let [cx, cy, sx, sy] = [0, 0, 0, 0];
  for (const cmd of cmds) {
    if (cmd === 'M') {
      flush();
      [cx, cy] = [q[k], q[k + 1]];
      [sx, sy] = [cx, cy];
      cur = [cx, cy];
      k += 2;
    } else if (cmd === 'L') {
      [cx, cy] = [q[k], q[k + 1]];
      cur.push(cx, cy);
      k += 2;
    } else if (cmd === 'C' || cmd === 'Q') {
      const n = cmd === 'C' ? 3 : 2;
      for (let i = 1; i <= 8; i++) {
        const t = i / 8;
        // de Casteljau over [current, ...controls]
        const xs = [cx];
        const ys = [cy];
        for (let j = 0; j < n; j++) xs.push(q[k + 2 * j]), ys.push(q[k + 2 * j + 1]);
        for (let r = xs.length - 1; r > 0; r--) {
          for (let j = 0; j < r; j++) {
            xs[j] += (xs[j + 1] - xs[j]) * t;
            ys[j] += (ys[j + 1] - ys[j]) * t;
          }
        }
        cur.push(xs[0], ys[0]);
      }
      [cx, cy] = [cur[cur.length - 2], cur[cur.length - 1]];
      k += n * 2;
    } else if (cmd === 'Z') {
      cur.push(sx, sy);
      [cx, cy] = [sx, sy];
      flush();
      cur = [sx, sy];
    }
  }
  flush();
  return out;
}

/** Some exporters write every segment as a path of its own, so a circle is
 *  a ring of 2-point paths with no path to trace. Rejoin those rings: open
 *  single-subpath paths whose ends meet one other end each, followed round
 *  until they close. Only closed rings count; an open run of segments is a
 *  contour or a wall as often as a symbol. Each ring is a virtual path
 *  (curves flattened), alongside the page's paths as a shape to match. */
const loopCache = new WeakMap<VectorPage, Map<number, VectorPath[]>>();
/** Endpoint snap for joining segments (pt). */
const JOIN = 0.02;

/** The rings up to maxSize on a page (cached per page and size). */
function pageLoops(page: VectorPage, maxSize: number): VectorPath[] {
  let bySize = loopCache.get(page);
  if (!bySize) loopCache.set(page, (bySize = new Map()));
  let out = bySize.get(maxSize);
  if (!out) bySize.set(maxSize, (out = loops(page.paths, maxSize)));
  return out;
}

/** The rings up to maxSize among some paths. Every path in such a ring is
 *  no bigger than the ring, so the rest are never looked at. */
function loops(paths: Iterable<VectorPath>, maxSize: number): VectorPath[] {
  const open: VectorPath[] = [];
  for (const p of paths) {
    if (size(p) <= maxSize && p.cmds.length > 1 && p.cmds.lastIndexOf('M') === 0 && !p.cmds.includes('Z')) open.push(p);
  }
  const n = open.length;
  // the points path ends meet at, in an open-addressed table (a page holds
  // ~10^5 of them, too many for a Map per call): per point, the first two
  // ends to meet there as index*2 + (0 head, 1 tail); a third end makes it
  // a junction (-1), where no ring runs through
  const cap = 2 ** Math.ceil(Math.log2(4 * n + 16));
  const mask = cap - 1;
  const keys = new Float64Array(cap).fill(NaN);
  const one = new Int32Array(cap).fill(-1);
  const two = new Int32Array(cap).fill(-2);
  const slot = (x: number, y: number) => {
    const kx = Math.round(x / JOIN);
    const ky = Math.round(y / JOIN);
    const k = kx * 2 ** 26 + ky; // a page spans well under 2^26 snaps a side
    let h = (Math.imul(kx, 0x9e3779b1) ^ Math.imul(ky, 0x85ebca6b)) & mask;
    while (!Number.isNaN(keys[h]) && keys[h] !== k) h = (h + 1) & mask;
    keys[h] = k;
    return h;
  };
  const head = new Int32Array(n);
  const tail = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const q = open[i].pts;
    head[i] = slot(q[0], q[1]);
    tail[i] = slot(q[q.length - 2], q[q.length - 1]);
    for (let end = 0; end < 2; end++) {
      const h = end ? tail[i] : head[i];
      if (one[h] < 0) one[h] = i * 2 + end;
      else if (two[h] === -2) two[h] = i * 2 + end;
      else two[h] = -1;
    }
  }
  const out: VectorPath[] = [];
  const used = new Uint8Array(n);
  // walk from path `from` on through `at` while exactly two ends meet
  // there: the paths passed (reversed = entered at its tail) and the point
  // the run stops at
  const walk = (from: number, at: number) => {
    const run: { i: number; reversed: boolean }[] = [];
    let cur = from;
    for (;;) {
      const a = one[at];
      const b = two[at];
      if (b < 0) break;
      const other = (a >> 1) === cur ? b : a;
      const next = other >> 1;
      if (used[next]) break;
      used[next] = 1;
      const reversed = (other & 1) === 1;
      run.push({ i: next, reversed });
      at = reversed ? head[next] : tail[next];
      cur = next;
    }
    return { run, at };
  };
  for (let f = 0; f < n; f++) {
    if (used[f] || head[f] === tail[f]) continue;
    // the run of paths through f between junctions (points where other
    // than two ends meet): each path joins one run, so each is walked once.
    // It's a ring if it closes, or if both ends stop at the same junction
    // (a ring with a spoke drawn to one of its vertices)
    used[f] = 1;
    const fwd = walk(f, tail[f]);
    const back = fwd.at === head[f] ? { run: [], at: head[f] } : walk(f, head[f]);
    const closed = fwd.at === back.at && fwd.run.length + back.run.length >= 2;
    const ring = [
      ...back.run.reverse().map(({ i, reversed }) => ({ p: open[i], reversed: !reversed })),
      { p: open[f], reversed: false },
      ...fwd.run.map(({ i, reversed }) => ({ p: open[i], reversed })),
    ];
    if (!closed) continue;
    const pts: number[] = [];
    for (const { p, reversed } of ring) {
      const line = polylines(p.cmds, p.pts)[0] ?? [];
      const xy: number[] = [];
      for (let k = 0; k < line.length; k += 2) xy.push(line[k], line[k + 1]);
      if (reversed) {
        for (let k = xy.length - 2; k >= 0; k -= 2) pts.push(xy[k], xy[k + 1]);
      } else pts.push(...xy);
      pts.length -= 2; // the next member starts where this one ends
    }
    // the same ring whichever segment the walk began at: counter-clockwise
    // from its lowest (then leftmost) vertex
    let area = 0;
    for (let k = 0; k < pts.length; k += 2) {
      const j = (k + 2) % pts.length;
      area += pts[k] * pts[j + 1] - pts[j] * pts[k + 1];
    }
    const vs: [number, number][] = [];
    for (let k = 0; k < pts.length; k += 2) vs.push([pts[k], pts[k + 1]]);
    if (area < 0) vs.reverse();
    let low = 0;
    vs.forEach(([x, y], i) => {
      if (y < vs[low][1] || (y === vs[low][1] && x < vs[low][0])) low = i;
    });
    pts.length = 0;
    for (let i = 0; i <= vs.length; i++) pts.push(...vs[(low + i) % vs.length]);
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let k = 0; k < pts.length; k += 2) {
      x0 = Math.min(x0, pts[k]);
      x1 = Math.max(x1, pts[k]);
      y0 = Math.min(y0, pts[k + 1]);
      y1 = Math.max(y1, pts[k + 1]);
    }
    const loop = { cmds: 'M' + 'L'.repeat(pts.length / 2 - 1), pts: Float64Array.from(pts), x0, y0, x1, y1 };
    if (size(loop) <= maxSize && size(loop) > 0) out.push(loop);
  }
  return out;
}

/** Points sampled every `step` along the paths' outlines (curves
 *  flattened), keeping those inside the box, relative to its corner. */
function ink(paths: Iterable<VectorPath>, [x0, y0, x1, y1]: Box, step: number): number[] {
  const out: number[] = [];
  for (const p of paths) {
    for (const line of polylines(p.cmds, p.pts)) {
      for (let k = 2; k < line.length; k += 2) {
        const [ax, ay, bx, by] = [line[k - 2], line[k - 1], line[k], line[k + 1]];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
        for (let i = 0; i <= n; i++) {
          const x = ax + ((bx - ax) * i) / n;
          const y = ay + ((by - ay) * i) / n;
          if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out.push(x - x0, y - y0);
        }
      }
    }
  }
  return out;
}

/** Which cells of an n x n grid over a w x h box hold ink. */
function cover(pts: number[], w: number, h: number, n = COVER): Uint8Array {
  const grid = new Uint8Array(n * n);
  const fx = n / Math.max(w, 1e-6);
  const fy = n / Math.max(h, 1e-6);
  for (let k = 0; k < pts.length; k += 2) {
    const gx = Math.min(n - 1, Math.max(0, Math.floor(pts[k] * fx)));
    const gy = Math.min(n - 1, Math.max(0, Math.floor(pts[k + 1] * fy)));
    grid[gy * n + gx] = 1;
  }
  return grid;
}

/** Share of a's inked cells with ink in b within one cell (n x n grids). */
function within(a: Uint8Array, b: Uint8Array, n = COVER): number {
  let inked = 0;
  let met = 0;
  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      if (!a[gy * n + gx]) continue;
      inked++;
      search: for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = gx + dx;
          const y = gy + dy;
          if (x >= 0 && y >= 0 && x < n && y < n && b[y * n + x]) {
            met++;
            break search;
          }
        }
      }
    }
  }
  return inked ? met / inked : 1;
}

/** `n` points evenly spaced by arc length along polylines (taken end to
 *  end), and their total length. */
function resample(lines: number[][], n: number): { pts: Float64Array; length: number } | null {
  let length = 0;
  for (const l of lines) for (let k = 2; k < l.length; k += 2) length += Math.hypot(l[k] - l[k - 2], l[k + 1] - l[k - 1]);
  if (!(length > 0)) return null;
  const pts = new Float64Array(n * 2);
  let i = 0;
  let walked = 0;
  for (const l of lines) {
    for (let k = 2; k < l.length; k += 2) {
      const seg = Math.hypot(l[k] - l[k - 2], l[k + 1] - l[k - 1]);
      for (let at = ((i + 0.5) * length) / n; i < n && at <= walked + seg; at = ((i + 0.5) * length) / n) {
        const t = seg ? (at - walked) / seg : 0;
        pts[2 * i] = l[k - 2] + (l[k] - l[k - 2]) * t;
        pts[2 * i + 1] = l[k - 1] + (l[k + 1] - l[k - 1]) * t;
        i++;
      }
      walked += seg;
    }
  }
  for (; i < n; i++) {
    // rounding left the last sample(s) past the end: pin them to it
    const l = lines[lines.length - 1];
    pts[2 * i] = l[l.length - 2];
    pts[2 * i + 1] = l[l.length - 1];
  }
  return { pts, length };
}

/** Mean distance from each point of a to its nearest point of b, or
 *  Infinity once any point lies further than `cap`. */
function reach(a: Float64Array, b: Float64Array, cap: number): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 2) {
    let best = Infinity;
    for (let j = 0; j < b.length; j += 2) {
      const d = (a[i] - b[j]) ** 2 + (a[i + 1] - b[j + 1]) ** 2;
      if (d < best) best = d;
    }
    best = Math.sqrt(best);
    if (best > cap) return Infinity;
    sum += best;
  }
  return sum / (a.length / 2);
}

/** A seed outline on a unit scale (divided by its box's longer side),
 *  sampled coarse (probe) and fine (target) for an outline comparison that
 *  ignores how a curve was tessellated: the same circle as 4 Béziers or a
 *  48-gon samples to nearly the same points. */
interface Outline {
  probe: Float64Array;
  target: Float64Array;
  /** Outline length, in the same unit. */
  length: number;
}

function outlineOf(cmds: string, pts: ArrayLike<number>, ox: number, oy: number, unit: number): Outline | null {
  const lines = polylines(cmds, pts).map((l) => l.map((v, k) => (v - (k % 2 ? oy : ox)) / unit));
  const probe = resample(lines, OUTLINE_PROBE);
  const target = resample(lines, OUTLINE_TARGET);
  return probe && target ? { probe: probe.pts, target: target.pts, length: probe.length } : null;
}

/** How far apart two unit outlines are (symmetric mean nearest distance,
 *  in units of the box size), or Infinity past OUTLINE_MAX anywhere. */
function outlineError(a: Outline, b: Outline): number {
  const ab = reach(a.probe, b.target, OUTLINE_MAX);
  if (ab === Infinity) return ab;
  return Math.max(ab, reach(b.probe, a.target, OUTLINE_MAX));
}

/** Coverage grid cells per side for the second, finer ink check. */
const FINE = 32;
/** Share of a copy's fine-grid ink that must belong to the symbol. On the
 *  council sets true copies score 0.76 and up (a tank a dashed boundary
 *  crosses); look-alikes that pass the coarse check score 0.47-0.67 (a pipe
 *  pit with a leader arrow at its centre, a no-dig sign vs a north point). */
const FINE_OWN = 0.7;
/** Same-size band: a copy within this ratio of the taught size is the same
 *  block (CAD rounding, a curve re-tessellated); outside it, only with
 *  scale matching on. */
const SAME_SIZE = 1.03;
/** Size ratio band for a sheet drawn at another scale. The council sets
 *  scale annotation blocks by 6.6% on their 1:3000 sheets. */
export const SCALE_BAND = 1.15;
/** Size ratio band when scale matching is asked for (trees drawn to their
 *  canopy). Wider, a circle with lines through it starts to match any. */
export const SCALE_WIDE = 2;
/** How far a copy's box proportions may differ (in units of its size). */
const ASPECT_TOL = 0.04;
/** How far a copy's outline length may differ, as a share. */
const LENGTH_TOL = 0.08;
/** Outline samples: probes and the denser targets they're measured to. */
const OUTLINE_PROBE = 64;
const OUTLINE_TARGET = 160;
/** Outline comparison limits (unit: the box's longer side): the mean gap,
 *  and the most any one sample may stray. */
const OUTLINE_MEAN = 0.015;
const OUTLINE_MAX = 0.06;
/** Near hits score below every exact hit (exact >= COVER_OWN). */
const NEAR_SCORE = 0.7;

/** How a template is matched beyond exact copies. */
export interface VectorMatchOptions {
  /** Also match near-exact copies: the same outline drawn with different
   *  segments (a curve re-tessellated) or, within `scale`, at another size.
   *  Default true; false is exact copies only. */
  near?: boolean;
  /** Largest size ratio a near copy may have. Default SAME_SIZE (size
   *  differences only from rounding); SCALE_BAND or SCALE_WIDE to match
   *  scaled copies. */
  scale?: number;
  /** Scaled copies only on a sheet with no same-size copy, all at one
   *  scale: a sheet drawn at another annotation scale scales every block on
   *  it alike, while different sizes on one sheet mean different things (a
   *  450 vs a 600 pit, a 15 kL vs a 22.5 kL tank). Default true. */
  oneScale?: boolean;
}

/** A symbol taught on one sheet, ready to match on any sheet: the seed
 *  path's exact shape and the ink around it, in PDF points. A CAD block is
 *  usually drawn the same size on every sheet of a set; near matching (see
 *  VectorMatchOptions) covers the sheets where it isn't. */
export interface VectorTemplate {
  /** The seed path's segment string (see VectorPath.cmds). */
  cmds: string;
  /** Seed points relative to its box's lower-left corner, x,y interleaved. */
  shape: Float64Array;
  /** Seed box size. */
  w: number;
  h: number;
  /** Ink sampled inside the symbol's box (the seed's box plus margin),
   *  relative to the seed's corner, x,y interleaved. */
  ink: number[];
  /** Point tolerance for tracing the seed. */
  tol: number;
  /** Box margin around the seed the ink check looks at. */
  margin: number;
  /** Ink sampling step along outlines. */
  step: number;
  /** Largest path counted as part of a symbol on the teaching sheet; the
   *  same cut applies on every sheet so the ink compares like with like. */
  maxSize: number;
}

/** Teach the scan from a click: the template of the clicked symbol, and
 *  its copies on this sheet (exact copies first, each group in reading
 *  order). Near copies are matched at the taught size unless opts.scale
 *  says otherwise. */
export function vectorTemplate(
  page: VectorPage,
  clicked: Pt,
  opts: VectorMatchOptions = {},
): { template: VectorTemplate; hits: ScanHit[] } | { error: string } {
  const [vx0, vy0, vx1, vy1] = page.view;
  const maxSize = MAX_SYMBOL * Math.min(vx1 - vx0, vy1 - vy0);
  // rings rejoined from segments, around the click only
  const reach: Box = [clicked.x - maxSize, clicked.y - maxSize, clicked.x + maxSize, clicked.y + maxSize];
  const near = index(page.paths, maxSize);
  const small = [...page.paths, ...loops(near(reach), maxSize)].filter((p) => size(p) <= maxSize && size(p) > 0);
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

  const match = { near: opts.near ?? true, scale: opts.scale ?? SAME_SIZE, oneScale: opts.oneScale ?? true };
  let best: { template: VectorTemplate; hits: ScanHit[] } | null = null;
  // a click may sit in several boxes (a wall segment beside the symbol):
  // take the biggest one that repeats
  for (const seed of candidates.slice(0, 8)) {
    const template = teach(seed, near, maxSize);
    const hits = matchSymbol(page, template, near, match);
    if (!best || hits.length > best.hits.length) best = { template, hits };
    if (best.hits.length >= 2) break;
  }
  return best!;
}

export function vectorScan(page: VectorPage, clicked: Pt, opts: VectorMatchOptions = {}): ScanResult {
  const taught = vectorTemplate(page, clicked, opts);
  return 'error' in taught ? taught : { hits: taught.hits, provider: 'vector' };
}

/** Every copy of a taught symbol on a sheet (any sheet): exact copies, then
 *  near ones, each in reading order. Another sheet may be drawn at another
 *  scale, so scaled copies are matched unless opts.scale says otherwise. */
export function matchVectorTemplate(page: VectorPage, template: VectorTemplate, opts: VectorMatchOptions = {}): ScanHit[] {
  const match = { near: opts.near ?? true, scale: opts.scale ?? SCALE_BAND, oneScale: opts.oneScale ?? true };
  return matchSymbol(page, template, index(page.paths, template.maxSize), match);
}

/** Stable numbering: rows top to bottom, then left to right. */
const readingOrder = (a: ScanHit, b: ScanHit) => (Math.abs(b.y - a.y) > 8 ? b.y - a.y : a.x - b.x);

/** The template for the symbol around `seed`. */
function teach(seed: VectorPath, near: Index, maxSize: number): VectorTemplate {
  const w = seed.x1 - seed.x0;
  const h = seed.y1 - seed.y0;
  const tol = Math.max(0.1, 0.02 * Math.max(w, h));
  const margin = Math.max(0.5, 0.03 * Math.max(w, h));
  const step = Math.max(0.05, Math.max(w, h) / FINE);
  const box: Box = [seed.x0 - margin, seed.y0 - margin, seed.x1 + margin, seed.y1 + margin];
  const sampled = ink(near(box), box, step);
  const rel: number[] = [];
  for (let k = 0; k < sampled.length; k += 2) rel.push(sampled[k] + box[0] - seed.x0, sampled[k + 1] + box[1] - seed.y0);
  return { cmds: seed.cmds, shape: turned(seed, seed.x0, seed.y0, VARIANTS[0]), w, h, ink: rel, tol, margin, step, maxSize };
}

/** One quarter turn or mirror of a template, ready to compare copies to. */
interface Turned {
  /** Seed points turned, re-anchored at their box minimum. */
  shape: Float64Array;
  /** Turned box size. */
  w: number;
  h: number;
  /** Template ink cover over the turned symbol box, coarse and fine. */
  want: Uint8Array;
  wantFine: Uint8Array;
  /** The turned seed outline on a unit scale (for near copies). */
  outline: Outline | null;
}

function turnTemplate(t: VectorTemplate, v: Variant): Turned {
  const shape = new Float64Array(t.shape.length);
  for (let k = 0; k < shape.length; k += 2) {
    shape[k] = v[0] * t.shape[k] + v[2] * t.shape[k + 1];
    shape[k + 1] = v[1] * t.shape[k] + v[3] * t.shape[k + 1];
  }
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
  const [w, h] = v[0] ? [t.w, t.h] : [t.h, t.w];
  const { margin } = t;
  const turnedInk: number[] = [];
  for (let k = 0; k < t.ink.length; k += 2) {
    const x = t.ink[k];
    const y = t.ink[k + 1];
    turnedInk.push(v[0] * x + v[2] * y - mx + margin, v[1] * x + v[3] * y - my + margin);
  }
  return {
    shape,
    w,
    h,
    want: cover(turnedInk, w + 2 * margin, h + 2 * margin),
    wantFine: cover(turnedInk, w + 2 * margin, h + 2 * margin, FINE),
    outline: null,
  };
}

/** Does a copy's surroundings carry the template's ink? The coarse grid
 *  allows a cell of slack each way; the fine grid then checks the copy's
 *  own ink at half that slack, so a different symbol sharing the outline
 *  can't hide in the slack. */
function inkMatch(page: Index, v: Turned, cbox: Box, step: number): { kept: number; own: number; fineOwn: number } | null {
  const pts = ink(page(cbox), cbox, step);
  const w = cbox[2] - cbox[0];
  const h = cbox[3] - cbox[1];
  const got = cover(pts, w, h);
  const kept = within(v.want, got);
  const own = within(got, v.want);
  if (kept < COVER_KEPT || own < COVER_OWN) return null;
  return { kept, own, fineOwn: within(cover(pts, w, h, FINE), v.wantFine, FINE) };
}

/** Every copy of a template's symbol: paths tracing the seed's exact shape
 *  (in any quarter turn or mirror) whose surroundings, inside the symbol's
 *  box, carry the same ink; then, if asked, near copies: paths of about the
 *  seed's proportions and outline whose ink matches once scaled to size. */
function matchSymbol(page: VectorPage, t: VectorTemplate, near: Index, opts: Required<VectorMatchOptions>): ScanHit[] {
  const { tol, margin, step } = t;
  const hits: ScanHit[] = [];
  const traced = new Set<VectorPath>();
  const seen = (x: number, y: number, r: number) => hits.some((h) => Math.abs(h.x - x) <= r && Math.abs(h.y - y) <= r);
  const turns = VARIANTS.map((v) => turnTemplate(t, v));
  const S = Math.max(t.w, t.h);
  // rings rejoined from segments are worth matching to a seed of straight
  // segments (often a ring itself); a seed drawn with curves comes from an
  // exporter that writes whole paths, and rejoining a sheet's ~10^5
  // segments would cost more than the whole match
  const ringLike = /^ML+Z?$/.test(t.cmds);
  const limit = Math.min(t.maxSize, S * (opts.near ? Math.max(opts.scale, SAME_SIZE) : SAME_SIZE));
  const shapes = ringLike ? [...page.paths, ...pageLoops(page, limit)] : page.paths;

  for (const v of turns) {
    for (const c of shapes) {
      if (!traces(c, t.cmds, v.shape, c.x0, c.y0, tol)) continue;
      traced.add(c);
      const cx = (c.x0 + c.x1) / 2;
      const cy = (c.y0 + c.y1) / 2;
      if (seen(cx, cy, tol * 2)) continue;
      const cbox: Box = [c.x0 - margin, c.y0 - margin, c.x0 + v.w + margin, c.y0 + v.h + margin];
      const m = inkMatch(near, v, cbox, step);
      if (m && m.fineOwn >= FINE_OWN) hits.push({ x: cx, y: cy, score: Math.min(m.kept, m.own), match: 'exact' });
    }
  }
  const exact = hits.length;
  if (!opts.near) return hits.sort(readingOrder);

  // near copies: no exact trace, so compare outlines, which don't depend on
  // how the drawing split a curve into segments, then the ink scaled to size
  for (const v of turns) v.outline = outlineOf(t.cmds, v.shape, 0, 0, S);
  const seedLength = turns[0].outline?.length;
  if (!seedLength) return hits.sort(readingOrder);
  const nearHits: (ScanHit & { scale: number })[] = [];
  for (const c of shapes) {
    if (traced.has(c)) continue;
    const cs = size(c);
    const s = cs / S;
    if (!(s <= opts.scale && s >= 1 / opts.scale) || cs > t.maxSize) continue;
    const cw = (c.x1 - c.x0) / cs;
    const ch = (c.y1 - c.y0) / cs;
    const fits = turns.filter((v) => Math.abs(cw - v.w / S) <= ASPECT_TOL && Math.abs(ch - v.h / S) <= ASPECT_TOL);
    if (!fits.length) continue;
    const cx = (c.x0 + c.x1) / 2;
    const cy = (c.y0 + c.y1) / 2;
    // a fill and its stroke, or a double outline, are one symbol
    if (seen(cx, cy, 0.25 * cs) || nearHits.some((h) => Math.abs(h.x - cx) <= 0.25 * cs && Math.abs(h.y - cy) <= 0.25 * cs)) continue;
    const o = outlineOf(c.cmds, c.pts, c.x0, c.y0, cs);
    if (!o || Math.abs(o.length - seedLength) > LENGTH_TOL * seedLength) continue;
    let best: (ScanHit & { scale: number }) | null = null;
    for (const v of fits) {
      const err = outlineError(o, v.outline!);
      if (err > OUTLINE_MEAN) continue;
      const pad = s * margin;
      const m = inkMatch(near, v, [c.x0 - pad, c.y0 - pad, c.x1 + pad, c.y1 + pad], step * s);
      if (!m || m.fineOwn < FINE_OWN) continue;
      const score = NEAR_SCORE * Math.min(m.kept, m.own, 1 - err / OUTLINE_MEAN / 2);
      if (!best || score > best.score!) best = { x: cx, y: cy, score, match: 'near', scale: s };
    }
    if (best) nearHits.push(best);
  }

  let kept = nearHits;
  if (opts.oneScale) {
    const same = nearHits.filter((h) => h.scale <= SAME_SIZE && h.scale >= 1 / SAME_SIZE);
    const scaled = nearHits.filter((h) => !same.includes(h));
    kept = same;
    if (!exact && !same.length && scaled.length) {
      // one scale per sheet: the biggest group of copies agreeing on it
      const group = (h: { scale: number }) => scaled.filter((o) => Math.abs(o.scale / h.scale - 1) <= SAME_SIZE - 1);
      kept = scaled.map(group).sort((a, b) => b.length - a.length)[0];
    }
  }
  return [...hits.sort(readingOrder), ...kept.map((h) => ({ ...h, scale: Math.round(h.scale * 1000) / 1000 })).sort(readingOrder)];
}
