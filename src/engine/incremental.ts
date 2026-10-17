// Encrypted PDFs, read and written without re-encrypting the whole file.
// pdf-lib can parse an encrypted file's top-level objects but not its
// (encrypted) object streams, and it can't write encryption at all. So:
//   loadEncryptedPdf()   follows the cross-reference chain, decrypts the
//                        object streams and every string, and hands back an
//                        ordinary pdf-lib PDFDocument over the plain objects;
//   appendIncrementalUpdate()  leaves the original bytes untouched and
//                        appends the changed objects (strings re-encrypted
//                        with the file's key) plus a new cross-reference
//                        section whose trailer keeps /Encrypt and /ID and
//                        points back with /Prev (ISO 32000-2 §7.5.6).

import {
  PDFArray,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObjectParser,
  PDFParser,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
  type PDFObject,
} from 'pdf-lib';
import { PdfCryptError, openSecurityHandler, type SecurityHandler } from './pdfcrypt.ts';

type XrefEntry = { kind: 'direct'; offset: number; gen: number } | { kind: 'packed'; stream: number; index: number } | { kind: 'free' };

export interface XrefInfo {
  /** Offset of the newest cross-reference section (the update's /Prev). */
  startxref: number;
  /** The newest section is a cross-reference stream, not an xref table. */
  isStream: boolean;
  /** The newest trailer (for a cross-reference stream, its dictionary). */
  trailer: PDFDict;
  size: number;
  /** The current entry for every object number. */
  entries: Map<number, XrefEntry>;
}

export interface EncryptedPdf {
  doc: PDFDocument;
  handler: SecurityHandler;
  xref: XrefInfo;
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < Math.min(to, bytes.length); i += 8192) s += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, to, bytes.length)));
  return s;
}
const encodeAscii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const isWhite = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;

function lastStartxref(bytes: Uint8Array): number {
  const tail = ascii(bytes, Math.max(0, bytes.length - 2048), bytes.length);
  const m = tail.match(/startxref\s+(\d+)\s*(?:%%EOF)?\s*$/) ?? [...tail.matchAll(/startxref\s+(\d+)/g)].pop();
  if (!m) throw new PdfCryptError('this PDF has no cross-reference offset (startxref)');
  return Number(m[1]);
}

/** Parse the indirect object ("N G obj …") that starts at offset. */
function parseIndirectAt(bytes: Uint8Array, offset: number, context: PDFContext): { num: number; gen: number; object: PDFObject } {
  const head = ascii(bytes, offset, offset + 64).match(/^\s*(\d+)\s+(\d+)\s+obj/);
  if (!head) throw new PdfCryptError(`this PDF's cross-reference table points at no object (offset ${offset})`);
  const object = PDFObjectParser.forBytes(bytes.subarray(offset + head[0].length), context).parseObject();
  return { num: Number(head[1]), gen: Number(head[2]), object };
}

/** Undo a PNG predictor (/Predictor ≥ 10), as cross-reference streams use. */
function unpredict(data: Uint8Array, parms: PDFObject | undefined): Uint8Array {
  if (!(parms instanceof PDFDict)) return data;
  const num = (k: string, d: number) => {
    const v = parms.lookup(PDFName.of(k));
    return v instanceof PDFNumber ? v.asNumber() : d;
  };
  const predictor = num('Predictor', 1);
  if (predictor < 10) {
    if (predictor === 1) return data;
    throw new PdfCryptError(`this PDF uses TIFF predictor ${predictor}, which pdf2takeoff can't read`);
  }
  const bpp = Math.max(1, Math.ceil((num('Colors', 1) * num('BitsPerComponent', 8)) / 8));
  const rowLen = Math.ceil((num('Colors', 1) * num('BitsPerComponent', 8) * num('Columns', 1)) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const src = r * (rowLen + 1) + 1;
    const at = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const left = i >= bpp ? out[at + i - bpp] : 0;
      const up = r > 0 ? out[at - rowLen + i] : 0;
      const upLeft = r > 0 && i >= bpp ? out[at - rowLen + i - bpp] : 0;
      let pred = 0;
      if (type === 1) pred = left;
      else if (type === 2) pred = up;
      else if (type === 3) pred = (left + up) >> 1;
      else if (type === 4) {
        const p = left + up - upLeft;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[at + i] = (data[src + i] + pred) & 255;
    }
  }
  return out;
}

