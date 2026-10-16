// Write markups back into a PDF as standard annotations (Line, PolyLine,
// Polygon, FreeText) so they open in Bluebeam Revu, Acrobat and friends.
// Pure pdf-lib: bytes in, bytes out — works identically in any host.

import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, type PDFObject, type PDFPage } from 'pdf-lib';
import type { Calibration, Markup, Pt } from './types.ts';
import { markupLength, markupArea, markupPerimeter, markupVolume, markupAngle } from './geometry.ts';
import { formatLength, formatArea, formatVolume, type DisplayUnit } from './units.ts';
import { resolveCalibration, type Viewport } from './viewports.ts';

export const ANNOTATION_AUTHOR = 'pdf2takeoff';
export const ENCRYPTED_PDF_MESSAGE =
  'this PDF is encrypted (edit-restricted), and pdf2takeoff cannot write markups into encrypted PDFs yet: export CSV or Excel instead';

/** Private annotation key holding the markup's exact data as JSON, so a
 *  round-trip never has to parse the human-readable Contents text. */
export const PAYLOAD_KEY = 'PDF2TakeoffMarkup';

/** What PAYLOAD_KEY carries. Geometry stays in the standard keys (L,
 *  Vertices, Rect) so edits made in Revu/Acrobat still come back. */
export interface MarkupPayload {
  v: 1;
  id: string;
  type: Markup['type'];
  label: string;
  depth?: number; // metres
  status?: Markup['status'];
  layer?: string;
}

/** Text value of a PDF string object (literal or hex), else null. */
export function pdfText(v: PDFObject | undefined): string | null {
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : null;
}

const PRODUCER = 'pdf2takeoff 0.1.0';
const COLOR_HEX: Record<string, [number, number, number]> = {
  length: [225 / 255, 29 / 255, 72 / 255],
  area: [124 / 255, 58 / 255, 237 / 255],
  count: [2 / 255, 132 / 255, 199 / 255],
  perimeter: [13 / 255, 148 / 255, 136 / 255],
  volume: [79 / 255, 70 / 255, 229 / 255],
  angle: [219 / 255, 39 / 255, 119 / 255],
  note: [217 / 255, 119 / 255, 6 / 255],
};

function pdfDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}+00'00'`;
}

function contentsFor(m: Markup, calibrations: Map<number, Calibration>, displayUnit: DisplayUnit, viewports: Viewport[] = []): string {
  const tags = [
    ...(m.status ? [`[${m.status}]`] : []),
    ...(m.layer ? [`[layer:${m.layer}]`] : []),
  ];
  const body = contentsBody(m, resolveCalibration(m, calibrations, viewports), displayUnit);
  return tags.length ? `${body} ${tags.join(' ')}` : body;
}

function contentsBody(m: Markup, cal: Calibration | undefined, displayUnit: DisplayUnit): string {
  // angles are scale-free — they never need calibration
  if (m.type === 'angle') return `${m.label}: ${markupAngle(m).toFixed(1)}°`;
  if (m.type === 'note') return m.label; // the note IS the text
  if (!cal) return m.type === 'count' ? `${m.label}: 1` : m.label;
  if (m.type === 'count') return `${m.label}: 1`;
  let v: string;
  if (m.type === 'perimeter') {
    v = formatLength(markupPerimeter(m, cal.metersPerPt), displayUnit);
  } else if (m.type === 'volume') {
    // depth rides along in the comment so round-trips (and humans in Revu) see it
    const vol = formatVolume(markupVolume(m, cal.metersPerPt), displayUnit);
    return `${m.label}: ${vol} (depth ${formatLength(m.depth ?? 0, displayUnit)})`;
  } else if (m.type === 'length') {
    v = formatLength(markupLength(m, cal.metersPerPt), displayUnit);
  } else {
    v = formatArea(markupArea(m, cal.metersPerPt), displayUnit);
  }
  return `${m.label}: ${v}`;
}

function bbox(points: Pt[], pad: number): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

/** Drop the annotations a previous save wrote, so saving a reopened file
 *  replaces its markups instead of stacking a second copy on top. */
function removeOwnAnnotations(page: PDFPage): void {
  const annots = page.node.Annots();
  if (!annots) return;
  const kept: PDFObject[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const dict = annots.lookup(i);
    const own = dict instanceof PDFDict && pdfText(dict.lookup(PDFName.of('T'))) === ANNOTATION_AUTHOR;
    if (!own) kept.push(annots.get(i));
  }
  if (kept.length === annots.size()) return;
  if (kept.length) page.node.set(PDFName.of('Annots'), page.doc.context.obj(kept));
  else page.node.delete(PDFName.of('Annots'));
}

export interface AnnotateOptions {
  bytes: Uint8Array;
  markups: Markup[];
  calibrations: Map<number, Calibration>;
  displayUnit: DisplayUnit;
  viewports?: Viewport[];
}

/** Return a copy of the PDF with one standard annotation per markup,
 *  replacing any pdf2takeoff annotations already in it. */
export async function buildAnnotatedPdf(opts: AnnotateOptions): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(opts.bytes.slice(), { ignoreEncryption: true });
  // edit-restricted council/consultant sets are common; pdf-lib can't
  // re-encrypt them, so say so instead of leaking its load-time advice
  if (pdfDoc.isEncrypted) throw new Error(ENCRYPTED_PDF_MESSAGE);
  pdfDoc.setProducer(PRODUCER);
  pdfDoc.setModificationDate(new Date());

  const pages = pdfDoc.getPages();
  const { context } = pdfDoc;
  for (const page of pages) removeOwnAnnotations(page);

  const addAnnot = (pageIndex: number, dict: Record<string, string | number | number[] | PDFObject>) => {
    const page = pages[pageIndex];
    const annots = page.node.Annots() ?? context.obj([]);
    page.node.set(PDFName.of('Annots'), annots);
    const ref = context.register(context.obj(dict));
    annots.push(ref);
  };

  const payload = (m: Markup): MarkupPayload => ({
    v: 1,
    id: m.id,
    type: m.type,
    label: m.label,
    ...(m.depth !== undefined ? { depth: m.depth } : {}),
    ...(m.status ? { status: m.status } : {}),
    ...(m.layer ? { layer: m.layer } : {}),
  });

  // hex (UTF-16) strings: labels may hold any script, and ² ³ ° survive
  const common = (m: Markup) => ({
    Type: PDFName.of('Annot'),
    T: PDFString.of(ANNOTATION_AUTHOR),
    Contents: PDFHexString.fromText(contentsFor(m, opts.calibrations, opts.displayUnit, opts.viewports)),
    [PAYLOAD_KEY]: PDFHexString.fromText(JSON.stringify(payload(m))),
    M: PDFString.of(pdfDate()),
    C: COLOR_HEX[m.type],
    CA: 1,
    F: 4, // print
  });

  for (const m of opts.markups) {
    const pi = m.page - 1;
    if (pi < 0 || pi >= pages.length) continue;
    const flat: number[] = [];
    for (const p of m.points) flat.push(p.x, p.y);

    if (m.type === 'length' && m.points.length === 2) {
      addAnnot(pi, {
        ...common(m),
        Subtype: PDFName.of('Line'),
        Rect: bbox(m.points, 4),
        L: flat,
        IC: COLOR_HEX.length,
      });
    } else if (m.type === 'length' || m.type === 'angle') {
      addAnnot(pi, {
        ...common(m),
        Subtype: PDFName.of('PolyLine'),
        Rect: bbox(m.points, 4),
        Vertices: flat,
        IC: COLOR_HEX[m.type],
      });
    } else if (m.type === 'area' || m.type === 'perimeter' || m.type === 'volume') {
      addAnnot(pi, {
        ...common(m),
        Subtype: PDFName.of('Polygon'),
        Rect: bbox(m.points, 4),
        Vertices: flat,
        IC: COLOR_HEX[m.type],
      });
    } else {
      // count and note share FreeText; counts always carry ': 1' so the
      // reader can tell them apart on round-trip
      const [x, y] = [m.points[0].x, m.points[0].y];
      addAnnot(pi, {
        ...common(m),
        Subtype: PDFName.of('FreeText'),
        Rect: [x - 14, y - 9, x + 14, y + 9],
        DA: PDFString.of('/Helv 9 Tf 1 g'),
        Q: 1,
        C: COLOR_HEX.count,
        IC: COLOR_HEX.count,
      });
    }
  }

  return pdfDoc.save();
}
