// ScaledDrawingBench sheet generator: designs one floor-plan sheet from a
// seeded RNG (rooms with known inside-face areas, walls with known lengths,
// repeated symbols with known counts, dimension strings, a scale statement
// in one of five notations), draws it as a vector PDF with pdf-lib, and
// writes the estimator-style questions whose answers the design makes exact.
//
// Conventions (stated in bench/scaled-drawing-bench/README.md):
//   - geometry is designed in model units (metres on metric sheets, feet on
//     imperial ones) and converted to PDF points through the drawing ratio;
//   - walls are filled rectangles: exterior te thick, partitions ti thick;
//   - room areas and perimeters are measured between the inside wall faces;
//   - wall lengths are outside-face (external walls) or centreline (partitions);
//   - doors are plain openings (no leaf or swing drawn);
//   - symbols are drawn at paper size (9 pt) whatever the scale, as on real
//     drawings; a legend in the title column shows one of each class used.

import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { polyArea, polyPerimeter } from './draw.mjs';
import { shuffleV01 } from './shuffle-v01.mjs';

const METERS_PER_PT = 0.0254 / 72;
const BLACK = rgb(0, 0, 0);
const DARK = rgb(0.15, 0.15, 0.18);
const GREY = rgb(0.4, 0.42, 0.46);
const GRID = rgb(0.92, 0.92, 0.93);
const WHITE = rgb(1, 1, 1);

export const SHEET_SIZES = {
  A3: { w: 1190.55, h: 841.89, label: 'A3' },
  A1: { w: 2383.94, h: 1683.78, label: 'A1' },
  ARCHD: { w: 2592, h: 1728, label: 'ARCH D' },
};

export const CLASSES = ['downlight', 'gpo', 'switch', 'smoke detector', 'diffuser'];
const PLURAL = { downlight: 'downlights', gpo: 'GPOs (power outlets)', switch: 'light switches', 'smoke detector': 'smoke detectors', diffuser: 'air diffusers' };

/** The five scale notations plus the deliberately unanswerable NTS sheets. */
export const NOTATIONS = ['ratio', 'imperial', 'engineer', 'bar', 'dimension'];

const ROOM_NAMES = ['OFFICE 1', 'OFFICE 2', 'OFFICE 3', 'MEETING', 'STORE', 'KITCHEN', 'LOBBY', 'PLANT', 'WC', 'BED 1', 'BED 2', 'LIVING', 'STUDY', 'LAUNDRY', 'WORKSHOP', 'RECEPTION', 'SERVER', 'STAFF', 'PRINT', 'ARCHIVE'];

/** Symbol half-extent on paper (pt): 9 pt symbols at every scale. */
export const SYM_PT = 4.5;
/** Legend symbol centre sits this far (pt) left of the legend label's first glyph. */
export const LEGEND_OFFSET_PT = 12;

const snapTo = (v, g) => Math.round(v / g) * g;
const nearly = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/** Unit system constants: metric sheets in metres, imperial sheets in feet. */
function unitSystem(units, big) {
  if (units === 'm') {
    return {
      units, mPerUnit: 1, te: 0.2, ti: 0.1, door: 0.9, minRoom: 2.4, grid: 0.3, labelBand: 2.0,
      sizes: big ? [6.0, 7.2, 8.4, 9.6, 10.8, 12.0] : [3.0, 3.6, 4.2, 4.8, 5.4, 6.0],
      heights: big ? [12.0, 14.4, 16.8, 19.2, 24.0] : [6.0, 7.2, 8.4, 9.6, 10.8, 12.0],
      unitName: 'metres', areaUnit: 'm2', areaName: 'square metres', dimUnit: 'mm', lengthUnit: 'm',
    };
  }
  return {
    units, mPerUnit: 0.3048, te: 0.5, ti: 1 / 3, door: 3, minRoom: 8, grid: 1, labelBand: 6.5,
    sizes: big ? [20, 24, 28, 32, 36, 40] : [10, 12, 14, 16, 18, 20],
    heights: big ? [40, 48, 56, 64, 80] : [20, 24, 28, 32, 36, 40],
    unitName: 'feet', areaUnit: 'ft2', areaName: 'square feet', dimUnit: 'ft', lengthUnit: 'ft',
  };
}

/** Printed dimension text: millimetres on metric sheets, feet and inches on imperial ones. */
export function formatDim(v, units) {
  if (units === 'm') return String(Math.round(v * 1000));
  const totalIn = Math.round(v * 12);
  return `${Math.floor(totalIn / 12)}'-${totalIn % 12}"`;
}
/** The numeric value a reader gets from the printed text, in the sheet's dimUnit (mm or decimal ft). */
export function dimValue(v, units) {
  return units === 'm' ? Math.round(v * 1000) : Math.round(v * 12) / 12;
}

function cutRect(r, axis, g0, g1) {
  // split a wall rect by an opening [g0, g1] along axis ('x' or 'y')
  const lo = axis === 'x' ? r.x0 : r.y0;
  const hi = axis === 'x' ? r.x1 : r.y1;
  if (g1 <= lo || g0 >= hi) return [r];
  const out = [];
  if (g0 > lo) out.push(axis === 'x' ? { ...r, x1: g0 } : { ...r, y1: g0 });
  if (g1 < hi) out.push(axis === 'x' ? { ...r, x0: g1 } : { ...r, y0: g1 });
  return out;
}

function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function segHitsRect(a, b, r) {
  // Liang-Barsky clip test
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - r.x0], [dx, r.x1 - a.x], [-dy, a.y - r.y0], [dy, r.y1 - a.y]]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Build walls, rooms and dimension strings from a layout (all in model
 * units, building inside-face origin at 0,0). Pure, so revision B is the same
 * layout with a few parameters changed.
 */
