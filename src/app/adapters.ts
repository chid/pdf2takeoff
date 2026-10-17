// Host wiring for the engine's scan port: the page's vector paths, pdf.js
// rasterization and the optional ONNX detector, all browser-side.

import * as pdfjsLib from 'pdfjs-dist';
import type { ScanDeps } from '../engine/ports';
import { vectorPage } from '../engine/scan-vector';
import { renderRaster } from './raster';
import { detectorStatus } from './onnx-detector';
import { getPdfDoc } from './viewer';

export const scanDeps: ScanDeps = {
  async vectors(pageNum) {
    const doc = getPdfDoc();
    if (!doc) return null;
    const page = await doc.getPage(pageNum);
    // annotations left out, so earlier count markups never teach the scan
    const ops = await page.getOperatorList({ annotationMode: pdfjsLib.AnnotationMode.DISABLE });
    return vectorPage(page.view, ops, pdfjsLib.OPS);
  },
  renderRaster,
  detector: detectorStatus,
  warn: (message) => console.warn(message),
};
