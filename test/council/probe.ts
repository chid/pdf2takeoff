// Child process for the council suite: render each page the way `scan` does
// and run the CV scan from a few ink points, then the vector scan from the
// same click, printing one JSON line per page.
// Isolated in its own process so a native crash surfaces as a signal.
//
//   node --experimental-strip-types test/council/probe.ts <file.pdf> <pages>

import { readFileSync } from 'node:fs';
import { openPdf, vectorPageNode } from '../../src/headless/pdfjs-node.ts';
import { renderRasterNode } from '../../src/headless/raster-node.ts';
import { RASTER_SCALE } from '../../src/engine/ports.ts';
import { cvScan } from '../../src/engine/scan-cv.ts';
import { vectorScan } from '../../src/engine/scan-vector.ts';
import { parsePages } from './pages.ts';

const [file, pagesArg] = process.argv.slice(2);
const doc = await openPdf(new Uint8Array(readFileSync(file)));

for (const page of parsePages(pagesArg, doc.numPages)) {
  const t0 = performance.now();
  const pdfPage = await doc.getPage(page);
  const [vx0, vy0, vx1, vy1] = pdfPage.view as number[];
  const raster = await renderRasterNode(doc, page, RASTER_SCALE);
  const renderMs = performance.now() - t0;

  const isInk = (i: number) =>
    (raster.data[i * 4] * 299 + raster.data[i * 4 + 1] * 587 + raster.data[i * 4 + 2] * 114) / 1000 < 150;
  const px = raster.width * raster.height;
  let ink = 0;
  for (let i = 0; i < px; i++) if (isInk(i)) ink++;

  // click evenly spaced ink pixels (reading order); keep the first click
  // that teaches the scan a real symbol (not a dot) with several instances
  const CANDIDATES = 25;
  const MIN_TEMPLATE_PX = 40;
  const picks: number[] = [];
  for (let i = 0, seen = 0, next = 1; i < px && picks.length < CANDIDATES; i++) {
    if (!isInk(i)) continue;
    seen++;
    if (seen >= (next * ink) / (CANDIDATES + 1)) {
      picks.push(i);
      next++;
    }
  }
  let scan: Record<string, unknown> | null = null;
  let attempts = 0;
  for (const i of picks) {
    const at = raster.toPdf(i % raster.width, Math.floor(i / raster.width));
    attempts++;
    const res = cvScan(raster, at);
    if ('error' in res || res.hits.length < 2 || (res.templatePx ?? 0) < MIN_TEMPLATE_PX) continue;
    // every hit must land on the page, and map back inside the raster
    const offPage = res.hits.filter((h) => h.x < vx0 - 1 || h.x > vx1 + 1 || h.y < vy0 - 1 || h.y > vy1 + 1).length;
    const offRaster = res.hits.filter((h) => {
      const r = raster.toRaster(h.x, h.y);
      return r.x < 0 || r.y < 0 || r.x >= raster.width || r.y >= raster.height;
    }).length;
    // the clicked symbol matches itself, so one hit (its centroid) sits
    // within the template's extent of the click — checked by the test
    const nearest = Math.min(...res.hits.map((h) => Math.hypot(h.x - at.x, h.y - at.y)));
    scan = { at: [at.x, at.y], hits: res.hits.length, templatePx: res.templatePx, offPage, offRaster, nearestPt: nearest };
    break;
  }

  // the vector tier from the same click, where there was one
  let vector: Record<string, unknown> | null = null;
  if (scan) {
    const v0 = performance.now();
    const res = vectorScan(await vectorPageNode(doc, page), { x: (scan.at as number[])[0], y: (scan.at as number[])[1] });
    vector = 'error' in res
      ? { error: res.error }
      : {
          hits: res.hits.length,
          offPage: res.hits.filter((h) => h.x < vx0 - 1 || h.x > vx1 + 1 || h.y < vy0 - 1 || h.y > vy1 + 1).length,
          ms: Math.round(performance.now() - v0),
        };
  }

  console.log(
    JSON.stringify({
      page,
      rotate: pdfPage.rotate,
      view: [vx0, vy0, vx1, vy1],
      raster: [raster.width, raster.height],
      inkFraction: ink / (raster.width * raster.height),
      renderMs: Math.round(renderMs),
      totalMs: Math.round(performance.now() - t0),
      attempts,
      scan,
      vector,
    }),
  );
}