export function buildGeometry(L) {
  const { te, ti, door, Hb } = L;
  const strips = [];
  let x = 0;
  for (const s of L.strips) {
    strips.push({ ...s, x0: x, x1: x + s.w });
    x += s.w + ti;
  }
  const Wb = x - ti;
  const walls = [];
  const rooms = [];
  const last = strips.length - 1;

  // exterior walls (south wall carries the entrance opening)
  walls.push({ kind: 'ext', side: 'north', x0: -te, y0: Hb, x1: Wb + te, y1: Hb + te });
  walls.push({ kind: 'ext', side: 'west', x0: -te, y0: -te, x1: 0, y1: Hb + te });
  walls.push({ kind: 'ext', side: 'east', x0: Wb, y0: -te, x1: Wb + te, y1: Hb + te });
  let south = [{ kind: 'ext', side: 'south', x0: -te, y0: -te, x1: Wb + te, y1: 0 }];
  for (const d of L.extDoors) south = south.flatMap((r) => cutRect(r, 'x', d.at, d.at + door));
  walls.push(...south);

  // strip partitions with door openings
  strips.forEach((s, i) => {
    if (i === last) return;
    let pieces = [{ kind: 'partition', p: i, x0: s.x1, y0: -te / 2, x1: s.x1 + ti, y1: Hb + te / 2 }];
    for (const d of L.stripDoors.filter((d) => d.p === i)) pieces = pieces.flatMap((r) => cutRect(r, 'y', d.at, d.at + door));
    walls.push(...pieces);
  });

  // rooms per strip, with horizontal partitions (one may be stepped)
  strips.forEach((s, si) => {
    const leftC = si === 0 ? -te / 2 : s.x0 - ti / 2;
    const rightC = si === last ? Wb + te / 2 : s.x1 + ti / 2;
    let y = 0;
    const rows = [];
    s.rows.forEach((h, ri) => {
      const y0 = y;
      const y1 = ri === s.rows.length - 1 ? Hb : y + h;
      rows.push({ y0, y1 });
      y = y1 + ti;
    });
    const stripRooms = rows.map((r, ri) => ({
      name: s.names[ri], strip: si, row: ri, x0: s.x0, x1: s.x1, y0: r.y0, y1: r.y1,
      poly: [{ x: s.x0, y: r.y0 }, { x: s.x1, y: r.y0 }, { x: s.x1, y: r.y1 }, { x: s.x0, y: r.y1 }],
      shape: 'rect', labelAt: { x: (s.x0 + s.x1) / 2, y: (r.y0 + r.y1) / 2 }, westExtent: r.y1 - r.y0,
    }));
    rows.forEach((r, ri) => {
      if (ri === rows.length - 1) return;
      const yp = r.y1 + ti / 2; // partition centreline
      const step = s.step && s.step.k === ri ? s.step : null;
      let pieces;
      if (step) {
        const { xm, d } = step;
        pieces = [
          { kind: 'partition', strip: si, k: ri, x0: leftC, y0: yp - ti / 2, x1: xm + ti / 2, y1: yp + ti / 2, piece: 'low' },
          { kind: 'partition', strip: si, k: ri, x0: xm - ti / 2, y0: yp - ti / 2, x1: xm + ti / 2, y1: yp + d + ti / 2, piece: 'riser' },
          { kind: 'partition', strip: si, k: ri, x0: xm - ti / 2, y0: yp + d - ti / 2, x1: rightC, y1: yp + d + ti / 2, piece: 'high' },
        ];
        const lo = stripRooms[ri];
        const hi = stripRooms[ri + 1];
        lo.poly = [
          { x: s.x0, y: lo.y0 }, { x: s.x1, y: lo.y0 }, { x: s.x1, y: yp + d - ti / 2 },
          { x: xm + ti / 2, y: yp + d - ti / 2 }, { x: xm + ti / 2, y: yp - ti / 2 }, { x: s.x0, y: yp - ti / 2 },
        ];
        lo.shape = 'L';
        lo.westExtent = yp - ti / 2 - lo.y0;
        lo.labelAt = { x: (s.x0 + s.x1) / 2, y: (lo.y0 + yp - ti / 2) / 2 };
        hi.poly = [
          { x: s.x0, y: yp + ti / 2 }, { x: xm - ti / 2, y: yp + ti / 2 }, { x: xm - ti / 2, y: yp + d + ti / 2 },
          { x: s.x1, y: yp + d + ti / 2 }, { x: s.x1, y: hi.y1 }, { x: s.x0, y: hi.y1 },
        ];
        hi.shape = 'L';
        hi.westExtent = hi.y1 - (yp + ti / 2);
        hi.labelAt = { x: (s.x0 + s.x1) / 2, y: (yp + d + ti / 2 + hi.y1) / 2 };
      } else {
        pieces = [{ kind: 'partition', strip: si, k: ri, x0: leftC, y0: yp - ti / 2, x1: rightC, y1: yp + ti / 2, piece: 'flat' }];
      }
      for (const dr of L.rowDoors.filter((d) => d.strip === si && d.k === ri)) {
        pieces = pieces.flatMap((r) => (r.piece === 'riser' ? [r] : cutRect(r, 'x', dr.at, dr.at + door)));
      }
      walls.push(...pieces);
    });
    rooms.push(...stripRooms);
  });
  for (const r of rooms) {
    r.area = polyArea(r.poly);
    r.perimeter = polyPerimeter(r.poly);
  }

  // which room holds each symbol
  const symbols = L.symbols.map((s) => ({ ...s, room: rooms.find((r) => pointInPoly(s, r.poly))?.name ?? null }));

  // dimension strings: a chain under the bottom row of each strip, a chain
  // along the west face of the first strip, and the overall sizes
  const dims = [];
  if (!L.nts) {
    for (const s of strips) {
      const room = rooms.find((r) => r.strip === strips.indexOf(s) && r.row === 0);
      dims.push({ side: 'south', chain: 1, a: { x: s.x0, y: 0 }, b: { x: s.x1, y: 0 }, value: s.x1 - s.x0, room: room.name });
    }
    for (const r of rooms.filter((r) => r.strip === 0)) {
      const yTop = r.shape === 'L' && r.row === 0 ? r.y0 + r.westExtent : r.y1;
      const yBot = r.shape === 'L' && r.row > 0 ? r.y1 - r.westExtent : r.y0;
      dims.push({ side: 'west', chain: 1, a: { x: 0, y: yBot }, b: { x: 0, y: yTop }, value: yTop - yBot, room: r.name });
    }
    dims.push({ side: 'south', chain: 2, a: { x: -te, y: 0 }, b: { x: Wb + te, y: 0 }, value: Wb + 2 * te, room: null });
    dims.push({ side: 'west', chain: 2, a: { x: 0, y: -te }, b: { x: 0, y: Hb + te }, value: Hb + 2 * te, room: null });
  }

  return { Wb, Hb, te, ti, door, strips, walls, rooms, symbols, dims };
}