function decodeStream(stream: PDFRawStream): Uint8Array {
  return unpredict(decodePDFRawStream(stream).decode(), stream.dict.lookup(PDFName.of('DecodeParms')));
}

const intOf = (d: PDFDict, key: string): number | undefined => {
  const v = d.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : undefined;
};

/** Follow the cross-reference chain from the last startxref, newest first. */
export function readXref(bytes: Uint8Array, context: PDFContext): XrefInfo {
  const entries = new Map<number, XrefEntry>();
  const seen = new Set<number>();
  const startxref = lastStartxref(bytes);
  let newest: { trailer: PDFDict; isStream: boolean } | undefined;

  const set = (num: number, e: XrefEntry) => {
    if (!entries.has(num)) entries.set(num, e);
  };

  const readStreamSection = (offset: number): PDFDict => {
    const { object } = parseIndirectAt(bytes, offset, context);
    if (!(object instanceof PDFRawStream)) throw new PdfCryptError(`this PDF's cross-reference section at ${offset} is unreadable`);
    const dict = object.dict;
    const w = dict.lookup(PDFName.of('W'));
    if (!(w instanceof PDFArray) || w.size() !== 3) throw new PdfCryptError('this PDF has a malformed cross-reference stream');
    const widths = w.asArray().map((n) => (n instanceof PDFNumber ? n.asNumber() : 0));
    const idx = dict.lookup(PDFName.of('Index'));
    const index = idx instanceof PDFArray ? idx.asArray().map((n) => (n instanceof PDFNumber ? n.asNumber() : 0)) : [0, intOf(dict, 'Size') ?? 0];
    const data = decodeStream(object);
    const field = (at: number, width: number) => {
      let v = 0;
      for (let i = 0; i < width; i++) v = v * 256 + data[at + i];
      return v;
    };
    const rowLen = widths[0] + widths[1] + widths[2];
    let at = 0;
    for (let s = 0; s + 1 < index.length; s += 2) {
      for (let k = 0; k < index[s + 1] && at + rowLen <= data.length; k++, at += rowLen) {
        const type = widths[0] ? field(at, widths[0]) : 1;
        const f2 = field(at + widths[0], widths[1]);
        const f3 = field(at + widths[0] + widths[1], widths[2]);
        const num = index[s] + k;
        if (type === 0) set(num, { kind: 'free' });
        else if (type === 1) set(num, { kind: 'direct', offset: f2, gen: f3 });
        else if (type === 2) set(num, { kind: 'packed', stream: f2, index: f3 });
      }
    }
    return dict;
  };

  const readTableSection = (offset: number): PDFDict => {
    let pos = offset;
    while (isWhite(bytes[pos])) pos++;
    pos += 4; // "xref"
    const token = (): string => {
      while (pos < bytes.length && isWhite(bytes[pos])) pos++;
      const start = pos;
      while (pos < bytes.length && !isWhite(bytes[pos])) pos++;
      return ascii(bytes, start, pos);
    };
    for (;;) {
      const first = token();
      if (first === 'trailer' || first === '') break;
      const start = Number(first);
      const count = Number(token());
      if (!Number.isFinite(start) || !Number.isFinite(count)) throw new PdfCryptError('this PDF has a malformed cross-reference table');
      for (let k = 0; k < count; k++) {
        const off = Number(token());
        const gen = Number(token());
        const kind = token();
        set(start + k, kind === 'n' ? { kind: 'direct', offset: off, gen } : { kind: 'free' });
      }
    }
    const trailer = PDFObjectParser.forBytes(bytes.subarray(pos), context).parseObject();
    if (!(trailer instanceof PDFDict)) throw new PdfCryptError('this PDF has a malformed trailer');
    return trailer;
  };

  let offset: number | undefined = startxref;
  while (offset !== undefined && !seen.has(offset)) {
    seen.add(offset);
    let p = offset;
    while (isWhite(bytes[p])) p++;
    const isStream = ascii(bytes, p, p + 4) !== 'xref';
    const trailer = isStream ? readStreamSection(offset) : readTableSection(offset);
    newest ??= { trailer, isStream };
    // hybrid files list their object-stream entries in /XRefStm
    const xrefStm = isStream ? undefined : intOf(trailer, 'XRefStm');
    if (xrefStm !== undefined && !seen.has(xrefStm)) {
      seen.add(xrefStm);
      readStreamSection(xrefStm);
    }
    offset = intOf(trailer, 'Prev');
  }
  if (!newest) throw new PdfCryptError("this PDF's cross-reference chain is unreadable");
  return { startxref, isStream: newest.isStream, trailer: newest.trailer, size: intOf(newest.trailer, 'Size') ?? 0, entries };
}

