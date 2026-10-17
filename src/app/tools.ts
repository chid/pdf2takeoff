// Tool state machine: calibrate, length, area, count, and selection.
// Click geometry comes in as SVG overlay events, converted to PDF space.

import { state, emit, nextId, type Pt, type Markup, defaultLabel, distPt } from './state';
import { eventToView, viewToPdf, isTypingTarget } from './viewer';
import { renderMarkups, renderPreview, type PreviewSpec } from './render';
import { compareState } from './compare';
import { scanForSimilar } from '../engine/scan';
import { syncUpsertMarkup, syncDeleteMarkup, syncCalibration } from './session';
import { getActiveLayer, DEFAULT_LAYER } from './layers';
import { PRESET_SCALES as SCALES } from '../engine/units';
import { ocrPage } from './ocr';
import { findScaleRatio, nearestDimensionValue } from '../engine/ocr';
import { dynamicFill } from '../engine/dynamicfill';
import { renderRaster } from './raster';
import { scanDeps } from './adapters';
import { parseLength, toMeters, PRESET_SCALES, metersPerPtForRatio, type Unit } from '../engine/units';

export let onStatusHint: ((text: string) => void) | null = null;
export function setStatusHint(fn: (text: string) => void): void {
  onStatusHint = fn;
}

function hint(text: string): void {
  onStatusHint?.(text);
}

/** One-off hint from other modules (library, etc.). */
export function showHint(text: string): void {
  hint(text);
}

const HINTS: Record<string, string> = {
  pan: 'Drag to pan · Ctrl+wheel to zoom · click a markup to select it',
  calibrate: 'Click two ends of a known dimension to calibrate the scale',
  length: 'Click each vertex of the run · double-click or Enter to finish · Esc cancels',
  area: 'Click each corner of the area · double-click or Enter to finish · Esc cancels',
  count: 'Click to place a count mark · each click counts one item',
  perimeter: 'Click each corner of the boundary · double-click or Enter to close · Esc cancels',
  volume: 'Click each corner of the area · double-click or Enter to finish, then enter the depth',
  angle: 'Click the corner vertex, then one point on each ray',
  note: 'Click where the note belongs, then type the text in the list (rename)',
  fill: 'Click inside a room or slab — the fill reads its area off the walls',
  viewport: 'Outline a region drawn at a different scale (e.g. a 1:20 detail), then pick its scale',
  scan: 'Click one instance of a repeated symbol; the scan finds and counts every match on the page',
};

let svg: SVGSVGElement;
let draft: Pt[] = [];
let cursor: Pt | null = null;
let calibFirst: Pt | null = null;
let pendingCalib: { a: Pt; b: Pt } | null = null;

// Modal elements live in index.html
let calibModal: HTMLElement;
let calibDrawnText: HTMLElement;
let calibInput: HTMLInputElement;
let calibUnitSel: HTMLSelectElement;
let calibPresetSel: HTMLSelectElement;