/** Design one sheet: layout parameters, scale statement, symbols, questions and the revision B change set. */
export function designSheet(R, index, opts) {
  const { rand, randInt, pick, rng } = R;
  const id = `SDB-${String(index + 1).padStart(3, '0')}`;
  const kind = index < opts.vectorCount ? 'vector' : 'raster';
  const nts = rng() < opts.ntsShare;
  const notation = nts ? 'nts' : pick(NOTATIONS);
  let units;
  let ratio;
  let scaleNote = null;
  switch (notation) {
    case 'ratio':
      units = 'm';
      ratio = pick([50, 100, 200]);
      break;
    case 'imperial':
      units = 'ft';
      ratio = pick([48, 96]);
      scaleNote = ratio === 48 ? 'SCALE: 1/4" = 1\'-0"' : 'SCALE: 1/8" = 1\'-0"';
      break;
    case 'engineer':
      units = 'ft';
      ratio = pick([120, 240]);
      scaleNote = ratio === 120 ? 'SCALE: 1" = 10\'' : 'SCALE: 1" = 20\'';
      break;
    case 'bar':
      units = 'm';
      ratio = pick([50, 100, 200]);
      break;
    case 'dimension':
      units = rng() < 0.5 ? 'm' : 'ft';
      ratio = units === 'm' ? pick([50, 100, 200]) : pick([48, 96]);
      break;
    default: // nts
      units = rng() < 0.6 ? 'm' : 'ft';
      ratio = units === 'm' ? pick([50, 100, 200]) : pick([48, 96, 120]);
      scaleNote = 'SCALE: NTS';
  }
  const sheetKey = units === 'ft' ? pick(['ARCHD', 'ARCHD', 'A1', 'A3']) : pick(['A3', 'A3', 'A1', 'A1']);
  const sheet = SHEET_SIZES[sheetKey];
  if (notation === 'ratio') scaleNote = `SCALE 1:${ratio} @ ${sheet.label}`;
  const big = ratio >= 150;
  const U = unitSystem(units, big);
  const ptPerU = U.mPerUnit / (METERS_PER_PT * ratio);
  const rotated = rng() < opts.rotatedShare;
  const grid = rng() < 0.3;
  const recipe = kind === 'raster' ? pick(['blur', 'noise', 'contrast', 'rotate', 'photocopy']) : null;

  // sheet regions (pt): a title column at the right, the plan area to its left
  const titleW = Math.min(260, Math.round(sheet.w * 0.18));
  const frame = { x0: 18, y0: 18, x1: sheet.w - 18, y1: sheet.h - 18 };
  const plan = { x0: frame.x0, y0: frame.y0, x1: frame.x1 - titleW, y1: frame.y1 };
  const availW = (plan.x1 - plan.x0 - 170) / ptPerU; // room for the west dimension chains and margins
  const availH = (plan.y1 - plan.y0 - 150) / ptPerU;

  // strips and rows
  const nStrips = randInt(2, 3);
  const widths = [];
  let total = 0;
  for (let i = 0; i < nStrips; i++) {
    const room = availW * 0.92 - total - (nStrips - 1) * U.ti;
    const fits = U.sizes.filter((w) => w <= room - (nStrips - 1 - i) * U.sizes[0]);
    if (!fits.length) break;
    const w = pick(fits);
    widths.push(w);
    total += w;
  }
  while (widths.length < 2) widths.push(U.sizes[0]);
  const hFits = U.heights.filter((h) => h <= availH * 0.92);
  const Hb = hFits.length ? pick(hFits) : U.heights[0];
  const names = [...ROOM_NAMES];
  const takeName = () => names.splice(Math.floor(rng() * names.length), 1)[0];
  const strips = widths.map((w) => {
    const n = randInt(1, 3);
    const rows = [];
    let remaining = Hb;
    for (let k = 0; k < n - 1; k++) {
      const fits = U.sizes.filter((h) => h <= remaining - U.ti - U.minRoom);
      if (!fits.length) break;
      const h = pick(fits);
      rows.push(h);
      remaining -= h + U.ti;
    }
    rows.push(remaining);
    return { w, rows, names: rows.map(() => takeName()), step: null };
  });
  if (strips.reduce((n, s) => n + s.rows.length, 0) < 3) {
    // too few rooms: split the first strip in two
    const s = strips[0];
    const h = U.sizes.find((v) => v <= Hb - U.ti - U.minRoom) ?? Hb / 2;
    s.rows = [h, Hb - h - U.ti];
    s.names = [s.names[0], takeName()];
  }

  // one stepped partition (two L-shaped rooms) on about a third of the sheets
  const L = { units, ratio, te: U.te, ti: U.ti, door: U.door, minRoom: U.minRoom, Hb, nts, strips, stripDoors: [], rowDoors: [], extDoors: [], symbols: [] };
  let geo = buildGeometry(L);
  if (rng() < 0.35) {
    const cands = geo.strips.map((s, i) => ({ s, i })).filter(({ s }) => s.rows.length >= 2);
    if (cands.length) {
      const { s, i } = pick(cands);
      const k = randInt(0, s.rows.length - 2);
      const upper = s.rows[k + 1];
      const dMax = upper - U.labelBand - U.ti;
      const dChoices = [1, 2, 3, 4, 5].map((n) => n * U.grid * 2).filter((d) => d <= dMax);
      if (dChoices.length) {
        const xm = snapTo(s.x0 + s.w * rand(0.35, 0.65), U.grid);
        strips[i].step = { k, xm, d: pick(dChoices) };
        geo = buildGeometry(L);
      }
    }
  }

  // doors: openings between strips, between rows, and one entrance in the south wall
  const partitionDoorSpots = (p) => {
    const spots = [];
    for (let y = U.grid; y + U.door < Hb; y += U.grid) {
      const ok = [p, p + 1].every((si) =>
        geo.rooms.some((r) => r.strip === si && y - 0.6 * U.grid * 2 >= r.y0 && y + U.door + 0.6 * U.grid * 2 <= (r.shape === 'L' && r.row === 0 ? r.y0 + r.westExtent : r.y1)
          && (r.shape !== 'L' || r.row === 0 || y - 0.6 * U.grid * 2 >= r.y1 - r.westExtent)),
      );
      if (ok) spots.push(y);
    }
    return spots;
  };
  const rowDoorSpots = (si, k) => {
    // flat or low/high pieces of the partition between rows k and k+1 of strip si
    const pieces = geo.walls.filter((w) => w.kind === 'partition' && w.strip === si && w.k === k && w.piece !== 'riser');
    const s = geo.strips[si];
    const spots = [];
    for (const pc of pieces) {
      const lo = Math.max(pc.x0, s.x0) + (nearly(pc.x0, s.x0 - U.ti / 2) || pc.x0 < s.x0 ? (si === 0 ? 2 * U.grid : 5 * U.grid) : 3 * U.grid);
      const hi = Math.min(pc.x1, s.x1) - U.door - (nearly(pc.x1, s.x1 + U.ti / 2) || pc.x1 > s.x1 ? (si === geo.strips.length - 1 ? 2 * U.grid : 5 * U.grid) : 3 * U.grid);
      for (let x = snapTo(lo, U.grid); x <= hi; x += U.grid) spots.push(x);
    }
    return spots;
  };
  for (let p = 0; p < strips.length - 1; p++) {
    if (rng() < 0.7) {
      const spots = partitionDoorSpots(p);
      if (spots.length) L.stripDoors.push({ p, at: pick(spots) });
    }
  }
  strips.forEach((s, si) => {
    for (let k = 0; k < s.rows.length - 1; k++) {
      if (rng() < 0.6) {
        const spots = rowDoorSpots(si, k);
        if (spots.length) L.rowDoors.push({ strip: si, k, at: pick(spots) });
      }
    }
  });
  {
    const bottom = geo.rooms.filter((r) => r.row === 0);
    const r = pick(bottom);
    const spots = [];
    for (let x = snapTo(r.x0 + 2 * U.grid, U.grid); x + U.door <= r.x1 - 2 * U.grid; x += U.grid) spots.push(x);
    if (spots.length) L.extDoors.push({ at: pick(spots), room: r.name });
  }
  // every room gets at least one opening
  const roomDoors = (r) => {
    let n = 0;
    for (const d of L.stripDoors) if ((r.strip === d.p || r.strip === d.p + 1) && d.at >= r.y0 && d.at + U.door <= r.y1) n++;
    for (const d of L.rowDoors) if (d.strip === r.strip && (d.k === r.row || d.k === r.row - 1)) n++;
    for (const d of L.extDoors) if (r.row === 0 && d.at >= r.x0 && d.at + U.door <= r.x1) n++;
    return n;
  };
  for (const r of geo.rooms) {
    if (roomDoors(r) > 0) continue;
    const tries = [];
    if (r.row > 0) tries.push(() => rowDoorSpots(r.strip, r.row - 1).map((at) => ({ strip: r.strip, k: r.row - 1, at })));
    if (r.row < strips[r.strip].rows.length - 1) tries.push(() => rowDoorSpots(r.strip, r.row).map((at) => ({ strip: r.strip, k: r.row, at })));
    let placed = false;
    for (const t of tries) {
      const spots = t();
      if (spots.length) {
        L.rowDoors.push(pick(spots));
        placed = true;
        break;
      }
    }
    if (!placed) {
      for (const p of [r.strip - 1, r.strip]) {
        if (p < 0 || p >= strips.length - 1) continue;
        const spots = partitionDoorSpots(p).filter((y) => y >= r.y0 && y + U.door <= r.y1);
        if (spots.length) {
          L.stripDoors.push({ p, at: pick(spots) });
          placed = true;
          break;
        }
      }
    }
  }
  geo = buildGeometry(L);

  // symbols: 2 to 4 classes, placed clear of walls, labels and each other
  const nClasses = randInt(2, 4);
  const classes = shuffleV01(CLASSES, rng).slice(0, nClasses);
  const target = randInt(5, 40);
  const clearU = Math.max((SYM_PT + 7) / ptPerU, 0.7 * U.grid * 3); // clear of wall faces, incl. a 2-grid partition move
  const stripClearU = Math.max(clearU, 3 * U.grid + SYM_PT / ptPerU);
  const gapU = (2 * SYM_PT + 8) / ptPerU;
  const labelHalfW = (fontWidth('RECEPTION', 9) / 2 + 10) / ptPerU;
  const labelHalfH = 12 / ptPerU;
  const placed = [];
  const stripXs = geo.strips.slice(0, -1).map((s) => s.x1 + U.ti / 2);
  for (let attempt = 0; attempt < 4000 && placed.length < target; attempt++) {
    const room = pick(geo.rooms);
    const x = rand(room.x0 + clearU, room.x1 - clearU);
    const y = rand(room.y0 + clearU, room.y1 - clearU);
    const p = { x, y };
    if (!pointInPoly(p, room.poly)) continue;
    let ok = true;
    for (let i = 0; i < room.poly.length && ok; i++) {
      if (distToSegment(p, room.poly[i], room.poly[(i + 1) % room.poly.length]) < clearU) ok = false;
    }
    if (!ok) continue;
    if (stripXs.some((sx) => Math.abs(x - sx) < stripClearU)) continue;
    if (Math.abs(x - room.labelAt.x) < labelHalfW && Math.abs(y - room.labelAt.y) < labelHalfH) continue;
    if (placed.some((q) => Math.hypot(q.x - x, q.y - y) < gapU)) continue;
    placed.push({ cls: pick(classes), x, y });
  }
  // every listed class appears at least once
  for (const c of classes) if (!placed.some((s) => s.cls === c) && placed.length) placed[Math.floor(rng() * placed.length)].cls = c;
  L.symbols = placed;
  geo = buildGeometry(L);
  const legend = classes.filter((c) => placed.some((s) => s.cls === c));

  // revision B on a subset: 1 to 3 changes from a known menu
  let revB = null;
  if (rng() < opts.revBShare) {
    const changes = [];
    const LB = JSON.parse(JSON.stringify(L));
    const menu = shuffleV01(['wall moved', 'door added', 'symbol removed'], rng).slice(0, randInt(1, 3));
    for (const m of menu) {
      if (m === 'wall moved' && strips.length >= 2) {
        const p = randInt(0, strips.length - 2);
        const dx = pick([-2, 2]) * U.grid;
        if (LB.strips[p].w + dx >= U.minRoom && LB.strips[p + 1].w - dx >= U.minRoom) {
          LB.strips[p].w += dx;
          LB.strips[p + 1].w -= dx;
          // a stepped partition in the shrinking strip keeps its notch inside the strip
          const gB = buildGeometry(LB);
          const okStep = gB.strips.every((s) => !s.step || (s.step.xm > s.x0 + 2 * U.grid && s.step.xm < s.x1 - 2 * U.grid));
          const okDoors = LB.rowDoors.every((d) => {
            const s = gB.strips[d.strip];
            return d.at >= s.x0 + U.grid && d.at + U.door <= s.x1 - U.grid;
          });
          if (okStep && okDoors) {
            changes.push('wall moved');
            if (!nts) changes.push('dimension changed');
          } else {
            LB.strips[p].w -= dx;
            LB.strips[p + 1].w += dx;
          }
        }
      } else if (m === 'door added') {
        const gB = buildGeometry(LB);
        const cands = [];
        for (let p = 0; p < strips.length - 1; p++) {
          if (LB.stripDoors.some((d) => d.p === p)) continue;
          const spots = partitionDoorSpots(p);
          if (spots.length) cands.push(() => LB.stripDoors.push({ p, at: pick(spots) }));
        }
        gB.strips.forEach((s, si) => {
          for (let k = 0; k < s.rows.length - 1; k++) {
            if (LB.rowDoors.some((d) => d.strip === si && d.k === k)) continue;
            const spots = rowDoorSpots(si, k);
            if (spots.length) cands.push(() => LB.rowDoors.push({ strip: si, k, at: pick(spots) }));
          }
        });
        for (const r of gB.rooms.filter((r) => r.row === 0 && !LB.extDoors.some((d) => d.room === r.name))) {
          const spots = [];
          for (let x = snapTo(r.x0 + 2 * U.grid, U.grid); x + U.door <= r.x1 - 2 * U.grid; x += U.grid) spots.push(x);
          if (spots.length) cands.push(() => LB.extDoors.push({ at: pick(spots), room: r.name }));
        }
        if (cands.length) {
          pick(cands)();
          changes.push('door added');
        }
      } else if (m === 'symbol removed' && LB.symbols.length) {
        const i = randInt(0, LB.symbols.length - 1);
        const [gone] = LB.symbols.splice(i, 1);
        changes.push(`${gone.cls} removed`);
      }
    }
    if (changes.length) revB = { L: LB, changes: [...new Set(changes)].sort() };
  }

  const spec = {
    id, index, kind, notation, nts, units, ratio, scaleNote, sheetKey, sheet, rotated, grid, recipe, titleW, frame, plan, ptPerU, U, L, geo, legend, revB,
    bar: notation === 'bar' ? barFor(ratio, ptPerU, titleW) : null,
  };
  spec.questions = questionsFor(spec, R);
  return spec;
}