const bytesOf = (v: PDFObject): Uint8Array | null => (v instanceof PDFString || v instanceof PDFHexString ? v.asBytes() : null);

/** Replace every string in a direct object tree, in place. */
async function mapStringsInPlace(obj: PDFObject, f: (b: Uint8Array) => Promise<Uint8Array>): Promise<void> {
  const container = obj instanceof PDFRawStream ? obj.dict : obj;
  if (container instanceof PDFDict) {
    for (const [key, value] of container.entries()) {
      const b = bytesOf(value);
      if (b) container.set(key, PDFHexString.of(toHex(await f(b))));
      else await mapStringsInPlace(value, f);
    }
  } else if (container instanceof PDFArray) {
    for (let i = 0; i < container.size(); i++) {
      const value = container.get(i);
      const b = bytesOf(value);
      if (b) container.set(i, PDFHexString.of(toHex(await f(b))));
      else await mapStringsInPlace(value, f);
    }
  }
}

/** A deep copy of a direct object tree with every string replaced. */
async function mapStringsCopy(obj: PDFObject, context: PDFContext, f: (b: Uint8Array) => Promise<Uint8Array>): Promise<PDFObject> {
  const b = bytesOf(obj);
  if (b) return PDFHexString.of(toHex(await f(b)));
  if (obj instanceof PDFRawStream) throw new PdfCryptError('pdf2takeoff cannot append streams to an encrypted PDF');
  if (obj instanceof PDFDict) {
    const out = PDFDict.withContext(context);
    for (const [key, value] of obj.entries()) out.set(key, await mapStringsCopy(value, context, f));
    return out;
  }
  if (obj instanceof PDFArray) {
    const out = PDFArray.withContext(context);
    for (const value of obj.asArray()) out.push(await mapStringsCopy(value, context, f));
    return out;
  }
  return obj;
}

function encryptParams(enc: PDFDict, trailer: PDFDict) {
  const name = (d: PDFDict, k: string) => {
    const v = d.lookup(PDFName.of(k));
    return v instanceof PDFName ? v.decodeText() : undefined;
  };
  const str = (k: string) => {
    const v = enc.lookup(PDFName.of(k));
    return v ? (bytesOf(v) ?? undefined) : undefined;
  };
  // V4/V5: /StmF and /StrF name a crypt filter in /CF (or /Identity)
  const method = (k: string) => {
    const f = name(enc, k);
    if (f === undefined || f === 'Identity') return f;
    const cf = enc.lookup(PDFName.of('CF'));
    const filter = cf instanceof PDFDict ? cf.lookup(PDFName.of(f)) : undefined;
    return filter instanceof PDFDict ? (name(filter, 'CFM') ?? 'None') : 'None';
  };
  const id = trailer.lookup(PDFName.of('ID'));
  const id0 = id instanceof PDFArray && id.size() > 0 ? bytesOf(id.get(0)) : null;
  const em = enc.lookup(PDFName.of('EncryptMetadata'));
  return {
    filter: name(enc, 'Filter') ?? '',
    v: intOf(enc, 'V') ?? 0,
    r: intOf(enc, 'R') ?? 0,
    length: intOf(enc, 'Length'),
    o: str('O') ?? new Uint8Array(0),
    u: str('U') ?? new Uint8Array(0),
    oe: str('OE'),
    ue: str('UE'),
    p: intOf(enc, 'P') ?? 0,
    encryptMetadata: em === undefined || String(em) !== 'false',
    stmMethod: method('StmF'),
    strMethod: method('StrF'),
    id0: id0 ?? new Uint8Array(0),
  };
}