export function initTools(overlay: SVGSVGElement): void {
  svg = overlay;
  calibModal = document.getElementById('calibModal')!;
  calibDrawnText = document.getElementById('calibDrawn')!;
  calibInput = document.getElementById('calibLength') as HTMLInputElement;
  calibUnitSel = document.getElementById('calibUnit') as HTMLSelectElement;
  calibPresetSel = document.getElementById('calibPreset') as HTMLSelectElement;

  calibPresetSel.replaceChildren(new Option('Or pick a standard scale…', ''));
  for (const p of PRESET_SCALES) calibPresetSel.add(new Option(p.label, String(p.ratio)));

  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerleave', () => {
    cursor = null;
    refreshPreview();
  });
  svg.addEventListener('dblclick', onDoubleClick);
  window.addEventListener('keydown', onKeyDown);

  document.getElementById('calibCancel')?.addEventListener('click', closeCalibModal);
  document.getElementById('calibApply')?.addEventListener('click', applyCalibration);
  document.getElementById('depthCancel')?.addEventListener('click', closeDepthModal);
  document.getElementById('vpCancel')?.addEventListener('click', closeVpModal);
  document.getElementById('vpApply')?.addEventListener('click', applyViewport);
  document.getElementById('vpModal')?.addEventListener('pointerdown', (e) => {
    if (e.target === document.getElementById('vpModal')) closeVpModal();
  });
  document.getElementById('depthApply')?.addEventListener('click', applyDepth);
  document.getElementById('depthModal')?.addEventListener('pointerdown', (e) => {
    if (e.target === document.getElementById('depthModal')) closeDepthModal();
  });
  document.getElementById('depthInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyDepth();
    if (e.key === 'Escape') closeDepthModal();
  });
  calibModal.addEventListener('pointerdown', (e) => {
    if (e.target === calibModal) closeCalibModal();
  });
  calibInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyCalibration();
  });
  document.getElementById('ocrReadBtn')?.addEventListener('click', () => void runOcrRead());

  calibPresetSel.addEventListener('change', () => {
    const ratio = parseFloat(calibPresetSel.value);
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    const label = calibPresetSel.selectedOptions[0]?.label ?? `1:${ratio}`;
    applyScaleToPages(metersPerPtForRatio(ratio), `preset ${label}`);
    closeCalibModal();
    renderMarkups();
    emit();
    hint('Scale set · press L for length, A for area, N to count');
  });
}

export function setTool(tool: typeof state.tool): void {
  state.tool = tool;
  // manual tool switching drops an active preset unless the type still matches;
  // a count preset survives the scan tool so scan hits come out pre-labelled
  if (
    state.activePreset &&
    state.activePreset.type !== tool &&
    !(tool === 'scan' && state.activePreset.type === 'count')
  ) {
    state.activePreset = null;
  }
  draft = [];
  calibFirst = null;
  pendingCalib = null;
  svg.classList.toggle('drawing', tool !== 'pan');
  svg.style.cursor =
    tool === 'pan' ? 'grab' : tool === 'count' ? 'copy' : tool === 'scan' ? 'zoom-in' : 'crosshair';
  renderPreview(null);
  hint(HINTS[tool] ?? '');
  emit();
}

function eventToPdf(e: PointerEvent | MouseEvent): Pt | null {
  const v = eventToView(e);
  if (!v) return null;
  return viewToPdf(v);
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  if (e.target instanceof Element && e.target.closest('[data-id]') && state.tool === 'pan') {
    const g = e.target.closest('[data-id]')!;
    const id = g.getAttribute('data-id')!;
    const m = state.markups.find((x) => x.id === id);
    if (m) {
      state.selectedId = id;
      renderMarkups();
      emit();
      if (m.page === state.pageNum) {
        const vtx = e.target.closest('.vtx');
        beginDrag(m, vtx ? Number(vtx.getAttribute('data-idx')) : null, e);
      }
    }
    return;
  }
  const p = eventToPdf(e);
  if (!p) return;

  switch (state.tool) {
    case 'calibrate': {
      if (!calibFirst) {
        calibFirst = p;
        hint('Now click the other end of the known dimension');
      } else {
        pendingCalib = { a: calibFirst, b: p };
        calibFirst = null;
        openCalibModal();
      }
      refreshPreview();
      break;
    }
    case 'length':
    case 'area':
    case 'perimeter':
    case 'volume':
    case 'viewport':
      draft.push(p);
      refreshPreview();
      break;
    case 'angle':
      draft.push(p);
      if (draft.length === 3) finishDraft(); // vertex + two rays
      refreshPreview();
      break;
    case 'count': {
      const m: Markup = {
        id: nextId('mk'),
        page: state.pageNum,
        type: 'count',
        layer: getActiveLayer() !== DEFAULT_LAYER ? getActiveLayer() : undefined,
        label: state.activePreset?.type === 'count' ? state.activePreset.label : defaultLabel('count'),
        points: [p],
        createdAt: Date.now(),
      };
      state.markups.push(m);
      state.lastAction = null;
      syncUpsertMarkup(m);
      renderMarkups();
      emit();
      break;
    }
    case 'note': {
      const note: Markup = {
        id: nextId('mk'),
        page: state.pageNum,
        type: 'note',
        layer: getActiveLayer() !== DEFAULT_LAYER ? getActiveLayer() : undefined,
        label: state.activePreset?.type === 'note' ? state.activePreset.label : 'Note',
        points: [p],
        createdAt: Date.now(),
      };
      state.markups.push(note);
      state.lastAction = null;
      syncUpsertMarkup(note);
      renderMarkups();
      emit();
      hint('Note placed · type its text in the Label column of the list');
      break;
    }
    case 'fill':
      void runFill(p);
      break;
    case 'scan':
      void runScan(p);
      break;
    case 'pan':
      state.selectedId = null;
      renderMarkups();
      emit();
      break;
  }
}