/** Graphic scale bar: the largest round length that fits the title column. */
function barFor(ratio, ptPerU, titleW) {
  const maxPt = titleW * 0.7;
  const n = [50, 20, 10, 5, 2, 1].find((v) => v * ptPerU <= maxPt) ?? 1;
  return { n, lengthPt: n * ptPerU, divisions: n === 1 ? 4 : 5 };
}

// Helvetica advance widths (per 1000 em) for the glyphs the sheets print, so
// text can be centred without the font object.
const HELV = { ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278, 0: 556, 1: 556, 2: 556, 3: 556, 4: 556, 5: 556, 6: 556, 7: 556, 8: 556, 9: 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500 };
export function fontWidth(text, size) {
  let w = 0;
  for (const ch of text) w += HELV[ch] ?? 600;
  return (w / 1000) * size;
}

/** Point of a symbol-free, wall-free spot inside a room polygon: its label centre (model units). */
export function labelPointPt(spec, room) {
  return toPt(spec, room.labelAt.x, room.labelAt.y);
}

/** Model units -> PDF points (building inside-face origin placed in the plan area). */
export function toPt(spec, xU, yU) {
  const { origin, ptPerU } = spec.placement ?? placeBuilding(spec);
  return { x: origin.x + xU * ptPerU, y: origin.y + yU * ptPerU };
}

