// PDF rendering with pdf.js: document lifecycle, page canvas, zoom/pan, and
// the SVG overlay that carries all markups. The overlay viewBox is the page
// viewport at scale 1, so markup geometry in PDF-point space never changes
// with zoom — only the canvas re-rasterises.

import * as pdfjsLib from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, PageViewport, RenderTask } from 'pdfjs-dist';
import { state, emit } from './state';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export type ViewPt = { x: number; y: number }; // viewport@1 space (top-left origin)

let doc: PDFDocumentProxy | null = null;
let viewport1: PageViewport | null = null;
let renderTask: RenderTask | null = null;
let renderSeq = 0;

let scrollEl: HTMLElement;
let pageEl: HTMLElement;
let canvas: HTMLCanvasElement;
let svg: SVGSVGElement;
export let markupsLayer: SVGGElement;
export let previewLayer: SVGGElement;

export let onFirstRender: (() => void) | null = null;

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;
const MAX_CANVAS_PIXELS = 2.5e7;

export function initViewer(
  scroll: HTMLElement,
  page: HTMLElement,
  cnv: HTMLCanvasElement,
  overlay: SVGSVGElement,
  ml: SVGGElement,
  pl: SVGGElement,
): void {
  scrollEl = scroll;
  pageEl = page;
  canvas = cnv;
  svg = overlay;
  markupsLayer = ml;
  previewLayer = pl;
  bindWheel();
  bindPan();
}

export function hasDoc(): boolean {
  return doc !== null;
}

/** The loaded document, for engine modules (scan, export) that need their own renders. */
export function getPdfDoc(): PDFDocumentProxy | null {
  return doc;
}

export async function loadPdf(bytes: Uint8Array, name: string): Promise<void> {
  await closePdf();
  state.fileName = name;
  state.fileBytes = bytes;
  state.pageNum = 1;
  state.markups = [];
  state.selectedId = null;
  state.calibrations.clear();
  const task = pdfjsLib.getDocument({ data: bytes.slice() });
  doc = await task.promise;
  state.pageCount = doc.numPages;
  state.zoom = fitWidthZoom();
  emit();
}

export async function closePdf(): Promise<void> {
  if (renderTask) {
    try {
      renderTask.cancel();
    } catch {
      /* cancelled */
    }
    renderTask = null;
  }
  if (doc) {
    try {
      await doc.destroy();
    } catch {
      /* already destroyed */
    }
    doc = null;
  }
}

export async function renderPage(): Promise<void> {
  if (!doc) return;
  const mySeq = ++renderSeq;
  if (renderTask) {
    try {
      renderTask.cancel();
    } catch {
      /* cancelled */
    }
    renderTask = null;
  }
  const page = await doc.getPage(state.pageNum);
  if (mySeq !== renderSeq) return; // superseded
  viewport1 = page.getViewport({ scale: 1 });

  // SVG overlay geometry is zoom-independent; size only changes with the page.
  svg.setAttribute('viewBox', `0 0 ${viewport1.width} ${viewport1.height}`);

  applyLayoutSize();
  await paintCanvas(page, mySeq);
}

function fitWidthZoom(): number {
  if (!viewport1) return 1;
  const available = scrollEl.clientWidth - 64;
  return clampZoom(available / viewport1.width);
}

export function fitWidth(): void {
  if (!viewport1) return;
  state.zoom = fitWidthZoom();
  emit();
}

export function setZoom(z: number): void {
  state.zoom = clampZoom(z);
  emit();
}

export function zoomAt(clientX: number, clientY: number, factor: number): void {
  const cr = scrollEl.getBoundingClientRect();
  const cx = clientX - cr.left;
  const cy = clientY - cr.top;
  const z2 = clampZoom(state.zoom * factor);
  if (z2 === state.zoom) return;
  const ratio = z2 / state.zoom;
  const contentX = scrollEl.scrollLeft + cx;
  const contentY = scrollEl.scrollTop + cy;
  state.zoom = z2;
  previewResize();
  scrollEl.scrollLeft = contentX * ratio - cx;
  scrollEl.scrollTop = contentY * ratio - cy;
  emit();
}

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

function applyLayoutSize(): void {
  if (!viewport1) return;
  const w = viewport1.width * state.zoom;
  const h = viewport1.height * state.zoom;
  pageEl.style.width = `${w}px`;
  pageEl.style.height = `${h}px`;
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
}

/** Immediately stretch existing raster to the new zoom so interaction feels live,
 *  then the debounced render re-rasterises crisply. */
function previewResize(): void {
  applyLayoutSize();
}

async function paintCanvas(page: pdfjsLib.PDFPageProxy, mySeq: number): Promise<void> {
  const viewport = page.getViewport({ scale: state.zoom });
  let dpr = Math.min(window.devicePixelRatio || 1, 3);
  const px = viewport.width * dpr;
  const py = viewport.height * dpr;
  if (px * py > MAX_CANVAS_PIXELS) {
    dpr = Math.max(1, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
  }
  canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
  canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
  applyLayoutSize();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  try {
    renderTask = page.render({
      canvas,
      canvasContext: ctx,
      viewport,
      transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
    });
    await renderTask.promise;
  } catch {
    return; // cancelled or superseded
  }
  if (mySeq === renderSeq && onFirstRender) {
    onFirstRender();
    onFirstRender = null;
  }
  renderTask = null;
}

export function viewSize(): { w: number; h: number } {
  return viewport1 ? { w: viewport1.width, h: viewport1.height } : { w: 0, h: 0 };
}

/** Event position → viewport@1 coordinates (the SVG viewBox space). */
export function eventToView(e: { clientX: number; clientY: number }): ViewPt | null {
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return {
    x: ((e.clientX - rect.left) / rect.width) * (viewport1?.width ?? 0),
    y: ((e.clientY - rect.top) / rect.height) * (viewport1?.height ?? 0),
  };
}

export function viewToPdf(v: ViewPt) {
  if (!viewport1) return { x: 0, y: 0 };
  const [x, y] = viewport1.convertToPdfPoint(v.x, v.y);
  return { x, y };
}

export function pdfToView(p: { x: number; y: number }): ViewPt {
  if (!viewport1) return { x: 0, y: 0 };
  const [x, y] = viewport1.convertToViewportPoint(p.x, p.y);
  return { x, y };
}

// --- interaction: wheel zoom, drag pan ---

function bindWheel(): void {
  scrollEl.addEventListener(
    'wheel',
    (e) => {
      if (!doc) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.01);
        zoomAt(e.clientX, e.clientY, factor);
      }
      // plain wheel/touchpad scrolls the container natively
    },
    { passive: false },
  );
}

let spaceDown = false;

function bindPan(): void {
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isTypingTarget(e.target)) spaceDown = true;
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') spaceDown = false;
  });

  svg.addEventListener('pointerdown', (e) => {
    if (!doc) return;
    const wantPan = e.button === 1 || spaceDown || state.tool === 'pan';
    if (!wantPan) return;
    // clicking a markup selects/drags it — don't also pan the canvas
    if (state.tool === 'pan' && e.target instanceof Element && e.target.closest('[data-id]')) return;
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    let lastX = e.clientX;
    let lastY = e.clientY;
    const move = (ev: PointerEvent) => {
      scrollEl.scrollLeft -= ev.clientX - lastX;
      scrollEl.scrollTop -= ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
    };
    const up = () => {
      svg.removeEventListener('pointermove', move);
      svg.removeEventListener('pointerup', up);
      svg.removeEventListener('pointercancel', up);
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
  });
}

export function isTypingTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
  );
}