/** Open an encrypted PDF (empty user password) as a plain pdf-lib PDFDocument:
 *  object streams unpacked and every string decrypted. Pass the context of
 *  an already-parsed copy (PDFDocument.load with ignoreEncryption) to skip
 *  re-parsing. Throws PdfCryptError when the file can't be handled. */
export async function loadEncryptedPdf(bytes: Uint8Array, parsed?: PDFContext): Promise<EncryptedPdf> {
  const context = parsed ?? (await PDFParser.forBytesWithOptions(bytes).parseDocument());
  const xref = readXref(bytes, context);
  const { trailer } = xref;
  const encRef = trailer.get(PDFName.of('Encrypt'));
  const encDict = encRef ? context.lookup(encRef) : undefined;
  if (!(encDict instanceof PDFDict)) throw new PdfCryptError("this PDF's encryption dictionary is missing");
  const handler = await openSecurityHandler(encryptParams(encDict, trailer));

  // strings of top-level objects are encrypted with their own object's key
  for (const [num, e] of xref.entries) {
    if (e.kind !== 'direct') continue;
    const ref = PDFRef.of(num, e.gen);
    if (encRef instanceof PDFRef && ref === encRef) continue;
    const obj = context.lookup(ref);
    if (obj === undefined) continue;
    const type = obj instanceof PDFRawStream ? obj.dict.lookup(PDFName.of('Type')) : undefined;
    if (type === PDFName.of('XRef')) continue; // never encrypted
    await mapStringsInPlace(obj, async (b) => {
      try {
        return await handler.decryptString(b, num, e.gen);
      } catch {
        return b; // not actually encrypted (or damaged): leave as found
      }
    });
  }

  // objects inside object streams: decrypt the stream, then parse them out
  // (their strings aren't encrypted separately)
  const packed = new Map<number, { num: number; index: number }[]>();
  for (const [num, e] of xref.entries) {
    if (e.kind !== 'packed') continue;
    const list = packed.get(e.stream) ?? [];
    list.push({ num, index: e.index });
    packed.set(e.stream, list);
  }
  for (const [streamNum, members] of packed) {
    const at = xref.entries.get(streamNum);
    if (at?.kind !== 'direct') continue;
    const { object } = parseIndirectAt(bytes, at.offset, context);
    if (!(object instanceof PDFRawStream)) continue;
    const plain = PDFRawStream.of(object.dict, await handler.decryptStream(object.contents, streamNum, at.gen));
    const data = decodeStream(plain);
    const first = intOf(object.dict, 'First') ?? 0;
    const n = intOf(object.dict, 'N') ?? 0;
    const header = ascii(data, 0, first).trim().split(/\s+/).map(Number);
    for (const { num, index } of members) {
      if (index >= n || header[index * 2] !== num) continue;
      const obj = PDFObjectParser.forBytes(data.subarray(first + header[index * 2 + 1]), context).parseObject();
      context.assign(PDFRef.of(num, 0), obj);
    }
  }

  for (const key of ['Root', 'Info', 'Encrypt', 'ID'] as const) {
    const v = trailer.get(PDFName.of(key));
    if (v) context.trailerInfo[key] = v;
  }
  context.largestObjectNumber = Math.max(context.largestObjectNumber, xref.size - 1);
  const Doc = PDFDocument as unknown as new (context: PDFContext, ignoreEncryption: boolean, updateMetadata: boolean) => PDFDocument;
  return { doc: new Doc(context, true, false), handler, xref };
}