export function placeBuilding(spec) {
  if (spec.placement) return spec.placement;
  const { plan, ptPerU, geo } = spec;
  const bw = (geo.Wb + 2 * geo.te) * ptPerU;
  const bh = (geo.Hb + 2 * geo.te) * ptPerU;
  const left = plan.x0 + 110; // west dimension chains
  const bottom = plan.y0 + 100; // south dimension chains
  const freeW = plan.x1 - 30 - left - bw;
  const freeH = plan.y1 - 40 - bottom - bh;
  const origin = { x: left + geo.te * ptPerU + Math.max(0, freeW) / 2, y: bottom + geo.te * ptPerU + Math.max(0, freeH) / 2 };
  spec.placement = { origin, ptPerU };
  return spec.placement;
}

// ---------- questions ----------

function questionsFor(spec, R) {
  const { pick, rng } = R;
  const { id, geo, U, nts, units, ratio } = spec;
  const qs = [];
  let n = 0;
  const q = (type, question, answer, unit, tolerance, provenance) => {
    n++;
    qs.push({ id: `${id}-q${String(n).padStart(2, '0')}`, sheet: id, page: 1, type, question, answer, unit, tolerance, provenance });
  };
  const UNANS = 'unanswerable';
  const scaleHow = units === 'm' ? 'for example 100 for 1:100' : 'for example 48 for 1/4" = 1\'-0" and 240 for 1" = 20\'';
  q('scale', `What is the drawing scale of sheet ${id}? Give the ratio as the N in 1:N (${scaleHow}).`, nts ? UNANS : ratio, 'ratio', 0.02, {
    notation: spec.notation, stated: spec.scaleNote ?? (spec.notation === 'bar' ? 'graphic scale bar only' : 'printed dimensions only'),
  });

  // lengths: two of the three candidates
  const lengthCands = [
    () => q('length', `What is the overall length of the north external wall of the building on sheet ${id}, measured along its outside face, in ${U.unitName}?`, nts ? UNANS : round(geo.Wb + 2 * geo.te), U.lengthUnit, 0.02, { wall: 'north external', face: 'outside' }),
    () => q('length', `What is the overall length of the east external wall of the building on sheet ${id}, measured along its outside face, in ${U.unitName}?`, nts ? UNANS : round(geo.Hb + 2 * geo.te), U.lengthUnit, 0.02, { wall: 'east external', face: 'outside' }),
  ];
  const pairs = [];
  for (let p = 0; p < geo.strips.length - 1; p++) {
    for (const a of geo.rooms.filter((r) => r.strip === p)) {
      for (const b of geo.rooms.filter((r) => r.strip === p + 1)) {
        // the ray between the labels, and rays a few points above and below it,
        // must all cross this partition and nothing else (a door opening at
        // label height would let a reader's ray slip through)
        const margin = 4 / spec.ptPerU;
        const ok = [-margin, 0, margin].every((dy) => {
          const A = { x: a.labelAt.x, y: a.labelAt.y + dy };
          const B = { x: b.labelAt.x, y: b.labelAt.y + dy };
          const crossed = geo.walls.filter((w) => segHitsRect(A, B, w));
          return crossed.length && crossed.every((w) => w.kind === 'partition' && w.p === p);
        });
        if (ok) pairs.push({ a, b, p });
      }
    }
  }
  if (pairs.length) {
    const { a, b, p } = pick(pairs);
    lengthCands.push(() =>
      q('length', `What is the centreline length of the partition wall between ${a.name} and ${b.name} on sheet ${id}, measured from the centreline of the south external wall to the centreline of the north external wall and including any door opening, in ${U.unitName}?`, nts ? UNANS : round(geo.Hb + geo.te), U.lengthUnit, 0.02, {
        wall: `partition ${p}`, between: [a.name, b.name], centrelineXU: geo.strips[p].x1 + geo.ti / 2,
      }),
    );
  }
  shuffleV01(lengthCands, rng).slice(0, 2).forEach((f) => f());

  // areas: two or three rooms, L-shaped ones first
  const rooms = shuffleV01(geo.rooms, rng);
  const areaRooms = [...rooms.filter((r) => r.shape === 'L'), ...rooms.filter((r) => r.shape !== 'L')].slice(0, Math.min(rooms.length, 2 + (rng() < 0.5 ? 1 : 0)));
  for (const r of areaRooms) {
    q('area', `What is the floor area of ${r.name} on sheet ${id}, in ${U.areaName}, measured between the inside faces of its walls?`, nts ? UNANS : round(r.area), U.areaUnit, 0.02, {
      room: r.name, shape: r.shape, polygonU: r.poly.map((p) => [round(p.x), round(p.y)]), labelAtU: [round(r.labelAt.x), round(r.labelAt.y)],
    });
  }
  const pr = pick(rooms);
  q('perimeter', `What is the internal perimeter of ${pr.name} on sheet ${id}, in ${U.unitName}, measured along the inside faces of its walls and ignoring door openings?`, nts ? UNANS : round(pr.perimeter), U.lengthUnit, 0.02, {
    room: pr.name, shape: pr.shape, polygonU: pr.poly.map((p) => [round(p.x), round(p.y)]),
  });

  // counts: sheet-wide for one or two classes, one room count
  const classes = shuffleV01(spec.legend, rng);
  for (const c of classes.slice(0, Math.min(classes.length, 1 + (rng() < 0.6 ? 1 : 0)))) {
    const total = geo.symbols.filter((s) => s.cls === c).length;
    q('count', `How many ${PLURAL[c]} are shown on the plan of sheet ${id}? Count every instance on the drawing and do not count the legend symbol.`, total, 'count', 0, {
      class: c, centresU: geo.symbols.filter((s) => s.cls === c).map((s) => [round(s.x), round(s.y)]),
    });
  }
  {
    const withSyms = geo.rooms.filter((r) => geo.symbols.some((s) => s.room === r.name));
    const r = withSyms.length ? pick(withSyms) : pick(geo.rooms);
    const present = classes.filter((c) => geo.symbols.some((s) => s.room === r.name && s.cls === c));
    const c = present.length ? pick(present) : pick(classes);
    const cnt = geo.symbols.filter((s) => s.room === r.name && s.cls === c).length;
    q('count', `How many ${PLURAL[c]} are in ${r.name} on sheet ${id}?`, cnt, 'count', 0, { class: c, room: r.name });
  }

  // one printed dimension to read
  {
    const south = geo.dims.filter((d) => d.side === 'south' && d.chain === 1);
    const west = geo.dims.filter((d) => d.side === 'west' && d.chain === 1);
    const useWest = west.length && rng() < 0.3;
    const dimUnitHow = units === 'm' ? 'millimetres, as printed' : 'decimal feet (12\'-6" is 12.5)';
    if (nts) {
      const r = pick(geo.rooms);
      const side = rng() < 0.7 ? 'directly below (south of)' : 'to the left of (west of)';
      q('dimension_read', `What dimension is printed on the dimension string ${side} ${r.name} on sheet ${id}? Give the printed value in ${dimUnitHow}.`, UNANS, U.dimUnit, 0.005, { room: r.name, note: 'no dimensions are printed on this sheet' });
    } else {
      const d = useWest ? pick(west) : pick(south);
      const side = useWest ? 'to the left of (west of)' : 'directly below (south of)';
      q('dimension_read', `What dimension is printed on the dimension string ${side} ${d.room} on sheet ${id}? Give the printed value in ${dimUnitHow}.`, dimValue(d.value, units), U.dimUnit, 0.005, {
        room: d.room, side: d.side, printed: formatDim(d.value, units),
      });
    }
  }

  if (spec.revB) {
    q('compare', `Sheet ${id} has a revision B (file ${id}-revB.pdf). Which changes does revision B make compared with revision A? Answer with a list of items drawn from: "wall moved", "door added", "dimension changed", and "<symbol> removed" where <symbol> is one of downlight, gpo, switch, smoke detector, diffuser. List each kind of change once.`, spec.revB.changes, 'set', null, {
      changes: spec.revB.changes,
    });
  }
  return qs;
}

