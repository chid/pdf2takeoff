// Run lengths by line style: "total stormwater line on this sheet". Services
// are told apart by how they're drawn (colour, width, dash), so a click on
// one line picks the style, and every path painted that way is joined into
// runs whose lengths add up to the takeoff.
//
// CAD exporters rarely leave dashing to the PDF: the council sets we test on
// draw every dash as its own short stroked path (no dash pattern at all), and
// letter-coded services ("-S-", "-E-") put the letters' strokes in the gaps
// in the same colour. So the paths of a style are treated as pieces: closed
// shapes (pits, tanks, dots) and glyph-sized strokes are dropped, and the
// rest are chained end to end across gaps no longer than the style's own
// dash gaps, turning corners. A run's length includes the gaps it bridges:
// the pipe runs on under them. A path stroked with a dash pattern is a
// single piece already, measured along its full geometry.
//
// Runs stop where a pit or other symbol interrupts the line: a run is the
// line as drawn, not pit centre to pit centre. There's no legend detection:
// a key swatch drawn in exactly the line's style would count as a run (the
// sets tested draw their swatches wider, so they're a style of their own).
//
// Pure engine code: the host supplies the VectorPage (see scan-vector.ts).

import type { Pt } from './types.ts';
import type { PathStyle, VectorPage, VectorPath } from './scan-vector.ts';

export interface LineRun {
  /** The run as a polyline in PDF user space, gaps bridged. */
  points: Pt[];
  /** Polyline length in PDF points. */
  length: number;
  /** Paths (dashes) joined into the run. */
  pieces: number;
}

export interface LineRunsResult {
  /** Index into page.styles of the clicked line's style. */
  styleId: number;
  style: PathStyle;
  /** Longest gap bridged between pieces, in points. */
  gapTolerance: number;
  /** Longest first. */
  runs: LineRun[];
  /** Sum of run lengths, in points. */
  total: number;
}

export interface LineRunsOptions {
  /** Longest gap (pt) to bridge between pieces; default: from the drawing. */
  gap?: number;
  /** How far (pt) from a line a click may land; default 4. */
  reach?: number;
}

/** Reach (pt) for a click that lands near, not on, a line (or in a dash gap). */
const CLICK_REACH = 4;
/** Pieces shorter than this share of the style's dominant piece length are
 *  glyph strokes (the S of a sewer line), capped at GLYPH_MAX pt. */
const GLYPH_SHARE = 0.25;
const GLYPH_MAX = 1.5;
/** Strokes joined end to end within this many dash lengths are a mark. */
const GLYPH_DASHES = 1.5;
/** Ends this close (pt, plus the line width) join whatever the angle. */
const TOUCH = 0.2;
/** Bridgeable gap: this many times the style's typical dash gap. */
const GAP_FACTOR = 1.5;
/** Share of piece ends that must have a piece straight ahead for the style
 *  to count as pre-broken dashes. */
const DASHED_SHARE = 0.5;
/** Longest dash gap (pt) looked for, and no more than this many dashes. */
const GAP_SEARCH = 25;
const GAP_SEARCH_DASHES = 2;

/** A path's open subpaths flattened to polylines, x,y interleaved (curves
 *  in 8 steps). Closed subpaths are shapes, not lines, and are left out. */
