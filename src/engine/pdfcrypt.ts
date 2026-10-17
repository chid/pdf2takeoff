// The PDF Standard security handler (ISO 32000-2 §7.6.4): derive the file
// key of an encrypted PDF for the empty user password — the "no password to
// open, but edit-restricted" files councils and consultants publish — and
// encrypt/decrypt its strings and streams. Covers RC4 40/128-bit (R2–R4),
// AES-128 (AESV2, R4) and AES-256 (AESV3, R5/R6).
//
// MD5 and RC4 are small and pure TS here; SHA-2 and AES come from WebCrypto
// (globalThis.crypto.subtle), which Node ≥ 19 and every browser provide.

/** Why an encrypted PDF can't be handled (shown to the user as-is). */
export class PdfCryptError extends Error {}

// ---------------------------------------------------------------- primitives

interface Subtle {
  digest(alg: string, data: Uint8Array): Promise<ArrayBuffer>;
  importKey(format: 'raw', key: Uint8Array, alg: string, extractable: boolean, usages: string[]): Promise<unknown>;
  encrypt(alg: { name: string; iv: Uint8Array }, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(alg: { name: string; iv: Uint8Array }, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}
interface WebCrypto {
  subtle: Subtle;
  getRandomValues(a: Uint8Array): Uint8Array;
}

function webCrypto(): WebCrypto {
  const c = (globalThis as unknown as { crypto?: WebCrypto }).crypto;
  if (!c?.subtle) throw new PdfCryptError('this environment has no WebCrypto, which encrypted PDFs need');
  return c;
}

function concat(...parts: ArrayLike<number>[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(data: Uint8Array): Uint8Array {
  const len = data.length;
  const padded = new Uint8Array(((len + 72) >>> 6) << 6);
  padded.set(data);
  padded[len] = 0x80;
  const bits = len * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bits >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bits / 2 ** 32), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const m = new Array<number>(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true);
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      const s = MD5_S[(i >>> 4) * 4 + (i & 3)];
      const t = (a + f + MD5_K[i] + m[g]) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((t << s) | (t >>> (32 - s)))) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((w, i) => ov.setUint32(i * 4, w >>> 0, true));
  return out;
}

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

async function sha(bits: 256 | 384 | 512, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await webCrypto().subtle.digest(`SHA-${bits}`, data));
}

const aesKey = (key: Uint8Array, usage: 'encrypt' | 'decrypt') =>
  webCrypto().subtle.importKey('raw', key, 'AES-CBC', false, [usage]);

/** AES-CBC encryption; without padding when data is block-aligned and
 *  pad is false (WebCrypto always pads, so the pad block is cut off). */
async function aesEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array, pad: boolean): Promise<Uint8Array> {
  const out = new Uint8Array(await webCrypto().subtle.encrypt({ name: 'AES-CBC', iv }, await aesKey(key, 'encrypt'), data));
  return pad ? out : out.subarray(0, data.length);
}

/** AES-CBC decryption. For unpadded data a block is appended that decrypts
 *  to a full PKCS#7 pad block, which WebCrypto then strips again. */
async function aesDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array, pad: boolean): Promise<Uint8Array> {
  let input = data;
  if (!pad) {
    const last = data.length >= 16 ? data.subarray(data.length - 16) : iv;
    const extra = await aesEncrypt(key, last, new Uint8Array(16).fill(16), false);
    input = concat(data, extra);
  }
  return new Uint8Array(await webCrypto().subtle.decrypt({ name: 'AES-CBC', iv }, await aesKey(key, 'decrypt'), input));
}

// ------------------------------------------------------- security handler

/** The /Encrypt dictionary entries the handler needs, already resolved. */
export interface EncryptParams {
  filter: string;
  v: number;
  r: number;
  length?: number; // bits
  o: Uint8Array;
  u: Uint8Array;
  oe?: Uint8Array;
  ue?: Uint8Array;
  p: number;
  encryptMetadata: boolean;
  /** Crypt filter method per /StmF and /StrF (V4/V5): None, V2, AESV2, AESV3. */
  stmMethod?: string;
  strMethod?: string;
  /** First element of the trailer /ID (R2–R4 key derivation). */
  id0: Uint8Array;
}

type Method = 'None' | 'RC4' | 'AESV2' | 'AESV3';

/** Encrypts/decrypts the strings and streams of one encrypted PDF. */
export interface SecurityHandler {
  /** Revision of the standard handler (2–6) and the cipher in use. */
  revision: number;
  cipher: string;
  /** The /P permission bits allow adding/modifying annotations. */
  canAnnotate: boolean;
  decryptString(data: Uint8Array, num: number, gen: number): Promise<Uint8Array>;
  encryptString(data: Uint8Array, num: number, gen: number): Promise<Uint8Array>;
  decryptStream(data: Uint8Array, num: number, gen: number): Promise<Uint8Array>;
}

const PASSWORD_PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

const OPEN_PASSWORD_MESSAGE = 'this PDF needs a password to open, and pdf2takeoff only handles encrypted PDFs that open without one';

const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

function le32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, true);
  return b;
}