const round = (v) => Math.round(v * 1e4) / 1e4;

// ---------- drawing ----------

/**
 * Draw a sheet (revision A, or revision B when `rev` is 'B') as a vector PDF.
 * Returns the PDF bytes.
 */
export async function drawSheet(spec, rev = 'A') {
  const L = rev === 'B' ? spec.revB.L : spec.L;
  const geo = rev === 'B' ? buildGeometry(L) : spec.geo;
  const { sheet, frame, plan, titleW, ptPerU, U, units } = spec;
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date('2026-10-18T00:00:00Z'));
  doc.setModificationDate(new Date('2026-10-18T00:00:00Z'));
  doc.setProducer('ScaledDrawingBench generator');
  doc.setCreator('pdf2takeoff scripts/scaled-drawing-bench.mjs');
  doc.setTitle(`${spec.id} REV ${rev}`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([sheet.w, sheet.h]);
  const { origin } = placeBuilding(spec);
  const P = (xU, yU) => ({ x: origin.x + xU * ptPerU, y: origin.y + yU * ptPerU });
  const text = (str, x, y, size, opts = {}) => page.drawText(str, { x, y, size, font: opts.bold ? bold : font, color: opts.color ?? DARK, ...(opts.rotate ? { rotate: degrees(opts.rotate) } : {}) });
  const centred = (str, cx, y, size, opts = {}) => text(str, cx - fontWidth(str, size) / 2, y, size, opts);

  // frame and title column separator
  page.drawRectangle({ x: frame.x0, y: frame.y0, width: frame.x1 - frame.x0, height: frame.y1 - frame.y0, borderColor: DARK, borderWidth: 0.8 });
  page.drawLine({ start: { x: plan.x1, y: frame.y0 }, end: { x: plan.x1, y: frame.y1 }, thickness: 0.8, color: DARK });

  // faint grid inside the building on some sheets
  if (spec.grid) {
    const step = U.grid * (units === 'm' ? (spec.ratio >= 150 ? 10 : 4) : (spec.ratio >= 150 ? 10 : 4));
    for (let x = 0; x <= geo.Wb + 1e-9; x += step) page.drawLine({ start: P(x, 0), end: P(x, geo.Hb), thickness: 0.3, color: GRID });
    for (let y = 0; y <= geo.Hb + 1e-9; y += step) page.drawLine({ start: P(0, y), end: P(geo.Wb, y), thickness: 0.3, color: GRID });
  }

  // walls as filled rectangles
  for (const w of geo.walls) {
    const a = P(w.x0, w.y0);
    const b = P(w.x1, w.y1);
    page.drawRectangle({ x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y, color: BLACK });
  }

  // room labels
  for (const r of geo.rooms) {
    const c = P(r.labelAt.x, r.labelAt.y);
    centred(r.name, c.x, c.y - 3.2, 9, { bold: true, color: GREY });
  }

  // symbols
  for (const s of geo.symbols) {
    const c = P(s.x, s.y);
    drawSymbol(page, s.cls, c.x, c.y);
  }

  // dimension strings
  const tick = 3.5;
  const dimLine = (a, b, label, vertical) => {
    page.drawLine({ start: a, end: b, thickness: 0.5, color: GREY });
    for (const p of [a, b]) page.drawLine({ start: { x: p.x - tick, y: p.y - tick }, end: { x: p.x + tick, y: p.y + tick }, thickness: 0.6, color: GREY });
    if (vertical) {
      const mid = (a.y + b.y) / 2;
      text(label, a.x - 3, mid - fontWidth(label, 7) / 2, 7, { rotate: 90, color: DARK });
    } else {
      centred(label, (a.x + b.x) / 2, a.y + 3, 7, { color: DARK });
    }
  };
  for (const d of geo.dims) {
    const label = formatDim(d.value, units);
    if (d.side === 'south') {
      const y = origin.y - geo.te * ptPerU - (d.chain === 1 ? 22 : 46);
      const a = { x: P(d.a.x, 0).x, y };
      const b = { x: P(d.b.x, 0).x, y };
      // extension lines stop short of the wall ink
      for (const p of [a, b]) page.drawLine({ start: { x: p.x, y: y - 4 }, end: { x: p.x, y: origin.y - geo.te * ptPerU - 6 }, thickness: 0.3, color: GREY });
      dimLine(a, b, label, false);
    } else {
      const x = origin.x - geo.te * ptPerU - (d.chain === 1 ? 22 : 46);
      const a = { x, y: P(0, d.a.y).y };
      const b = { x, y: P(0, d.b.y).y };
      for (const p of [a, b]) page.drawLine({ start: { x: x - 4, y: p.y }, end: { x: origin.x - geo.te * ptPerU - 6, y: p.y }, thickness: 0.3, color: GREY });
      dimLine(a, b, label, true);
    }
  }

  // ---- title column: north arrow, legend, scale bar, title block ----
  const cx = plan.x1 + titleW / 2;
  let y = frame.y1 - 40;
  page.drawCircle({ x: cx, y, size: 13, borderColor: GREY, borderWidth: 1 });
  page.drawLine({ start: { x: cx, y: y - 9 }, end: { x: cx, y: y + 9 }, thickness: 1.4, color: DARK });
  page.drawLine({ start: { x: cx, y: y + 9 }, end: { x: cx - 3.5, y: y + 3 }, thickness: 1.1, color: DARK });
  centred('N', cx, y + 17, 8, { bold: true, color: GREY });
  y -= 48;

  text('LEGEND', plan.x1 + 14, y, 9, { bold: true });
  y -= 7;
  for (const cls of spec.legend) {
    y -= 18;
    const labelX = plan.x1 + 14 + LEGEND_OFFSET_PT;
    drawSymbol(page, cls, labelX - LEGEND_OFFSET_PT, y + 3);
    text(cls.toUpperCase(), labelX, y, 8);
  }
  y -= 30;

  if (spec.bar) {
    const { n, lengthPt, divisions } = spec.bar;
    const x0 = cx - lengthPt / 2;
    const seg = lengthPt / divisions;
    for (let i = 0; i < divisions; i++) {
      page.drawRectangle({ x: x0 + i * seg, y, width: seg, height: 5, color: i % 2 === 0 ? DARK : WHITE, borderColor: DARK, borderWidth: 0.5 });
    }
    centred('0', x0, y + 8, 7);
    if (divisions === 5) centred(String(n / 2), x0 + lengthPt / 2, y + 8, 7);
    centred(String(n), x0 + lengthPt, y + 8, 7);
    centred(units === 'm' ? 'METRES' : 'FEET', cx, y - 10, 7, { color: GREY });
    y -= 36;
  }

  // title block at the foot of the column
  const tbH = 150;
  const tb = { x: plan.x1, y: frame.y0, w: titleW, h: tbH };
  page.drawLine({ start: { x: tb.x, y: tb.y + tb.h }, end: { x: tb.x + tb.w, y: tb.y + tb.h }, thickness: 0.8, color: DARK });
  const rows = [
    ['ScaledDrawingBench v0.1', true, 9],
    [`PROJECT SDB-${spec.seedTag ?? 'SEED'}`, false, 8],
    ['GROUND FLOOR PLAN', true, 9],
    [`SHEET ${spec.id}    REV ${rev}`, false, 8],
    [spec.scaleNote ?? (spec.notation === 'bar' ? 'SEE GRAPHIC SCALE' : 'REFER TO PRINTED DIMENSIONS'), true, 8.5],
    [units === 'm' ? 'DIMENSIONS IN MILLIMETRES' : 'DIMENSIONS IN FEET AND INCHES', false, 7.5],
    ['DATE 2026-10-18    SIZE ' + spec.sheet.label, false, 7.5],
    ['Synthetic drawing. Data CC BY 4.0', false, 7],
  ];
  let ty = tb.y + tb.h - 18;
  for (const [str, b, size] of rows) {
    text(str, tb.x + 10, ty, size, { bold: b, color: b ? DARK : GREY });
    ty -= 18;
    if (str.startsWith('SHEET')) page.drawLine({ start: { x: tb.x, y: ty + 12 }, end: { x: tb.x + tb.w, y: ty + 12 }, thickness: 0.5, color: GREY });
  }

  if (spec.rotated) page.setRotation(degrees(90));
  return doc.save({ useObjectStreams: false });
}

