// Scan entry point: picks the best available provider.
//   tier 0  scan-vector.ts — exact match on the page's vector paths
//   tier 1  scan-cv.ts    — classic CV template match, always available
//   tier 2  scan-onnx.ts  — trained symbol detector (host-loaded ONNX)
// Tier 0 answers when the click lands on a vector symbol that repeats; a
// scanned sheet, a symbol drawn as an image or a one-off falls through to
// the raster tiers. Tier 2 runs only when the host supplies a detector
// session; any failure falls back to tier 1 in the same call, so scanning
// never hard-fails because of a missing or broken model.
//
// Teach once, count every sheet: teachSymbol() runs the same tiers from a
// click and also returns what the answering tier learned (a SymbolTemplate);
// countTemplate() counts that symbol on any page without a click.

import type { Pt, ScanHit, ScanResult } from './types.ts';
import { RASTER_SCALE, type ScanDeps } from './ports.ts';
import { cvTemplate, matchCvTemplate, type CvTemplate } from './scan-cv.ts';
import { detectorTemplate, matchDetectorTemplate, type DetectorTemplate } from './scan-onnx.ts';
import { matchVectorTemplate, vectorTemplate, type VectorTemplate } from './scan-vector.ts';

/** A symbol taught on one page, tagged by the tier that learned it. */
export type SymbolTemplate =
  | { tier: 'vector'; vector: VectorTemplate }
  | { tier: 'cv'; cv: CvTemplate }
  | { tier: 'detector'; detector: DetectorTemplate; note: string };

export async function scanForSimilar(pageNum: number, clicked: Pt, deps: ScanDeps): Promise<ScanResult> {
  const taught = await teachSymbol(pageNum, clicked, deps);
  return 'error' in taught ? taught : taught.result;
}

/** Scan from a click, keeping the template of whichever tier answered.
 *  The vector tier answers once the clicked symbol has `minVectorHits`
 *  copies on the page: 2 for a single-sheet scan (a lone match may be a
 *  stray line beside a raster symbol), 1 when teaching a symbol drawn once
 *  per sheet (a north point, a title block) to count across sheets. */
export async function teachSymbol(
  pageNum: number,
  clicked: Pt,
  deps: ScanDeps,
  minVectorHits = 2,
): Promise<{ template: SymbolTemplate; result: Extract<ScanResult, { hits: ScanHit[] }> } | { error: string }> {
  if (deps.vectors) {
    try {
      const page = await deps.vectors(pageNum);
      const taught = page && vectorTemplate(page, clicked);
      if (taught && 'hits' in taught && taught.hits.length >= minVectorHits) {
        return { template: { tier: 'vector', vector: taught.template }, result: { hits: taught.hits, provider: 'vector' } };
      }
    } catch (err) {
      deps.warn?.(`vector scan failed, falling back to raster: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const detector = await deps.detector();
  const raster = await deps.renderRaster(pageNum, RASTER_SCALE);
  if (detector) {
    try {
      const taught = await detectorTemplate(raster, clicked, detector);
      if ('error' in taught) return taught;
      const note = `${taught.template.label} · ${detector.modelName}`;
      return {
        template: { tier: 'detector', detector: taught.template, note },
        result: { hits: taught.hits, provider: 'detector', note },
      };
    } catch (err) {
      deps.warn?.(`tier-2 scan failed, falling back to CV: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const taught = cvTemplate(raster, clicked);
  if ('error' in taught) return taught;
  return {
    template: { tier: 'cv', cv: taught.template },
    result: { hits: taught.hits, provider: 'cv', templatePx: taught.template.px },
  };
}

/** Count a taught symbol on a page, with the tier that taught it. A page
 *  the tier can't read (no vector paths, a detector gone missing) counts
 *  nothing rather than guessing with another tier's idea of the symbol. */
export async function countTemplate(pageNum: number, template: SymbolTemplate, deps: ScanDeps): Promise<ScanResult> {
  if (template.tier === 'vector') {
    const page = deps.vectors ? await deps.vectors(pageNum) : null;
    if (!page) return { error: 'no vector paths for this page' };
    return { hits: matchVectorTemplate(page, template.vector), provider: 'vector' };
  }
  const raster = await deps.renderRaster(pageNum, RASTER_SCALE);
  if (template.tier === 'detector') {
    const detector = await deps.detector();
    if (!detector) return { error: 'the detector that taught this symbol is not available' };
    return { hits: await matchDetectorTemplate(raster, template.detector, detector), provider: 'detector', note: template.note };
  }
  return { hits: matchCvTemplate(raster, template.cv), provider: 'cv', templatePx: template.cv.px };
}