function flatten(p: VectorPath): number[][] {
  const q = p.pts;
  const lines: number[][] = [];
  let out: number[] = [];
  let k = 0;
  for (const cmd of p.cmds) {
    if (cmd === 'M') {
      if (out.length >= 4) lines.push(out);
      out = [q[k], q[k + 1]];
      k += 2;
    } else if (cmd === 'L') {
      out.push(q[k], q[k + 1]);
      k += 2;
    } else if (cmd === 'C' || cmd === 'Q') {
      const n = cmd === 'C' ? 3 : 2;
      const cx = out[out.length - 2];
      const cy = out[out.length - 1];
      for (let i = 1; i <= 8; i++) {
        const t = i / 8;
        const xs = [cx];
        const ys = [cy];
        for (let j = 0; j < n; j++) {
          xs.push(q[k + 2 * j]);
          ys.push(q[k + 2 * j + 1]);
        }
        for (let r = xs.length - 1; r > 0; r--) {
          for (let j = 0; j < r; j++) {
            xs[j] += (xs[j + 1] - xs[j]) * t;
            ys[j] += (ys[j + 1] - ys[j]) * t;
          }
        }
        out.push(xs[0], ys[0]);
      }
      k += n * 2;
    } else if (cmd === 'Z') {
      out = []; // a closed shape: a pit, a tank, a dot
    }
  }
  if (out.length >= 4) lines.push(out);
  // a subpath that ends where it starts is a shape too (a circle as curves)
  return lines.filter((xy) => {
    const n = xy.length;
    return n === 4 || Math.hypot(xy[0] - xy[n - 2], xy[1] - xy[n - 1]) > 1e-3 * Math.max(1, polyLength(xy));
  });
}

function polyLength(xy: number[]): number {
  let len = 0;
  for (let k = 2; k < xy.length; k += 2) len += Math.hypot(xy[k] - xy[k - 2], xy[k + 1] - xy[k - 1]);
  return len;
}

/** Distance from a point to a path's segments (control points as a polyline). */
function distanceTo(p: VectorPath, at: Pt): number {
  const q = p.pts;
  if (q.length === 2) return Math.hypot(q[0] - at.x, q[1] - at.y);
  let best = Infinity;
  for (let k = 2; k < q.length; k += 2) {
    const [ax, ay, bx, by] = [q[k - 2], q[k - 1], q[k], q[k + 1]];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((at.x - ax) * dx + (at.y - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx - at.x, ay + t * dy - at.y));
  }
  return best;
}

interface Piece {
  xy: number[];
  length: number;
}

/** One end of a piece: where it is and the way the line leaves it (unit). */
interface End {
  piece: number;
  side: 0 | 1; // 0 = start, 1 = end
  x: number;
  y: number;
  dx: number;
  dy: number;
}

function endsOf(pieces: Piece[]): End[] {
  const ends: End[] = [];
  pieces.forEach(({ xy }, i) => {
    const n = xy.length;
    // direction from the nearest distinct point, so zero-length steps at the
    // ends don't leave it undefined
    const dir = (x: number, y: number, from: number, step: number): [number, number] => {
      for (let k = from; k >= 0 && k < n; k += step) {
        const d = Math.hypot(x - xy[k], y - xy[k + 1]);
        if (d > 1e-6) return [(x - xy[k]) / d, (y - xy[k + 1]) / d];
      }
      return [0, 0];
    };
    const [sx, sy] = dir(xy[0], xy[1], 2, 2);
    const [ex, ey] = dir(xy[n - 2], xy[n - 1], n - 4, -2);
    ends.push({ piece: i, side: 0, x: xy[0], y: xy[1], dx: sx, dy: sy });
    ends.push({ piece: i, side: 1, x: xy[n - 2], y: xy[n - 1], dx: ex, dy: ey });
  });
  return ends;
}

/** Ends within `r` of each other, as an index lookup. */
function endIndex(ends: End[], r: number): (e: End) => End[] {
  const cell = Math.max(r, 0.5);
  const cells = new Map<string, End[]>();
  for (const e of ends) {
    const key = `${Math.floor(e.x / cell)},${Math.floor(e.y / cell)}`;
    const list = cells.get(key);
    if (list) list.push(e);
    else cells.set(key, [e]);
  }
  return (e) => {
    const out: End[] = [];
    const gx = Math.floor(e.x / cell);
    const gy = Math.floor(e.y / cell);
    for (let i = gx - 1; i <= gx + 1; i++) {
      for (let j = gy - 1; j <= gy + 1; j++) {
        for (const f of cells.get(`${i},${j}`) ?? []) {
          if (f.piece !== e.piece && Math.hypot(f.x - e.x, f.y - e.y) <= r) out.push(f);
        }
      }
    }
    return out;
  };
}

