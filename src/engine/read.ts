// Read pdf2takeoff-authored annotations back out of a PDF.
// readPdfMarkups() walks the raw annotation dictionaries with pdf-lib, so it
// sees the exact geometry and the private JSON payload the writer embeds.
// parseMarkups() turns annotation-shaped objects into Markups; files saved
// before the payload existed fall back to parsing the Contents text.

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import type { Markup, MarkupType } from './types.ts';
import { ANNOTATION_AUTHOR, PAYLOAD_KEY, pdfText } from './annotate.ts';
import { toMeters, type Unit } from './units.ts';

/** An annotation object, accessed structurally (pdf-lib reader or a renderer). */
export type AnnotationLike = Record<string, unknown> & { subtype?: string; payload?: string };

const MARKUP_TYPES: MarkupType[] = ['length', 'area', 'count', 'perimeter', 'volume', 'angle', 'note'];

/** The writer's JSON payload, when present and well-formed. */
function payloadOf(raw: unknown): Partial<Markup> | null {
  if (typeof raw !== 'string') return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (p.v !== 1 || !MARKUP_TYPES.includes(p.type as MarkupType) || typeof p.label !== 'string') return null;
    return {
      type: p.type as MarkupType,
      label: p.label,
      ...(typeof p.id === 'string' && p.id ? { id: p.id } : {}),
      ...(typeof p.depth === 'number' && Number.isFinite(p.depth) ? { depth: p.depth } : {}),
      ...(p.status === 'check' || p.status === 'confirmed' ? { status: p.status } : {}),
      ...(typeof p.layer === 'string' && p.layer ? { layer: p.layer } : {}),
    };
  } catch {
    return null;
  }
}

/** A depth as formatLength wrote it ("150 mm", "0.15 m", "1'-6\"") → metres. */
function parseDepth(s: string): number | undefined {
  const ftIn = s.match(/^(\d+)'-(\d+(?:\.\d+)?)"$/);
  if (ftIn) return toMeters(parseFloat(ftIn[1]) + parseFloat(ftIn[2]) / 12, 'ft');
  const unit = s.match(/^(\d+(?:\.\d+)?)\s*(mm|cm|m|in|ft)$/);
  if (unit) return toMeters(parseFloat(unit[1]), unit[2] as Unit);
  return undefined;
}

export function parseMarkups(annots: AnnotationLike[], page: number, startIndex: number): Markup[] {
  const found: Markup[] = [];

  // renderers wrap text in {str} objects and may hand back typed arrays
  const strOf = (v: unknown): string | null =>
    v && typeof v === 'object' && typeof (v as { str?: unknown }).str === 'string'
      ? (v as { str: string }).str
      : null;
  const numsOf = (v: unknown): number[] | null => {
    if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v as ArrayLike<number>);
    return null;
  };

  for (const a of annots) {
    const title = strOf(a.titleObj) ?? (typeof a.title === 'string' ? a.title : '');
    if (title !== ANNOTATION_AUTHOR) continue;
    const subtype = String(a.subtype ?? '');

    const toPt = (x: number, y: number): { x: number; y: number } => ({ x, y });
    let points: { x: number; y: number }[] = [];

    const line = numsOf(a.lineCoordinates);
    if (subtype === 'Line' && line && line.length === 4) {
      points = [toPt(line[0], line[1]), toPt(line[2], line[3])];
    } else if (subtype === 'PolyLine' || subtype === 'Polygon') {
      const v = numsOf(a.vertices);
      if (v) for (let i = 0; i + 1 < v.length; i += 2) points.push(toPt(v[i], v[i + 1]));
    } else if (subtype === 'FreeText') {
      const r = numsOf(a.rect);
      if (r && r.length === 4) points = [toPt((r[0] + r[2]) / 2, (r[1] + r[3]) / 2)];
    }

    if (points.length === 0) continue;

    const index = startIndex + found.length;
    const base = { id: `im-${page}-${index}`, page, points, createdAt: Date.now() + index };

    const payload = payloadOf(a.payload);
    if (payload) {
      found.push({ ...base, ...(payload as Pick<Markup, 'type' | 'label'>) });
      continue;
    }

    // Legacy files: no payload, so recover everything from the Contents
    // text the writer formats as `label: value [status] [layer:name]`.
    const contentsRaw = strOf(a.contentsObj) ?? (typeof a.contents === 'string' ? a.contents : '');
    const layerMatch = contentsRaw.match(/\[layer:([^\]]+)\]\s*$/);
    const statusMatch = contentsRaw.match(/\[(check|confirmed)\](?:\s*\[layer:[^\]]+\])?\s*$/);
    const contents = (statusMatch || layerMatch)
      ? contentsRaw.slice(0, (statusMatch ?? layerMatch)!.index!).trimEnd()
      : contentsRaw;

    // The unit suffix tells the type back: ² = area, ³ (+ depth note) =
    // volume, ° = angle, a bare value on a Polygon = perimeter. Uncalibrated
    // comments carry no value and degrade to the geometry's base type.
    let type: Markup['type'];
    let depth: number | undefined;
    if (subtype === 'FreeText') {
      type = /: 1$/.test(contents) ? 'count' : 'note';
    } else if (subtype === 'Polygon') {
      if (contents.includes('³')) {
        type = 'volume';
        const d = contents.match(/\(depth ([^)]+)\)$/);
        if (d) depth = parseDepth(d[1].trim());
      } else if (contents.includes('²')) {
        type = 'area';
      } else if (contents.includes(':')) {
        type = 'perimeter';
      } else {
        type = 'area';
      }
    } else if (subtype === 'PolyLine' && contents.includes('°')) {
      type = 'angle';
    } else {
      type = 'length';
    }

    // a note's text is the whole comment; anything else splits off the
    // value at the LAST ': ' so labels may contain colons themselves
    const valueSplit = contents.match(/^(.*):\s[^:]*$/);
    const label = type === 'note' ? contents : (valueSplit ? valueSplit[1].trim() : contents);

    found.push({
      ...base,
      type,
      label: label || 'Restored',
      ...(depth !== undefined ? { depth } : {}),
      ...(statusMatch ? { status: statusMatch[1] as 'check' | 'confirmed' } : {}),
      ...(layerMatch ? { layer: layerMatch[1] } : {}),
    });
  }
  return found;
}