/** The original bytes plus an incremental update holding `objects` (new or
 *  replaced indirect objects), encrypted with the file's key. */
export async function appendIncrementalUpdate(bytes: Uint8Array, pdf: EncryptedPdf, objects: [PDFRef, PDFObject][]): Promise<Uint8Array> {
  const { context } = pdf.doc;
  const parts: Uint8Array[] = [bytes];
  let length = bytes.length;
  const push = (b: Uint8Array) => {
    parts.push(b);
    length += b.length;
  };
  const last = bytes[bytes.length - 1];
  if (last !== 0x0a && last !== 0x0d) push(encodeAscii('\n'));

  const offsets: { num: number; gen: number; offset: number }[] = [];
  for (const [ref, obj] of [...objects].sort((a, b) => a[0].objectNumber - b[0].objectNumber)) {
    const { objectNumber: num, generationNumber: gen } = ref;
    const body = await mapStringsCopy(obj, context, (b) => pdf.handler.encryptString(b, num, gen));
    offsets.push({ num, gen, offset: length });
    push(encodeAscii(`${num} ${gen} obj\n${body.toString()}\nendobj\n`));
  }

  // the new trailer keeps the file's identity and encryption
  const trailerEntries: string[] = [];
  for (const key of ['Root', 'Info', 'Encrypt', 'ID'] as const) {
    const v = context.trailerInfo[key] ?? pdf.xref.trailer.get(PDFName.of(key));
    if (v) trailerEntries.push(`/${key} ${v.toString()}`);
  }
  trailerEntries.push(`/Prev ${pdf.xref.startxref}`);

  const xrefOffset = length;
  if (pdf.xref.isStream) {
    // a cross-reference stream (never encrypted), uncompressed: W [1 4 2]
    const self = context.nextRef();
    offsets.push({ num: self.objectNumber, gen: 0, offset: xrefOffset });
    const size = Math.max(pdf.xref.size, ...offsets.map((o) => o.num + 1));
    const index: number[] = [];
    for (const o of offsets) {
      if (index.length && index[index.length - 2] + index[index.length - 1] === o.num) index[index.length - 1]++;
      else index.push(o.num, 1);
    }
    const data = new Uint8Array(offsets.length * 7);
    offsets.forEach((o, i) => {
      const dv = new DataView(data.buffer, i * 7, 7);
      dv.setUint8(0, 1);
      dv.setUint32(1, o.offset);
      dv.setUint16(5, o.gen);
    });
    const dict = `<< /Type /XRef /Size ${size} /Index [${index.join(' ')}] /W [1 4 2] ${trailerEntries.join(' ')} /Length ${data.length} >>`;
    push(encodeAscii(`${self.objectNumber} 0 obj\n${dict}\nstream\n`));
    push(data);
    push(encodeAscii('\nendstream\nendobj\n'));
  } else {
    const size = Math.max(pdf.xref.size, ...offsets.map((o) => o.num + 1));
    let table = 'xref\n';
    for (let i = 0; i < offsets.length; ) {
      let j = i + 1;
      while (j < offsets.length && offsets[j].num === offsets[j - 1].num + 1) j++;
      table += `${offsets[i].num} ${j - i}\n`;
      for (let k = i; k < j; k++) table += `${String(offsets[k].offset).padStart(10, '0')} ${String(offsets[k].gen).padStart(5, '0')} n\r\n`;
      i = j;
    }
    push(encodeAscii(`${table}trailer\n<< /Size ${size} ${trailerEntries.join(' ')} >>\n`));
  }
  push(encodeAscii(`startxref\n${xrefOffset}\n%%EOF\n`));

  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