/** How well two ends continue each other across the gap between them:
 *  a cost (lower is better), or null when they don't. Each line must carry
 *  on toward the other (a corner may turn within the gap), never doubling
 *  back or stepping sideways onto a neighbouring line. */
function joinCost(a: End, b: End, touch: number): number | null {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const d = Math.hypot(vx, vy);
  if (d <= touch) return d;
  // a leaves along (dx, dy); b's line arrives against its own (dx, dy)
  const ca = (a.dx * vx + a.dy * vy) / d;
  const cb = -(b.dx * vx + b.dy * vy) / d;
  if (ca < -0.1 || cb < -0.1 || ca + cb < 1) return null;
  return d * (3 - ca - cb);
}

/** The length carrying the most ink: dashes, not the glyphs between them. */
function dominantLength(pieces: Piece[]): number {
  const ink = new Map<number, number>();
  for (const p of pieces) {
    const bucket = Math.round(p.length * 4);
    ink.set(bucket, (ink.get(bucket) ?? 0) + p.length);
  }
  let best = 0;
  let most = -1;
  for (const [bucket, total] of ink) {
    if (total > most) [best, most] = [bucket / 4, total];
  }
  return best;
}

/** The style's own dash gap: how far a piece end typically is from the
 *  next piece straight ahead of it. Zero unless most ends have one: solid
 *  lines (and everything else drawn in their style) don't, and bridging
 *  their chance alignments would join unrelated lines. */
function typicalGap(ends: End[], width: number, reach: number): number {
  const near = endIndex(ends, reach);
  const gaps: number[] = [];
  for (const e of ends) {
    let best = Infinity;
    for (const f of near(e)) {
      const vx = f.x - e.x;
      const vy = f.y - e.y;
      const d = Math.hypot(vx, vy);
      const ahead = e.dx * vx + e.dy * vy;
      const side = Math.abs(e.dx * vy - e.dy * vx);
      if (d > 1e-6 && ahead > 0.9 * d && side <= Math.max(0.3, width)) best = Math.min(best, d);
    }
    if (best < Infinity) gaps.push(best);
  }
  if (gaps.length < DASHED_SHARE * ends.length) return 0;
  gaps.sort((x, y) => x - y);
  // the upper quartile: some patterns alternate short and long gaps (a
  // sewer's dash, dash, S)
  return gaps[Math.floor(0.75 * (gaps.length - 1))];
}

/** Drop letters and marks drawn on the line (the E of an "-E-" powerline,
 *  a pole's circle in arcs): three or more strokes meeting end to end
 *  within GLYPH_DASHES dashes. A
 *  dash broken at a corner is two strokes, and a lone stroke on the line's
 *  axis (an E's middle bar) just carries the run on. */
function withoutGlyphs(pieces: Piece[], touch: number, dash: number): Piece[] {
  const ends = endsOf(pieces);
  const parent = pieces.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const near = endIndex(ends, touch);
  for (const e of ends) for (const f of near(e)) parent[find(e.piece)] = find(f.piece);
  const groups = new Map<number, { count: number; box: number[] }>();
  pieces.forEach(({ xy }, i) => {
    const root = find(i);
    const g = groups.get(root) ?? { count: 0, box: [Infinity, Infinity, -Infinity, -Infinity] };
    g.count++;
    for (let k = 0; k < xy.length; k += 2) {
      g.box = [Math.min(g.box[0], xy[k]), Math.min(g.box[1], xy[k + 1]), Math.max(g.box[2], xy[k]), Math.max(g.box[3], xy[k + 1])];
    }
    groups.set(root, g);
  });
  return pieces.filter((_, i) => {
    const { count, box } = groups.get(find(i))!;
    return count < 3 || Math.hypot(box[2] - box[0], box[3] - box[1]) >= GLYPH_DASHES * dash;
  });
}

