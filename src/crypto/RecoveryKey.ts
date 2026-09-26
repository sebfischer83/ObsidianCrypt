import { sha256 } from "@noble/hashes/sha2.js";
import { CryptoError } from "../errors/CryptoError";
import { constantTimeEqual } from "../util/bytes";
import type { CryptoProvider } from "./CryptoProvider";

/**
 * Recovery key: 256 random bits plus a 16-bit checksum, rendered as Crockford base32 in groups of five
 * (55 characters). The checksum only detects typos; it has no security function.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const RECOVERY_SECRET_LENGTH = 32;
const CHECKSUM_LENGTH = 2;
const GROUP = 5;

export function generateRecoverySecret(crypto: CryptoProvider): Uint8Array {
  return crypto.randomBytes(RECOVERY_SECRET_LENGTH);
}

export function formatRecoveryKey(secret: Uint8Array): string {
  if (secret.length !== RECOVERY_SECRET_LENGTH) throw new CryptoError("InvalidInput", "recovery secret length");
  const data = new Uint8Array(RECOVERY_SECRET_LENGTH + CHECKSUM_LENGTH);
  data.set(secret);
  data.set(sha256(secret).subarray(0, CHECKSUM_LENGTH), RECOVERY_SECRET_LENGTH);
  const chars = base32Encode(data);
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += GROUP) groups.push(chars.slice(i, i + GROUP));
  return groups.join("-");
}

export function parseRecoveryKey(input: string): Uint8Array {
  const normalized = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  const expectedChars = Math.ceil(((RECOVERY_SECRET_LENGTH + CHECKSUM_LENGTH) * 8) / 5);
  if (normalized.length !== expectedChars) throw new CryptoError("WrongRecoveryKey", "length");
  const data = base32Decode(normalized, RECOVERY_SECRET_LENGTH + CHECKSUM_LENGTH);
  const secret = data.slice(0, RECOVERY_SECRET_LENGTH);
  const checksum = data.subarray(RECOVERY_SECRET_LENGTH);
  if (!constantTimeEqual(checksum, sha256(secret).subarray(0, CHECKSUM_LENGTH))) {
    throw new CryptoError("WrongRecoveryKey", "checksum (typo?)");
  }
  return secret;
}

function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31] as string;
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31] as string;
  return out;
}

function base32Decode(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new CryptoError("WrongRecoveryKey", "invalid character");
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      if (index < length) out[index++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  if (index !== length) throw new CryptoError("WrongRecoveryKey", "length");
  return out;
}
