// Core data types shared by every pdf2takeoff surface (web app, CLI, MCP).
// Pure data — no environment dependencies.

export type Pt = { x: number; y: number };

export type MarkupType = 'length' | 'area' | 'count' | 'perimeter' | 'volume' | 'angle' | 'note';

export interface Markup {
  id: string;
  page: number; // 1-based
  type: MarkupType;
  label: string;
  points: Pt[]; // PDF user space (origin bottom-left)
  createdAt: number;
  /** Volume only: the extrusion depth in metres. */
  depth?: number;
  /** Review status: 'check' = needs verification, 'confirmed' = verified. */
  status?: 'check' | 'confirmed';
  /** Layer name; absent = the default layer. */
  layer?: string;
}

export interface Calibration {
  metersPerPt: number;
  source: string; // e.g. 'measured 12.00 m' or 'preset 1:100'
}

export interface ScanHit {
  x: number; // centre, PDF points
  y: number;
  label?: string; // class name when the provider knows it
  score?: number; // match/confidence 0..1
  /** Vector tier: 'exact' traces the taught path; 'near' matched its
   *  outline and ink only (re-tessellated or scaled), worth a check. */
  match?: 'exact' | 'near';
  /** Vector tier, near hits: size relative to the taught symbol. */
  scale?: number;
}

export type ScanResult =
  | { hits: ScanHit[]; provider: 'vector' | 'cv' | 'detector'; templatePx?: number; note?: string }
  | { error: string };
