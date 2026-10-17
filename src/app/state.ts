// Central application state with a tiny subscribe/emit store. Measurement
// math and data types live in the engine (src/engine); this module re-exports
// them so UI modules have one familiar import site.

import type { DisplayUnit } from '../engine/units';
import type { Calibration, Markup, MarkupType, Pt } from '../engine/types';
import type { Viewport } from '../engine/viewports';
import { resolveCalibration } from '../engine/viewports';
import type { CustomColumn, TakeoffData } from '../engine/export';

export type { Calibration, Markup, MarkupType, Pt };
export { markupLength, markupArea, distPt, defaultLabel, nextId } from '../engine/geometry';

export type ToolId = 'pan' | 'calibrate' | 'viewport' | 'length' | 'area' | 'count' | 'perimeter' | 'volume' | 'angle' | 'note' | 'fill' | 'scan' | 'runs';

export interface ToolPreset {
  type: MarkupType;
  label: string;
}

export interface AppState {
  fileName: string;
  fileBytes: Uint8Array | null; // original bytes, kept for save-with-annotations
  pageCount: number;
  pageNum: number; // 1-based
  zoom: number;
  fit: 'width' | null;
  displayUnit: DisplayUnit;
  tool: ToolId;
  calibrations: Map<number, Calibration>;
  markups: Markup[];
  selectedId: string | null;
  /** last reversible action, so Ctrl+Z can restore a drag before falling back to delete-newest */
  lastAction: { kind: 'move'; id: string; before: Pt[] } | null;
  presets: ToolPreset[];
  activePreset: ToolPreset | null;
  columns: CustomColumn[];
  viewports: Viewport[];
  listFilter: {
    status: 'all' | 'none' | 'check' | 'confirmed';
    text: string;
    sort: 'added' | 'label' | 'page';
  };
}

export const state: AppState = {
  fileName: '',
  fileBytes: null,
  pageCount: 0,
  pageNum: 1,
  zoom: 1,
  fit: 'width',
  displayUnit: 'm',
  tool: 'pan',
  calibrations: new Map(),
  markups: [],
  selectedId: null,
  lastAction: null,
  presets: [],
  activePreset: null,
  columns: [],
  viewports: [],
  listFilter: { status: 'all', text: '', sort: 'added' },
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(): void {
  for (const fn of listeners) fn();
}

export function calibrationFor(page: number): Calibration | undefined {
  return state.calibrations.get(page);
}

/** Calibration for a markup, honouring viewports (per-region scales). */
export function calibrationForMarkup(m: Markup): Calibration | undefined {
  return resolveCalibration(m, state.calibrations, state.viewports);
}

/** Everything the engine needs to serialize this session's takeoff. */
export function takeoffData(): TakeoffData {
  return {
    markups: state.markups,
    calibrations: state.calibrations,
    displayUnit: state.displayUnit,
    columns: state.columns,
    viewports: state.viewports,
  };
}