/** Every pdf2takeoff markup in a PDF, read straight from its annotation
 *  dictionaries (renderers like PDF.js normalise Line coordinates and drop
 *  private keys). Unreadable or encrypted files yield no markups. */
export async function readPdfMarkups(bytes: Uint8Array): Promise<Markup[]> {
  let pdfDoc: PDFDocument;
  try {
    pdfDoc = await PDFDocument.load(bytes.slice(), { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return [];
  }
  if (pdfDoc.isEncrypted) return [];

  const nums = (d: PDFDict, key: string): number[] | undefined => {
    const arr = d.lookup(PDFName.of(key));
    if (!(arr instanceof PDFArray)) return undefined;
    const out = arr.asArray().map((o) => {
      const n = d.context.lookup(o);
      return n instanceof PDFNumber ? n.asNumber() : NaN;
    });
    return out.every(Number.isFinite) ? out : undefined;
  };

  const found: Markup[] = [];
  pdfDoc.getPages().forEach((page, i) => {
    const annots = page.node.Annots();
    if (!annots) return;
    const likes: AnnotationLike[] = [];
    for (let j = 0; j < annots.size(); j++) {
      const d = annots.lookup(j);
      if (!(d instanceof PDFDict)) continue;
      const subtype = d.lookup(PDFName.of('Subtype'));
      likes.push({
        subtype: subtype instanceof PDFName ? subtype.decodeText() : undefined,
        title: pdfText(d.lookup(PDFName.of('T'))) ?? undefined,
        contents: pdfText(d.lookup(PDFName.of('Contents'))) ?? undefined,
        payload: pdfText(d.lookup(PDFName.of(PAYLOAD_KEY))) ?? undefined,
        lineCoordinates: nums(d, 'L'),
        vertices: nums(d, 'Vertices'),
        rect: nums(d, 'Rect'),
      });
    }
    found.push(...parseMarkups(likes, i + 1, found.length));
  });
  return found;
}