/** Algorithm 2: the R2–R4 file key for the empty user password. */
function legacyFileKey(p: EncryptParams): Uint8Array {
  const n = p.r === 2 ? 5 : (p.length ?? (p.v >= 4 ? 128 : 40)) / 8;
  if (!Number.isInteger(n) || n < 5 || n > 16) throw new PdfCryptError(`this PDF's encryption key length (${p.length} bits) isn't valid`);
  let hash = md5(concat(PASSWORD_PAD, p.o.subarray(0, 32), le32(p.p), p.id0, p.r >= 4 && !p.encryptMetadata ? [255, 255, 255, 255] : []));
  if (p.r >= 3) for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, n));
  const key = hash.slice(0, n);

  // Algorithms 4/5: the key must reproduce /U, else an open password is set
  let check: Uint8Array;
  if (p.r === 2) {
    check = rc4(key, PASSWORD_PAD);
  } else {
    check = rc4(key, md5(concat(PASSWORD_PAD, p.id0)));
    for (let i = 1; i <= 19; i++) check = rc4(key.map((b) => b ^ i), check);
  }
  const len = p.r === 2 ? 32 : 16;
  if (!equalBytes(check.subarray(0, len), p.u.subarray(0, len))) throw new PdfCryptError(OPEN_PASSWORD_MESSAGE);
  return key;
}

/** Algorithm 2.B (R6): the iterated SHA-2/AES hash of a password. */
async function hashR6(password: Uint8Array, salt: Uint8Array, udata: Uint8Array): Promise<Uint8Array> {
  let k = await sha(256, concat(password, salt, udata));
  for (let round = 0; ; round++) {
    const one = concat(password, k, udata);
    const k1 = new Uint8Array(one.length * 64);
    for (let i = 0; i < 64; i++) k1.set(one, i * one.length);
    const e = await aesEncrypt(k.subarray(0, 16), k.subarray(16, 32), k1, false);
    let mod = 0;
    for (let i = 0; i < 16; i++) mod += e[i];
    k = await sha(([256, 384, 512] as const)[mod % 3], e);
    if (round >= 63 && e[e.length - 1] <= round - 31) break;
  }
  return k.subarray(0, 32);
}

/** Algorithm 2.A: the R5/R6 file key for the empty user password. */
async function aes256FileKey(p: EncryptParams): Promise<Uint8Array> {
  if (p.u.length < 48 || !p.ue || p.ue.length < 32) throw new PdfCryptError("this PDF's AES-256 encryption dictionary is incomplete");
  const empty = new Uint8Array(0);
  const hash = (salt: Uint8Array) => (p.r === 5 ? sha(256, salt) : hashR6(empty, salt, empty));
  if (!equalBytes(await hash(p.u.subarray(32, 40)), p.u.subarray(0, 32))) throw new PdfCryptError(OPEN_PASSWORD_MESSAGE);
  return aesDecrypt(await hash(p.u.subarray(40, 48)), new Uint8Array(16), p.ue.subarray(0, 32), false);
}

function methodOf(cfm: string | undefined, p: EncryptParams): Method {
  if (p.v < 4) return 'RC4';
  if (cfm === undefined || cfm === 'Identity' || cfm === 'None') return 'None';
  if (cfm === 'V2') return 'RC4';
  if (cfm === 'AESV2' || cfm === 'AESV3') return cfm;
  throw new PdfCryptError(`this PDF uses the ${cfm} crypt filter, which pdf2takeoff can't handle`);
}

/** Open the Standard security handler with the empty user password. Throws
 *  PdfCryptError for public-key or unknown handlers and password-protected files. */
export async function openSecurityHandler(p: EncryptParams): Promise<SecurityHandler> {
  if (p.filter !== 'Standard') throw new PdfCryptError(`this PDF uses the ${p.filter} security handler (certificate encryption), which pdf2takeoff can't handle`);
  if (![1, 2, 4, 5].includes(p.v) || p.r < 2 || p.r > 6) throw new PdfCryptError(`this PDF uses encryption V${p.v} R${p.r}, which pdf2takeoff can't handle`);
  const aes256 = p.v === 5;
  const key = aes256 ? await aes256FileKey(p) : legacyFileKey(p);
  const strMethod = methodOf(p.strMethod, p);
  const stmMethod = methodOf(p.stmMethod, p);

  const objectKey = (method: Method, num: number, gen: number): Uint8Array => {
    if (method === 'AESV3') return key;
    const salt = method === 'AESV2' ? [0x73, 0x41, 0x6c, 0x54] : [];
    const h = md5(concat(key, [num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255], salt));
    return h.subarray(0, Math.min(key.length + 5, 16));
  };

  const decrypt = async (method: Method, data: Uint8Array, num: number, gen: number): Promise<Uint8Array> => {
    if (method === 'None') return data;
    const k = objectKey(method, num, gen);
    if (method === 'RC4') return rc4(k, data);
    // 16-byte IV, then PKCS#7-padded ciphertext; some writers emit an
    // empty string as nothing or as the IV alone
    if (data.length <= 16) return new Uint8Array(0);
    const body = data.subarray(16, 16 + Math.floor((data.length - 16) / 16) * 16);
    return aesDecrypt(k, data.subarray(0, 16), body, true);
  };

  const encrypt = async (method: Method, data: Uint8Array, num: number, gen: number): Promise<Uint8Array> => {
    if (method === 'None') return data;
    const k = objectKey(method, num, gen);
    if (method === 'RC4') return rc4(k, data);
    const iv = webCrypto().getRandomValues(new Uint8Array(16));
    return concat(iv, await aesEncrypt(k, iv, data, true));
  };

  return {
    revision: p.r,
    cipher: strMethod === 'RC4' ? `RC4 ${key.length * 8}-bit` : strMethod === 'AESV2' ? 'AES-128' : strMethod === 'AESV3' ? 'AES-256' : 'none',
    canAnnotate: (p.p & 32) !== 0,
    decryptString: (data, num, gen) => decrypt(strMethod, data, num, gen),
    encryptString: (data, num, gen) => encrypt(strMethod, data, num, gen),
    decryptStream: (data, num, gen) => decrypt(stmMethod, data, num, gen),
  };
}