/** Drag a whole markup, or one vertex when vtxIdx is given. Live value updates. */
function beginDrag(m: import('./state').Markup, vtxIdx: number | null, e: PointerEvent): void {
  const start = eventToPdf(e);
  if (!start) return;
  const before = m.points.map((p) => ({ ...p }));
  state.lastAction = { kind: 'move', id: m.id, before };
  const move = (ev: PointerEvent) => {
    const cur = eventToPdf(ev);
    if (!cur) return;
    if (vtxIdx != null && vtxIdx >= 0 && vtxIdx < m.points.length) {
      m.points[vtxIdx] = cur;
    } else {
      const dx = cur.x - start.x;
      const dy = cur.y - start.y;
      m.points = before.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
    renderMarkups();
    syncUpsertMarkup(m);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    renderMarkups();
    emit();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
}

function onPointerMove(e: PointerEvent): void {
  if (state.tool === 'pan') return;
  cursor = eventToPdf(e);
  refreshPreview();
}

function onDoubleClick(e: MouseEvent): void {
  const p = eventToPdf(e);
  if (!p) return;
  if (state.tool === 'length' || state.tool === 'area' || state.tool === 'perimeter' || state.tool === 'volume' || state.tool === 'viewport') {
    // the second click of a double-click registers as a duplicate vertex
    if (draft.length >= 2 && distPt(draft[draft.length - 1], draft[draft.length - 2]) < 1) {
      draft.pop();
    }
    finishDraft();
  }
}

async function runFill(p: Pt): Promise<void> {
  hint('Filling…');
  const t0 = performance.now();
  try {
    const raster = await renderRaster(state.pageNum, 3);
    const result = dynamicFill(raster, p);
    if ('error' in result) {
      hint(result.error);
      return;
    }
    const m: Markup = {
      id: nextId('mk'),
      page: state.pageNum,
      type: 'area',
      layer: getActiveLayer() !== DEFAULT_LAYER ? getActiveLayer() : undefined,
      label: state.activePreset?.type === 'area' ? state.activePreset.label : 'Filled area',
      points: result.points,
      createdAt: Date.now(),
    };
    state.markups.push(m);
    state.lastAction = null;
    syncUpsertMarkup(m);
    setTool('pan');
    renderMarkups();
    emit();
    const cal = state.calibrations.get(state.pageNum);
    if (cal) {
      hint(`Fill area added (${Math.round(performance.now() - t0)} ms) · drag vertices to adjust`);
    } else {
      hint('Fill area added · calibrate the scale to see its value');
    }
  } catch (err) {
    hint(`Fill failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function runScan(p: Pt): Promise<void> {
  const t0 = performance.now();
  const result = await scanForSimilar(state.pageNum, p, scanDeps);
  if ('error' in result) {
    hint(result.error);
    return;
  }
  const ms = Math.round(performance.now() - t0);
  const hits = result.hits;
  if (hits.length < 2) {
    hint(
      result.provider === 'detector'
        ? 'Detector found fewer than 2 symbols; click directly on a symbol type you want counted'
        : 'No repeats found; click a smaller, isolated symbol that repeats on the page',
    );
    return;
  }
  const fallbackLabel = state.activePreset?.type === 'count' ? state.activePreset.label : 'Scanned symbol';
  for (const hit of hits) {
    const scanned: Markup = {
      id: nextId('mk'),
      page: state.pageNum,
      type: 'count',
      layer: getActiveLayer() !== DEFAULT_LAYER ? getActiveLayer() : undefined,
      label: hit.label ?? fallbackLabel,
      points: [{ x: hit.x, y: hit.y }],
      // a near match (outline and ink, not the exact path) is for the
      // estimator to confirm, not to count blind
      ...(hit.match === 'near' ? { status: 'check' as const } : {}),
      createdAt: Date.now(),
    };
    state.markups.push(scanned);
    syncUpsertMarkup(scanned);
  }
  state.lastAction = null;
  setTool('pan');
  renderMarkups();
  emit();
  const label = hits[0].label ?? fallbackLabel;
  const near = hits.filter((h) => h.match === 'near').length;
  const check = near ? ` · ${near} near match${near === 1 ? '' : 'es'} flagged ⚑ to check` : '';
  hint(
    label !== 'Scanned symbol'
      ? `Scan counted ${hits.length} × ${label} in ${ms} ms${check}`
      : `Scan found ${hits.length} symbols in ${ms} ms${check}; rename "Scanned symbol" in the list to group them`,
  );
}

function finishDraft(): void {
  const min =
    state.tool === 'area' || state.tool === 'perimeter' || state.tool === 'volume' || state.tool === 'viewport' ? 3 : 2;
  if (state.tool === 'angle') {
    if (draft.length === 3) pushDraftMarkup('angle');
  } else if (draft.length >= min) {
    if (state.tool === 'volume') {
      pendingVolume = [...draft];
      draft = [];
      openDepthModal();
    } else if (state.tool === 'viewport') {
      pendingViewport = [...draft];
      draft = [];
      openVpModal();
    } else {
      pushDraftMarkup(state.tool as 'length' | 'area' | 'perimeter');
    }
  }
  draft = [];
  renderPreview(null);
  renderMarkups();
  emit();
}

function pushDraftMarkup(type: 'length' | 'area' | 'perimeter' | 'volume' | 'angle', depth?: number): void {
  state.markups.push({
    id: nextId('mk'),
    page: state.pageNum,
    type,
    label: state.activePreset?.type === type ? state.activePreset.label : defaultLabel(type),
    points: [...draft],
    createdAt: Date.now(),
    ...(depth !== undefined ? { depth } : {}),
    ...(getActiveLayer() !== DEFAULT_LAYER ? { layer: getActiveLayer() } : {}),
  });
  state.lastAction = null;
  syncUpsertMarkup(state.markups[state.markups.length - 1]);
}

function refreshPreview(): void {
  let spec: PreviewSpec | null = null;
  if (state.tool === 'viewport') {
    if (draft.length > 0) spec = { kind: 'area', points: draft, cursor };
  } else if (state.tool === 'length' || state.tool === 'area' || state.tool === 'perimeter' || state.tool === 'volume' || state.tool === 'angle') {
    if (draft.length > 0) spec = { kind: state.tool, points: draft, cursor };
  } else if (state.tool === 'calibrate' && calibFirst) {
    spec = { kind: 'calibrate', points: [calibFirst], cursor };
  }
  renderPreview(spec);
}

// --- calibration modal ---

function openCalibModal(): void {
  if (!pendingCalib) return;
  const paperMm = distPt(pendingCalib.a, pendingCalib.b) * (25.4 / 72);
  calibDrawnText.textContent = `You drew ${paperMm.toFixed(1)} mm on paper.`;
  calibInput.value = '';
  calibPresetSel.value = '';
  calibModal.classList.remove('hidden');
  calibUnitSel.value = state.displayUnit === 'ft-in' ? 'ft' : (state.displayUnit as Unit);
  calibInput.focus();
}

function closeCalibModal(): void {
  calibModal.classList.add('hidden');
  pendingCalib = null;
}

/** Set the scale on the current page, or every page when "all pages" is checked. */
function applyScaleToPages(metersPerPt: number, source: string): void {
  const all = (document.getElementById('calibAllPages') as HTMLInputElement | null)?.checked;
  const pages = all ? Array.from({ length: state.pageCount }, (_, i) => i + 1) : [state.pageNum];
  for (const p of pages) {
    state.calibrations.set(p, { metersPerPt, source });
    syncCalibration(p, { metersPerPt, source });
  }
}

// --- volume depth modal ---

let pendingVolume: Pt[] | null = null;
let depthModal: HTMLElement;
let depthInput: HTMLInputElement;
let depthUnitSel: HTMLSelectElement;

function openDepthModal(): void {
  depthModal = document.getElementById('depthModal')!;
  depthInput = document.getElementById('depthInput') as HTMLInputElement;
  depthUnitSel = document.getElementById('depthUnit') as HTMLSelectElement;
  depthInput.value = '';
  depthUnitSel.value = state.displayUnit === 'ft-in' ? 'ft' : (state.displayUnit as Unit);
  depthModal.classList.remove('hidden');
  depthInput.focus();
}

function closeDepthModal(): void {
  depthModal.classList.add('hidden');
  pendingVolume = null;
}

function applyDepth(): void {
  if (!pendingVolume) return closeDepthModal();
  const unit = depthUnitSel.value as Unit;
  const value = parseLength(depthInput.value, unit);
  if (value == null) {
    depthInput.classList.add('invalid');
    setTimeout(() => depthInput.classList.remove('invalid'), 600);
    return;
  }
  const depth = toMeters(value, unit);
  const points = pendingVolume;
  pendingVolume = null;
  depthModal.classList.add('hidden');
  draft = points; // reuse pushDraftMarkup against the stashed polygon
  pushDraftMarkup('volume', depth);
  draft = [];
  setTool('pan');
  hint('Volume added · switch units any time in the toolbar');
}

/** OCR the sheet and either apply a title-block ratio or pre-fill the clicked dimension's value. */
async function runOcrRead(): Promise<void> {
  const btn = document.getElementById('ocrReadBtn') as HTMLButtonElement;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Reading… (first run fetches the OCR pack)';
  try {
    const words = await ocrPage(state.pageNum);
    const scaleHit = findScaleRatio(words);

    // with a clicked dimension, its printed label is the most direct answer
    if (pendingCalib) {
      const dim = nearestDimensionValue(words, pendingCalib.a, pendingCalib.b);
      if (dim) {
        calibInput.value = String(dim.value);
        calibUnitSel.value = dim.unit;
        calibInput.classList.remove('invalid');
        hint(`Read "${dim.text}" next to your dimension — check it, then Apply scale`);
        return;
      }
    }
    if (scaleHit) {
      applyScaleToPages(metersPerPtForRatio(scaleHit.ratio), `${scaleHit.source} (sheet)`);
      closeCalibModal();
      renderMarkups();
      emit();
      hint(`Scale 1:${scaleHit.ratio} read from the sheet · press L to measure`);
      return;
    }
    hint('Could not read a scale or dimension from this sheet — type the length manually');
  } catch {
    hint('OCR failed — the first run needs internet to fetch the language pack');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// --- viewport scale modal ---

let pendingViewport: Pt[] | null = null;
let vpModal: HTMLElement;
let vpPresetSel: HTMLSelectElement;

function openVpModal(): void {
  vpModal = document.getElementById('vpModal')!;
  vpPresetSel = document.getElementById('vpPreset') as HTMLSelectElement;
  vpPresetSel.replaceChildren(new Option('Pick the region\'s scale…', ''));
  for (const p of SCALES) vpPresetSel.add(new Option(p.label, String(p.ratio)));
  vpModal.classList.remove('hidden');
  vpPresetSel.focus();
}

function closeVpModal(): void {
  vpModal.classList.add('hidden');
  pendingViewport = null;
}

function applyViewport(): void {
  if (!pendingViewport) return closeVpModal();
  const ratio = parseFloat(vpPresetSel.value);
  if (!Number.isFinite(ratio) || ratio <= 0) {
    vpPresetSel.classList.add('invalid');
    setTimeout(() => vpPresetSel.classList.remove('invalid'), 600);
    return;
  }
  const label = vpPresetSel.selectedOptions[0]?.label ?? `1:${Math.round(ratio)}`;
  state.viewports.push({
    id: nextId('vp'),
    page: state.pageNum,
    points: pendingViewport.map((p) => ({ ...p })),
    metersPerPt: metersPerPtForRatio(ratio),
    source: `viewport ${label}`,
  });
  pendingViewport = null;
  vpModal.classList.add('hidden');
  setTool('pan');
  renderMarkups();
  emit();
  hint(`Viewport ${label} set · measurements inside it use this scale`);
}

function applyCalibration(): void {
  if (!pendingCalib) return closeCalibModal();
  const unit = calibUnitSel.value as Unit;
  const value = parseLength(calibInput.value, unit);
  if (value == null) {
    calibInput.classList.add('invalid');
    setTimeout(() => calibInput.classList.remove('invalid'), 600);
    return;
  }
  const ptDist = distPt(pendingCalib.a, pendingCalib.b);
  const meters = toMeters(value, unit);
  applyScaleToPages(meters / ptDist, `measured ${calibInput.value.trim()} ${unit}`);
  closeCalibModal();
  renderMarkups();
  emit();
  hint('Scale set · press L for length, A for area, N to count');
}

// --- keyboard ---

function onKeyDown(e: KeyboardEvent): void {
  if (isTypingTarget(e.target)) return;
  const depthM = document.getElementById('depthModal');
  const vpM = document.getElementById('vpModal');
  if (!calibModal.classList.contains('hidden') || !depthM?.classList.contains('hidden') || !vpM?.classList.contains('hidden')) {
    if (e.key === 'Escape') {
      closeCalibModal();
      closeDepthModal();
    }
    return;
  }

  const toolKeys: Record<string, typeof state.tool> = {
    v: 'pan',
    c: 'calibrate',
    l: 'length',
    a: 'area',
    n: 'count',
    p: 'perimeter',
    o: 'volume',
    g: 'angle',
    t: 'note',
    d: 'fill',
    w: 'viewport',
    s: 'scan',
  };
  const k = e.key.toLowerCase();

  if (k === 'escape') {
    if (draft.length || calibFirst) {
      draft = [];
      calibFirst = null;
      renderPreview(null);
      hint(HINTS[state.tool]);
    } else if (state.selectedId) {
      state.selectedId = null;
      renderMarkups();
      emit();
    }
    return;
  }
  if (k === 'enter') {
    if (draft.length) finishDraft();
    return;
  }
  if (k === 'backspace') {
    if (draft.length) {
      draft.pop();
      refreshPreview();
      return; // don't delete a selected markup while drawing
    }
  }
  if ((k === 'delete' || k === 'backspace') && state.selectedId) {
    const deleted = state.selectedId;
    state.markups = state.markups.filter((m) => m.id !== state.selectedId);
    state.selectedId = null;
    if (deleted) syncDeleteMarkup(deleted);
    renderMarkups();
    emit();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && k === 'z') {
    e.preventDefault();
    if (draft.length) {
      draft.pop();
      refreshPreview();
    } else if (state.lastAction?.kind === 'move') {
      const moved = state.markups.find((x) => x.id === state.lastAction!.id);
      if (moved) {
        moved.points = state.lastAction.before;
        state.lastAction = null;
        syncUpsertMarkup(moved);
        renderMarkups();
        emit();
        return;
      }
    }
    if (state.markups.length) {
      const newest = state.markups.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
      state.markups = state.markups.filter((m) => m.id !== newest.id);
      if (state.selectedId === newest.id) state.selectedId = null;
      syncDeleteMarkup(newest.id);
      renderMarkups();
      emit();
    }
    return;
  }
  if (toolKeys[k] && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (compareState.active && k !== 'v') return; // measuring is paused during compare
    setTool(toolKeys[k]);
  }
}