/**
 * A thin filled quad from (x1,y1) to (y2,y2): the inner strokes of a symbol.
 * Filled, not stroked, so a symbol's stroke ends never read as free wall
 * ends to the vector doorway bridging (fill-vector.ts), which only pairs
 * stroked segments; the scan tiers see the same geometry and pixels.
 */
function bar(page, x1, y1, x2, y2, width = 0.7) {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const nx = (-(y2 - y1) / len) * (width / 2);
  const ny = ((x2 - x1) / len) * (width / 2);
  const dx = x2 - x1;
  const dy = y2 - y1;
  // drawSvgPath takes SVG coordinates (y down) relative to x,y
  const p = (px, py) => `${px.toFixed(3)} ${(-py).toFixed(3)}`;
  page.drawSvgPath(`M ${p(nx, ny)} L ${p(dx + nx, dy + ny)} L ${p(dx - nx, dy - ny)} L ${p(-nx, -ny)} Z`, { x: x1, y: y1, color: BLACK, borderWidth: 0 });
}

/** One symbol instance at paper size, drawn as consecutive paths that touch (one connected component). */
export function drawSymbol(page, cls, x, y) {
  const s = SYM_PT;
  const stroke = { borderColor: BLACK, borderWidth: 0.8 };
  switch (cls) {
    case 'downlight':
      page.drawCircle({ x, y, size: s, ...stroke, color: WHITE });
      bar(page, x - s, y, x + s, y);
      bar(page, x, y - s, x, y + s);
      break;
    case 'gpo':
      // rectangle with a solid centre dot touching its long sides (no free stroke ends)
      page.drawRectangle({ x: x - s, y: y - 0.7 * s, width: 2 * s, height: 1.4 * s, ...stroke, color: WHITE });
      page.drawCircle({ x, y, size: 0.7 * s, color: BLACK });
      break;
    case 'switch':
      page.drawSvgPath(`M ${-s} ${0.8 * s} L ${s} ${0.8 * s} L 0 ${-s} Z`, { x, y, color: BLACK, borderWidth: 0 });
      break;
    case 'smoke detector':
      // circle with an inscribed diamond whose corners sit on the circle's curve anchors
      page.drawCircle({ x, y, size: s, ...stroke, color: WHITE });
      page.drawSvgPath(`M ${-s} 0 L 0 ${-s} L ${s} 0 L 0 ${s} Z`, { x, y, borderColor: BLACK, borderWidth: 0.7 });
      break;
    case 'diffuser':
      page.drawRectangle({ x: x - 0.85 * s, y: y - 0.85 * s, width: 1.7 * s, height: 1.7 * s, ...stroke, color: WHITE });
      bar(page, x - 0.85 * s, y - 0.85 * s, x + 0.85 * s, y + 0.85 * s);
      bar(page, x - 0.85 * s, y + 0.85 * s, x + 0.85 * s, y - 0.85 * s);
      break;
  }
}

export { pointInPoly, segHitsRect, PLURAL };
