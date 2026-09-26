/**
 * Byte helpers without Node's Buffer (must run on Obsidian mobile).
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function utf8Encode(text: string): Uint8Array {
  return textEncoder.encode(text);
}

/** Strict UTF-8 decoding: invalid sequences throw instead of being replaced. */
export function utf8Decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    out += HEX[b >> 4] as string;
    out += HEX[b & 0x0f] as string;
  }
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("Invalid hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_ENC = utf8Encode(B64_ALPHABET);
const B64_DEC = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();
const asciiDecoder = new TextDecoder("ascii");

/** Standard base64 with padding. Works on large inputs without building intermediate binary strings. */
export function toBase64(bytes: Uint8Array): string {
  const outLen = Math.ceil(bytes.length / 3) * 4;
  const out = new Uint8Array(outLen);
  let o = 0;
  let i = 0;
  const full = bytes.length - (bytes.length % 3);
  for (; i < full; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out[o++] = B64_ENC[(n >> 18) & 63] as number;
    out[o++] = B64_ENC[(n >> 12) & 63] as number;
    out[o++] = B64_ENC[(n >> 6) & 63] as number;
    out[o++] = B64_ENC[n & 63] as number;
  }
  const rest = bytes.length - full;
  if (rest > 0) {
    const b0 = bytes[i] as number;
    const b1 = rest === 2 ? (bytes[i + 1] as number) : 0;
    const n = (b0 << 16) | (b1 << 8);
    out[o++] = B64_ENC[(n >> 18) & 63] as number;
    out[o++] = B64_ENC[(n >> 12) & 63] as number;
    out[o++] = rest === 2 ? (B64_ENC[(n >> 6) & 63] as number) : 61; // '='
    out[o++] = 61;
  }
  return asciiDecoder.decode(out);
}

/** Strict base64 decoding. Whitespace (e.g. line breaks in GitHub responses) is ignored. */
export function fromBase64(input: string): Uint8Array {
  const clean = input.replace(/[\r\n\t ]/g, "");
  if (clean.length % 4 !== 0) throw new Error("Invalid base64 length");
  let pad = 0;
  if (clean.endsWith("==")) pad = 2;
  else if (clean.endsWith("=")) pad = 1;
  const outLen = (clean.length / 4) * 3 - pad;
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_DEC[clean.charCodeAt(i)] as number;
    const c1 = B64_DEC[clean.charCodeAt(i + 1)] as number;
    const isLast = i + 4 === clean.length;
    const ch2 = clean.charCodeAt(i + 2);
    const ch3 = clean.charCodeAt(i + 3);
    const c2 = isLast && pad >= 2 && ch2 === 61 ? 0 : (B64_DEC[ch2] as number);
    const c3 = isLast && pad >= 1 && ch3 === 61 ? 0 : (B64_DEC[ch3] as number);
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) throw new Error("Invalid base64 character");
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (o < outLen) out[o++] = (n >> 16) & 0xff;
    if (o < outLen) out[o++] = (n >> 8) & 0xff;
    if (o < outLen) out[o++] = n & 0xff;
  }
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Constant-time comparison for MACs and key checks. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Best-effort zeroisation of key material (JS gives no hard guarantees). */
export function wipe(bytes: Uint8Array | null | undefined): void {
  if (bytes) bytes.fill(0);
}

/**
 * Returns an ArrayBuffer view that WebCrypto accepts, avoiding a copy when the
 * Uint8Array already spans its whole buffer.
 */
export function asBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) return bytes as Uint8Array<ArrayBuffer>;
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

/** Returns an ArrayBuffer containing exactly the bytes of the view (copies only if needed). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}
