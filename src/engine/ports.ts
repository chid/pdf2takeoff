// Environment ports: the only seams between the engine and its host.
//
// The engine never touches a DOM, a bundler or a network — the host (browser
// app today, Node CLI/MCP next) supplies implementations:
//   RasterPage    — a rendered page as pixels + coordinate transforms
//   DetectorSession — a loaded ONNX symbol detector
//   VectorPage    — a page's vector paths and text (from scan-vector.ts)
//   ScanDeps      — everything the scan dispatcher needs from the host
//
// Coordinate conventions (public API, everywhere):
//   • PDF user space: points, origin bottom-left (what annotations store)
//   • Raster space: pixels, origin top-left of the rendered image
//   • RasterPage.toPdf/toRaster are the only place the two meet, so hosts
//     with page rotation keep exact fidelity by delegating to their renderer.

import type { Pt } from './types.ts';
import type { VectorPage } from './scan-vector.ts';

/** Raster scale (px per PDF point) both scan tiers render at. */
export const RASTER_SCALE = 3;

export interface RasterPage {
  width: number; // px
  height: number; // px
  /** RGBA, row-major, 4 bytes/px, top-left origin. */
  data: Uint8ClampedArray | Uint8Array;
  /** Raster px → PDF user space (origin bottom-left). */
  toPdf(x: number, y: number): Pt;
  /** PDF user space → raster px. */
  toRaster(x: number, y: number): Pt;
}

export interface DetectorSession {
  /** Square model input size, e.g. 416. */
  inputSize: number;
  /** Index → class name. */
  classes: string[];
  /** Score threshold 0..1. */
  score: number;
  /** Per-class NMS IoU threshold 0..1. */
  iou: number;
  /**
   * 'yolox-raw': output rows are [x1,y1,x2,y2,obj,cls...] and the score is
   * obj * cls (official YOLOX export). 'mmdet': scores are already combined,
   * obj column is ~1.
   */
  head: 'yolox-raw' | 'mmdet';
  /** Manifest model file name, surfaced in scan notes. */
  modelName: string;
  /** Run one [1,3,size,size] float input; return the raw output tensor. */
  run(input: Float32Array, size: number): Promise<{ data: Float32Array; dims: number[] }>;
}

export interface ScanDeps {
  renderRaster(pageNum: number, scale: number): Promise<RasterPage>;
  /** null when no trained model is available — tier-1 CV runs instead. */
  detector(): Promise<DetectorSession | null>;
  /** The page's vector paths for the exact tier; omit when the host can't
   *  supply them (the raster tiers then run alone). */
  vectors?(pageNum: number): Promise<VectorPage | null>;
  /** Optional sink for recoverable tier-2 failures (host decides logging). */
  warn?(message: string): void;
}