/** Every run drawn in the style of the line under the click. */
export function lineRuns(page: VectorPage, clicked: Pt, opts: LineRunsOptions = {}): LineRunsResult | { error: string } {
  const reach = opts.reach ?? CLICK_REACH;
  // the clicked line: the stroked path whose ink is nearest within reach
  let seed: VectorPath | null = null;
  let seedDist = reach;
  for (const p of page.paths) {
    const s = page.styles[p.style];
    if (!s?.stroked) continue;
    if (p.x0 - reach > clicked.x || p.x1 + reach < clicked.x || p.y0 - reach > clicked.y || p.y1 + reach < clicked.y) continue;
    const d = Math.max(0, distanceTo(p, clicked) - s.width / 2);
    if (d <= seedDist) [seed, seedDist] = [p, d];
  }
  if (!seed) return { error: 'click directly on a line to measure its runs' };
  const styleId = seed.style;
  const style = page.styles[styleId];

  // the style's pieces, closed shapes left out
  let pieces: Piece[] = [];
  for (const p of page.paths) {
    if (p.style !== styleId) continue;
    for (const xy of flatten(p)) pieces.push({ xy, length: polyLength(xy) });
  }
  const dash = dominantLength(pieces);
  const minLength = Math.min(GLYPH_MAX, GLYPH_SHARE * dash);
  pieces = pieces.filter((p) => p.length >= minLength && p.length > 0);
  const touch = TOUCH + style.width;
  pieces = withoutGlyphs(pieces, touch, dash);
  if (!pieces.length) return { error: 'no line runs in this style' };

  const ends = endsOf(pieces);
  const search = Math.min(GAP_SEARCH, GAP_SEARCH_DASHES * dash) + touch;
  const gap = opts.gap ?? Math.max(touch, GAP_FACTOR * typicalGap(ends, style.width, search) + style.width);

  // join ends greedily, best continuation first; each end joins at most once
  const near = endIndex(ends, gap);
  const pairs: [number, End, End][] = [];
  for (const e of ends) {
    for (const f of near(e)) {
      if (e.piece > f.piece || (e.piece === f.piece && e.side >= f.side)) continue;
      const cost = joinCost(e, f, touch);
      if (cost !== null) pairs.push([cost, e, f]);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const link = new Map<End, End>();
  for (const [, e, f] of pairs) {
    if (link.has(e) || link.has(f)) continue;
    link.set(e, f);
    link.set(f, e);
  }

  // walk the chains: from each free end (then any leftover loops)
  const endOf = (piece: number, side: 0 | 1) => ends[piece * 2 + side];
  const used = new Uint8Array(pieces.length);
  const runs: LineRun[] = [];
  const walk = (start: End) => {
    const points: Pt[] = [];
    let length = 0;
    let count = 0;
    let at: End | undefined = start;
    while (at && !used[at.piece]) {
      used[at.piece] = 1;
      count++;
      const { xy } = pieces[at.piece];
      const n = xy.length / 2;
      for (let i = 0; i < n; i++) {
        const k = at.side === 0 ? i : n - 1 - i;
        const pt = { x: xy[2 * k], y: xy[2 * k + 1] };
        const last = points[points.length - 1];
        if (last) {
          const d = Math.hypot(pt.x - last.x, pt.y - last.y);
          if (d <= 1e-9) continue;
          length += d;
        }
        points.push(pt);
      }
      at = link.get(endOf(at.piece, at.side === 0 ? 1 : 0));
    }
    if (points.length >= 2) runs.push({ points, length, pieces: count });
  };
  for (const e of ends) if (!used[e.piece] && !link.has(e)) walk(e);
  for (const e of ends) if (!used[e.piece]) walk(e);

  runs.sort((a, b) => b.length - a.length);
  return { styleId, style, gapTolerance: gap, runs, total: runs.reduce((s, r) => s + r.length, 0) };
}
